"""Two real HTTP principals; fixture stores only, no model or Feishu calls."""
import copy
import hashlib
import json
import os
from pathlib import Path
import tempfile
import threading
import types
import unittest
import urllib.error
import urllib.parse
import urllib.request
from http.server import ThreadingHTTPServer
from unittest import mock

from action_sources import DailyReceipts
from feishu_accounts import AccountError
from feishu_mobile import MobileFeishu, MobileError
from local_backend import Backend, Handler, Operations, TEAM, overlap
from meeting_features import Meetings
import minutes_items
from recordings import Recordings


class Accounts:
    def principal(self, token):
        if token not in ('phone-a', 'phone-b'):
            raise AccountError(401, 'PERSONAL_IDENTITY_REQUIRED', '需要本人手机会话')
        return token

    principal_readonly_snapshot = principal

    def status(self, token):
        self.principal(token)
        return dict(status='bound', binding_revision=1,
                    account=dict(open_id='ou_' + token, tenant_key='tenant', name='真实' + token))

    status_readonly_snapshot = status

    def create_session(self):
        return {'session_token': 'new-opaque-session'}

    def recipients(self, token):
        self.principal(token)
        return {'items': []}


class PersonalObjectsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.backend = Backend.__new__(Backend)
        b = self.backend
        b.args = types.SimpleNamespace(state_dir=self.tmp.name, feishu='dry-run')
        b.ops = Operations(os.path.join(self.tmp.name, 'operations'))
        b.meetings = Meetings(os.path.join(self.tmp.name, 'meetings'), b.ops, team=TEAM)
        b.recordings = Recordings(os.path.join(self.tmp.name, 'recordings'))
        b.speaker_state_lock = threading.RLock()
        b.daily_receipts = DailyReceipts()
        b.boards = types.SimpleNamespace(view=lambda sid: dict(session_id=sid, tasks=[], review_queue=[]))
        b.jev = b.resolver = b.feishu = None
        b.speakers = types.SimpleNamespace(ready=False)
        b.split_config = None
        b.mobile_feishu = MobileFeishu(b, os.path.join(self.tmp.name, 'mobile'), Accounts())
        self.mobile = b.mobile_feishu
        self.line = dict(id='u1', text='预算决定控制在十万以内。', start_ms=0, end_ms=1000, tag='decision', speaker=None)
        for sid, phone, date in [('own-a', 'phone-a', '01'), ('other-b', 'phone-b', '14'), ('legacy', None, '13')]:
            if phone:
                self.mobile.owners.reserve(sid, phone, False)
            b.meetings.sync(dict(session_id=sid, started_at=f'2026-10-{date}T00:00:00Z', utterances=[self.line]))
            b.meetings.set_project(dict(session_id=sid, project='同名项目'))
            b.meetings.review(dict(session_id=sid, utterance_id='u1', verdict='confirmed'))
        class Protected(Handler):
            api_token = 'shared-service'
        Protected.backend = b
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Protected)
        self.worker = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.worker.start()
        self.addCleanup(self.stop_server)

    def stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.worker.join()

    def request(self, method, path, body=None, token='phone-a', raw=None, headers=None):
        h = {'Authorization': 'Bearer shared-service'}
        if token is not None:
            h['X-Oops-User-Token'] = token
        h.update(headers or {})
        data = raw if raw is not None else json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(f'http://127.0.0.1:{self.server.server_port}' + path,
                                     data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req) as response:
                data = response.read()
                return response.status, json.loads(data) if response.headers.get_content_type() == 'application/json' else data
        except urllib.error.HTTPError as error:
            with error:
                return error.code, json.load(error)

    def test_service_token_alone_is_not_a_person_for_any_app_object(self):
        for method, path, body in [('GET', '/v1/meetings', None), ('GET', '/v1/meetings/own-a', None),
                ('GET', '/v1/projects', None), ('GET', '/v1/tasks', None),
                ('GET', '/v1/recordings/own-a', None),
                ('POST', '/v1/meetings/sync', {'session_id': 'new-1'}),
                ('POST', '/v1/meetings/search', {'query': '预算'}),
                ('POST', '/v1/actions/draft', {'session_id': 'own-a'}),
                ('POST', '/v1/utterances', {'session_id': 'own-a'})]:
            with self.subTest(path=path):
                self.assertEqual(401, self.request(method, path, body, token=None)[0])
        self.assertEqual(200, self.request('GET', '/healthz', token=None)[0])
        self.assertEqual(200, self.request('POST', '/v1/feishu/session', {}, token=None)[0])

    def test_list_filters_before_limit_and_never_reports_other_counts(self):
        code, value = self.request('GET', '/v1/meetings?limit=1')
        self.assertEqual(200, code)
        self.assertEqual(1, value['count'])
        self.assertEqual(['own-a'], [row['session_id'] for row in value['items']])
        code, value = self.request('GET', '/v1/meetings?limit=1', token='phone-b')
        self.assertEqual(['other-b'], [row['session_id'] for row in value['items']])

    def test_all_meeting_reads_and_mutations_reject_another_person(self):
        for tail in ('', '/minutes', '/board', '/delivery/status'):
            self.assertEqual(403, self.request('GET', '/v1/meetings/other-b' + tail)[0])
        before = Path(self.backend.meetings.path('other-b')).read_bytes()
        mutations = [('sync', {'utterances': [dict(self.line, text='恶意覆盖')]}),
                     ('rename', {'title': '不能改名'}), ('delete', {'confirm': True}),
                     ('project', {'project': '不能迁走'}),
                     ('review', {'utterance_id': 'u1', 'verdict': 'rejected'}),
                     ('retain', {'confirm': True}), ('items', {'item_id': 'fake'})]
        for action, extra in mutations:
            with self.subTest(action=action):
                self.assertEqual(403, self.request('POST', '/v1/meetings/' + action,
                    dict(session_id='other-b', **extra))[0])
                self.assertEqual(before, Path(self.backend.meetings.path('other-b')).read_bytes())
        self.assertEqual(200, self.request('POST', '/v1/meetings/rename', dict(session_id='own-a', title='本人可改'))[0])

    def test_legacy_sync_is_not_claim_and_explicit_old_migration_still_works(self):
        body = dict(session_id='legacy', utterances=[])
        self.assertEqual(403, self.request('POST', '/v1/meetings/sync', body)[0])
        self.assertNotIn('legacy', self.mobile.session_scope('phone-a'))
        # Existing operational migration uses this unchanged owners schema.
        with self.mobile.owners.connect() as db:
            db.execute('INSERT INTO owners(sid,principal,account) VALUES (?,?,?)', ('legacy', 'phone-a', 'tenant:ou_phone-a'))
        self.assertEqual(200, self.request('GET', '/v1/meetings/legacy')[0])
        self.assertEqual(403, self.request('GET', '/v1/meetings/legacy', token='phone-b')[0])
        self.assertEqual(200, self.request('POST', '/v1/meetings/sync', body)[0])

    def test_new_sync_reserves_only_the_authenticated_principal(self):
        body = dict(session_id='new-personal', started_at='2026-10-14T00:00:00Z', utterances=[self.line], principal='phone-b')
        self.assertEqual(200, self.request('POST', '/v1/meetings/sync', body)[0])
        self.assertTrue(self.mobile.owners.check('new-personal', 'phone-a'))
        self.assertEqual(403, self.request('POST', '/v1/meetings/sync', body, token='phone-b')[0])

    def test_recording_only_legacy_and_tombstone_cannot_be_claimed(self):
        os.makedirs(os.path.join(self.tmp.name, 'recordings', 'audio-legacy'))
        Path(self.backend.meetings.path('deleted-legacy') + '.deleted').touch()
        for sid in ('audio-legacy', 'deleted-legacy'):
            self.assertEqual(403, self.request('POST', '/v1/recordings/' + sid + '/manifest', {})[0])
            self.assertNotIn(sid, self.mobile.session_scope('phone-a'))

    def test_every_recording_verb_checks_owner_before_read_or_write(self):
        def recording(action, sid, *_args, **_kwargs):
            return b'RIFF-fixture' if action == 'clip' else dict(session_id=sid, complete=True, received=3)
        self.backend.recording_call = mock.Mock(side_effect=recording)
        for method, suffix, body, raw in [('GET', '', None, None), ('GET', '/clip?start_ms=0&end_ms=1000', None, None),
                ('POST', '/manifest', {}, None), ('POST', '/complete', {}, None),
                ('PUT', '/audio.pcm?offset=0', None, b'abc')]:
            with self.subTest(method=method, suffix=suffix):
                self.backend.recording_call.reset_mock()
                self.assertEqual(403, self.request(method, '/v1/recordings/other-b' + suffix, body, raw=raw)[0])
                self.backend.recording_call.assert_not_called()
                self.assertEqual(200, self.request(method, '/v1/recordings/own-a' + suffix, body, raw=raw)[0])
                self.backend.recording_call.assert_called_once()

    def test_search_and_conflict_inputs_only_receive_allowed_sources(self):
        code, result = self.request('POST', '/v1/meetings/search', {'query': '预算'})
        self.assertEqual(200, code)
        self.assertEqual({'own-a'}, {item['session_id'] for item in result['items']})
        seen = []
        def choose(state, *_args, **_kwargs):
            seen.extend(state['previous'])
            return dict(choice='none', probabilities={'none': 1}), 'fixture'
        self.backend.jev = types.SimpleNamespace(choice=choose)
        body = dict(session_id='own-a', kind='conflict', utterance=self.line, previous=[])
        code, value = self.request('POST', '/v1/notices', body)
        self.assertEqual(200, code)
        self.assertEqual([], seen)
        # Add a second owned meeting so the fixture proves allowed evidence is used.
        self.mobile.owners.reserve('own-second', 'phone-a', False)
        self.backend.meetings.sync(dict(session_id='own-second', started_at='2026-10-02T00:00:00Z', utterances=[self.line]))
        self.backend.meetings.set_project(dict(session_id='own-second', project='同名项目'))
        self.backend.meetings.review(dict(session_id='own-second', utterance_id='u1', verdict='confirmed'))
        code, value = self.request('POST', '/v1/notices', body)
        self.assertEqual(200, code)
        self.assertEqual({'own-second'}, {item['session_id'] for item in seen})

    def test_same_project_name_does_not_join_other_principals(self):
        code, projects = self.request('GET', '/v1/projects')
        self.assertEqual(200, code)
        self.assertEqual(1, projects['items'][0]['meeting_count'])
        code, project = self.request('GET', '/v1/projects/' + urllib.parse.quote('同名项目'))
        self.assertEqual(200, code)
        self.assertEqual(['own-a'], [row['session_id'] for row in project['meetings']])
        self.assertEqual({'own-a'}, {row['session_id'] for row in project['decisions']})

    def test_tasks_and_meeting_items_do_not_leak_other_sources(self):
        for sid, token in [('own-a', 'phone-a'), ('other-b', 'phone-b')]:
            self.backend.ops.save(dict(op_id='task-' + token, status='created', created_at='2026-10-14',
                personal_binding=dict(principal_id=token, account_open_id='ou_' + token, tenant_key='tenant'),
                request=dict(session_id=sid, draft=dict(what='自建任务' + token, who=TEAM[0]), evidence={}),
                feishu_task=dict(guid='fake-' + token, url='https://example.invalid/' + token)))
        self.backend.feishu_task_state = lambda guid, *args: dict(state='open', due_ms=None)
        # Genuine confirmed minutes items must also be scoped before aggregation.
        self.backend.meetings.cited = lambda sid: dict(items=minutes_items.build(dict(
            actions=[dict(task='确认待办' + sid, ids=['u1'])])))
        for sid in ('own-a', 'other-b'):
            item = self.backend.meetings.load(sid)['items'][0]
            self.backend.meetings.review_item(dict(session_id=sid, item_id=item['id'], fingerprint=item['fingerprint'],
                action='confirm', owner=TEAM[0]))
        code, value = self.request('GET', '/v1/tasks')
        self.assertEqual(200, code)
        self.assertEqual(['task-phone-a'], [item['op_id'] for item in value['items']])
        self.assertEqual(['own-a'], [item['session_id'] for item in value['meeting_items']])
        self.assertEqual(403, self.request('GET', '/v1/actions/task-phone-b')[0])
        self.assertEqual(200, self.request('GET', '/v1/actions/task-phone-a')[0])

    def test_personal_review_actor_cannot_be_forged_in_body(self):
        code, value = self.request('POST', '/v1/meetings/review',
            dict(session_id='own-a', utterance_id='u1', verdict='confirmed', by='伪造他人', _actor_principal='phone-b'))
        self.assertEqual(200, code)
        self.assertEqual('真实phone-a', value['review']['by'])
        self.assertEqual('phone-a', value['review']['by_principal'])

    def test_label_candidates_require_explicit_grant_not_display_name(self):
        fixture = dict(parsed_items=[dict(id='label-' + mid, source_meeting=dict(id=mid),
            reviews=[dict(verdict='confirmed')]) for mid in ('0235', '0236')],
            parsed_status=dict(state='ready', meetings=[dict(id=mid, status='ready', count=1) for mid in ('0235', '0236')]))
        loader = mock.Mock(return_value=fixture)
        value = self.mobile.parsed_tasks('phone-a', loader)
        loader.assert_not_called()
        self.assertEqual('disabled', value['parsed_status']['state'])
        self.mobile.owners.grant_read('label_meeting', '0235', 'phone-a', 'explicit-admin-fixture')
        value = self.mobile.parsed_tasks('phone-a', loader)
        self.assertEqual(['label-0235'], [item['id'] for item in value['parsed_items']])
        self.assertEqual(1, value['parsed_status']['counts']['total'])
        self.assertEqual(1, value['parsed_status']['review_counts']['confirmed'])
        self.assertEqual(['0235'], [row['id'] for row in value['parsed_status']['meetings']])
        self.assertEqual([], self.mobile.parsed_tasks('phone-b', loader)['parsed_items'])

    def test_daily_session_identity_does_not_archive_or_cross_phone(self):
        self.mobile.check_action_owner('phone-a', dict(session_id='daily-a'), draft=True)
        self.assertFalse(Path(self.backend.meetings.path('daily-a')).exists())
        with self.assertRaises(MobileError):
            self.mobile.check_action_owner('phone-b', dict(session_id='daily-a'), draft=True)
        # Manual tasks remain valid without inventing a meeting or source.
        self.mobile.check_action_owner('phone-a', dict(draft={'what': '手动记录'}))
        with self.assertRaises(MobileError):
            self.mobile.check_action_owner('phone-a', dict(session_id='other-b', draft={'what': '伪造关联'}))

    def test_explicit_read_grant_allows_only_read_and_withdrawal_is_immediate(self):
        self.mobile.owners.grant_read('meeting', 'other-b', 'phone-a', 'explicit-admin-fixture')
        self.assertEqual(200, self.request('GET', '/v1/meetings/other-b')[0])
        self.assertEqual(2, self.request('GET', '/v1/meetings')[1]['count'])
        self.assertEqual(403, self.request('POST', '/v1/meetings/rename', dict(session_id='other-b', title='不可写'))[0])
        self.assertEqual(403, self.request('GET', '/v1/meetings/other-b/delivery')[0])
        row = self.backend.meetings.load('other-b')
        row['review_export_scope'] = 'revoked'
        self.backend.meetings.write('other-b', row)
        self.assertEqual(403, self.request('GET', '/v1/meetings/other-b')[0])
        self.mobile.owners.revoke_read('meeting', 'other-b', 'phone-a')
        self.assertEqual(frozenset({'own-a'}), self.mobile.session_scope('phone-a'))

    def voice_fixture(self):
        self.backend.voiceprint_catalog = lambda: dict(revision='global-opaque-revision', people=[
            dict(name=name, registered=True, seconds=30, sample_id='private-' + name, sources=[dict(source='mic')])
            for name in TEAM])
        def manage(body, action, authorize=None):
            if authorize:
                authorize()
            return self.backend.voiceprint_catalog()
        self.backend.voiceprint_manage = mock.Mock(side_effect=manage)

    def test_service_and_display_name_do_not_authorize_voice_write(self):
        self.voice_fixture()
        for action in ('enroll', 'delete'):
            self.assertEqual(401, self.request('POST', '/v1/voiceprints/' + action, dict(name=TEAM[0]), token=None)[0])
            self.assertEqual(403, self.request('POST', '/v1/voiceprints/' + action,
                dict(name=TEAM[0], selfName='真实phone-a', account_open_id='ou_phone-a'))[0])
        self.backend.voiceprint_manage.assert_not_called()
        self.assertEqual([], self.request('GET', '/v1/voiceprints')[1]['people'])

    def test_verified_open_id_mapping_or_explicit_voice_owner_is_required(self):
        self.voice_fixture()
        self.backend.people = types.SimpleNamespace(data=dict(people={TEAM[0]: 'ou_phone-a', TEAM[1]: 'ou_phone-b'}))
        code, value = self.request('POST', '/v1/voiceprints/enroll', dict(name=TEAM[0]))
        self.assertEqual(200, code)
        self.assertEqual([TEAM[0]], [person['name'] for person in value['people']])
        self.assertEqual(403, self.request('POST', '/v1/voiceprints/delete', dict(name=TEAM[1]))[0])
        self.backend.people.data = dict(people={})
        self.mobile.owners.set_voice_owner(TEAM[0], 'phone-a', 'tenant:ou_phone-a', 'explicit-admin')
        self.assertEqual(200, self.request('POST', '/v1/voiceprints/delete', dict(name=TEAM[0]))[0])
        self.assertEqual(403, self.request('POST', '/v1/voiceprints/delete', dict(name=TEAM[0]), token='phone-b')[0])

    def test_voice_summary_grant_never_exposes_private_sample_fields(self):
        self.voice_fixture()
        self.backend.people = types.SimpleNamespace(data=dict(people={TEAM[0]: 'ou_phone-a'}))
        self.mobile.owners.grant_read('voice_profile', TEAM[1], 'phone-a', 'explicit-admin')
        code, value = self.request('GET', '/v1/voiceprints')
        self.assertEqual(200, code)
        own, shared = value['people']
        self.assertIn('sample_id', own)
        self.assertEqual(dict(name=TEAM[1], registered=True, shared=True), shared)
        self.backend.voiceprint_manage = lambda *_args: dict(speaker=TEAM[2], closest=TEAM[2], score=.9, margin=.4,
            scores=[dict(name=TEAM[0], score=.2), dict(name=TEAM[2], score=.9)])
        code, value = self.request('POST', '/v1/voiceprints/test', {})
        self.assertEqual(200, code)
        self.assertIsNone(value['speaker'])
        self.assertIsNone(value['closest'])
        self.assertIsNone(value['score'])
        self.assertEqual([TEAM[0]], [score['name'] for score in value['scores']])

    def test_person_invite_stays_narrow_and_cannot_delete_or_read_objects(self):
        from voiceprint_invites import issue_invite
        import time
        self.voice_fixture()
        self.server.RequestHandlerClass.enroll_secret = 'fixture-enroll-secret'
        invite = issue_invite('fixture-enroll-secret', TEAM[0], int(time.time()) + 60)
        headers = {'Authorization': 'Bearer ' + invite}
        code, value = self.request('GET', '/v1/voiceprints', token=None, headers=headers)
        self.assertEqual(200, code)
        self.assertEqual([TEAM[0]], [person['name'] for person in value['people']])
        self.assertEqual(403, self.request('POST', '/v1/voiceprints/delete', dict(name=TEAM[0]), token=None, headers=headers)[0])
        self.assertEqual(403, self.request('GET', '/v1/meetings', token=None, headers=headers)[0])

    def test_shared_list_read_does_not_queue_a_model_write_for_shared_objects(self):
        self.mobile.owners.grant_read('meeting', 'other-b', 'phone-a', 'explicit-admin')
        self.backend.queue_titles = mock.Mock()
        self.assertEqual(200, self.request('GET', '/v1/meetings')[0])
        self.backend.queue_titles.assert_called_once_with(allowed_sessions=frozenset({'own-a'}))

    def test_calendar_dispatch_requires_owner_and_confirm_is_independent(self):
        self.mobile.calendar = mock.Mock()
        self.mobile.calendar.prepare.return_value = dict(draft=dict(revision=1), suggestions=[])
        code, value = self.request('GET', '/v1/meetings/own-a/calendar?followup_id=manual')
        self.assertEqual(200, code)
        self.mobile.calendar.prepare.assert_called_once_with('phone-a', 'own-a', 'manual')
        self.assertEqual(403, self.request('GET', '/v1/meetings/other-b/calendar')[0])
        self.assertEqual(401, self.request('GET', '/v1/meetings/own-a/calendar', token=None)[0])

    def test_assistant_jobs_artifacts_and_delivery_are_personal_and_read_only(self):
        from agent_delivery import AgentDelivery
        jobs_dir = Path(self.tmp.name) / 'jobs'
        jobs = {}
        for job_id, token, sid in [('a' * 32, 'phone-a', 'own-a'), ('b' * 32, 'phone-b', 'other-b'),
                                   ('c' * 32, None, 'own-a')]:
            folder = jobs_dir / 'files' / job_id
            folder.mkdir(parents=True)
            (folder / '结果.md').write_text('已有正文，不生成')
            (folder / '原成果.pptx').write_bytes(b'original-pptx')
            jobs[job_id] = dict(id=job_id, kind='ppt', title='原成果', status='done', generation_status='ready',
                private_result=True, result_revision=1, owner_principal=token,
                payload=dict(session_id=sid, source_fingerprint='fixed-existing-source'))
        store = types.SimpleNamespace(dir=str(jobs_dir), load=lambda job_id: copy.deepcopy(jobs[job_id]),
                                      all=lambda: copy.deepcopy(list(jobs.values())))
        source = mock.Mock(return_value={})
        self.mobile.assistant = AgentDelivery(Path(self.tmp.name) / 'deliveries', self.mobile.accounts, store,
            self.mobile.check_job_owner, source)
        code, value = self.request('GET', '/v1/assistant/jobs')
        self.assertEqual(200, code)
        self.assertEqual(['a' * 32], [item['job_id'] for item in value['items']])
        self.assertEqual(401, self.request('GET', '/v1/assistant/jobs', token=None)[0])
        self.assertEqual(403, self.request('GET', '/v1/assistant/jobs/' + 'b' * 32 + '/delivery')[0])
        self.assertEqual(403, self.request('GET', '/v1/assistant/jobs/' + 'c' * 32 + '/delivery')[0])
        code, value = self.request('GET', '/v1/assistant/jobs/' + 'a' * 32 + '/delivery')
        self.assertEqual(200, code)
        self.assertEqual('已有正文，不生成', value['draft']['content'])
        file_path = '/v1/assistant/jobs/' + 'a' * 32 + '/files/' + urllib.parse.quote('原成果.pptx')
        code, artifact = self.request('GET', file_path)
        self.assertEqual(200, code)
        self.assertEqual(b'original-pptx', artifact)
        self.assertEqual(403, self.request('GET', file_path, token='phone-b')[0])
        self.assertEqual(400, self.request('GET', '/v1/assistant/jobs/' + 'a' * 32 + '/files/%2e%2e%2fsecret')[0])
        code, value = self.request('POST', '/v1/assistant/jobs/' + 'a' * 32 + '/delivery/confirm',
                                   dict(revision=1, op_id='assistant-fixture-1'))
        self.assertEqual(400, code)
        self.assertEqual('CONFIRMATION_REQUIRED', value['error']['code'])
        self.assertEqual(1, len(list(jobs_dir.glob('files/' + 'a' * 32 + '/*.pptx'))))

    def test_permission_filter_uses_readonly_account_snapshots(self):
        # A sender may hold the OAuth transaction lock; identity filtering must
        # not acquire it simply to reject another person's object.
        snapshot = self.mobile.accounts.status_readonly_snapshot('phone-a')
        self.mobile.accounts.status_readonly_snapshot = lambda token: copy.deepcopy(snapshot)
        self.mobile.accounts.principal = mock.Mock(side_effect=AssertionError('write-lock principal read'))
        self.mobile.accounts.status = mock.Mock(side_effect=AssertionError('write-lock account read'))
        self.assertEqual(200, self.request('GET', '/v1/meetings')[0])
        self.assertEqual(403, self.request('GET', '/v1/meetings/other-b')[0])
        self.assertEqual(200, self.request('GET', '/v1/tasks')[0])

    def test_meeting_projection_never_mutates_the_shared_input_object(self):
        op_id = 'foreign-link-op'
        self.backend.ops.save(dict(op_id=op_id, personal_binding=dict(principal_id='phone-b',
            account_open_id='ou_phone-b', tenant_key='tenant')))
        raw = dict(session_id='own-a', tasks=[dict(op_id=op_id, status='created', evidence=dict(utterance_ids=['u1']),
                   feishu_task=dict(url='https://example.invalid/private-b'))],
                   items=[dict(id='item', ids=['u1'], task_status='created', task_url='https://example.invalid/private-b')],
                   digest=dict(commitment=[dict(id='u1', task_status='created', task_url='https://example.invalid/private-b')]))
        before = copy.deepcopy(raw)
        projected = self.mobile.meeting_view('phone-a', raw)
        self.assertEqual(before, raw)
        self.assertEqual([], projected['tasks'])
        self.assertIsNone(projected['items'][0]['task_url'])
        self.assertIsNone(projected['digest']['commitment'][0]['task_url'])

    def ready_minutes_fixture(self):
        self.backend.meetings.sync(dict(session_id='own-a', ended_at='2026-10-14T01:00:00Z', utterances=[]))
        bot = types.SimpleNamespace(current_minutes=lambda sid: (self.backend.meetings.load(sid), dict(follow_ups=[])),
            minutes_fingerprint=lambda row: 'unchanged-text-and-minutes',
            minutes_markdown=lambda row, analysis: '已核对正文', current_job_minutes=lambda job: None)
        self.backend.feishu = bot
        return bot

    def test_private_or_withdrawn_source_blocks_all_personal_delivery_even_when_text_unchanged(self):
        self.ready_minutes_fixture()
        self.mobile.delivery.prepare('phone-a', 'own-a')
        self.mobile.calendar.prepare('phone-a', 'own-a')
        for field, value in [('private', True), ('review_export_scope', 'revoked')]:
            with self.subTest(field=field):
                row = self.backend.meetings.load('own-a')
                row.pop('private', None)
                row.pop('review_export_scope', None)
                row[field] = value
                self.backend.meetings.write('own-a', row)
                # Owner may still inspect original private history.
                self.assertEqual(200, self.request('GET', '/v1/meetings/own-a')[0])
                self.assertEqual(409, self.request('GET', '/v1/meetings/own-a/delivery')[0])
                self.assertEqual(409, self.request('GET', '/v1/meetings/own-a/calendar')[0])
                with self.assertRaises((MobileError, ValueError)):
                    self.mobile.load_minutes('own-a')
                with self.assertRaises((MobileError, ValueError)):
                    self.mobile.fingerprint(row)
                with self.assertRaises((MobileError, ValueError)):
                    self.mobile.check_job_source(dict(owner_principal='phone-a', payload=dict(session_id='own-a')))

    def test_read_grant_revoked_during_load_cannot_return_stale_body(self):
        self.mobile.owners.grant_read('meeting', 'other-b', 'phone-a', 'explicit-admin')
        load = self.backend.meetings.load
        def revoke_after_read(sid):
            row = load(sid)
            if sid == 'other-b':
                self.mobile.owners.revoke_read('meeting', sid, 'phone-a')
            return row
        with mock.patch.object(self.backend.meetings, 'load', side_effect=revoke_after_read):
            code, value = self.request('GET', '/v1/meetings/other-b')
        self.assertIn(code, (403, 409))
        self.assertNotIn(self.line['text'], json.dumps(value, ensure_ascii=False))

    def test_label_grant_revoked_during_slow_bridge_read_clears_body_and_counts(self):
        self.mobile.owners.grant_read('label_meeting', '0235', 'phone-a', 'explicit-admin')
        def loader():
            self.mobile.owners.revoke_read('label_meeting', '0235', 'phone-a')
            return dict(parsed_items=[dict(id='secret-label', source_meeting=dict(id='0235'), reviews=[])],
                parsed_status=dict(meetings=[dict(id='0235', status='ready', count=1)]))
        result = self.mobile.parsed_tasks('phone-a', loader)
        self.assertEqual([], result['parsed_items'])
        self.assertEqual(0, result['parsed_status']['counts']['total'])
        self.assertEqual([], result['parsed_status']['meetings'])

    def test_path_query_and_read_grants_cannot_be_used_to_modify_another_voice(self):
        self.voice_fixture()
        self.mobile.owners.grant_read('voice_profile', TEAM[1], 'phone-a', 'explicit-admin')
        self.assertEqual(403, self.request('POST', '/v1/voiceprints/delete', dict(name=TEAM[1]))[0])
        before = Path(self.backend.meetings.path('other-b')).read_bytes()
        for path in ('/v1/meetings/other-b?session_id=own-a',
                     '/v1/meetings/own-a%2f..%2fother-b', '/v1/meetings/%2e%2e%2fother-b',
                     '/v1/meetings/other-b%252f..', '/v1/meetings/other-b/minutes?session_id=own-a'):
            with self.subTest(path=path):
                self.assertIn(self.request('GET', path)[0], (400, 403, 404))
        for path in ('/v1/meetings/rename?session_id=own-a', '/v1/meetings/%72ename'):
            code, value = self.request('POST', path, dict(session_id='other-b', title='绕过尝试'))
            self.assertNotEqual(200, code)
        self.assertEqual(before, Path(self.backend.meetings.path('other-b')).read_bytes())
        self.backend.voiceprint_manage.assert_not_called()

    def test_local_no_api_token_still_treats_person_invitation_as_narrow(self):
        from voiceprint_invites import issue_invite
        import time
        self.voice_fixture()
        self.server.RequestHandlerClass.api_token = ''
        self.server.RequestHandlerClass.enroll_secret = 'local-invite-secret'
        invite = issue_invite('local-invite-secret', TEAM[0], int(time.time()) + 60)
        headers = {'Authorization': 'Bearer ' + invite}
        code, value = self.request('GET', '/v1/voiceprints', token=None, headers=headers)
        self.assertEqual(200, code)
        self.assertEqual([TEAM[0]], [person['name'] for person in value['people']])
        self.assertEqual(403, self.request('GET', '/v1/meetings', token=None, headers=headers)[0])
        self.assertEqual(403, self.request('POST', '/v1/voiceprints/delete', dict(name=TEAM[0]), token=None, headers=headers)[0])

    def test_existing_owner_checks_do_not_take_sqlite_writer_lock(self):
        import sqlite3
        account = 'tenant:ou_phone-a'
        self.mobile.owners.check('own-a', 'phone-a', account)
        writer = sqlite3.connect(self.mobile.owners.path, isolation_level=None)
        writer.execute('BEGIN IMMEDIATE')
        done, errors = threading.Event(), []
        def reader():
            try:
                self.mobile.owners.check('own-a', 'phone-a')
                self.mobile.owners.check('own-a', 'phone-a', account)
            except Exception as error:
                errors.append(error)
            finally:
                done.set()
        worker = threading.Thread(target=reader)
        worker.start()
        try:
            self.assertTrue(done.wait(.5), '已核实归属的读取不应等待另一个SQLite写事务')
            self.assertEqual([], errors)
        finally:
            writer.rollback()
            writer.close()
            worker.join(2)

    def test_internal_service_index_remains_distinct_from_personal_http(self):
        self.assertEqual(3, self.backend.meetings.listing()['count'])
        self.assertEqual(3, self.backend.meetings.projects()['items'][0]['meeting_count'])
        self.assertEqual(1, self.request('GET', '/v1/meetings')[1]['count'])


if __name__ == '__main__':
    unittest.main()
