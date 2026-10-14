"""Real failure classes through live/cached minutes, tags, drafts and import; no API calls."""
import copy
import datetime as dt
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from item_quality import assess_item
from local_backend import Backend, TagCache
from meeting_features import Meetings
from minutes_quality import project
from label_minutes_import import build_bundle
from test_feishu_actions import FakeResolver, make


def utter(uid, text):
    return dict(id=uid, text=text, start_ms=int(uid[1:]) * 2000, end_ms=int(uid[1:]) * 2000 + 1000)


ROWS = [utter('u1', '举个例子，如果缺了云服务，我们立马买。钱用来换资源。'),
        utter('u2', '有问题马上说，不要被问题卡壳。'),
        utter('u3', '把这两个代码叠成一百就好了。'),
        utter('u4', '然后一版以后再更新 UI 和交互设计。'),
        utter('u5', '我明天来整理并发送接口说明。')]
ANALYSIS = dict(version=5, substantive=True, overview='安排接口开发', theme='开发安排',
    actions=[dict(task='如果缺云服务就立马买', ids=['u1'], owner='', due=''),
             dict(task='有问题马上说，不要被问题卡壳', ids=['u2'], owner='', due=''),
             dict(task='将代码叠出一百版，并更新 UI', ids=['u3', 'u4'], owner='', due=''),
             dict(task='整理并发送接口说明', ids=['u5'], owner='', due='明天')],
    decisions=[], undecided=[], topics=[], open_questions=[], follow_ups=[])


class MinutesQualityTest(unittest.TestCase):
    def test_examples_principles_removed_quantity_open_and_real_task_kept(self):
        before = copy.deepcopy(ANALYSIS)
        result = project(ANALYSIS, dict(utterances=ROWS))
        self.assertEqual(['整理并发送接口说明'], [a['task'] for a in result['actions']])
        self.assertEqual(2, len(result['quality_rejected']))
        self.assertEqual('quantity_ambiguity', result['undecided'][0]['quality']['reason'])
        self.assertEqual(['u3', 'u4'], result['undecided'][0]['ids'])
        self.assertNotIn('一版', result['undecided'][0]['topic'])
        self.assertEqual(before, ANALYSIS)
        self.assertEqual(result, project(result, dict(utterances=ROWS)))

    def test_cached_minutes_read_queue_and_import_share_guard_without_model(self):
        with tempfile.TemporaryDirectory() as folder:
            resolver = FakeResolver({})
            actions, meetings, calls = make(folder, resolver)
            meetings.cited, meetings.minutes_current = actions.cited_sentences, actions.minutes_current
            stamp = dt.datetime.now(dt.timezone.utc).isoformat()
            meetings.sync(dict(session_id='quality-session', started_at=stamp, ended_at=stamp, utterances=ROWS))
            row = meetings.load('quality-session')
            actions.state.put(copy.deepcopy(ANALYSIS), 'meetings', 'quality-session', 'analysis')
            actions.state.put(actions.minutes_fingerprint(row), 'meetings', 'quality-session', 'analysis_fingerprint')
            original = copy.deepcopy(actions.state.get('meetings', 'quality-session'))
            row = meetings.load('quality-session')  # catches a recursive cited->load bug
            self.assertEqual(['task', 'open'], [i['kind'] for i in row['items']])
            view = actions.minutes_view(row)
            self.assertEqual(1, len(view['minutes']['actions']))
            self.assertEqual(1, len(view['minutes']['undecided']))
            imported = build_bundle(row, ANALYSIS, actions.minutes_fingerprint(row), 'quality-meeting', ['林春源'])
            self.assertEqual(['task', 'open'], [i['kind'] for i in imported['items']['items']])
            self.assertTrue(all(not i['claimed'] and 'owner' not in i for i in imported['items']['items']))
            self.assertEqual(original, actions.state.get('meetings', 'quality-session'))
            self.assertEqual((0, []), (resolver.asked, calls))
            meetings.sync(dict(session_id='quality-session', utterances=[]))
            saved = json.loads(Path(meetings.path('quality-session')).read_text())
            self.assertNotIn('items', saved)
            self.assertNotIn('digest', saved)

    def test_fresh_model_minutes_also_apply_guard(self):
        with tempfile.TemporaryDirectory() as folder:
            actions, _, calls = make(folder, FakeResolver({'analysis': ANALYSIS}))
            row = dict(session_id='quality-session', started_at=dt.datetime.now(dt.timezone.utc).isoformat(), utterances=ROWS)
            result = actions.analyse_once(row)
            self.assertEqual(1, len(result['actions']))
            self.assertEqual(1, len(result['undecided']))
            self.assertEqual([], calls)

    def test_missing_part_of_a_legacy_citation_cannot_be_silently_replaced(self):
        analysis = dict(actions=[dict(task='整理接口说明', ids=['u5', 'gone'])])
        result = project(analysis, dict(utterances=ROWS))
        self.assertEqual([], result['actions'])
        self.assertEqual('evidence_incomplete', result['undecided'][0]['quality']['reason'])
        self.assertEqual(['u5', 'gone'], result['undecided'][0]['ids'])
        self.assertEqual(['u5', 'gone'], analysis['actions'][0]['ids'])

    def test_cached_tag_is_guarded_and_real_commitment_kept(self):
        backend = Backend.__new__(Backend)
        backend.jev, backend.tags = None, TagCache()
        for uid in ('u1', 'u2', 'u5'):
            u = next(u for u in ROWS if u['id'] == uid)
            req = dict(session_id='quality-session', utterance_id=uid, text=u['text'], start_ms=u['start_ms'],
                       end_ms=u['end_ms'], context=[])
            backend.tags.get_or_compute(('quality-session', uid), lambda: dict(tag='commitment', engine='cached', prob=.9))
            result = backend.tag(req)
            self.assertEqual('commitment' if uid == 'u5' else 'uncertain', result['tag'])

    def test_ambiguous_draft_never_prefills_an_executable_task(self):
        backend = Backend.__new__(Backend)
        backend.prune_transient_caches = backend.refresh_attribution_gate = lambda: None
        backend.speaker_state_lock, backend.speaker_evidence = threading.RLock(), {}
        backend.split_config, backend.jev = None, None
        backend.strict_a_enabled = backend.self_owner_enabled = backend.named_owner_enabled = False
        u = ROWS[2]
        quality = assess_item('将代码叠出一百版', [u], ROWS)
        backend.resolve_tasks = lambda *_: [dict(what='将代码叠出一百版', quality=quality, utterance=u)]
        with patch('local_backend.owner_resolution', return_value=dict(owner=None, suggested_owner=None)):
            result = backend.draft(dict(session_id='quality-session', utterances=[u], context=ROWS[3:4]))
        self.assertEqual('', result['what'])
        self.assertIsNone(result['who'])
        self.assertEqual('needs_review', result['quality']['status'])
        self.assertTrue(result['task_context']['missing'])


