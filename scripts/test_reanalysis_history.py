#!/usr/bin/env python3
"""Reanalysis reads are scoped to the unchanged original source, with no model calls."""
import copy
import http.cookiejar
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from unittest.mock import patch

from replay_history import (HistoryError, ReplayAccess, StoredHistory, make_handler, minutes_fingerprint,
                            reanalysis_source_hash, source_hash)


class ReanalysisHistoryTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / 'meetings').mkdir()
        (self.root / 'reanalyses').mkdir()
        self.row = dict(session_id='safe', started_at='2026-10-14T00:00:00Z', time_zone='UTC', title='方案核对',
            utterances=[dict(id='u1', text='先核对方案。', start_ms=0, end_ms=1000, speaker='甲', tag='idea'),
                        dict(id='u2', text='我来核对方案。', start_ms=1000, end_ms=2000, speaker='乙', tag='commitment')], reviews={})
        self.write_source()
        self.run = dict(version=1, run_id='run-safe', source_session_id='safe', source_hash=reanalysis_source_hash(self.row),
            source_snapshot=copy.deepcopy(self.row), created_at='2026-10-14T00:10:00Z', requested_model='jev-test',
            utterances=copy.deepcopy(self.row['utterances']),
            events=[dict(kind='tag', id='u2', source_hash=source_hash(self.row['utterances'][1]),
                         result=dict(tag='commitment', prob=.8, engine='jev-test'))],
            raw_calls=[dict(utterance_id='u2', stage='whole_tag', latency_ms=100, attempt=1,
                request=dict(model='jev-test', state=dict(utterance='我来核对方案。', context=['先核对方案。']),
                             questions=dict(q=dict(type='choice', instructions='分类', criteria={'yes': '是', 'no': '否'}))),
                response=dict(model='jev-test', answers=dict(q=dict(choice='yes', probabilities=dict(yes=.8, no=.2))), usage=dict(tokens=10)))],
            budget=dict(approved_cny=.1))
        self.write_run()
        self.history = StoredHistory(str(self.root), reanalyses_dir=str(self.root / 'reanalyses'),
            reanalysis_builder=lambda record, row, minutes: dict(record=record, sid=row['session_id'], minutes=minutes))

    def tearDown(self):
        self.temp.cleanup()

    def write_source(self):
        (self.root / 'meetings/safe.json').write_text(json.dumps(self.row))

    def write_run(self):
        (self.root / 'reanalyses/run-safe.json').write_text(json.dumps(self.run))

    def test_same_bound_source_reads_complete_choices_without_reclassification(self):
        with patch('urllib.request.urlopen', side_effect=AssertionError('no models or HTTP')):
            result = self.history.reanalysis_detail('run-safe', ['safe'])
        self.assertEqual(dict(yes=.8, no=.2), result['record']['raw_calls'][0]['response']['answers']['q']['probabilities'])
        self.assertEqual('jev-test', result['record']['requested_model'])
        self.assertNotIn('source_snapshot', result['record'])

    def test_list_is_scoped_and_filter_cannot_expand_scope(self):
        self.assertEqual([], self.history.reanalysis_listing([])['reanalyses'])
        [item] = self.history.reanalysis_listing(['safe'], 'safe')['reanalyses']
        self.assertEqual(('ready', 2, 'safe'), (item['status'], item['utterance_count'], item['source_session_id']))
        with self.assertRaises(HistoryError) as raised:
            self.history.reanalysis_listing(['other'], 'safe')
        self.assertEqual(403, raised.exception.status)
        with self.assertRaises(HistoryError) as raised:
            self.history.reanalysis_detail('run-safe', ['other'])
        self.assertEqual(403, raised.exception.status)

    def test_reanalysis_listing_reuses_available_theme_without_writing_source(self):
        self.row.pop('title')
        self.write_source()
        (self.root / 'feishu').mkdir()
        (self.root / 'feishu/state.json').write_text(json.dumps(dict(meetings=dict(safe=dict(
            analysis=dict(theme='已有纪要主题', actions=[], decisions=[], topics=[]),
            analysis_fingerprint=minutes_fingerprint(self.row))))))
        source_path = self.root / 'meetings/safe.json'
        before = source_path.read_bytes()
        with patch('urllib.request.urlopen', side_effect=AssertionError('no models or HTTP')):
            [item] = self.history.reanalysis_listing(['safe'], 'safe')['reanalyses']
        self.assertEqual('已有纪要主题', item['title'])
        self.assertEqual(before, source_path.read_bytes())

    def test_source_hash_covers_text_identity_time_tag_and_segments(self):
        original = reanalysis_source_hash(self.row)
        for field, value in [('text', '已经核对过。'), ('speaker', '丙'), ('start_ms', 2), ('tag', 'decision'),
                             ('segments', [dict(speaker='丙', text='先核对方案。')])]:
            row = copy.deepcopy(self.row)
            row['utterances'][0][field] = value
            self.assertNotEqual(original, reanalysis_source_hash(row), field)
        row = copy.deepcopy(self.row)
        row['reviews'] = dict(u1=dict(speaker='丙'))
        self.assertNotEqual(original, reanalysis_source_hash(row))
        row = copy.deepcopy(self.row)
        row.update(updated_at='later', processing_trace=[{'not': 'input'}], title='改名')
        self.assertEqual(original, reanalysis_source_hash(row))

    def test_changed_context_or_human_identity_disables_old_analysis_body(self):
        for mutate in (lambda: self.row['utterances'][0].update(text='上下文已变'),
                       lambda: self.row.update(reviews=dict(u1=dict(speaker='丙')))):
            self.row = copy.deepcopy(self.run['source_snapshot'])
            mutate()
            self.write_source()
            with self.assertRaises(HistoryError) as raised:
                self.history.reanalysis_detail('run-safe', ['safe'])
            self.assertEqual((409, 'reanalysis_source_changed'), (raised.exception.status, raised.exception.code))
            [item] = self.history.reanalysis_listing(['safe'])['reanalyses']
            self.assertEqual(('source_changed', 0), (item['status'], item['utterance_count']))
            self.assertNotIn('我来核对', json.dumps(item, ensure_ascii=False))

    def test_expiry_and_deletion_disable_read_without_modifying_originals_or_run(self):
        self.row['storage_policy'] = dict(transcript_expires_at='2000-01-01T00:00:00Z')
        self.write_source()
        before = (self.root / 'reanalyses/run-safe.json').read_bytes()
        with self.assertRaises(HistoryError) as raised:
            self.history.reanalysis_detail('run-safe', ['safe'])
        self.assertEqual(410, raised.exception.status)
        [item] = self.history.reanalysis_listing(['safe'])['reanalyses']
        self.assertEqual('source_unavailable', item['status'])
        (self.root / 'meetings/safe.json').unlink()
        with self.assertRaises(HistoryError) as raised:
            self.history.reanalysis_detail('run-safe', ['safe'])
        self.assertEqual(404, raised.exception.status)
        self.assertEqual(before, (self.root / 'reanalyses/run-safe.json').read_bytes())

    def test_snapshot_cannot_disagree_with_declared_source_hash(self):
        self.run['source_snapshot']['utterances'][0]['text'] = '别的会议内容'
        self.write_run()
        with self.assertRaises(HistoryError) as raised:
            self.history.reanalysis_detail('run-safe', ['safe'])
        self.assertEqual((503, 'reanalysis_snapshot_invalid'), (raised.exception.status, raised.exception.code))

    def test_transport_headers_and_unstructured_provider_fields_are_never_exposed(self):
        call = self.run['raw_calls'][0]
        call['headers'] = dict(Authorization='secret-transport-token')
        call['request']['api_key'] = 'secret-request-key'
        call['response']['debug'] = 'secret-provider-debug'
        call['response']['answers']['q']['internal_reasoning'] = 'private-provider-field'
        self.run['credential'] = 'secret-root-field'
        self.write_run()
        exposed = json.dumps(self.history.reanalysis_detail('run-safe', ['safe']))
        for secret in ('secret-transport-token', 'secret-request-key', 'secret-provider-debug', 'private-provider-field', 'secret-root-field'):
            self.assertNotIn(secret, exposed)
        self.assertIn('probabilities', exposed)

    def test_reads_leave_source_review_trace_and_new_run_files_byte_identical(self):
        files = [self.root / 'meetings/safe.json', self.root / 'reanalyses/run-safe.json']
        before = {str(path): path.read_bytes() for path in files}
        with patch('urllib.request.urlopen', side_effect=AssertionError('network forbidden')):
            self.history.reanalysis_listing(['safe'])
            self.history.reanalysis_detail('run-safe', ['safe'])
        self.assertEqual(before, {str(path): path.read_bytes() for path in files})

    def test_traversal_symlinks_and_malformed_records_are_rejected(self):
        with self.assertRaises(HistoryError) as raised:
            self.history.reanalysis_detail('../run-safe', ['safe'])
        self.assertEqual(400, raised.exception.status)
        os.symlink(self.root / 'reanalyses/run-safe.json', self.root / 'reanalyses/alias.json')
        with self.assertRaises(HistoryError) as raised:
            self.history.reanalysis_record('alias')
        self.assertEqual(404, raised.exception.status)
        self.run['run_id'] = 'other'
        self.write_run()
        with self.assertRaises(HistoryError) as raised:
            self.history.reanalysis_record('run-safe')
        self.assertEqual(503, raised.exception.status)

    def test_http_routes_require_existing_scope_and_ignore_unrelated_query_ids(self):
        access = ReplayAccess(str(self.root / 'access.sqlite3'))
        server = ThreadingHTTPServer(('127.0.0.1', 0), make_handler(self.history, access, str(self.root), '/', False))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = 'http://127.0.0.1:' + str(server.server_port)
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        try:
            for path in ('/api/reanalyses', '/api/reanalyses/run-safe'):
                with self.assertRaises(urllib.error.HTTPError) as raised:
                    opener.open(base + path)
                self.assertEqual(401, raised.exception.code)
                raised.exception.close()
            invite = access.mint(['safe'])
            with opener.open(urllib.request.Request(base + '/api/session', data=json.dumps(dict(invite=invite)).encode())) as response:
                self.assertEqual(200, response.status)
            with opener.open(base + '/api/reanalyses?source_session_id=safe') as response:
                self.assertEqual('run-safe', json.load(response)['reanalyses'][0]['run_id'])
                self.assertIsNone(response.headers['Access-Control-Allow-Origin'])
            with opener.open(base + '/api/reanalyses/run-safe?source_session_id=other') as response:
                self.assertEqual('safe', json.load(response)['sid'])
            with self.assertRaises(urllib.error.HTTPError) as raised:
                opener.open(base + '/api/reanalyses?source_session_id=other')
            self.assertEqual(403, raised.exception.code)
            raised.exception.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == '__main__':
    unittest.main()
