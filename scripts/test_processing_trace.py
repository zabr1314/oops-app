#!/usr/bin/env python3
import json
import os
import tempfile
import unittest
from unittest.mock import patch

from meeting_features import Meetings
from processing_trace import ProcessingTrace
from replay_history import StoredHistory
from local_backend import Backend, TagCache


class ProcessingTraceTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.meetings = Meetings(self.temp.name + '/meetings', team=['甲', '乙', '丙', '丁'])
        self.trace = ProcessingTrace()
        self.request = dict(session_id='safe', utterance_id='u1', text='我来核对方案。', start_ms=1000, end_ms=2000,
                            context=['先做安卓。'])
        self.result = dict(utterance_id='u1', tag='commitment', prob=.83, engine='jev-test', timing_ms=dict(jev_ms=120),
                           task_quality=dict(status='accepted', reason='grounded'))

    def tearDown(self):
        self.temp.cleanup()

    def sync(self):
        self.meetings.sync(dict(session_id='safe', started_at='2026-10-14T00:00:00Z', utterances=[
            dict(id='u0', text='先做安卓。', start_ms=0, end_ms=1000, tag='decision', speaker='甲'),
            dict(id='u1', text='我来核对方案。', start_ms=1000, end_ms=2000, tag='commitment', speaker='乙')]))

    def stored(self):
        with open(self.meetings.path('safe')) as stream:
            return json.load(stream)

    def test_daily_requests_do_not_create_archives_and_expire_in_memory(self):
        self.trace.record_tag(self.request, self.result)
        self.assertEqual(0, self.trace.attach(self.meetings, 'safe'))
        self.assertEqual([], os.listdir(self.meetings.dir))
        self.trace.prune(next(iter(self.trace.pending.values()))['at'] + 301)
        self.assertFalse(self.trace.pending)

    def test_trace_attaches_only_after_sync_with_bound_context_and_exact_result(self):
        self.trace.record_tag(self.request, self.result)
        self.sync()
        self.assertEqual(1, self.trace.attach(self.meetings, 'safe'))
        [event] = self.stored()['processing_trace']
        self.assertEqual(self.result, event['result'])
        self.assertEqual(['先做安卓。'], event['context'])
        self.assertEqual('u0', event['context_sources'][0]['id'])
        self.assertFalse(self.trace.pending)

    def test_changed_input_is_not_attached_and_unbound_context_not_retained(self):
        self.trace.record_tag(dict(self.request, text='旧的原话'), self.result)
        self.sync()
        self.assertEqual(0, self.trace.attach(self.meetings, 'safe'))
        self.trace.record_tag(dict(self.request, context=['库中不存在的内容']), self.result)
        self.assertEqual(1, self.trace.attach(self.meetings, 'safe'))
        [event] = self.stored()['processing_trace']
        self.assertNotIn('context', event)
        self.assertEqual('unbound_not_retained', event['context_status'])

    def test_source_identity_change_purges_old_context_from_disk(self):
        self.trace.record_tag(self.request, self.result)
        self.sync()
        self.trace.attach(self.meetings, 'safe')
        self.meetings.review(dict(session_id='safe', utterance_id='u0', speaker='丙'))
        [event] = self.stored()['processing_trace']
        self.assertNotIn('context', event)
        self.assertEqual('source_changed', event['context_status'])
        self.meetings.review(dict(session_id='safe', utterance_id='u1', speaker='丁'))
        self.assertFalse(self.stored()['processing_trace'])

    def test_transcript_expiry_clears_trace_from_disk_and_delete_removes_archive(self):
        self.trace.record_tag(self.request, self.result)
        self.sync()
        self.trace.attach(self.meetings, 'safe')
        row = self.stored()
        row['storage_policy'] = dict(transcript_expires_at='2000-01-01T00:00:00Z')
        with open(self.meetings.path('safe'), 'w') as stream:
            json.dump(row, stream)
        self.meetings.cleanup()
        self.assertNotIn('processing_trace', self.stored())
        self.meetings.delete(dict(session_id='safe', confirm=True))
        self.assertFalse(os.path.exists(self.meetings.path('safe')))

    def test_actual_whole_clause_and_quality_stages_are_captured_without_new_calls(self):
        backend = Backend.__new__(Backend)
        backend.jev, backend.tags, backend.processing_trace = object(), TagCache(), self.trace
        whole = dict(tag='idea', prob=.62, engine='jev-test')
        with patch('local_backend.jev_tag', return_value=whole) as tag, \
             patch('local_backend.jev_task_clauses', return_value=[('我来核对方案。', .81)]) as clauses, \
             patch('local_backend.assess_item', return_value=dict(status='accepted', reason='grounded')):
            result = backend.tag(self.request)
            captured = next(iter(self.trace.pending.values()))
            first_time = captured['event']['recorded_at']
            self.assertEqual('commitment', result['tag'])
            self.assertEqual(['whole_tag', 'task_clauses', 'task_quality'], [s['kind'] for s in captured['event']['stages']])
            self.assertEqual(whole, captured['event']['stages'][0]['result'])
            self.assertEqual(.81, captured['event']['stages'][1]['clauses'][0]['yes_prob'])
            self.assertEqual(whole['prob'], captured['event']['stages'][0]['result']['prob'])
            backend.tag(self.request)
            self.assertEqual(1, tag.call_count)
            self.assertEqual(1, clauses.call_count)
            self.assertEqual(first_time, next(iter(self.trace.pending.values()))['event']['recorded_at'])
            self.assertNotIn('stages', result)

    def test_actual_fallback_error_type_and_rules_stage_are_captured(self):
        backend = Backend.__new__(Backend)
        backend.jev, backend.tags, backend.processing_trace = object(), TagCache(), self.trace
        with patch('local_backend.jev_tag', side_effect=TimeoutError('do not retain provider details')), \
             patch('local_backend.jev_task_clauses', return_value=[]), \
             patch('local_backend.assess_item', return_value=dict(status='accepted', reason='grounded')):
            backend.tag(self.request)
        stages = next(iter(self.trace.pending.values()))['event']['stages']
        self.assertEqual('failed', stages[0]['status'])
        self.assertEqual('TimeoutError', stages[0]['error_type'])
        self.assertEqual('rules_fallback', stages[1]['kind'])
        self.assertNotIn('do not retain', str(stages))


if __name__ == '__main__':
    unittest.main()