class AsrClosureWireTest(unittest.TestCase):
    def test_recording_end_fills_missing_closure_without_overwriting_device_outcome(self):
        with tempfile.TemporaryDirectory() as folder:
            meetings = Meetings(folder)
            stamp = dt.datetime.now(dt.timezone.utc).isoformat()
            meetings.sync(dict(session_id='closure-session', started_at=stamp, utterances=[]))
            self.assertTrue(meetings.set_ended('closure-session', stamp, 'recording', 'incomplete', 'finish_timeout', '结束未确认'))
            self.assertFalse(meetings.set_ended('closure-session', stamp, 'recording', 'acknowledged'))
            self.assertEqual('incomplete', meetings.load('closure-session')['asr_closure'])

    def test_terminal_status_roundtrip_retry_and_late_sync_do_not_erase_failure(self):
        with tempfile.TemporaryDirectory() as folder:
            meetings = Meetings(folder)
            stamp = dt.datetime.now(dt.timezone.utc).isoformat()
            body = dict(session_id='closure-session', started_at=stamp, ended_at=stamp, utterances=ROWS,
                        asr_closure='incomplete', asr_error_code='finish_timeout', asr_error='等待结束确认超时')
            self.assertEqual('incomplete', meetings.sync(body)['asr_closure'])
            meetings.sync(body)
            meetings.sync(dict(session_id='closure-session', utterances=[]))
            row = meetings.load('closure-session')
            self.assertEqual(('incomplete', 'finish_timeout'), (row['asr_closure'], row['asr_error_code']))
            self.assertEqual('incomplete', meetings.listing()['items'][0]['asr_closure'])
            with self.assertRaises(ValueError): meetings.sync(dict(body, asr_closure='acknowledged'))
            self.assertEqual('incomplete', meetings.load('closure-session')['asr_closure'])

    def test_invalid_or_nonterminal_status_rejected_and_legacy_preserved(self):
        with tempfile.TemporaryDirectory() as folder:
            meetings = Meetings(folder)
            stamp = dt.datetime.now(dt.timezone.utc).isoformat()
            body = dict(session_id='closure-session', started_at=stamp, utterances=[])
            for value in ('acknowledged', 'unknown', True):
                with self.assertRaises(ValueError): meetings.sync(dict(body, asr_closure=value))
            meetings.sync(body)
            self.assertNotIn('asr_closure', meetings.load('closure-session'))


if __name__ == '__main__': unittest.main()
