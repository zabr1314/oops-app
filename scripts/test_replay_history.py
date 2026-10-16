#!/usr/bin/env python3
"""Stored history is scoped, read-only and never silently reruns a model."""
import datetime as dt
import http.cookiejar
import json
import os
import sqlite3
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from unittest.mock import patch

from replay_history import (HistoryError, ReplayAccess, StoredHistory, deployed_pipeline,
                            make_handler, minutes_fingerprint, source_hash)


class HistoryTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = self.temp.name
        os.makedirs(self.root + '/meetings')
        os.makedirs(self.root + '/feishu')
        self.row = dict(session_id='safe', started_at='2026-10-14T01:00:00Z', time_zone='UTC',
            utterances=[dict(id='u1', text='我来核对这份方案。', start_ms=0, end_ms=1000, tag='commitment')],
            reviews={})
        self.write_row()
        self.history = StoredHistory(self.root, builder=lambda row, minutes, traces: dict(row=row, minutes=minutes, traces=traces))

    def tearDown(self):
        self.temp.cleanup()

    def write_row(self):
        with open(self.root + '/meetings/safe.json', 'w') as stream:
            json.dump(self.row, stream)

    def test_scope_excludes_other_meetings_and_validates_ids(self):
        self.assertEqual(['safe'], [r['session_id'] for r in self.history.listing(['safe'])['meetings']])
        for sid, status in [('other', 403), ('../safe', 400)]:
            with self.assertRaises(HistoryError) as raised:
                self.history.detail(sid, ['safe'])
            self.assertEqual(status, raised.exception.status)

    def test_no_recorded_probability_context_or_model_is_fabricated(self):
        detail = self.history.detail('safe', ['safe'])
        self.assertEqual([], detail['traces'])
        self.assertNotIn('prob', detail['row']['utterances'][0])
        self.assertEqual('not_recorded', detail['minutes']['reason'])

    def test_source_hash_invalidates_trace_after_text_or_time_change(self):
        event = dict(kind='tag', id='u1', source_hash=source_hash(self.row['utterances'][0]), result=dict(tag='commitment', prob=.82), context_sources=[])
        self.row['processing_trace'] = [event]
        self.write_row()
        self.assertEqual(event['result'], self.history.detail('safe', ['safe'])['traces'][0]['result'])
        self.row['utterances'][0]['text'] = '方案已核对过。'
        self.write_row()
        self.assertEqual([], self.history.detail('safe', ['safe'])['traces'])

    def test_context_is_hidden_when_unbound_revised_or_removed(self):
        previous = dict(id='u0', text='先做安卓。', start_ms=0, end_ms=500, tag='decision', speaker='甲')
        self.row['utterances'][0].update(start_ms=500, end_ms=1000)
        self.row['utterances'].insert(0, previous)
        event = dict(kind='tag', id='u1', source_hash=source_hash(self.row['utterances'][1]), context=['先做安卓。'],
            context_sources=[dict(id='u0', source_hash=source_hash(previous))])
        self.row['processing_trace'] = [event]
        self.write_row()
        self.assertEqual(['先做安卓。'], self.history.detail('safe', ['safe'])['traces'][0]['context'])
        previous['speaker'] = '乙'
        self.write_row()
        trace = self.history.detail('safe', ['safe'])['traces'][0]
        self.assertNotIn('context', trace)
        self.assertEqual('source_changed', trace['context_status'])
        self.row['processing_trace'][0].pop('context_sources')
        self.write_row()
        self.assertNotIn('context', self.history.detail('safe', ['safe'])['traces'][0])

    def test_expiry_and_deletion_take_effect_on_next_read_without_mutation(self):
        self.row['storage_policy'] = dict(transcript_expires_at='2000-01-01T00:00:00Z')
        self.write_row()
        with open(self.root + '/meetings/safe.json', 'rb') as stream:
            before = stream.read()
        with self.assertRaises(HistoryError) as raised:
            self.history.detail('safe', ['safe'])
        self.assertEqual(410, raised.exception.status)
        self.assertEqual([], self.history.listing(['safe'])['meetings'])
        with open(self.root + '/meetings/safe.json', 'rb') as stream:
            self.assertEqual(before, stream.read())
        os.unlink(self.root + '/meetings/safe.json')
        with self.assertRaises(HistoryError) as raised:
            self.history.detail('safe', ['safe'])
        self.assertEqual(404, raised.exception.status)

    def test_stored_minutes_source_changes_are_not_exposed_as_current(self):
        state = dict(meetings=dict(safe=dict(analysis=dict(overview='已存纪要', topics=[], actions=[], decisions=[], open_questions=[], runs=3),
            analysis_fingerprint=minutes_fingerprint(self.row))))
        with open(self.root + '/feishu/state.json', 'w') as stream:
            json.dump(state, stream)
        minutes = self.history.detail('safe', ['safe'])['minutes']
        self.assertEqual('ready', minutes['status'])
        self.assertEqual(3, minutes['generation']['successful_runs'])
        self.assertIsNone(minutes['generation']['recorded_calls'])
        self.assertEqual('verified', minutes['generation']['source_binding'])
        self.assertEqual(dict(document_created=None, sent_receipts=None, ledger_written=None, done=None), minutes['delivery_record'])
        self.row['reviews'] = dict(u1=dict(verdict='rejected'))
        self.write_row()
        view = self.history.detail('safe', ['safe'])['minutes']
        self.assertEqual(dict(status='unavailable', reason='source_changed'), view)

    def test_reader_makes_no_network_calls_and_does_not_write_source(self):
        before = {path: os.stat(self.root + '/' + path).st_mtime_ns for path in ['meetings/safe.json']}
        with patch('urllib.request.urlopen', side_effect=AssertionError('network forbidden')):
            self.history.listing(['safe'])
            self.history.detail('safe', ['safe'])
        self.assertEqual(before['meetings/safe.json'], os.stat(self.root + '/meetings/safe.json').st_mtime_ns)

    def test_deleted_marker_and_symlink_are_not_read(self):
        open(self.root + '/meetings/safe.json.deleted', 'w').close()
        self.assertEqual([], self.history.listing(['safe'])['meetings'])
        os.symlink(self.root + '/meetings/safe.json', self.root + '/meetings/alias.json')
        with self.assertRaises(HistoryError):
            self.history.row('alias')

    def test_deployed_pipeline_reads_actual_source_and_identifies_current_scope(self):
        for name, source in [('feishu_actions.py', 'class A:\n def tick_meeting(self):\n  self.once(self.scan_questions)\n def after_meeting(self):\n  self.bot.doc("x")\n'),
                ('minutes_vote.py', 'RUNS=3\n'), ('local_backend.py', 'VERSION=1\n')]:
            with open(self.root + '/' + name, 'w') as stream:
                stream.write(source)
        view = deployed_pipeline(self.root)
        self.assertTrue(view['in_meeting_research'])
        self.assertTrue(view['legacy_auto_delivery_supported'])
        self.assertEqual('deployed_source', view['scope'])
        self.assertEqual(3, view['minutes_configured_runs'])
        self.assertEqual(3, len(view['source_hashes']))

    def test_delivery_metadata_never_contains_document_url_or_recipient_ids(self):
        state = dict(meetings=dict(safe=dict(analysis=dict(overview='纪要', actions=[], decisions=[], topics=[]),
            analysis_fingerprint=minutes_fingerprint(self.row), doc_url='https://private.invalid/secret',
            sent={'private-recipient-id': True}, ledger=True, done=True)))
        with open(self.root + '/feishu/state.json', 'w') as stream:
            json.dump(state, stream)
        minutes = self.history.minutes(self.row)
        self.assertEqual(dict(document_created=True, sent_receipts=1, ledger_written=True, done=True), minutes['delivery_record'])
        self.assertNotIn('private-recipient-id', str(minutes))
        self.assertNotIn('private.invalid', str(minutes))

    def test_history_handoff_metadata_exposes_only_bound_question_counts_and_actual_trace_time(self):
        state = dict(meetings=dict(safe=dict(analysis=dict(overview='纪要', actions=[], decisions=[], topics=[]),
            analysis_fingerprint=minutes_fingerprint(self.row),
            analysis_trace=dict(recorded_at='2026-10-14T01:01:00Z', latency_ms=345))),
            questions=dict(safe=dict(u1=dict(question='private-query', quote='private-quote', job='private-job'),
                removed=dict(question='removed-private')), other=dict(u1=dict(question='other-private'))))
        with open(self.root + '/feishu/state.json', 'w') as stream:
            json.dump(state, stream)
        with patch('urllib.request.urlopen', side_effect=AssertionError('no network')):
            view = self.history.minutes(self.row)
        self.assertEqual(dict(query_records=1), view['historical_records'])
        self.assertEqual('2026-10-14T01:01:00Z', view['generation']['recorded_at'])
        self.assertEqual(345, view['generation']['latency_ms'])
        for secret in ('private-query', 'private-quote', 'private-job', 'removed-private', 'other-private'):
            self.assertNotIn(secret, json.dumps(view))


class AccessTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.access = ReplayAccess(self.temp.name + '/access.sqlite3')

    def tearDown(self):
        self.temp.cleanup()

    def test_invite_is_single_use_scoped_and_only_hash_is_stored(self):
        invite = self.access.mint(['safe', 'safe'], 600)
        session, remaining = self.access.exchange(invite)
        self.assertEqual(['safe'], self.access.scope(session))
        self.assertTrue(0 < remaining <= 600)
        with self.assertRaises(HistoryError):
            self.access.exchange(invite)
        with self.access.connect() as db:
            self.assertNotIn(invite, str(db.execute('SELECT * FROM access').fetchall()))
            self.assertNotIn(session, str(db.execute('SELECT * FROM access').fetchall()))
        self.assertEqual(0o600, os.stat(self.access.path).st_mode & 0o777)

    def test_prepared_replays_are_listed_and_read_only_inside_scope(self):
        from replay_history import StoredHistory, HistoryError
        os.makedirs(self.temp.name + '/state/meetings')
        os.makedirs(self.temp.name + '/replays')
        replay = dict(version=2, source=dict(kind='replay', title='讨论 0238', started_at='2026-10-05T23:26:47+08:00'),
                      sentences=[dict(id='u1', text='好', end_ms=1, forks=[dict(layer='jev')])], post=None)
        with open(self.temp.name + '/replays/dji-0238.json', 'w') as stream:
            json.dump(replay, stream)
        history = StoredHistory(self.temp.name + '/state', replays_dir=self.temp.name + '/replays')
        listed = history.listing(['dji-0238'])['meetings']
        self.assertEqual([('dji-0238', '讨论 0238', 1, 'replay')], [(m['session_id'], m['title'], m['utterance_count'], m['kind']) for m in listed])
        self.assertEqual('replay', history.detail('dji-0238', ['dji-0238'])['source']['kind'])
        with self.assertRaises(HistoryError):
            history.detail('dji-0238', ['other'])
        self.assertEqual([], history.listing(['missing'])['meetings'])

    def test_open_access_file_lists_meetings_and_is_revoked_by_deleting_it(self):
        self.assertIsNone(self.access.open_scope())
        path = os.path.join(os.path.dirname(os.path.abspath(self.access.path)), 'open-access.json')
        with open(path, 'w') as stream:
            json.dump({'meetings': ['m2', 'm1', 'm1']}, stream)
        self.assertEqual(['m1', 'm2'], self.access.open_scope())
        with open(path, 'w') as stream:
            json.dump({'meetings': ['../escape']}, stream)
        self.assertIsNone(self.access.open_scope())
        os.unlink(path)
        self.assertIsNone(self.access.open_scope())

    def test_expired_sessions_do_not_return_scope(self):
        invite = self.access.mint(['safe'], 60)
        session, _ = self.access.exchange(invite)
        with self.access.connect() as db:
            db.execute('UPDATE access SET expires=?', (time.time() - 1,))
        with self.assertRaises(HistoryError):
            self.access.scope(session)

    def test_concurrent_exchanges_only_consume_invite_once(self):
        invite = self.access.mint(['safe'])
        result = []
        def run():
            try:
                result.append(self.access.exchange(invite))
            except HistoryError:
                result.append(None)
        threads = [threading.Thread(target=run) for _ in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(1, sum(r is not None for r in result))

    def test_http_scope_cookie_and_readonly_boundary(self):
        public = self.temp.name + '/public'
        os.makedirs(public)
        with open(public + '/funnel.html', 'w') as stream:
            stream.write('<html>history</html>')
        class History:
            def listing(self, scope):
                return dict(scope=scope)
            def detail(self, sid, scope):
                if sid not in scope:
                    raise HistoryError(403, 'meeting_outside_scope')
                return dict(sid=sid)
        server = ThreadingHTTPServer(('127.0.0.1', 0), make_handler(History(), self.access, public, '/', False))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = 'http://127.0.0.1:' + str(server.server_port)
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        try:
            with opener.open(base + '/api/pipeline') as response:
                self.assertEqual('*', response.headers['Access-Control-Allow-Origin'])
                self.assertNotIn('meetings', json.load(response))
            with self.assertRaises(urllib.error.HTTPError) as raised:
                opener.open(base + '/api/meetings')
            self.assertEqual(401, raised.exception.code)
            raised.exception.close()
            invite = self.access.mint(['safe'])
            with opener.open(urllib.request.Request(base + '/api/session', data=json.dumps(dict(invite=invite)).encode())) as response:
                cookie = response.headers['Set-Cookie']
                self.assertIn('HttpOnly', cookie)
                self.assertIn('SameSite=Strict', cookie)
            with opener.open(base + '/api/meetings') as response:
                self.assertEqual(['safe'], json.load(response)['scope'])
                self.assertEqual('no-store', response.headers['Cache-Control'])
                self.assertIsNone(response.headers['Access-Control-Allow-Origin'])
            for path, method, status in [('/api/meetings/other', 'GET', 403), ('/api/meetings/safe', 'DELETE', 405),
                    ('/api/meetings/safe', 'POST', 405), ('/../private', 'GET', 404)]:
                with self.assertRaises(urllib.error.HTTPError) as raised:
                    opener.open(urllib.request.Request(base + path, method=method))
                self.assertEqual(status, raised.exception.code)
                raised.exception.close()
            with opener.open(urllib.request.Request(base + '/api/session', method='DELETE')) as response:
                self.assertEqual('signed_out', json.load(response)['status'])
                self.assertIn('Max-Age=0', response.headers['Set-Cookie'])
            with self.assertRaises(urllib.error.HTTPError) as raised:
                opener.open(base + '/api/meetings')
            self.assertEqual(401, raised.exception.code)
            raised.exception.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_studio_assets_are_fixed_public_files_not_a_directory_browser(self):
        public = self.temp.name + '/public'
        os.makedirs(public + '/brand')
        os.makedirs(public + '/icons')
        assets = {'funnel-studio.js': b'window.studio = true;', 'funnel-studio.css': b'.studio {display: grid;}',
                  'funnel-after-studio.js': b'window.afterStudio = true;', 'funnel-after-studio.css': b'.after-studio {display: grid;}',
                  'brand/mascot.png': b'\x89PNG\r\n\x1a\n', 'icons/desk.svg': b'<svg/>',
                  'icons/paper-plane-tilt.svg': b'<svg/>'}
        for name, value in assets.items():
            with open(public + '/' + name, 'wb') as stream:
                stream.write(value)
        with open(public + '/brand/private.json', 'w') as stream:
            stream.write('private fixture')
        server = ThreadingHTTPServer(('127.0.0.1', 0), make_handler(object(), self.access, public, '/', False))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = 'http://127.0.0.1:' + str(server.server_port)
        try:
            for name, value in assets.items():
                with urllib.request.urlopen(base + '/' + name) as response:
                    self.assertEqual(value, response.read())
                    if name.endswith('.png'):
                        self.assertEqual('image/png', response.headers['Content-Type'])
                    if name.endswith('.svg'):
                        self.assertEqual('image/svg+xml', response.headers['Content-Type'])
            for path in ('/brand/private.json', '/brand/../brand/mascot.png', '/brand/%2e%2e/mascot.png'):
                with self.assertRaises(urllib.error.HTTPError) as raised:
                    urllib.request.urlopen(base + path)
                self.assertEqual(404, raised.exception.code)
                raised.exception.close()
            os.unlink(public + '/funnel-studio.js')
            os.symlink(public + '/brand/private.json', public + '/funnel-studio.js')
            with self.assertRaises(urllib.error.HTTPError) as raised:
                urllib.request.urlopen(base + '/funnel-studio.js')
            self.assertEqual(404, raised.exception.code)
            raised.exception.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == '__main__':
    unittest.main()
