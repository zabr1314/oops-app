"""Synthetic source lifecycles and journal races; no models, credentials or external writes."""
import copy
import datetime as dt
import json
import os
import tempfile
import threading
import time
import types
import unittest
import urllib.request
import urllib.error
from http.server import ThreadingHTTPServer
from unittest.mock import patch

from action_sources import binding_for, digest
from local_backend import Backend, Operations, ApiError, Handler
from meeting_features import Meetings
from task_board import Boards


class ActionSourceTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.backend = Backend.__new__(Backend)
        self.backend.ops = Operations(os.path.join(self.temp.name, 'ops'))
        self.backend.meetings = Meetings(os.path.join(self.temp.name, 'meetings'), self.backend.ops, team=['洪玉麟', '林春源'])
        self.backend.args = types.SimpleNamespace(feishu='dry-run')
        self.backend.people = types.SimpleNamespace(resolve=lambda name: ('ou_owner', None))
        self.backend.feishu = None
        self.sid = 'source-session'
        self.u = dict(id='u1', text='我明天把方案发给你。', start_ms=0, end_ms=1000, speaker='洪玉麟', tag='commitment')
        self.sync([self.u])

    def sync(self, rows):
        return self.backend.meetings.sync(dict(session_id=self.sid, started_at='2026-10-13T00:00:00Z', utterances=rows))

    def request(self, op='source-op-001', ids=None):
        binding = self.backend.sign_action_binding(binding_for(self.backend.meetings.load(self.sid), ids or ['u1']))
        return dict(op_id=op, session_id=self.sid, draft=dict(who='洪玉麟', what='发送方案'),
                    evidence=dict(utterance_ids=[s['id'] for s in binding['sources']],
                                  quote=' '.join(s['quote'] for s in binding['sources']), source_binding=binding))

    def assert_rejected(self, req, code=None):
        with self.assertRaises(ApiError) as error: self.backend.confirm(req)
        self.assertEqual(409, error.exception.status)
        self.assertTrue(error.exception.extra['no_external_write'])
        if code: self.assertEqual(code, error.exception.code)
        self.assertIsNone(self.backend.ops.load(req['op_id']))

    def retained(self, quote=None):
        row = self.backend.meetings.load(self.sid)
        current = next(u for u in row['utterances'] if u['id'] == 'u1')
        self.backend.meetings.retain(dict(session_id=self.sid, confirm=True,
            evidence=[dict(id='u1', quote=quote or current['text'], expected_text_hash=digest(current['text']))]))

    def expire(self):
        # Same transformation as natural policy expiry, with no full-text source left.
        with self.backend.meetings.lock:
            row = self.backend.meetings.load(self.sid)
            row['utterances'], row['notices'], row['transcript_status'] = [], [], 'expired'
            for item in row.get('retained_evidence', []): item['source_status'] = 'expired'
            self.backend.meetings.write(self.sid, row)

    def journal(self, req, **fields):
        op = dict(op_id=req['op_id'], request=copy.deepcopy(req), request_canonical=json.dumps(req, ensure_ascii=False, sort_keys=True),
                  status='pending', attempts=0, feishu_task=None, message=None, **fields)
        self.backend.ops.save(op)
        return op

    def test_valid_source_creates_once_and_created_history_survives_deletion(self):
        req = self.request()
        created = self.backend.confirm(req)
        self.assertEqual('created', created['status'])
        self.backend.meetings.delete(dict(session_id=self.sid, confirm=True))
        self.assertEqual(created, self.backend.confirm(req))
        self.assertEqual(created, self.backend.status(req['op_id']))
        self.assertEqual(1, self.backend.ops.load(req['op_id'])['attempts'])

    def test_missing_old_binding_never_becomes_manual(self):
        for changes in ({'evidence': {}}, {'evidence': None}, {'session_id': None}, {}):
            req = self.request()
            req['evidence'].pop('source_binding')
            req.update(changes)
            self.assert_rejected(req, 'SOURCE_BINDING_REQUIRED')

    def test_source_free_manual_task_still_works(self):
        req = dict(op_id='manual-op-001', draft=dict(who='洪玉麟', what='本人填写的事项'))
        self.assertEqual('created', self.backend.confirm(req)['status'])

    def test_text_speaker_and_review_changes_reject_frozen_source(self):
        old = self.request()
        self.sync([dict(self.u, text='改为下周再发。')])
        self.assert_rejected(old, 'ACTION_SOURCE_CHANGED')
        latest = self.request()
        self.sync([dict(self.u, text='改为下周再发。', speaker='林春源')])
        self.assert_rejected(latest, 'ACTION_SOURCE_CHANGED')
        reviewed = self.request()
        self.backend.meetings.review(dict(session_id=self.sid, utterance_id='u1', owner='林春源'))
        self.assert_rejected(reviewed, 'ACTION_SOURCE_CHANGED')

    def test_edit_then_undo_cannot_revive_a_previous_binding(self):
        old = self.request()
        self.sync([dict(self.u, text='新的版本')])
        self.sync([self.u])
        self.assert_rejected(old, 'ACTION_SOURCE_CHANGED')
        self.assertEqual('created', self.backend.confirm(self.request())['status'])

    def test_append_is_not_a_source_revision(self):
        req = self.request()
        self.sync([dict(self.u, id='u2', text='这是另一件事情。', start_ms=1000, end_ms=2000)])
        self.assertEqual('created', self.backend.confirm(req)['status'])

    def test_deleted_rejected_and_fake_hash_sources_do_not_write(self):
        fake = self.request()
        fake['evidence']['source_binding']['sources'][0]['text_hash'] = '0' * 64
        self.assert_rejected(fake, 'ACTION_SOURCE_INVALID')
        old = self.request()
        self.backend.meetings.review(dict(session_id=self.sid, utterance_id='u1', verdict='rejected'))
        self.assert_rejected(old, 'ACTION_SOURCE_CHANGED')
        self.backend.meetings.delete(dict(session_id=self.sid, confirm=True))
        self.assert_rejected(old, 'ACTION_SOURCE_UNAVAILABLE')

    def test_ids_quote_kind_and_session_are_exact(self):
        old = self.request()
        for field, value in [('utterance_ids', ['u2']), ('quote', '编造的原话')]:
            req = copy.deepcopy(old); req['evidence'][field] = value
            self.assert_rejected(req, 'ACTION_SOURCE_INVALID')
        for field, value in [('kind', 'manual'), ('source_revision', 'client-invented')]:
            req = copy.deepcopy(old); req['evidence']['source_binding']['sources'][0][field] = value
            self.assert_rejected(req)
        req = copy.deepcopy(old); req['evidence']['source_binding']['session_id'] = 'another-session'
        self.assert_rejected(req, 'ACTION_SOURCE_INVALID')

    def test_independent_excerpt_survives_natural_expiry_and_supports_new_draft(self):
        old = self.request()
        self.retained()
        self.expire()
        self.assertEqual('created', self.backend.confirm(old)['status'])
        new = self.request('retained-op-002')
        self.assertEqual('saved_excerpt', new['evidence']['source_binding']['sources'][0]['kind'])
        self.assertEqual('created', self.backend.confirm(new)['status'])

    def test_expiry_without_independent_quote_and_partial_quote_cannot_authorize_full_quote(self):
        old = self.request()
        self.retained('把方案发给你')
        self.expire()
        self.assert_rejected(old, 'ACTION_SOURCE_CHANGED')
        kept = self.request('retained-op-002')
        self.assertEqual('created', self.backend.confirm(kept)['status'])

    def test_retained_rewrite_and_remove_do_not_revive_old_source(self):
        self.retained()
        old = self.request()
        self.retained('把方案发给你')
        self.assert_rejected(old, 'ACTION_SOURCE_CHANGED')
        current = self.request()
        with self.backend.meetings.lock:
            row = self.backend.meetings.load(self.sid); row['retained_evidence'] = []
            self.backend.meetings.write(self.sid, row)
        self.assert_rejected(current, 'ACTION_SOURCE_CHANGED')

    def test_retained_same_content_retry_does_not_change_revision(self):
        self.retained(); old = self.request()
        self.retained()
        self.assertEqual('created', self.backend.confirm(old)['status'])

    def test_journal_recovery_checks_current_source_and_does_not_call_writer(self):
        req = self.request(); self.journal(req)
        self.sync([dict(self.u, text='来源修改')])
        with patch.object(self.backend, '_write_feishu_verified', side_effect=AssertionError('must not write')):
            result = self.backend.status(req['op_id'])
            event = self.backend.ops.running.get(req['op_id'])
            if event: self.assertTrue(event.wait(2))
        self.assertEqual('failed', self.backend.ops.load(req['op_id'])['status'])
        self.assertEqual('ACTION_SOURCE_CHANGED', self.backend.ops.load(req['op_id'])['error_code'])
        self.assertTrue(self.backend.status(req['op_id'])['source_invalidated'])

    def test_unknown_past_write_stays_pending_and_blocked_not_false_failure(self):
        req = self.request(); self.journal(req, external_write_attempted=True)
        self.sync([dict(self.u, text='来源修改')])
        self.backend.status(req['op_id'])
        event = self.backend.ops.running.get(req['op_id'])
        if event: self.assertTrue(event.wait(2))
        state = self.backend.status(req['op_id'])
        self.assertEqual('pending', state['status']); self.assertTrue(state['source_blocked'])
        self.assertNotIn('source_invalidated', state)
        self.assertFalse(self.backend.ops.running)

    def test_confirm_past_external_attempt_returns_unknown_pending_instead_of_409(self):
        req = self.request(); self.journal(req, external_write_attempted=True)
        self.sync([dict(self.u, text='来源修改')])
        state = self.backend.confirm(req)
        self.assertEqual('pending', state['status']); self.assertTrue(state['source_blocked'])
        self.assertFalse(self.backend.ops.running)

    def test_legacy_pending_without_attempt_marker_is_conservatively_unknown(self):
        req = self.request(); op = self.journal(req); op['attempts'] = 1; self.backend.ops.save(op)
        self.sync([dict(self.u, text='来源修改')])
        state = self.backend.confirm(req)
        self.assertEqual('pending', state['status']); self.assertTrue(state['source_blocked'])

    def test_old_created_without_binding_remains_queryable_but_old_pending_is_blocked(self):
        req = self.request(); req['evidence'].pop('source_binding')
        self.journal(req)
        self.backend.status(req['op_id'])
        event = self.backend.ops.running.get(req['op_id'])
        if event: self.assertTrue(event.wait(2))
        self.assertEqual('failed', self.backend.status(req['op_id'])['status'])
        op = self.backend.ops.load(req['op_id']); op.update(status='created', feishu_task=dict(guid='known-task', url='https://example.invalid/task'))
        self.backend.ops.save(op)
        self.assertEqual('known-task', self.backend.confirm(req)['feishu_task']['guid'])

    def test_worker_rechecks_after_journal_before_external_create(self):
        req = self.request()
        def delayed(op_id):
            done = threading.Event()
            return done
        with patch.object(self.backend, 'start_worker', side_effect=delayed), patch('local_backend.CONFIRM_WAIT_S', 0):
            self.assertEqual('pending', self.backend.confirm(req)['status'])
        self.sync([dict(self.u, text='已撤回的旧来源')])
        done = threading.Event()
        with patch.object(self.backend, '_write_feishu_verified', side_effect=AssertionError('must not write')):
            self.backend.create_task(req['op_id'], done)
        self.assertTrue(done.is_set()); self.assertEqual('failed', self.backend.status(req['op_id'])['status'])

    def test_source_mutation_cannot_race_between_last_check_and_write(self):
        req = self.request(); op = self.journal(req)
        started, changed, release = threading.Event(), threading.Event(), threading.Event()
        def writer(_):
            started.set(); self.assertTrue(release.wait(2))
            self.assertFalse(changed.is_set())
            return dict(status='created', feishu_task=dict(guid='known-task'))
        def mutation():
            self.sync([dict(self.u, text='稍后的修改')]); changed.set()
        with patch.object(self.backend, '_write_feishu_verified', side_effect=writer):
            worker = threading.Thread(target=self.backend.write_feishu, args=(op,)); worker.start()
            self.assertTrue(started.wait(2))
            modifier = threading.Thread(target=mutation); modifier.start()
            self.assertFalse(changed.wait(.05)); release.set()
            worker.join(2); modifier.join(2)
            self.assertFalse(worker.is_alive()); self.assertTrue(changed.is_set())

    def test_server_draft_and_board_binding_never_trust_client_text(self):
        binding, error = self.backend.draft_source_binding(dict(session_id=self.sid, utterances=[self.u]))
        self.assertIsNone(error); self.assertIsNotNone(binding)
        binding, error = self.backend.draft_source_binding(dict(session_id=self.sid, utterances=[dict(self.u, text='伪造文本')]))
        self.assertIsNone(binding); self.assertTrue(error)
        self.backend.boards = types.SimpleNamespace(view=lambda sid: dict(tasks=[dict(id='t1', sources=['u1'])]))
        board = self.backend.action_board(self.sid)
        self.assertEqual('u1', board['tasks'][0]['source_binding']['sources'][0]['id'])

    def test_draft_pending_speaker_correction_cannot_get_an_old_revision(self):
        binding, error = self.backend.draft_source_binding(dict(session_id=self.sid, utterances=[dict(self.u, speaker='林春源')]))
        self.assertIsNone(binding); self.assertIn('说话人', error)
        self.backend.meetings.review(dict(session_id=self.sid, utterance_id='u1', speaker='林春源'))
        binding, error = self.backend.draft_source_binding(dict(session_id=self.sid, utterances=[dict(self.u, speaker='林春源')]))
        self.assertIsNone(error); self.assertEqual('林春源', binding['sources'][0]['speaker'])
        self.assertEqual({'speaker': '林春源'}, binding['sources'][0]['review'])

    def test_context_changes_withdraw_resolved_task_without_expanding_selected_ids(self):
        context = dict(self.u, id='u2', text='方案预算不能超过十万元。', start_ms=1000, end_ms=2000)
        self.sync([context])
        binding, error = self.backend.draft_source_binding(dict(session_id=self.sid, utterances=[self.u], context=[context]))
        self.assertIsNone(error); self.assertEqual(['u1'], [s['id'] for s in binding['sources']])
        self.assertEqual(['u2'], [s['id'] for s in binding['context_sources']])
        req = self.request(); req['evidence']['source_binding'] = binding
        self.sync([dict(context, text='预算改为二十万元。')])
        self.assert_rejected(req, 'ACTION_SOURCE_CHANGED')

    def test_same_op_different_content_preserves_conflict_rule(self):
        req = self.request(); self.backend.confirm(req)
        changed = copy.deepcopy(req); changed['draft']['what'] = '不同任务'
        with self.assertRaises(ApiError) as error: self.backend.confirm(changed)
        self.assertEqual('OP_PAYLOAD_CONFLICT', error.exception.code)

    def test_context_cannot_be_removed_from_signed_contract(self):
        context = dict(self.u, id='u2', text='不能超过十万元。', start_ms=1000, end_ms=2000)
        self.sync([context])
        binding, _ = self.backend.draft_source_binding(dict(session_id=self.sid, utterances=[self.u], context=[context]))
        req = self.request(); req['evidence']['source_binding'] = binding
        req['evidence']['source_binding'].pop('context_sources')
        self.assert_rejected(req, 'ACTION_SOURCE_INVALID')

    def test_binding_proof_survives_server_restart_without_persisting_full_text(self):
        req = self.request()
        del self.backend._action_binding_key
        self.assertEqual('created', self.backend.confirm(req)['status'])
        key = os.path.join(self.backend.ops.dir, '.action-source-key')
        self.assertEqual(0o600, os.stat(key).st_mode & 0o777)
        self.assertEqual(32, os.stat(key).st_size)

    def test_actual_policy_cleanup_preserves_independent_source_contract(self):
        self.sid = 'actual-policy-session'
        now = dt.datetime.now(dt.timezone.utc)
        self.backend.meetings.sync(dict(session_id=self.sid, started_at=now.isoformat(), utterances=[self.u],
            recording_mode='meeting', cloud_save_confirmed=True, archive_started_at=now.isoformat(),
            audio_retention_days=7, transcript_retention_days=7))
        req = self.request(); self.retained()
        self.backend.meetings.cleanup(now + dt.timedelta(days=8))
        self.assertEqual([], self.backend.meetings.load(self.sid)['utterances'])
        self.assertEqual('created', self.backend.confirm(req)['status'])

    def test_external_create_has_a_durable_attempt_and_keeps_existing_readback(self):
        self.backend.args.feishu = 'cli'; self.backend.lark = 'not-executed'
        req = self.request(); calls = []
        def fake_lark(_path, args, **kwargs):
            calls.append(args)
            if '+create' in args:
                journal = self.backend.ops.load(req['op_id'])
                self.assertTrue(journal['external_write_attempted'])
                self.assertEqual(req, journal['request'])
                self.assertEqual(req['op_id'], json.loads(args[-1])['client_token'])
            return dict(guid='real-shaped-task-guid', summary='发送方案', url='https://example.invalid/task')
        with patch('local_backend.run_lark', side_effect=fake_lark):
            result = self.backend.confirm(req)
            self.assertEqual('created', result['status'])
            self.backend.confirm(req)
        self.assertEqual(2, len(calls))  # one external create and its required readback

    def http_confirm(self, req):
        class Local(Handler):
            api_token = 'synthetic-test-key'
        Local.backend = self.backend
        server = ThreadingHTTPServer(('127.0.0.1', 0), Local)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            request = urllib.request.Request(f'http://127.0.0.1:{server.server_port}/v1/actions/confirm',
                data=json.dumps(req).encode(), headers={'Authorization': 'Bearer synthetic-test-key'})
            try:
                with urllib.request.urlopen(request, timeout=3) as response: return response.status, json.load(response)
            except urllib.error.HTTPError as error:
                with error: return error.code, json.load(error)
        finally:
            server.shutdown(); server.server_close(); thread.join()

    def test_http_source_conflict_explicitly_says_no_external_write(self):
        req = self.request(); self.sync([dict(self.u, text='已修改')])
        status, result = self.http_confirm(req)
        self.assertEqual(409, status)
        self.assertEqual('ACTION_SOURCE_CHANGED', result['error']['code'])
        self.assertTrue(result['error']['no_external_write'])
        self.assertIsNone(self.backend.ops.load(req['op_id']))

    def test_http_previously_attempted_operation_remains_unknown_pending(self):
        req = self.request(); self.journal(req, external_write_attempted=True)
        self.sync([dict(self.u, text='已修改')])
        status, result = self.http_confirm(req)
        self.assertEqual(200, status); self.assertEqual('pending', result['status'])
        self.assertTrue(result['source_blocked'])

    def live_board(self, confirm_review=False):
        self.sid = 'board-policy-session'
        self.board_now = dt.datetime.now(dt.timezone.utc)
        second = dict(self.u, id='u2', text='另外还要准备合同。', start_ms=1000, end_ms=2000)
        self.backend.meetings.sync(dict(session_id=self.sid, started_at=self.board_now.isoformat(), utterances=[self.u, second],
            recording_mode='meeting', cloud_save_confirmed=True, archive_started_at=self.board_now.isoformat(),
            audio_retention_days=7, transcript_retention_days=7))
        if confirm_review:
            self.backend.meetings.review(dict(session_id=self.sid, utterance_id='u1', verdict='confirmed'))
        class Model:
            def complete_json(_self, _system, _user, **_kwargs):
                return {'tasks': [dict(id='new', what='发送方案', owner='洪玉麟', priority='P0', status='open', sources=['u1']),
                                  dict(id='new', what='准备合同', owner='洪玉麟', priority='P1', status='open', sources=['u2'])]}, 'fake'
        self.backend.boards = Boards(os.path.join(self.temp.name, 'boards'), Model(), source_rows=self.backend.board_sources)
        self.backend.boards.submit(self.sid, [dict(what='发送方案', source='u1'), dict(what='准备合同', source='u2')],
                                   self.backend.board_sources(self.sid))
        deadline = time.monotonic() + 2
        while self.backend.boards.view(self.sid)['pending'] and time.monotonic() < deadline: time.sleep(.01)
        self.assertEqual(2, len(self.backend.action_board(self.sid)['tasks']))

    def test_real_board_cleanup_and_restart_keep_only_effective_independent_excerpt(self):
        self.live_board(); self.retained()
        self.backend.meetings.cleanup(self.board_now + dt.timedelta(days=8))
        self.backend.boards.cleanup()  # same order as Backend.cleanup_storage, before App reads again
        self.assertTrue(os.path.isfile(self.backend.boards.path(self.sid)))
        self.backend.boards = Boards(self.backend.boards.folder, None, source_rows=self.backend.board_sources)
        board = self.backend.action_board(self.sid)
        self.assertEqual(['发送方案'], [t['what'] for t in board['tasks']])
        binding = board['tasks'][0]['source_binding']
        self.assertEqual('saved_excerpt', binding['sources'][0]['kind'])
        self.assertEqual([], self.backend.meetings.load(self.sid)['utterances'])
        req = self.request(); req['evidence']['source_binding'] = binding
        self.assertEqual('created', self.backend.confirm(req)['status'])

    def test_real_board_auto_confirmed_excerpt_survives_expiry_but_deleted_meeting_does_not(self):
        self.live_board(confirm_review=True)
        self.backend.meetings.cleanup(self.board_now + dt.timedelta(days=8))
        self.backend.boards.cleanup()
        self.assertEqual(['发送方案'], [t['what'] for t in self.backend.action_board(self.sid)['tasks']])
        self.backend.meetings.delete(dict(session_id=self.sid, confirm=True))
        self.backend.boards.cleanup()
        self.assertEqual([], self.backend.action_board(self.sid)['tasks'])

    def test_real_board_does_not_revive_after_source_edit_or_retained_rewrite(self):
        for mutation in ('original', 'retained'):
            with self.subTest(mutation=mutation):
                self.live_board(); self.retained()
                if mutation == 'original':
                    self.backend.meetings.sync(dict(session_id=self.sid, utterances=[dict(self.u, text='改为下周发')]))
                    self.backend.meetings.sync(dict(session_id=self.sid, utterances=[self.u]))
                else:
                    self.retained('把方案发给你')
                self.backend.meetings.cleanup(self.board_now + dt.timedelta(days=8)); self.backend.boards.cleanup()
                self.assertEqual([], self.backend.action_board(self.sid)['tasks'])
                self.backend.meetings.delete(dict(session_id=self.sid, confirm=True))
                # The next sub-case has its own session; deletion tombstones must never be bypassed.
                if mutation == 'original':
                    self.sid = 'next-policy-session'
                    self.backend.meetings = Meetings(os.path.join(self.temp.name, 'second-meetings'), self.backend.ops, team=['洪玉麟', '林春源'])


if __name__ == '__main__': unittest.main()
