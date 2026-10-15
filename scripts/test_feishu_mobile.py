"""Phone identity, immutable meeting ownership and HTTP boundary regressions."""
import json
import os
import tempfile
import threading
import types
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

from action_sources import DailyReceipts, binding_for

from feishu_accounts import AccountError
from feishu_mobile import MeetingOwners, MobileError, MobileFeishu
from local_backend import Handler, Backend, Operations, ApiError
from meeting_features import Meetings


class OwnersTest(unittest.TestCase):
    def test_new_meeting_belongs_to_one_phone_and_cannot_be_stolen(self):
        with tempfile.TemporaryDirectory() as directory:
            owners = MeetingOwners(directory)
            owners.reserve('meeting-1', 'phone-a', False)
            owners.reserve('meeting-1', 'phone-a', True)
            self.assertTrue(owners.check('meeting-1', 'phone-a'))
            for action in (lambda: owners.reserve('meeting-1', 'phone-b', True),
                           lambda: owners.check('meeting-1', 'phone-b')):
                with self.assertRaises(MobileError) as caught:
                    action()
                self.assertEqual(403, caught.exception.status)
            self.assertEqual(0o600, os.stat(owners.path).st_mode & 0o777)

    def test_legacy_meeting_is_never_claimed_by_next_phone(self):
        with tempfile.TemporaryDirectory() as directory:
            owners = MeetingOwners(directory)
            owners.reserve('legacy', 'phone-a', True)
            with self.assertRaises(MobileError) as caught:
                owners.check('legacy', 'phone-a', 'tenant:person-a')
            self.assertEqual('MEETING_OWNER_UNVERIFIED', caught.exception.code)

    def test_binding_first_account_is_stable_across_reconnect_and_blocks_account_swap(self):
        with tempfile.TemporaryDirectory() as directory:
            owners = MeetingOwners(directory)
            owners.reserve('meeting-2', 'phone-a', False)
            owners.check('meeting-2', 'phone-a', 'tenant:account-a')
            self.assertTrue(owners.check('meeting-2', 'phone-a', 'tenant:account-a'))
            with self.assertRaises(MobileError) as caught:
                owners.check('meeting-2', 'phone-a', 'tenant:account-b')
            self.assertEqual('MEETING_ACCOUNT_MISMATCH', caught.exception.code)


class FakeAccounts:
    def create_session(self):
        return {'session_token': 'test-opaque-session-token-which-is-long-enough'}

    def principal(self, token):
        if token not in ('phone-a', 'phone-b'):
            raise AccountError(401, 'PERSONAL_IDENTITY_REQUIRED', '请连接本人账号')
        return token

    def status(self, token):
        self.principal(token)
        return {'status': 'bound', 'binding_revision': 1,
                'account': {'open_id': 'account-' + token, 'tenant_key': 'tenant', 'name': token}}

    def principal_readonly_snapshot(self, token):
        return self.principal(token)

    def status_readonly_snapshot(self, token):
        return self.status(token)


class HttpBoundaryTest(unittest.TestCase):
    def test_manual_task_keeps_personal_identity_without_inventing_a_meeting(self):
        with tempfile.TemporaryDirectory() as directory:
            mobile = MobileFeishu(types.SimpleNamespace(feishu=None), directory, accounts=FakeAccounts())
            self.assertIsNone(mobile.check_action_owner('phone-a', {'draft': {'who': 'phone-a', 'what': '手动任务'}}))
            with self.assertRaises(AccountError):
                mobile.check_action_owner('not-a-phone', {'draft': {'what': '手动任务'}})

    def test_shared_service_token_cannot_impersonate_a_person_or_skip_send_confirmation(self):
        with tempfile.TemporaryDirectory() as directory:
            backend = types.SimpleNamespace(feishu=None)
            mobile = MobileFeishu(backend, directory, accounts=FakeAccounts())
            backend.mobile_feishu = mobile
            mobile.owners.reserve('meeting-1', 'phone-a', False)
            class Protected(Handler):
                api_token = 'test-service-token'
            Protected.backend = backend
            server = ThreadingHTTPServer(('127.0.0.1', 0), Protected)
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            def request(path, body=None, token=None, service=True):
                headers = {'Authorization': 'Bearer test-service-token'} if service else {}
                if token:
                    headers['X-Oops-User-Token'] = token
                req = urllib.request.Request(f'http://127.0.0.1:{server.server_port}' + path,
                    data=json.dumps(body).encode() if body is not None else None, headers=headers)
                try:
                    with urllib.request.urlopen(req) as response:
                        return response.status, json.load(response)
                except urllib.error.HTTPError as error:
                    with error:
                        return error.code, json.load(error)
            try:
                self.assertEqual(401, request('/v1/feishu/session', {}, service=False)[0])
                code, value = request('/v1/feishu/session', {})
                self.assertEqual(200, code)
                self.assertIn('session_token', value)
                self.assertEqual(401, request('/v1/feishu/status')[0])
                self.assertEqual('phone-a', request('/v1/feishu/status', token='phone-a')[1]['account']['name'])
                code, value = request('/v1/meetings/meeting-1/delivery/confirm', {'revision': 1}, 'phone-b')
                self.assertEqual(403, code)
                code, value = request('/v1/meetings/meeting-1/delivery/confirm', {'revision': 1}, 'phone-a')
                self.assertEqual(400, code)
                self.assertEqual('CONFIRMATION_REQUIRED', value['error']['code'])
                code, value = request('/v1/meetings/legacy/delivery', token='phone-a')
                self.assertEqual(403, code)
                self.assertNotIn('credentials', json.dumps(value))
            finally:
                server.shutdown(); server.server_close(); worker.join()


