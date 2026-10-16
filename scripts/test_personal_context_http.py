"""Real HTTP routing with local identities and no provider/network side effects."""
import copy
import json
import os
import sqlite3
import tempfile
import threading
import types
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

from feishu_accounts import AccountError
from feishu_mobile import MobileFeishu
from local_backend import Handler, Backend
from meeting_features import Meetings


class ContextAccounts:
    def __init__(self, directory):
        self.lock = threading.RLock()
        self.lock_path = os.path.join(directory, 'test-accounts.lock')
        self.data = {'sessions': {}}
        for token, principal, open_id, revision in [('token-a', 'phone-a', 'ou_a', 2),
                ('token-a2', 'phone-a2', 'ou_a', 6), ('token-b', 'phone-b', 'ou_b', 2)]:
            self.data['sessions'][token] = dict(principal_id=principal, binding_revision=revision,
                status='bound', account=dict(tenant_key='tenant', open_id=open_id, name=open_id))

    def _readonly_snapshot(self):
        return copy.deepcopy(self.data)

    @staticmethod
    def _entry_for_principal(data, principal):
        entry = next((row for row in data['sessions'].values() if row['principal_id'] == principal), None)
        if entry is None:
            raise AccountError(401, 'OOPS_USER_UNAUTHORIZED', '个人会话已撤销')
        return entry

    @staticmethod
    def _status(entry):
        return copy.deepcopy(entry)

    def principal_readonly_snapshot(self, token):
        if token not in self.data['sessions']:
            raise AccountError(401, 'OOPS_USER_UNAUTHORIZED', '个人会话无效')
        return self.data['sessions'][token]['principal_id']

    def status_readonly_snapshot(self, token):
        self.principal_readonly_snapshot(token)
        return self._status(self.data['sessions'][token])


class PersonalContextHttpTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.accounts = ContextAccounts(self.tmp.name)
        self.meetings = Meetings(os.path.join(self.tmp.name, 'meetings'))
        self.backend = types.SimpleNamespace(feishu=None, meetings=self.meetings)
        self.mobile = MobileFeishu(self.backend, os.path.join(self.tmp.name, 'mobile'), self.accounts)
        self.backend.mobile_feishu = self.mobile
        self.line = dict(id='u1', text='本季度由我负责产品体验。', start_ms=0, end_ms=1000, tag='idea', speaker=None)
        self.meetings.sync(dict(session_id='meeting-a', started_at='2026-10-16T00:00:00Z', utterances=[self.line]))
        self.mobile.owners.reserve('meeting-a', 'phone-a', False)
        self.mobile.owners.check('meeting-a', 'phone-a', 'tenant:ou_a')
        class Protected(Handler):
            api_token = 'service-token'
        Protected.backend = self.backend
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Protected)
        self.worker = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.worker.start()
        self.addCleanup(self.stop_server)

    def stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.worker.join()

    def request(self, method, suffix='', body=None, token='token-a', service=True):
        headers = {'Authorization': 'Bearer service-token'} if service else {}
        if token is not None:
            headers['X-Oops-User-Token'] = token
        req = urllib.request.Request(f'http://127.0.0.1:{self.server.server_port}/v1/personal/context' + suffix,
            data=json.dumps(body).encode() if body is not None else None, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            with error:
                return error.code, json.load(error)

    @staticmethod
    def body(value, revision=0, operation='op-profile', **extra):
        return dict(dict(value=value, expected_revision=revision, op_id=operation, confirmed=True), **extra)

    def memory(self, source=None, operation='op-memory', identifier='memory-1'):
        return self.request('POST', '/memories', self.body(dict(title='角色背景', body='负责产品体验'),
            operation=operation, memory_id=identifier, source=source or {'kind': 'manual'}))

    def test_service_credential_alone_or_unbound_account_cannot_sync(self):
        self.assertEqual(401, self.request('GET', token=None)[0])
        self.assertEqual(401, self.request('GET', service=False)[0])
        self.accounts.data['sessions']['token-a']['status'] = 'unbound'
        code, value = self.request('POST', '/profile', self.body({'name': '不能保存'}))
        self.assertEqual(401, code)
        self.assertEqual('PERSONAL_CONTEXT_BINDING_REQUIRED', value['error']['code'])

    def test_same_account_cross_phone_profile_sync_and_other_account_isolation(self):
        code, saved = self.request('POST', '/profile', self.body(dict(name='本人', role='产品')))
        self.assertEqual(200, code)
        self.assertEqual(2, saved['identity_revision'])
        code, other_device = self.request('GET', token='token-a2')
        self.assertEqual(200, code)
        self.assertEqual(6, other_device['identity_revision'])
        self.assertEqual('本人', other_device['profile']['value']['name'])
        self.assertIsNone(self.request('GET', token='token-b')[1]['profile'])
        self.assertEqual([], self.request('GET', token='token-b')[1]['memories'])

    def test_write_conflict_replay_and_delete_round_trip(self):
        self.assertEqual(200, self.memory()[0])
        self.assertTrue(self.memory()[1]['replayed'])
        changed = self.body(dict(title='角色背景', body='新内容'), operation='different-op', memory_id='memory-1', source={'kind': 'manual'})
        code, value = self.request('POST', '/memories', changed, token='token-a2')
        self.assertEqual(409, code)
        self.assertEqual('PERSONAL_CONTEXT_REVISION_CONFLICT', value['error']['code'])
        deleted = self.request('POST', '/memories/delete', dict(op_id='delete-1', memory_id='memory-1', expected_revision=1))
        self.assertEqual(200, deleted[0])
        self.assertEqual('deleted', self.request('GET', token='token-a2')[1]['memories'][0]['status'])
        self.assertEqual('deleted', self.memory()[1]['item']['status'])

    def test_phone_source_visibility_is_not_granted_by_same_account_context(self):
        code, value = self.memory(dict(kind='meeting', session_id='meeting-a', utterance_ids=['u1']))
        self.assertEqual(200, code)
        self.assertEqual(self.mobile.context_service_id, value['item']['source']['service_id'])
        other_device = self.request('GET', token='token-a2')[1]['memories'][0]
        self.assertEqual('source_unavailable', other_device['status'])
        self.assertIsNone(other_device['value'])
        self.assertEqual('current', self.request('GET')[1]['memories'][0]['status'])
        self.mobile.owners.grant_read('meeting', 'meeting-a', 'phone-a2', 'explicit-test-owner')
        self.assertEqual('current', self.request('GET', token='token-a2')[1]['memories'][0]['status'])
        self.mobile.owners.revoke_read('meeting', 'meeting-a', 'phone-a2')
        self.assertIsNone(self.request('GET', token='token-a2')[1]['memories'][0]['value'])
        self.assertEqual('current', self.request('GET')[1]['memories'][0]['status'])

    def test_cannot_import_other_persons_meeting_or_a_foreign_service_source(self):
        source = dict(kind='meeting', session_id='meeting-a', utterance_ids=['u1'])
        body = self.body(dict(title='不属于我', body='不能导入'), operation='foreign-memory', memory_id='foreign', source=source)
        self.assertEqual(403, self.request('POST', '/memories', body, token='token-b')[0])
        code, value = self.memory(dict(source, service_id='different-service'))
        self.assertEqual(409, code)
        self.assertEqual('PERSONAL_CONTEXT_SOURCE_CHANGED', value['error']['code'])
        self.assertEqual([], self.request('GET')[1]['memories'])

    def test_original_edit_or_expiry_invalidates_derived_memory(self):
        self.assertEqual(200, self.memory(dict(kind='meeting', session_id='meeting-a', utterance_ids=['u1']))[0])
        self.meetings.sync(dict(session_id='meeting-a', utterances=[dict(self.line, text='我已不负责该项目。')]))
        memory = self.request('GET')[1]['memories'][0]
        self.assertEqual('needs_review', memory['status'])
        self.assertIsNone(memory['value'])
        source = dict(kind='meeting', session_id='meeting-a', utterance_ids=['u1'])
        self.assertEqual(200, self.memory(source, operation='second-memory', identifier='memory-2')[0])
        with self.meetings.lock:
            row = self.meetings.load('meeting-a')
            row['transcript_status'] = 'expired'
            self.meetings.write('meeting-a', row)
        self.assertEqual('needs_review', self.request('GET')[1]['memories'][1]['status'])

    def test_snapshot_is_bounded_private_and_disabled_until_person_enables_it(self):
        self.memory()
        self.assertFalse(self.request('POST', '/snapshot', {})[1]['enabled'])
        self.assertEqual(200, self.request('POST', '/preferences', self.body(dict(enabled=True, tone='先结论', avoid='不公开私人资料'), operation='op-preferences'))[0])
        code, snapshot = self.request('POST', '/snapshot', {'memory_ids': ['memory-1']})
        self.assertEqual(200, code)
        self.assertTrue(snapshot['enabled'])
        self.assertEqual(2, snapshot['identity_revision'])
        self.assertEqual('负责产品体验', snapshot['context']['memories'][0]['body'])
        self.assertEqual(404, self.request('POST', '/snapshot', {'memory_ids': ['memory-1']}, token='token-b')[0])
        self.assertNotIn('account_key', json.dumps(snapshot))

    def test_account_switch_and_revocation_during_request_never_return_old_persons_body(self):
        self.request('POST', '/profile', self.body({'name': '甲的私人背景'}))
        original = self.mobile.personal_context.principal_guard
        calls = 0
        def switch(principal):
            nonlocal calls
            calls += 1
            if calls == 2:
                self.accounts.data['sessions']['token-a'].update(binding_revision=3,
                    account=dict(tenant_key='tenant', open_id='ou_b', name='乙'))
            return original(principal)
        self.mobile.personal_context.principal_guard = switch
        code, value = self.request('GET')
        self.assertEqual(409, code)
        self.assertNotIn('甲的私人背景', json.dumps(value, ensure_ascii=False))
        self.mobile.personal_context.principal_guard = original
        self.assertIsNone(self.request('GET')[1]['profile'])
        self.accounts.data['sessions'].pop('token-a')
        self.assertEqual(401, self.request('GET')[0])

    def test_query_identity_injection_and_wrong_methods_are_rejected(self):
        self.assertEqual(400, self.request('GET', '?principal=phone-b')[0])
        self.assertEqual(400, self.request('POST', '/profile', self.body({'name': '人'}, principal='phone-b'))[0])
        self.assertEqual(405, self.request('POST', '', {})[0])
        self.assertEqual(405, self.request('GET', '/profile')[0])
        self.assertEqual(400, self.request('POST', '/snapshot', [])[0])
        self.assertEqual(400, self.request('POST', '/snapshot', ['invalid'])[0])

    def test_busy_account_operation_fails_fast_and_same_operation_can_retry(self):
        acquired, release = threading.Event(), threading.Event()
        def hold_account():
            with self.accounts.lock:
                acquired.set()
                release.wait(3)
        worker = threading.Thread(target=hold_account)
        worker.start()
        self.assertTrue(acquired.wait(1))
        try:
            code, value = self.memory()
            self.assertEqual(409, code)
            self.assertEqual('PERSONAL_CONTEXT_IDENTITY_BUSY', value['error']['code'])
        finally:
            release.set()
            worker.join()
        code, value = self.memory()
        self.assertEqual(200, code)
        self.assertEqual(1, value['item']['revision'])
        self.assertFalse(value['replayed'])

    def test_background_ttl_hook_purges_derived_text_without_user_read_or_live_session(self):
        self.memory(dict(kind='meeting', session_id='meeting-a', utterance_ids=['u1']))
        self.memory(operation='manual-op', identifier='manual-memory')
        row = self.meetings.load('meeting-a')
        row['transcript_status'] = 'expired'
        self.meetings.write('meeting-a', row)
        self.accounts.data['sessions'].pop('token-a')
        self.backend.recordings = types.SimpleNamespace(cleanup=lambda: 0)
        self.backend.prune_transient_caches = lambda: None
        Backend.cleanup_storage(self.backend)
        with sqlite3.connect(self.mobile.personal_context.path) as db:
            entries = dict(db.execute("SELECT id,value FROM entries WHERE kind='memory'").fetchall())
        self.assertEqual('{}', entries['memory-1'])
        self.assertIn('负责产品体验', entries['manual-memory'])
        self.assertEqual('needs_review', self.request('GET', token='token-a2')[1]['memories'][1]['status'])

    def test_service_uuid_persists_is_private_and_distinguishes_services(self):
        directory = os.path.join(self.tmp.name, 'mobile')
        again = MobileFeishu(self.backend, directory, self.accounts)
        separate = MobileFeishu(self.backend, os.path.join(self.tmp.name, 'other-mobile'), self.accounts)
        self.assertEqual(self.mobile.context_service_id, again.context_service_id)
        self.assertNotEqual(self.mobile.context_service_id, separate.context_service_id)
        self.assertEqual(0o600, os.stat(os.path.join(directory, 'personal-context-service-id')).st_mode & 0o777)
        self.assertEqual(0o700, os.stat(directory).st_mode & 0o777)
        linked = os.path.join(self.tmp.name, 'linked-mobile')
        os.mkdir(linked)
        os.symlink(os.path.join(directory, 'personal-context-service-id'), os.path.join(linked, 'personal-context-service-id'))
        from feishu_mobile import MobileError
        with self.assertRaises(MobileError):
            MobileFeishu(self.backend, linked, self.accounts)

    def test_person_memory_wire_preserves_manual_label_and_stable_ids(self):
        def body(person_id, operation, memory_id):
            return self.body(dict(title='交流偏好', body='先给摘要', category='person', person_id=person_id,
                person_name='同名同事', person_kind='preference'), operation=operation,
                memory_id=memory_id, source={'kind': 'manual'})
        first = self.request('POST', '/memories', body('person-a', 'save-person-a', 'person-memory-a'))
        second = self.request('POST', '/memories', body('person-b', 'save-person-b', 'person-memory-b'))
        self.assertEqual(200, first[0]); self.assertEqual(200, second[0])
        self.assertEqual({'kind': 'manual'}, first[1]['item']['source'])
        items = self.request('GET', token='token-a2')[1]['memories']
        self.assertEqual(['person-a', 'person-b'], [item['value']['person_id'] for item in items])
        self.assertEqual([], self.request('GET', token='token-b')[1]['memories'])
        self.request('POST', '/preferences', self.body(dict(enabled=True), operation='enable-person-memory'))
        absent = self.request('POST', '/snapshot', dict(memory_ids=['person-memory-a']))
        self.assertEqual(200, absent[0])
        self.assertEqual([], absent[1]['context']['memories'])
        chosen = self.request('POST', '/snapshot', dict(person_id='person-a', scenario='通用'))
        self.assertEqual(200, chosen[0])
        self.assertEqual('person-a', chosen[1]['person_id'])
        self.assertEqual(['person-a'], [item['person_id'] for item in chosen[1]['context']['memories']])
        code, mismatch = self.request('POST', '/snapshot', dict(person_id='person-b', memory_ids=['person-memory-a']))
        self.assertEqual(409, code)
        self.assertEqual('PERSONAL_CONTEXT_PERSON_MISMATCH', mismatch['error']['code'])

    def test_person_quote_is_rejected_and_person_metadata_cannot_hide_in_self_memory(self):
        value = dict(title='人物事实', body='手工记下的信息', category='person', person_id='person-a', person_name='甲', person_kind='fact')
        body = self.body(value, operation='person-quote', memory_id='person-quote',
            source=dict(kind='meeting', session_id='meeting-a', utterance_ids=['u1']))
        code, error = self.request('POST', '/memories', body)
        self.assertEqual(409, code)
        self.assertEqual('PERSON_IDENTITY_UNVERIFIED', error['error']['code'])
        body['source'] = {'kind': 'manual'}
        body['value']['category'] = 'background'
        self.assertEqual(400, self.request('POST', '/memories', body)[0])


if __name__ == '__main__':
    unittest.main()
