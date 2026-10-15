"""Personal calendar journal regressions. All provider requests use this fake."""
import copy
import json
import os
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from calendar_delivery import CalendarDelivery, CalendarError
from feishu_accounts import Accounts as RealAccounts


class ApiError(Exception):
    def __init__(self, uncertain=False, code='FAKE_REJECTION'):
        self.uncertain, self.code = uncertain, code


class Accounts:
    def __init__(self):
        self.revision = 1
        self.account = {'open_id': 'ou_a', 'tenant_key': 'tenant'}
        self.capabilities = {'calendar_create': True, 'calendar_read': True,
            'calendar_delivery': True, 'calendar_invite': True}
        self.calls, self.events, self.invited = [], {}, []
        self.hook = None
        self.presubmit_hook = None
        self.names = {'ou_a': 'Alice', 'ou_b': 'Bob', 'ou_c': 'Carol'}
        self.bound = True

    def principal_readonly_snapshot(self, token):
        if token not in ('phone-a', 'phone-b'):
            raise ApiError(False, 'NO_PERSONAL_IDENTITY')
        return token.replace('phone-', 'person-')

    def status_readonly_snapshot(self, token):
        self.principal_readonly_snapshot(token)
        return dict(status='bound' if self.bound else 'expired', binding_revision=self.revision,
            account=self.account.copy(), capabilities=self.capabilities.copy())

    def validate_recipients(self, token, ids, expected_names=None):
        self.principal_readonly_snapshot(token)
        if any(uid not in self.names for uid in ids):
            raise CalendarError(403, 'RECIPIENTS_UNVERIFIED', '未知或跨组织参与人')
        if expected_names is not None and expected_names != {uid: self.names[uid] for uid in ids}:
            raise CalendarError(409, 'RECIPIENTS_CHANGED', '已核对的参与人姓名已变化')
        return ids[:]

    def recipient_identities(self, token, ids):
        self.validate_recipients(token, ids)
        return {uid: self.names[uid] for uid in ids}

    def user_request_for_principal(self, principal, method, path, body=None, params=None,
                                   expected_binding=None, expected_recipients=None, expected_recipient_names=None,
                                   before_request=None):
        actual = dict(binding_revision=self.revision, account_open_id=self.account['open_id'], tenant_key=self.account['tenant_key'])
        if expected_binding != actual or not self.bound:
            raise ApiError(False, 'FEISHU_BINDING_CHANGED')
        if expected_recipients is not None:
            self.validate_recipients(principal.replace('person-', 'phone-'), expected_recipients, expected_recipient_names)
        if self.presubmit_hook:
            self.presubmit_hook(method, path)
        if before_request:
            before_request()
        self.calls.append((method, path, copy.deepcopy(body), copy.deepcopy(params), copy.deepcopy(expected_recipients)))
        if self.hook:
            result = self.hook(method, path, body, params)
            if result is not None:
                return result
        data = {}
        if path.endswith('/primary'):
            data = {'calendars': [{'calendar': {'calendar_id': 'primary-a', 'type': 'primary'}}]}
        elif path.endswith('/events') and method == 'POST':
            event = dict(copy.deepcopy(body), event_id='event_1', organizer_calendar_id='primary-a',
                app_link='https://applink.feishu.cn/client/calendar/event/detail?key=event_1')
            self.events['event_1'] = event
            data = {'event': copy.deepcopy(event)}
        elif path.endswith('/attendees'):
            if method == 'POST':
                self.invited = [a['user_id'] for a in body['attendees']]
            data = {'items': [{'user_id': uid, 'type': 'user', 'rsvp_status': 'needs_action'} for uid in self.invited]}
        elif method == 'GET' and '/events/' in path:
            data = {'event': copy.deepcopy(self.events.get(path.rsplit('/', 1)[-1]) or {})}
        return {'code': 0, 'data': data}


class CalendarTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.auth = Accounts()
        self.rows = {'m1': dict(session_id='m1', ended_at='2026-10-14T10:00:00Z', time_zone='Asia/Shanghai',
            fingerprint='source-1', utterances=[{'id': 'u1', 'text': '周五下午三点一起核对方案'}],
            delivery_analysis={'follow_ups': [dict(title='方案核对', start='2026-10-16T15:00:00+08:00',
                minutes=30, ids=['u1'], attendees=['甲', '乙'], quote='周五下午三点一起核对方案')]})}
        self.owners = {'m1': 'person-a', 'm2': 'person-a'}
        self.delivery = self.new_delivery()

    def new_delivery(self):
        return CalendarDelivery(self.tmp.name, self.auth, lambda sid: self.rows[sid],
            lambda row: row['fingerprint'], owner_fn=lambda sid, principal: self.owners.get(sid) == principal)

    def review(self, attendees=None, followup_id='manual'):
        draft = self.delivery.prepare('phone-a', 'm1', followup_id)['draft']
        return self.delivery.save_review('phone-a', 'm1', dict(revision=draft['revision'], title='核对后的安排',
            description='只讨论已确认事项', start='2026-10-16T15:00:00+08:00', end='2026-10-16T15:30:00+08:00',
            time_zone='Asia/Shanghai', attendees=[] if attendees is None else attendees), followup_id)['draft']

    @staticmethod
    def body(draft, op_id='calendar-operation-1'):
        return dict(revision=draft['revision'], op_id=op_id, confirmed=True)

    def confirm(self, draft, op_id='calendar-operation-1', followup_id='manual'):
        return self.delivery.confirm('phone-a', 'm1', self.body(draft, op_id), followup_id)

    def posts(self, suffix):
        return [call for call in self.auth.calls if call[0] == 'POST' and call[1].endswith(suffix)]

    def test_prepare_is_private_and_never_preselects_suggested_people(self):
        value = self.delivery.prepare('phone-a', 'm1')
        self.assertEqual([], value['draft']['attendees'])
        self.assertFalse(value['draft']['reviewed'])
        self.assertEqual(['甲', '乙'], value['suggestions'][0]['attendee_hints'])
        fid = value['suggestions'][0]['followup_id']
        selected = self.delivery.prepare('phone-a', 'm1', fid)['draft']
        self.assertEqual(['u1'], selected['evidence_ids'])
        self.assertEqual([], selected['attendees'])
        self.assertEqual('2026-10-16T15:30:00+08:00', selected['end'])
        self.assertEqual([], self.auth.calls)

    def test_unknown_followup_cannot_be_fabricated_by_client(self):
        with self.assertRaises(CalendarError):
            self.delivery.prepare('phone-a', 'm1', 'fu-invented')
        self.rows['m1']['delivery_analysis']['follow_ups'][0]['ids'] = ['missing']
        self.rows['m1']['delivery_analysis']['follow_ups'][0]['quote'] = 'not present'
        self.assertEqual([], self.delivery.prepare('phone-a', 'm1')['suggestions'])

    def test_requires_personal_identity_ownership_and_bound_account(self):
        with self.assertRaises(ApiError):
            self.delivery.prepare('shared-service-token', 'm1')
        with self.assertRaises(CalendarError) as caught:
            self.delivery.prepare('phone-b', 'm1')
        self.assertEqual(403, caught.exception.status)
        self.auth.bound = False
        with self.assertRaises(CalendarError):
            self.delivery.prepare('phone-a', 'm1')
        self.assertEqual([], self.auth.calls)

    def test_confirm_requires_saved_review_and_explicit_confirmation(self):
        draft = self.delivery.prepare('phone-a', 'm1')['draft']
        with self.assertRaises(CalendarError):
            self.confirm(draft)
        draft = self.review()
        body = self.body(draft)
        body['confirmed'] = False
        with self.assertRaises(CalendarError):
            self.delivery.confirm('phone-a', 'm1', body)
        self.assertEqual([], self.auth.calls)

    def test_save_validates_explicit_audience_and_timezone(self):
        draft = self.review()
        valid = dict(revision=draft['revision'], title='安排', description='', start='2026-10-16T15:00:00+08:00',
            end='2026-10-16T15:30:00+08:00', time_zone='Asia/Shanghai', attendees=[])
        variants = [{'attendees': None}, {'attendees': ['ou_unknown']}, {'start': '2026-10-16T15:00:00'},
            {'time_zone': 'not/a/zone'}, {'time_zone': 'UTC'}, {'end': '2026-10-16T14:00:00+08:00'},
            {'end': '2026-10-25T14:00:00+08:00'}, {'title': ''}, {'description': 'x' * 2001}]
        for change in variants:
            with self.subTest(change=list(change)):
                with self.assertRaises(CalendarError):
                    self.delivery.save_review('phone-a', 'm1', dict(valid, **change))

    def test_dst_offset_must_match_named_zone_and_nonexistent_local_time_is_rejected(self):
        draft = self.review()
        body = dict(revision=draft['revision'], title='DST核对', description='',
            start='2026-07-15T15:00:00-08:00', end='2026-07-15T15:30:00-08:00',
            time_zone='America/Los_Angeles', attendees=[])
        with self.assertRaises(CalendarError):  # July is UTC-7, not standard time
            self.delivery.save_review('phone-a', 'm1', body)
        body.update(start='2026-03-08T02:10:00-08:00', end='2026-03-08T02:40:00-08:00')
        with self.assertRaises(CalendarError):  # this wall time does not exist at spring-forward
            self.delivery.save_review('phone-a', 'm1', body)
        body.update(start='2026-07-15T15:00:00-07:00', end='2026-07-15T15:30:00-07:00')
        result = self.delivery.save_review('phone-a', 'm1', body)
        self.assertEqual('2026-07-15T15:00:00-07:00', result['draft']['start'])

    def test_dst_fall_back_uses_the_explicit_offset_instead_of_guessing_fold(self):
        draft = self.review()
        result = self.delivery.save_review('phone-a', 'm1', dict(revision=draft['revision'], title='秋季回拨', description='',
            start='2026-11-01T01:10:00-08:00', end='2026-11-01T01:40:00-08:00',
            time_zone='America/Los_Angeles', attendees=[]))
        self.confirm(result['draft'])
        body = self.posts('/events')[0][2]
        self.assertEqual('1793524200', body['start_time']['timestamp'])

    def test_success_always_reads_event_even_when_create_returns_a_link(self):
        draft = self.review()
        seen = []
        def hook(method, path, body, params):
            if method == 'POST' and path.endswith('/events'):
                state = self.delivery._read('person-a')
                op = state['operations']['calendar-operation-1']
                seen.append(op['create_step'])
                self.assertEqual('核对后的安排', op['draft']['title'])
        self.auth.hook = hook
        result = self.confirm(draft)
        self.assertEqual('created', result['status'])
        self.assertEqual('event_1', result['event_id'])
        self.assertTrue(result['event_verified'])
        self.assertEqual(['pending'], seen)
        self.assertEqual(1, len(self.posts('/events')))
        self.assertEqual(1, sum(c[0] == 'GET' and c[1].endswith('/events/event_1') for c in self.auth.calls))
        self.assertEqual([], self.posts('/attendees'))
        self.assertFalse(self.posts('/events')[0][2]['need_notification'])
        self.assertGreaterEqual(len(self.posts('/events')[0][3]['idempotency_key']), 32)

    def test_missing_event_id_is_unknown_and_never_replayed_even_after_restart(self):
        draft = self.review()
        self.auth.hook = lambda method, path, body, params: {'code': 0, 'data': {'event': {'app_link': 'https://applink.feishu.cn/whatever'}}} if path.endswith('/events') else None
        self.assertEqual('unknown', self.confirm(draft)['status'])
        self.delivery = self.new_delivery()
        self.assertEqual('unknown', self.confirm(draft, 'new-operation-id')['status'])
        self.assertEqual(1, len(self.posts('/events')))

    def test_uncertain_create_never_replays(self):
        draft = self.review()
        def hook(method, path, body, params):
            if path.endswith('/events'):
                raise ApiError(True)
        self.auth.hook = hook
        self.assertEqual('unknown', self.confirm(draft)['status'])
        self.auth.hook = None
        self.assertEqual('unknown', self.confirm(draft)['status'])
        self.assertEqual(1, len(self.posts('/events')))

    def test_known_rejection_can_retry_only_original_frozen_operation(self):
        draft = self.review()
        def hook(method, path, body, params):
            if path.endswith('/events'):
                raise ApiError(False)
        self.auth.hook = hook
        self.assertEqual('failed', self.confirm(draft)['status'])
        self.auth.hook = None
        self.assertEqual('created', self.confirm(draft)['status'])
        self.assertEqual(2, len(self.posts('/events')))
        self.assertEqual(self.posts('/events')[0][3], self.posts('/events')[1][3])

    def test_known_event_id_is_durable_before_read_and_only_get_resumes(self):
        draft = self.review()
        def hook(method, path, body, params):
            if method == 'GET' and path.endswith('/events/event_1'):
                op = self.delivery._read('person-a')['operations']['calendar-operation-1']
                self.assertEqual('event_1', op['event_id'])
                raise ApiError(False, 'READ_FAILED')
        self.auth.hook = hook
        result = self.confirm(draft)
        self.assertEqual('created_unverified', result['status'])
        self.assertFalse(result['event_verified'])
        self.delivery = self.new_delivery()
        self.auth.hook = None
        result = self.confirm(draft)
        self.assertEqual('created', result['status'])
        self.assertEqual(1, len(self.posts('/events')))

    def test_crash_after_receiving_id_does_not_repeat_create(self):
        draft = self.review()
        def hook(method, path, body, params):
            if method == 'GET' and '/events/' in path:
                raise SystemExit('simulated process loss')
        self.auth.hook = hook
        with self.assertRaises(SystemExit):
            self.confirm(draft)
        self.delivery = self.new_delivery()
        self.auth.hook = None
        self.assertEqual('created', self.confirm(draft)['status'])
        self.assertEqual(1, len(self.posts('/events')))

    def test_persisted_pending_create_is_unknown_after_process_loss(self):
        draft = self.review()
        principal, op = self.delivery._reserve('phone-a', 'm1', self.body(draft), 'manual')
        with self.delivery._state(principal) as (state, save):
            state['operations'][op['op_id']].update(status='creating', create_step='pending')
            save()
        self.delivery = self.new_delivery()
        self.assertEqual('unknown', self.delivery.status('phone-a', 'm1')['calendar']['status'])
        self.assertEqual('unknown', self.confirm(draft)['status'])
        self.assertEqual([], self.auth.calls)

    def test_persisted_queue_before_any_write_can_resume_after_process_loss(self):
        draft = self.review()
        self.delivery._reserve('phone-a', 'm1', self.body(draft), 'manual')
        self.delivery = self.new_delivery()
        self.assertEqual('failed', self.delivery.status('phone-a', 'm1')['calendar']['status'])
        self.assertEqual('created', self.confirm(draft)['status'])
        self.assertEqual(1, len(self.posts('/events')))

    def test_wrong_readback_is_not_success_and_does_not_recreate(self):
        draft = self.review()
        for change in ({'event_id': 'other'}, {'summary': 'wrong'}, {'description': 'wrong'}, {'start_time': {'timestamp': '1'}},
                       {'organizer_calendar_id': 'another'}, {'status': 'cancelled'}):
            with self.subTest(change=list(change)):
                def hook(method, path, body, params):
                    if method == 'GET' and path.endswith('/events/event_1'):
                        return {'code': 0, 'data': {'event': dict(self.auth.events['event_1'], **change)}}
                self.auth.hook = hook
                self.assertEqual('created_unverified', self.confirm(draft)['status'])
        self.auth.hook = None
        self.assertEqual('created', self.confirm(draft)['status'])
        self.assertEqual(1, len(self.posts('/events')))

    def test_only_confirmed_attendees_are_invited_and_read_back(self):
        draft = self.review(['ou_b'])
        body = dict(self.body(draft), attendees=['ou_c'], title='client substitution')
        result = self.delivery.confirm('phone-a', 'm1', body)
        self.assertEqual('created', result['status'])
        self.assertTrue(result['invitations_verified'])
        invite = self.posts('/attendees')[0]
        self.assertEqual([{'type': 'user', 'user_id': 'ou_b'}], invite[2]['attendees'])
        self.assertFalse(invite[2]['add_operator_to_attendee'])
        self.assertEqual(['ou_b'], invite[4])
        self.assertEqual('核对后的安排', self.posts('/events')[0][2]['summary'])

    def test_uncertain_invite_recovers_only_by_reading_original_event(self):
        draft = self.review(['ou_b'])
        def hook(method, path, body, params):
            if method == 'POST' and path.endswith('/attendees'):
                self.auth.invited = ['ou_b']  # provider accepted it but response was lost
                raise ApiError(True)
        self.auth.hook = hook
        self.assertEqual('invitation_unknown', self.confirm(draft)['status'])
        self.delivery = self.new_delivery()
        self.auth.hook = None
        self.assertEqual('created', self.confirm(draft)['status'])
        self.assertEqual(1, len(self.posts('/events')))
        self.assertEqual(1, len(self.posts('/attendees')))

    def test_definite_invite_rejection_resumes_original_operation_without_new_event(self):
        draft = self.review(['ou_b'])
        def hook(method, path, body, params):
            if method == 'POST' and path.endswith('/attendees'):
                raise ApiError(False, 'DEFINITE_INVITE_REJECTED')
        self.auth.hook = hook
        first = self.confirm(draft)
        self.assertEqual('created_unverified', first['status'])
        self.assertTrue(first['event_verified'])
        self.assertFalse(first['invitations_verified'])
        state = self.delivery._read('person-a')
        self.assertEqual('failed', state['operations'][first['op_id']]['invite_step'])
        self.delivery = self.new_delivery()
        self.auth.hook = None
        second = self.confirm(draft, 'replacement-click-id')
        self.assertEqual('created', second['status'])
        self.assertEqual(first['op_id'], second['op_id'])
        self.assertEqual(first['event_id'], second['event_id'])
        self.assertEqual(1, len(self.posts('/events')))
        self.assertEqual(2, len(self.posts('/attendees')))
        self.assertEqual(self.posts('/attendees')[0][2], self.posts('/attendees')[1][2])
        self.assertEqual(1, len(self.delivery._read('person-a')['operations']))

    def test_definite_invite_readback_failure_does_not_reset_successful_write(self):
        draft = self.review(['ou_b'])
        def hook(method, path, body, params):
            if method == 'GET' and path.endswith('/attendees'):
                raise ApiError(False, 'DEFINITE_READ_REJECTED')
        self.auth.hook = hook
        first = self.confirm(draft)
        self.assertEqual('invitation_unknown', first['status'])
        self.assertEqual('done', self.delivery._read('person-a')['operations'][first['op_id']]['invite_step'])
        self.auth.hook = None
        second = self.confirm(draft)
        self.assertEqual('created', second['status'])
        self.assertEqual(1, len(self.posts('/events')))
        self.assertEqual(1, len(self.posts('/attendees')))

    def test_unknown_invite_without_verified_attendees_is_never_sent_again(self):
        draft = self.review(['ou_b'])
        def hook(method, path, body, params):
            if method == 'POST' and path.endswith('/attendees'):
                raise ApiError(True)
        self.auth.hook = hook
        self.assertEqual('invitation_unknown', self.confirm(draft)['status'])
        self.auth.hook = None
        self.assertEqual('invitation_unknown', self.confirm(draft)['status'])
        self.assertEqual(1, len(self.posts('/attendees')))

    def test_same_version_with_different_operation_id_returns_original_receipt(self):
        draft = self.review()
        first = self.confirm(draft)
        second = self.confirm(draft, 'different-operation-id')
        self.assertEqual(first['op_id'], second['op_id'])
        self.assertEqual(1, len(self.posts('/events')))
        with self.assertRaises(CalendarError):
            self.delivery.confirm('phone-a', 'm1', dict(self.body(draft), revision=99))
        with self.assertRaises(CalendarError):
            self.delivery.save_review('phone-a', 'm1', dict(revision=draft['revision']))

    def test_source_and_binding_changes_revoke_new_writes(self):
        draft = self.review()
        self.rows['m1']['fingerprint'] = 'changed'
        with self.assertRaises(CalendarError):
            self.confirm(draft)
        self.rows['m1']['fingerprint'] = 'source-1'
        self.auth.revision = 2
        with self.assertRaises(CalendarError):
            self.confirm(draft)
        self.assertEqual([], self.auth.calls)

    def test_change_after_creation_prevents_inviting(self):
        draft = self.review(['ou_b'])
        def hook(method, path, body, params):
            if method == 'GET' and path.endswith('/events/event_1'):
                self.rows['m1']['fingerprint'] = 'source-changed-mid-operation'
        self.auth.hook = hook
        result = self.confirm(draft)
        self.assertEqual('created_unverified', result['status'])
        self.assertTrue(result['event_verified'])
        self.assertEqual([], self.posts('/attendees'))

    def test_account_swap_after_calendar_lookup_never_creates(self):
        draft = self.review()
        def hook(method, path, body, params):
            if path.endswith('/primary'):
                self.auth.revision = 2
        self.auth.hook = hook
        self.assertEqual('failed', self.confirm(draft)['status'])
        self.assertEqual([], self.posts('/events'))

    def test_permissions_require_readback_and_invitation_separately(self):
        draft = self.review()
        self.auth.capabilities['calendar_delivery'] = False
        with self.assertRaises(CalendarError):
            self.confirm(draft)
        self.assertEqual([], self.auth.calls)
        self.auth.capabilities['calendar_delivery'] = True
        draft = self.review(['ou_b'])
        self.auth.capabilities['calendar_invite'] = False
        with self.assertRaises(CalendarError):
            self.confirm(draft)
        self.assertEqual([], self.auth.calls)

    def test_saved_attendee_names_are_server_derived_and_frozen(self):
        draft = self.review(['ou_b'])
        self.assertEqual({'ou_b': 'Bob'}, draft['attendee_names'])
        self.confirm(draft)
        op = self.delivery._read('person-a')['operations']['calendar-operation-1']
        self.assertEqual({'ou_b': 'Bob'}, op['draft']['attendee_names'])

    def test_renamed_or_unverified_attendee_invalidates_saved_confirmation(self):
        draft = self.review(['ou_b'])
        self.auth.names['ou_b'] = 'Renamed Bob'
        with self.assertRaises(CalendarError) as caught:
            self.confirm(draft)
        self.assertEqual('RECIPIENTS_CHANGED', caught.exception.code)
        self.auth.names.pop('ou_b')
        with self.assertRaises(CalendarError) as caught:
            self.confirm(draft)
        self.assertEqual('RECIPIENTS_UNVERIFIED', caught.exception.code)
        self.assertEqual([], self.auth.calls)

    def test_every_calendar_step_rechecks_frozen_attendee_name(self):
        draft = self.review(['ou_b'])
        def hook(method, path, body, params):
            if path.endswith('/primary'):
                self.auth.names['ou_b'] = 'Renamed after lookup'
        self.auth.hook = hook
        result = self.confirm(draft)
        self.assertEqual('failed', result['status'])
        self.assertEqual('RECIPIENTS_CHANGED', result['reason'])
        self.assertEqual([], self.posts('/events'))

    def test_source_withdrawn_while_waiting_on_accounts_is_checked_before_http(self):
        draft = self.review(['ou_b'])
        self.auth.presubmit_hook = lambda method, path: self.rows['m1'].update(fingerprint='withdrawn-during-search')
        result = self.confirm(draft)
        self.assertEqual('failed', result['status'])
        self.assertEqual('CALENDAR_SOURCE_CHANGED', result['reason'])
        self.assertEqual([], self.auth.calls)  # not even the primary-calendar HTTP was submitted

    def test_source_withdrawn_before_invite_http_preserves_event_and_does_not_invite(self):
        draft = self.review(['ou_b'])
        def wait(method, path):
            if method == 'POST' and path.endswith('/attendees'):
                self.rows['m1']['fingerprint'] = 'withdrawn-while-locking-invite'
        self.auth.presubmit_hook = wait
        result = self.confirm(draft)
        self.assertEqual('created_unverified', result['status'])
        self.assertTrue(result['event_verified'])
        self.assertEqual([], self.posts('/attendees'))

    def test_status_and_repeat_confirm_stay_responsive_during_provider_write(self):
        draft = self.review()
        entered, release = threading.Event(), threading.Event()
        def hook(method, path, body, params):
            if method == 'POST' and path.endswith('/events'):
                entered.set()
                release.wait(3)
        self.auth.hook = hook
        self.delivery.confirm_async('phone-a', 'm1', self.body(draft))
        self.assertTrue(entered.wait(1))
        try:
            started = time.monotonic()
            status = self.delivery.status('phone-a', 'm1')
            repeated = self.delivery.confirm_async('phone-a', 'm1', self.body(draft, 'duplicate-operation-id'))
            self.assertLess(time.monotonic() - started, 0.3)
            self.assertEqual('creating', status['calendar']['status'])
            self.assertEqual('calendar-operation-1', repeated['op_id'])
        finally:
            release.set()
        for worker in list(self.delivery.workers.values()):
            worker.join(2)
        self.assertEqual('created', self.delivery.status('phone-a', 'm1')['calendar']['status'])
        self.assertEqual(1, len(self.posts('/events')))

    def test_two_instances_share_persistent_lock_and_do_not_double_create(self):
        draft = self.review()
        other = self.new_delivery()
        threads = [threading.Thread(target=lambda d=d: d.confirm('phone-a', 'm1', self.body(draft))) for d in (self.delivery, other)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(2)
            self.assertFalse(thread.is_alive())
        self.assertEqual(1, len(self.posts('/events')))

    def test_worker_start_failure_leaves_durable_safe_retry_receipt(self):
        draft = self.review()
        with patch('calendar_delivery.threading.Thread.start', side_effect=RuntimeError('cannot start')):
            with self.assertRaises(CalendarError):
                self.delivery.confirm_async('phone-a', 'm1', self.body(draft))
        result = self.delivery.status('phone-a', 'm1')['calendar']
        self.assertEqual('failed', result['status'])
        self.assertEqual([], self.auth.calls)
        self.assertEqual('created', self.confirm(draft)['status'])
        self.assertEqual(1, len(self.posts('/events')))

    def test_status_does_not_call_provider_and_hides_expired_source_content(self):
        draft = self.review()
        self.confirm(draft)
        calls = len(self.auth.calls)
        self.rows['m1']['transcript_status'] = 'expired'
        result = self.delivery.status('phone-a', 'm1')
        self.assertIsNone(result['draft'])
        self.assertEqual('source_changed', result['calendar']['source_status'])
        self.assertEqual(calls, len(self.auth.calls))

    def test_invalidation_purges_text_but_preserves_historical_success_receipt(self):
        draft = self.review()
        self.confirm(draft)
        self.delivery.invalidate('m1', 'source_expired', purge_content=True)
        state = self.delivery._read('person-a')
        op = state['operations']['calendar-operation-1']
        self.assertEqual('created', op['status'])
        self.assertEqual('event_1', op['event_id'])
        self.assertEqual('', op['draft']['title'])
        self.assertEqual('', op['draft']['description'])
        self.assertEqual('source_expired', op['source_status'])

    def test_untrusted_links_are_not_invented_or_forwarded(self):
        draft = self.review()
        def hook(method, path, body, params):
            if method == 'GET' and path.endswith('/events/event_1'):
                return {'code': 0, 'data': {'event': dict(self.auth.events['event_1'], app_link='https://evil.test/event')}}
        self.auth.hook = hook
        result = self.confirm(draft)
        self.assertEqual('created', result['status'])
        self.assertIsNone(result['event_url'])

    def test_journal_has_private_modes_and_no_opaque_session_token(self):
        draft = self.review()
        self.confirm(draft)
        path = self.delivery._path('person-a')
        self.assertEqual(0o600, os.stat(path).st_mode & 0o777)
        self.assertEqual(0o600, os.stat(path + '.lock').st_mode & 0o777)
        with open(path, encoding='utf-8') as source:
            text = source.read()
        self.assertNotIn('phone-a', text)
        self.assertNotIn('access_token', text)


class CalendarCapabilities(unittest.TestCase):
    def capabilities(self, scopes):
        class Probe(RealAccounts):
            @property
            def available(self):
                return True

            def _binding_status(self, entry):
                return 'bound'

            def _unseal(self, value):
                return {'scopes': scopes}
        obj = Probe.__new__(Probe)
        return obj._status({'principal_id': 'person-a', 'binding_revision': 1, 'account': {}, 'credentials': ''})['capabilities']

    def test_create_scope_alone_does_not_claim_verified_calendar_delivery(self):
        caps = self.capabilities(['calendar:calendar.event:create'])
        self.assertTrue(caps['calendar_create'])
        self.assertFalse(caps['calendar_delivery'])
        self.assertFalse(caps['calendar_read'])
        self.assertFalse(caps['calendar_invite'])

    def test_create_plus_read_supports_personal_only_event_not_invitation(self):
        caps = self.capabilities(['calendar:calendar.event:create', 'calendar:calendar:readonly'])
        self.assertTrue(caps['calendar_delivery'])
        self.assertFalse(caps['calendar_invite'])

    def test_existing_broad_calendar_scope_supports_full_flow(self):
        caps = self.capabilities(['calendar:calendar'])
        for key in ('calendar_create', 'calendar_read', 'calendar_invite', 'calendar_delivery'):
            self.assertTrue(caps[key])


if __name__ == '__main__':
    unittest.main()