class PersonalSourceContractTest(unittest.TestCase):
    """The device's signed evidence and new personal binding are both required."""
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.backend = Backend.__new__(Backend)
        self.backend.ops = Operations(os.path.join(self.tmp.name, 'ops'))
        self.backend.meetings = Meetings(os.path.join(self.tmp.name, 'meetings'), self.backend.ops, team=['洪玉麟'])
        self.backend.daily_receipts = DailyReceipts()
        self.backend.args = types.SimpleNamespace(feishu='dry-run')
        self.backend.feishu = None
        class PersonalAccounts(FakeAccounts):
            def recipients(self, token):
                self.principal(token)
                return {'items': [{'name': '洪玉麟', 'open_id': 'ou_owner', 'tenant_key': 'tenant'}]}
        self.mobile = MobileFeishu(self.backend, self.tmp.name, accounts=PersonalAccounts())
        self.backend.mobile_feishu = self.mobile
        self.sid = 'personal-meeting'
        self.line = dict(id='u1', text='我明天发送方案。', start_ms=0, end_ms=1000, speaker='洪玉麟', tag='commitment')
        self.mobile.owners.reserve(self.sid, 'phone-a', False)
        self.backend.meetings.sync(dict(session_id=self.sid, started_at='2026-10-14T00:00:00Z', utterances=[self.line]))

    def request(self):
        contract = self.backend.sign_action_binding(binding_for(self.backend.meetings.load(self.sid), ['u1']))
        return {'op_id': 'personal-source-op', 'session_id': self.sid, 'draft': {'who': '洪玉麟', 'what': '发送方案'},
                'evidence': {'utterance_ids': ['u1'], 'quote': self.line['text'], 'source_binding': contract}}

    def test_signed_device_contract_and_personal_identity_create_one_journal(self):
        body = self.request()
        result = self.backend.confirm(body, personal='phone-a')
        self.assertEqual('created', result['status'])
        stored = self.backend.ops.load(body['op_id'])
        self.assertEqual('phone-a', stored['personal_binding']['principal_id'])
        self.assertEqual('ou_owner', stored['personal_binding']['assignee_open_id'])
        self.assertEqual(1, stored['attempts'])
        self.assertEqual(result, self.backend.confirm(body, personal='phone-a'))
        self.assertEqual(1, self.backend.ops.load(body['op_id'])['attempts'])

    def test_other_phone_cannot_reuse_a_signed_contract(self):
        with self.assertRaises(MobileError) as caught:
            self.backend.confirm(self.request(), personal='phone-b')
        self.assertEqual('MEETING_OWNER_MISMATCH', caught.exception.code)
        self.assertIsNone(self.backend.ops.load('personal-source-op'))

    def test_personal_binding_does_not_rescue_unsigned_or_changed_source(self):
        body = self.request()
        body['evidence'].pop('source_binding')
        with self.assertRaises(ApiError) as caught:
            self.backend.confirm(body, personal='phone-a')
        self.assertEqual('SOURCE_BINDING_REQUIRED', caught.exception.code)
        self.assertTrue(caught.exception.extra['no_external_write'])
        body = self.request()
        self.backend.meetings.sync(dict(session_id=self.sid, started_at='2026-10-14T00:00:00Z',
            utterances=[dict(self.line, text='改为下周发送。')]))
        with self.assertRaises(ApiError) as caught:
            self.backend.confirm(body, personal='phone-a')
        self.assertEqual('ACTION_SOURCE_CHANGED', caught.exception.code)
        self.assertIsNone(self.backend.ops.load('personal-source-op'))

    def test_personal_daily_receipt_still_requires_the_signed_short_evidence(self):
        req = dict(session_id='personal-daily', recording_mode='daily', utterances=[self.line])
        receipt = self.backend.daily_receipts.issue(req)
        self.mobile.bind_receipt('phone-a', receipt)
        contract = self.backend.sign_action_binding(self.backend.daily_receipts.binding(req))
        body = {'op_id': 'personal-daily-op', 'session_id': req['session_id'], 'source_receipt': receipt,
                'draft': {'who': '洪玉麟', 'what': '发送方案'}, 'evidence': {'utterance_ids': ['u1'],
                    'quote': self.line['text'], 'clip_start_ms': 0, 'clip_end_ms': 1000, 'source_binding': contract}}
        with self.assertRaises(MobileError):
            self.backend.confirm(body, personal='phone-b')
        self.assertEqual('created', self.backend.confirm(body, personal='phone-a')['status'])


if __name__ == '__main__':
    unittest.main()
