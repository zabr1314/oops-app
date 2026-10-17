"""Only the new incremental-draft worker; fake model, no providers or live data."""
import copy
import datetime as dt
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from live_minutes import (LiveMinutesError, LiveMinutesStore, LiveMinutesWorker, MODEL,
                          PROTOCOL, COMPACT_PROTOCOL, adaptive_batch_limit, apply_patch_result, policy_status, prepare, snapshot_valid,
                          validate_config, validate_result)


BASE = dt.datetime(2026, 10, 17, tzinfo=dt.timezone.utc)


def utter(index):
    return dict(id='u' + str(index), text='这是第' + str(index) + '条完整原话。',
                start_ms=index * 10000, end_ms=index * 10000 + 9000, speaker='原始姓名')


def meeting(count=3, sid='current'):
    return dict(session_id=sid, started_at=BASE.isoformat(), utterances=[utter(i) for i in range(count)],
        storage_policy=dict(version=1, recording_mode='meeting', cloud_save_confirmed=True,
            audio_retention_days=30, transcript_retention_days=30, archive_started_at=BASE.isoformat(),
            audio_expires_at=(BASE + dt.timedelta(days=30)).isoformat(),
            transcript_expires_at=(BASE + dt.timedelta(days=30)).isoformat()))


def config(**changes):
    return validate_config(dict(version=1, enabled=True, from_started_at=BASE.isoformat(),
                                session_ids=['current'], **changes))


class Reader:
    def __init__(self, row):
        self.rows = {row['session_id']: row}

    def ids(self):
        return sorted(self.rows)

    def row(self, sid):
        return copy.deepcopy(self.rows[sid])


class FakeModel:
    model = MODEL

    def __init__(self):
        self.calls = []
        self.effect = None

    def complete_json(self, system, user, timeout):
        value = json.loads(user)
        self.calls.append(dict(input=value, timeout=timeout, attribute_timeout=self.timeout))
        if self.effect:
            return self.effect(value)
        last = value['new_utterances'][-1]
        uid = last['id'] if isinstance(last, dict) else last[0]
        return dict(through=uid, summary=dict(text='会中已有讨论。', ids=[uid]), ops=[]), MODEL


class LiveMinutesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = LiveMinutesStore(str(Path(self.temp.name) / 'draft.sqlite3'))
        self.store.initialize()
        self.row = meeting()
        self.reader = Reader(self.row)
        self.model = FakeModel()
        self.now = BASE + dt.timedelta(minutes=5)
        self.cfg = config()
        self.worker = LiveMinutesWorker(self.reader, self.store, self.cfg, model_factory=lambda: self.model,
                                        clock=lambda: self.now, monotonic=lambda: self.now.timestamp())

    def test_default_metadata_is_read_only_and_initial_scope_is_recent(self):
        missing = Path(self.temp.name) / 'absent.sqlite3'
        worker = LiveMinutesWorker(Reader(meeting(40)), LiveMinutesStore(str(missing)), self.cfg,
                                  model_factory=lambda: self.fail('metadata loaded a provider'), clock=lambda: self.now)
        result = worker.metadata()
        self.assertEqual(6, result['eligible_new_sources'])
        self.assertFalse(missing.exists())
        plan = prepare(meeting(40), None, self.cfg)
        user = json.loads(plan['user'])
        self.assertEqual([], user['context'])
        self.assertEqual('u34', user['new_utterances'][0]['id'])
        self.assertEqual(34, plan['snapshot']['ignored_prefix_count'])
        self.assertNotIn('原话', json.dumps(result, ensure_ascii=False))

    def test_new_only_and_twenty_seconds_start_to_start(self):
        result = self.worker.one()
        self.assertEqual('ready', result['status'])
        self.assertEqual((15, 15), (self.model.calls[0]['timeout'], self.model.calls[0]['attribute_timeout']))
        self.row['utterances'].append(utter(3))
        self.now += dt.timedelta(seconds=19)
        self.assertEqual('idle', self.worker.one()['status'])
        self.now += dt.timedelta(seconds=1)
        self.assertEqual('ready', self.worker.one()['status'])
        self.assertEqual(['u3'], [u['id'] for u in self.model.calls[1]['input']['new_utterances']])
        self.assertEqual('idle', self.worker.one()['status'])
        self.assertEqual(2, len(self.model.calls))
        self.assertEqual(4, len(self.store.view(self.row, self.now)['snapshot']['source_hashes']))

    def test_append_while_model_runs_keeps_explicit_old_coverage(self):
        def append(value):
            self.row['utterances'].append(utter(3))
            return dict(through='u2', summary=dict(text='已有小结', ids=['u2']), ops=[]), MODEL
        self.model.effect = append
        self.assertEqual('ready', self.worker.one()['status'])
        view = self.store.view(self.row, self.now)
        self.assertEqual(1, view['new_utterance_count'])
        self.assertEqual('u2', view['snapshot']['covers_through_id'])
        self.assertFalse(view['current'])

    def test_unknown_provider_attempt_is_persistent_and_not_resent(self):
        def fail(value):
            raise TimeoutError('private provider detail must not escape')
        self.model.effect = fail
        result = self.worker.one()
        self.assertEqual('model_result_unconfirmed', result['reason'])
        self.now += dt.timedelta(seconds=60)
        self.row['utterances'].append(utter(3))
        self.assertEqual('idle', self.worker.one()['status'])
        self.assertEqual(1, len(self.model.calls))
        self.assertEqual(1, self.store.counts()['attempts'])

    def test_worker_crash_pending_recovery_is_no_retry(self):
        plan = prepare(self.row, None, self.cfg)
        self.store.reserve('current', plan, self.now, self.now, self.cfg)
        self.store.recover_pending()
        self.now += dt.timedelta(seconds=60)
        self.assertEqual('idle', self.worker.one()['status'])
        self.assertEqual('worker_interrupted', self.store.view(self.row, self.now)['reason'])
        self.assertEqual([], self.model.calls)

    def test_edited_source_during_request_never_publishes(self):
        def edit(value):
            self.row['utterances'][0]['text'] = '已经修订的另一句话。'
            return dict(through='u2', summary=dict(text='已有小结', ids=['u0']), ops=[]), MODEL
        self.model.effect = edit
        self.assertEqual('stale', self.worker.one()['status'])
        self.assertNotIn('content', self.store.view(self.row, self.now))
        self.assertIsNone(self.store.checkpoint('current'))

    def test_ended_during_request_keeps_only_stopped_draft(self):
        def end(value):
            self.row['ended_at'] = self.now.isoformat()
            return dict(through='u2', summary=dict(text='已有小结', ids=['u2']), ops=[]), MODEL
        self.model.effect = end
        self.assertEqual('ended', self.worker.one()['status'])
        view = self.store.view(self.row, self.now)
        self.assertEqual('ended', view['status'])
        self.assertFalse(view['current'])

    def test_old_good_content_while_pending_and_paused_uses_old_timing(self):
        self.worker.one()
        old = self.store.checkpoint('current')
        self.row['utterances'].append(utter(3))
        self.now += dt.timedelta(seconds=20)
        plan = prepare(self.row, old, self.cfg)
        attempt = self.store.reserve('current', plan, self.now, self.now, self.cfg)
        view = self.store.view(self.row, self.now)
        self.assertTrue(view['updating'])
        self.assertTrue(view['is_previous'])
        self.assertEqual(old['timing'], view['timing'])
        self.assertNotEqual(view['timing']['started_at'], view['attempt']['started_at'])
        self.store.finish(attempt, 'current', 'paused', 'model_result_unconfirmed', self.now, 1)
        view = self.store.view(self.row, self.now)
        self.assertTrue(view['is_previous'])
        self.assertFalse(view['updating'])

    def test_paused_or_ended_source_change_purges_and_manual_identity_is_bound(self):
        self.worker.one()
        self.store.pause('current', 'trial_complete', status='stopped', now=self.now)
        self.row['reviews'] = {'u1': dict(speaker='已核对姓名')}
        self.assertNotIn('content', self.store.view(self.row, self.now))
        self.worker.one()
        self.assertIsNone(self.store.checkpoint('current'))
        with sqlite3.connect(self.store.path) as connection:
            self.assertEqual('{}', connection.execute('SELECT snapshot_json FROM attempts').fetchone()[0])

    def test_deleted_expired_and_disabled_remove_saved_body(self):
        for mode in ('deleted', 'expired', 'disabled'):
            with self.subTest(mode=mode):
                # A separate DB avoids re-enabling a deliberately paused session.
                store = LiveMinutesStore(str(Path(self.temp.name) / (mode + '.sqlite3')))
                store.initialize()
                row, model = meeting(), FakeModel()
                reader = Reader(row)
                cfg = config()
                worker = LiveMinutesWorker(reader, store, cfg, model_factory=lambda: model, clock=lambda: self.now)
                worker.one()
                if mode == 'deleted':
                    del reader.rows['current']
                elif mode == 'expired':
                    row['transcript_status'] = 'expired'
                else:
                    cfg['enabled'] = False
                worker.one()
                self.assertIsNone(store.checkpoint('current'))
                self.assertNotIn('已有讨论', Path(store.path).read_bytes().decode('utf-8', errors='ignore'))

    def test_policy_historical_scope_and_call_cap(self):
        self.row['storage_policy']['cloud_save_confirmed'] = False
        self.assertEqual('idle', self.worker.one()['status'])
        self.assertEqual([], self.model.calls)
        self.row['storage_policy']['cloud_save_confirmed'] = True
        # Use another SID because explicit current is allowed even before cutoff.
        old = meeting(sid='old')
        old['started_at'] = (BASE - dt.timedelta(days=1)).isoformat()
        self.assertFalse(prepare(old, None, self.cfg) is None)  # pure planning isn't authorization
        self.reader.rows['old'] = old
        self.worker.config['max_calls'] = 1
        self.assertEqual('ready', self.worker.one()['status'])
        self.now += dt.timedelta(seconds=20)
        self.row['utterances'].append(utter(3))
        self.assertEqual('stopped', self.worker.one()['status'])
        self.assertEqual(1, len(self.model.calls))

    def test_bad_citations_rejected_and_reviewed_identity_normalizes_for_gateway(self):
        with self.assertRaises(LiveMinutesError):
            validate_result(dict(summary=dict(text='无来源', ids=['invented']), actions=[], decisions=[],
                                 open_questions=[], ideas=[]), {'u0'})
        self.row['reviews'] = {'u1': dict(speaker='已核对姓名')}
        self.worker.one()
        normalized = copy.deepcopy(self.row)
        normalized['utterances'][1]['review'] = normalized['reviews']['u1']
        self.assertEqual('ready', self.store.view(normalized, self.now)['status'])
        normalized['reviews']['u1']['speaker'] = '另一个名字'
        self.assertEqual('stale', self.store.view(normalized, self.now)['status'])

    def test_scope_withdrawn_during_call_discards_reply(self):
        live_config = config()
        self.worker.config_loader = lambda: live_config
        def withdraw(value):
            live_config['enabled'] = False
            return dict(through='u2', summary=dict(text='已有小结', ids=['u2']), ops=[]), MODEL
        self.model.effect = withdraw
        self.assertEqual('stale', self.worker.one()['status'])
        self.assertIsNone(self.store.checkpoint('current'))

    def test_delta_omitted_old_items_stay_and_updates_keep_id_and_origins(self):
        self.worker.one()
        old = self.store.checkpoint('current')
        # Migration must not apply the new per-patch count/length caps to old items.
        old['content']['ideas'] = [dict(id='idea-' + str(i), text='旧条件' * 80, ids=['u0']) for i in range(60)]
        self.row['utterances'].append(utter(3))
        plan = prepare(self.row, old, self.cfg)
        addressable = next(iter(plan['inventory_ids']))
        result = apply_patch_result(dict(through='u3', summary=None, ops=[dict(op='update', id=addressable,
                    category='open_questions', text='出现新的条件，待核对。', ids=['u3'])]), plan)
        self.assertEqual(59, len(result['content']['ideas']))
        updated = result['content']['open_questions'][0]
        self.assertEqual(addressable, updated['id'])
        self.assertEqual(['u0', 'u3'], updated['ids'])
        self.assertEqual(old['content']['summary'], result['content']['summary'])

    def test_partial_through_advances_only_prefix_and_remainder_is_not_lost(self):
        def partial(value):
            return dict(through=value['new_utterances'][0]['id'], summary=None, ops=[]), MODEL
        self.model.effect = partial
        self.worker.one()
        view = self.store.view(self.row, self.now)
        self.assertEqual('u0', view['snapshot']['covers_through_id'])
        self.assertEqual((3, 1, 2), (view['attempt']['batch_count'], view['attempt']['processed_count'], view['new_utterance_count']))
        self.model.effect = None
        self.now += dt.timedelta(seconds=20)
        self.assertEqual('ready', self.worker.one()['status'])
        self.assertEqual(['u1', 'u2'], [u['id'] for u in self.model.calls[1]['input']['new_utterances']])
        self.assertEqual(0, self.store.view(self.row, self.now)['new_utterance_count'])

    def test_patch_future_evidence_unknown_target_and_duplicate_rejected(self):
        plan = prepare(self.row, None, self.cfg)
        bad = dict(through='u0', summary=None, ops=[dict(op='add', category='ideas', text='不能提前消费', ids=['u2'])])
        with self.assertRaises(LiveMinutesError):
            apply_patch_result(bad, plan)
        bad = dict(through='u2', summary=None, ops=[dict(op='update', id='invented', category='actions', text='内容', ids=['u2'])])
        with self.assertRaises(LiveMinutesError):
            apply_patch_result(bad, plan)
        bad = dict(through='invented', summary=None, ops=[])
        with self.assertRaises(LiveMinutesError):
            apply_patch_result(bad, plan)

    def test_same_real_request_is_not_reissued_after_operator_changes_status(self):
        plan = prepare(self.row, None, self.cfg)
        attempt = self.store.reserve('current', plan, self.now, self.now, self.cfg)
        self.store.finish(attempt, 'current', 'paused', 'model_result_unconfirmed', self.now, 30000)
        # Explicit operator status changes must still not bypass exact request identity.
        with self.store._write() as connection:
            connection.execute("UPDATE sessions SET status='ready',next_eligible_at=NULL WHERE session_id='current'")
        self.assertIsNone(self.store.reserve('current', plan, self.now, self.now, self.cfg))
        self.assertEqual('request_already_attempted', self.store.session('current')['reason'])
        self.assertEqual(1, self.store.counts()['attempts'])

    def test_ended_drain_needs_explicit_scope_and_checkpoint_and_stops_when_done(self):
        self.worker.one()
        self.row['utterances'] += [utter(i) for i in range(3, 7)]
        self.row['ended_at'] = self.now.isoformat()
        self.now += dt.timedelta(seconds=20)
        self.assertEqual('idle', self.worker.one()['status'])
        self.assertEqual(1, len(self.model.calls))
        self.cfg['drain_session_ids'] = ['current']
        self.assertEqual(1, self.worker.metadata()['eligible_sessions'])
        # An explicit operator recovery is required; granting drain doesn't unpause.
        self.assertEqual('idle', self.worker.one()['status'])
        with self.store._write() as connection:
            connection.execute("UPDATE sessions SET status='ready',next_eligible_at=NULL WHERE session_id='current'")
        self.cfg['max_new_sources'] = 2
        self.assertEqual('ready', self.worker.one()['status'])
        view = self.store.view(self.row, self.now)
        self.assertTrue(view['meeting_ended'])
        self.assertTrue(view['draining'])
        self.assertEqual(2, view['new_utterance_count'])
        self.now += dt.timedelta(seconds=20)
        self.assertEqual('ended', self.worker.one()['status'])
        self.assertFalse(self.store.view(self.row, self.now)['draining'])
        self.now += dt.timedelta(seconds=20)
        self.assertEqual('idle', self.worker.one()['status'])
        # A different ended meeting never gets a first full replay from drain alone.
        another = meeting(sid='other')
        another['ended_at'] = self.now.isoformat()
        self.reader.rows['other'] = another
        self.cfg['session_ids'].append('other')
        self.cfg['drain_session_ids'].append('other')
        self.worker.one()
        self.assertIsNone(self.store.session('other'))

    def test_legacy_attempt_schema_migration_keeps_every_value(self):
        path = str(Path(self.temp.name) / 'legacy.sqlite3')
        with sqlite3.connect(path) as connection:
            connection.execute('''CREATE TABLE attempts(attempt_id INTEGER PRIMARY KEY,session_id TEXT NOT NULL,
                fingerprint TEXT NOT NULL,status TEXT NOT NULL,snapshot_json TEXT NOT NULL,eligible_at TEXT NOT NULL,
                started_at TEXT NOT NULL,finished_at TEXT,model_ms INTEGER,reason TEXT,UNIQUE(session_id,fingerprint))''')
            connection.execute('INSERT INTO attempts VALUES(7,?,?,?,?,?,?,?,?,?)',
                ('current', 'exact-legacy-fingerprint', 'paused', '{"kept":1}', self.now.isoformat(),
                 self.now.isoformat(), self.now.isoformat(), 30192, 'model_result_unconfirmed'))
            before = connection.execute('SELECT * FROM attempts').fetchone()
        store = LiveMinutesStore(path)
        store.initialize()
        with store._read() as connection:
            after = connection.execute('SELECT * FROM attempts').fetchone()
            self.assertEqual(before, tuple(after)[:len(before)])
            self.assertIsNone(after['request_fingerprint'])
            self.assertIsNone(after['protocol'])

    def test_drain_scope_and_patch_budget_are_validated_without_running_models(self):
        with self.assertRaises(LiveMinutesError):
            config(drain_session_ids=['other'])
        self.assertEqual(24, self.cfg['max_new_sources'])
        self.assertEqual(2200, self.cfg['max_output_tokens'])
        plan = prepare(self.row, None, self.cfg)
        self.assertEqual(PROTOCOL, json.loads(plan['user'])['protocol'])
        self.assertEqual(plan['request_fingerprint'], prepare(self.row, None, self.cfg)['request_fingerprint'])

    def test_compact_input_retains_identity_and_human_checks_with_server_binding(self):
        compact = config(speed_profile='compact-v1', max_output_tokens=2200, max_patch_ops=12)
        self.row['reviews'] = {'u1': dict(speaker='人工核对姓名', owner='人工负责人', verdict='rejected')}
        plan = prepare(self.row, None, compact)
        payload = json.loads(plan['user'])
        self.assertEqual(COMPACT_PROTOCOL, plan['protocol'])
        self.assertEqual(['u1', '人工核对姓名', self.row['utterances'][1]['text'],
                          {'owner': '人工负责人', 'verdict': 'rejected'}], payload['new_utterances'][1])
        self.assertNotIn('start_ms', plan['user'])
        self.assertNotIn('text_hash', plan['user'])
        self.assertIn('start_ms', plan['snapshot']['source_hashes'][1])
        self.assertIn('binding', plan['snapshot']['source_hashes'][1])
        self.assertTrue(snapshot_valid(plan['snapshot'], self.row))
        self.assertEqual((1400, 6, 12), (compact['max_output_tokens'], compact['max_patch_ops'], compact['max_previous_items']))
        self.row['reviews']['u1']['owner'] = '另一个负责人'
        self.assertFalse(snapshot_valid(plan['snapshot'], self.row))

    def test_compact_patch_arrays_keep_source_prefix_and_unchanged_old_content(self):
        self.worker.one()
        old = self.store.checkpoint('current')
        old['content']['ideas'] = [dict(id='old-' + str(i), text='完整旧条件' * 40, ids=['u0']) for i in range(30)]
        self.row['utterances'].extend([utter(3), utter(4)])
        compact = config(speed_profile='compact-v1')
        plan = prepare(self.row, old, compact)
        target = next(iter(plan['inventory_ids']))
        result = apply_patch_result(dict(through='u3', summary=None,
            ops=[['u', target, 'q', '新增条件待确认。', ['u3']]]), plan)
        self.assertEqual(29, len(result['content']['ideas']))
        self.assertEqual(target, result['content']['open_questions'][0]['id'])
        self.assertEqual(['u0', 'u3'], result['content']['open_questions'][0]['ids'])
        self.assertEqual('u3', result['snapshot']['covers_through_id'])
        self.assertEqual(1, result['processed_count'])
        with self.assertRaises(LiveMinutesError):
            apply_patch_result(dict(through='u3', summary=None, ops=[['a', 'i', '越界', ['u4']]]), plan)
        self.assertNotEqual(plan['request_fingerprint'], prepare(self.row, old, self.cfg)['request_fingerprint'])

    def test_adaptive_batch_uses_success_latency_without_changing_failure_behavior(self):
        compact = config(speed_profile='compact-v1')
        previous = dict(protocol=COMPACT_PROTOCOL, timing=dict(model_ms=30000),
                        performance=dict(batch_limit=12, batch_count=12, processed_count=12))
        limit, reason = adaptive_batch_limit(previous, compact)
        self.assertEqual((6, 'previous_slow'), (limit, reason))
        previous['timing']['model_ms'] = 10000
        previous['performance']['batch_limit'] = previous['performance']['batch_count'] = 6
        previous['performance']['processed_count'] = 6
        self.assertEqual((8, 'previous_fast_full_batch'), adaptive_batch_limit(previous, compact))
        previous['protocol'] = PROTOCOL
        self.assertEqual((12, 'profile_initial'), adaptive_batch_limit(previous, compact))
        self.worker.config = compact
        def timeout(value):
            raise TimeoutError('unknown provider result')
        self.model.effect = timeout
        self.assertEqual('paused', self.worker.one()['status'])
        self.now += dt.timedelta(seconds=80)
        self.row['utterances'].append(utter(3))
        self.assertEqual('idle', self.worker.one()['status'])
        self.assertEqual(1, len(self.model.calls))

    def test_compact_success_reports_soft_target_without_timeout_or_source_loss(self):
        self.worker.config = config(speed_profile='compact-v1', timeout_seconds=60)
        def slow(value):
            self.now += dt.timedelta(seconds=25)
            return dict(through=value['new_utterances'][-1][0],
                        summary=dict(text='本轮有待核对的事实陈述。', ids=[value['new_utterances'][-1][0]]),
                        ops=[['a', 'i', '候选事实，需要核对。', [value['new_utterances'][-1][0]]]]), MODEL
        self.model.effect = slow
        result = self.worker.one()
        self.assertEqual('ready', result['status'])
        self.assertTrue(result['slow'])
        self.assertEqual(60, self.model.calls[0]['attribute_timeout'])
        checkpoint = self.store.checkpoint('current')
        self.assertEqual(COMPACT_PROTOCOL, checkpoint['protocol'])
        self.assertEqual(20, checkpoint['performance']['soft_target_seconds'])
        self.assertTrue(checkpoint['performance']['slow'])
        self.assertEqual(3, len(checkpoint['snapshot']['source_hashes']))

    def test_ended_source_invalidation_keeps_reason_and_no_success_metadata_becomes_content(self):
        self.worker.one()
        self.row['ended_at'] = self.now.isoformat()
        self.row['utterances'][1]['text'] = '结束同步修订了真实原话。'
        self.worker.one()
        self.worker.one()
        saved = self.store.session('current')
        self.assertEqual(('stale', 'source_changed'), (saved['status'], saved['reason']))
        view = self.store.view(self.row, self.now)
        self.assertTrue(view['meeting_ended'])
        self.assertFalse(view['checkpoint_available'])
        self.assertTrue(view['draft_invalidated'])
        self.assertEqual('ready', view['attempt']['status'])
        self.assertNotIn('content', view)
        self.assertNotIn('timing', view)
        self.assertNotIn('snapshot', view)
        self.assertEqual(1, len(self.model.calls))

    def test_explicit_recent_rebuild_requires_operator_unlock_and_publishes_only_current_sources(self):
        self.worker.one()
        self.row['utterances'] = [utter(i) for i in range(8)]
        self.row['utterances'][1]['text'] = '结束时修订后的当前原话。'
        self.row['ended_at'] = self.now.isoformat()
        self.worker.one()
        compact = config(speed_profile='compact-v1', rebuild_session_ids=['current'], initial_window_ms=120000)
        self.worker.config = compact
        self.assertEqual(1, self.worker.metadata()['eligible_sessions'])
        self.assertEqual('idle', self.worker.one()['status'])
        self.assertIsNone(self.store.checkpoint('current'))
        self.now += dt.timedelta(seconds=20)
        with self.store._write() as connection:
            connection.execute("UPDATE sessions SET status='ready',next_eligible_at=NULL WHERE session_id='current'")
        result = self.worker.one()
        self.assertEqual('ended', result['status'])
        view = self.store.view(self.row, self.now)
        self.assertTrue(view['checkpoint_available'])
        self.assertEqual(8, len(view['snapshot']['source_hashes']))
        self.assertEqual(0, view['snapshot']['ignored_prefix_count'])
        self.assertEqual(0, view['new_utterance_count'])
        self.assertEqual('结束时修订后的当前原话。', self.model.calls[-1]['input']['new_utterances'][1][2])
        self.assertEqual('idle', self.worker.one()['status'])
        self.assertEqual(2, len(self.model.calls))
        with self.assertRaises(LiveMinutesError):
            config(rebuild_session_ids=['other'])

    def test_initial_compact_requires_cited_summary_without_inventing_candidates(self):
        compact = config(speed_profile='compact-v1')
        plan = prepare(self.row, None, compact)
        self.assertTrue(json.loads(plan['user'])['first_draft'])
        with self.assertRaises(LiveMinutesError):
            apply_patch_result(dict(through='u2', summary=None, ops=[]), plan)
        with self.assertRaises(LiveMinutesError):
            apply_patch_result(dict(through='u2', summary=dict(text='简短回应。', ids=['u0']), ops=[]), plan)
        result = apply_patch_result(dict(through='u2', summary=dict(text='本轮是简短交流，未提取到明确事项。', ids=['u2']), ops=[]), plan)
        self.assertTrue(result['content']['summary']['text'])
        self.assertTrue(all(not result['content'][category] for category in ('actions', 'decisions', 'open_questions', 'ideas')))
        standard = prepare(self.row, None, self.cfg)
        self.assertEqual('', apply_patch_result(dict(through='u2', summary=None, ops=[]), standard)['content']['summary']['text'])


if __name__ == '__main__':
    unittest.main()
