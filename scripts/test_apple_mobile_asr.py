"""Focused offline ASR retention checks: temporary SQLite and in-memory sockets only."""
import datetime as dt
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import queue
import socket
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch
import uuid

import apple_mobile_asr as asr
from apple_mobile_gateway import Store, frozen_policy
from asr_words_probe import frame


def final(text='真实原话', start=0, end=1, **extra):
    return dict(definite=True, text=text, start_time=start, end_time=end, **extra)


class OfflineUpstream:
    def __init__(self):
        self.status, self.calls = 404, []
        self.session_id = None

    def call(self, method, path, body=None, timeout=10):
        self.calls.append((method, path, body))
        if method == 'POST':
            request = json.loads(body)
            return 200, asr.encoded(dict(utterance_id=request['utterance_id'], tag='idea',
                                        prob=None, engine='offline-fixture'))
        return self.status, asr.encoded(dict(session_id=self.session_id, utterances=[]))


class OfflineSocket:
    def __init__(self, finals, outcome='ack', on_eos=None):
        self.finals, self.outcome, self.on_eos = finals, outcome, on_eos
        self.responses, self.sent = queue.Queue(), []

    def settimeout(self, value):
        pass

    def send_binary(self, data):
        self.sent.append(data)
        if data[1] >> 4 == 2 and data[1] & 2:
            if self.on_eos:
                self.on_eos()
            if self.finals:
                self.responses.put(frame(9, asr.encoded(dict(result=dict(utterances=self.finals)))))
            self.responses.put(frame(9, b'', last=True) if self.outcome == 'ack' else b'')
        return len(data)

    def recv(self):
        return self.responses.get(timeout=2)

    def close(self):
        self.responses.put(b'')


class ASRRetentionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.network_guard = patch.object(socket, 'create_connection', side_effect=AssertionError('network forbidden'))
        self.network_guard.start()
        self.addCleanup(self.network_guard.stop)
        self.store = Store(Path(self.temporary.name) / 'mobile.sqlite')
        self.upstream = OfflineUpstream()
        self.service = asr.AsrService(self.store, self.upstream)
        self.service.credentials = dict(VOLC_API_KEY='offline-secret', VOLC_APP_ID='',
                                        VOLC_ACCESS_TOKEN='', VOLC_RESOURCE_ID='offline-resource')
        self.service.available = True
        self.gid, self.sid = str(uuid.uuid4()), str(uuid.uuid4())
        self.upstream.session_id = self.sid
        began = dt.datetime.now(dt.timezone.utc).isoformat()
        policy = frozen_policy(dict(recording_mode='meeting', cloud_save_confirmed=True,
                                    archive_started_at=began, audio_retention_days=7,
                                    transcript_retention_days=30))
        with self.store.transaction() as db:
            db.execute('INSERT INTO grants(id,label,created,token_expires,token_days) VALUES(?,?,?,?,?)',
                       (self.gid, 'offline', time.time(), time.time() + 3600, 7))
            db.execute('INSERT INTO sessions VALUES(?,?,?,?,?,?)',
                       (self.sid, self.gid, time.time(), began, 'Asia/Shanghai', asr.encoded(policy)))
        self.pcm = b'\x01\x00' * 16  # one millisecond: tests never wait for real recordings
        self.rid = str(uuid.uuid4())
        self.service.enqueue(self.gid, self.store.session(self.gid, self.sid), 0, self.rid,
                             hashlib.sha256(self.pcm).hexdigest(), 28_924, 28_925, self.pcm)
        self.row = self.service._claim()

    def run_attempt(self, finals, outcome='ack', on_eos=None, connect_error=None):
        wire = OfflineSocket(finals, outcome, on_eos)
        factory = unittest.mock.Mock(side_effect=connect_error, return_value=wire)
        with patch.dict(sys.modules, websocket=types.SimpleNamespace(create_connection=factory)):
            self.service._run(self.row)
        self.assertEqual(factory.call_count, 1)
        return self.service._row(self.gid, self.sid, 0), wire

    def test_mixed_coordinates_keep_valid_text_and_isolate_exact_rejection(self):
        bad = final(' 原样尾句，不改姓名小王或三点。 ', end=20)
        saved, _ = self.run_attempt([final(), bad])
        job = self.service.get(self.gid, self.sid, 0)
        self.assertEqual((saved['state'], saved['provider_closure']), ('incomplete', 'incomplete'))
        self.assertEqual([u['text'] for u in job['utterances']], ['真实原话'])
        rejected = job['rejected_finals'][0]
        self.assertEqual(rejected['text'], bad['text'])
        self.assertEqual(rejected['reason'], 'invalid_coordinates')
        self.assertEqual(rejected['provider_coordinates']['end_time'], dict(present=True, raw_json='20'))
        self.assertNotIn('start_ms', rejected)
        self.assertTrue(job['diagnostics']['provider_acknowledged'])
        self.assertEqual(job['diagnostics']['received_final_count'], 2)
        self.assertEqual(job['diagnostics']['sent_pcm_bytes'], len(self.pcm))
        processing = self.service._claim()
        self.service._process(processing)
        posts = [json.loads(body) for method, _, body in self.upstream.calls if method == 'POST']
        self.assertEqual([r['text'] for r in posts], ['真实原话'])
        self.assertIsNone(self.service._claim())  # no paid audio retry or tag retry

    def test_all_rejected_are_incomplete_not_silence_or_failed(self):
        saved, _ = self.run_attempt([final(end=2)])
        job = self.service.get(self.gid, self.sid, 0)
        self.assertEqual((saved['state'], saved['provider_closure']), ('incomplete', 'incomplete'))
        self.assertEqual(job['utterances'], [])
        self.assertEqual(job['diagnostics']['rejected_final_count'], 1)
        self.assertEqual(job['processing']['state'], 'skipped')
        self.assertIsNone(self.service._claim())

    def test_bad_word_container_or_sentinel_never_erases_valid_sentence(self):
        for words in (7, [dict(text='词', start_time=-1, end_time=1)],
                      [dict(text=' ', start_time=-1, end_time=-1)]):
            good, rejected, stats = self.service._normalize(self.row, [final(words=words)])
            self.assertEqual([u['text'] for u in good], ['真实原话'])
            self.assertEqual(rejected, [])
            self.assertEqual(stats['rejected_final_count'], 0)

    def test_null_float_and_out_of_range_times_preserve_other_finals(self):
        values = [None, 1.5, -1, 2, float('nan')]
        finals = [final()] + [final('未对齐', end=value) for value in values]
        good, rejected, stats = self.service._normalize(self.row, finals)
        self.assertEqual(len(good), 1)
        self.assertEqual(len(rejected), len(values))
        self.assertEqual(stats['rejected_final_count'], len(values))
        self.assertEqual(rejected[-1]['provider_coordinates']['end_time']['raw_json'], 'NaN')
        asr.encoded(rejected)  # raw literals cannot inject nonfinite JSON numbers

    def test_missing_sentence_and_word_times_are_never_assumed_zero(self):
        missing_start, missing_end = final('缺起点'), final('缺终点')
        del missing_start['start_time']
        del missing_end['end_time']
        timed = final('时间真实的原句', words=[dict(text='词缺起点', end_time=1),
                                        dict(text='词缺终点', start_time=0),
                                        dict(text='真实词', start_time=0, end_time=1)])
        good, rejected, stats = self.service._normalize(self.row, [missing_start, missing_end, timed])
        self.assertEqual([u['text'] for u in good], ['时间真实的原句'])
        self.assertEqual([w['text'] for w in good[0]['words']], ['真实词'])
        self.assertTrue(good[0]['word_timing_incomplete'])
        self.assertEqual([u['reason'] for u in rejected], ['invalid_coordinates'] * 2)
        self.assertEqual(rejected[0]['provider_coordinates']['start_time'], dict(present=False, raw_json='null'))
        self.assertEqual(rejected[1]['provider_coordinates']['end_time'], dict(present=False, raw_json='null'))
        self.assertEqual(stats['rejected_final_count'], 2)

    def test_no_last_packet_keeps_finals_and_incomplete(self):
        saved, wire = self.run_attempt([final()], outcome='closed')
        self.assertEqual((saved['state'], saved['provider_closure']), ('incomplete', 'incomplete'))
        self.assertEqual(len(json.loads(saved['result'])), 1)
        self.assertEqual(sum(bool(data[1] & 2) for data in wire.sent if data[1] >> 4 == 2), 1)

    def test_transient_source_502_keeps_paid_result_but_blocks_get_and_sol(self):
        saved, _ = self.run_attempt([final(), final('异常尾句', end=2)],
                                    on_eos=lambda: setattr(self.upstream, 'status', 502))
        self.assertEqual(len(json.loads(saved['result'])), 1)
        self.assertEqual(len(json.loads(saved['processing'])['rejected_finals']), 1)
        with self.assertRaises(asr.AsrError) as error:
            self.service.get(self.gid, self.sid, 0)
        self.assertEqual(error.exception.status, 502)
        self.service._process(self.service._claim())
        self.assertFalse(any(method == 'POST' for method, _, _ in self.upstream.calls))
        current = self.service._row(self.gid, self.sid, 0)
        self.assertIsNotNone(current['result'])
        self.assertEqual(len(json.loads(current['processing'])['rejected_finals']), 1)
        self.assertIsNone(self.service._claim())

    def test_expiry_clears_rejections_diagnostics_and_receipt(self):
        self.run_attempt([final(end=2)])
        with self.store.connect() as db:
            db.execute('UPDATE asr_jobs SET audio_expires=?', (time.time() - 1,))
        self.service.maintenance()
        saved = self.service._row(self.gid, self.sid, 0)
        self.assertIsNone(saved['result'])
        self.assertIsNone(saved['processing'])
        with self.store.connect() as db:
            self.assertIsNone(db.execute('SELECT response FROM requests WHERE id=?', (self.rid,)).fetchone()[0])

    def test_revocation_and_source_410_clear_all_plaintext(self):
        self.run_attempt([final(end=2)])
        self.store.revoke(self.gid)
        self.assertIsNone(self.service._row(self.gid, self.sid, 0)['processing'])
        # A source that was observed and then deleted also clears isolated text.
        with self.store.connect() as db:
            db.execute('UPDATE grants SET revoked=NULL WHERE id=?', (self.gid,))
            db.execute("UPDATE asr_jobs SET state='incomplete',source_known=1,result=?,processing=?",
                       (b'[]', asr.encoded(dict(state='skipped', items=[], rejected_finals=[{'text': 'private'}]))))
        self.upstream.status = 410
        with self.assertRaises(asr.AsrError) as error:
            self.service.get(self.gid, self.sid, 0)
        self.assertEqual(error.exception.status, 410)
        self.assertIsNone(self.service._row(self.gid, self.sid, 0)['processing'])

    def test_concurrent_source_invalidation_is_never_resurrected(self):
        saved, _ = self.run_attempt([final(), final(end=2)],
                                    on_eos=lambda: self.service._invalidate(self.row, 'SOURCE_INVALID'))
        self.assertEqual(saved['state'], 'failed')
        self.assertIsNone(saved['result'])
        self.assertIsNone(saved['processing'])

    def run_commit_race(self, mutation):
        original = self.store.transaction
        armed = True

        @contextmanager
        def concurrent_change():
            nonlocal armed
            if armed:
                armed = False
                with original() as db:
                    mutation(db)  # committed after _local_live, before final transaction
            with original() as db:
                yield db

        with patch.object(self.store, 'transaction', concurrent_change):
            return self.run_attempt([final(), final(end=2)])[0]

    def test_transaction_rechecks_expiry_after_local_check(self):
        saved = self.run_commit_race(lambda db: db.execute('UPDATE asr_jobs SET audio_expires=?', (time.time() - 1,)))
        self.assertEqual(saved['state'], 'failed')
        self.assertIsNone(saved['result'])
        self.assertIsNone(saved['processing'])

    def test_transaction_rechecks_source_state_after_local_check(self):
        saved = self.run_commit_race(lambda db: db.execute("UPDATE asr_jobs SET state='failed',error_code='SOURCE_INVALID',result=NULL,processing=NULL"))
        self.assertEqual(saved['error_code'], 'SOURCE_INVALID')
        self.assertIsNone(saved['result'])
        self.assertIsNone(saved['processing'])

    def test_transaction_rechecks_revocation_after_local_check(self):
        saved = self.run_commit_race(lambda db: db.execute('UPDATE grants SET revoked=?', (time.time(),)))
        self.assertEqual(saved['state'], 'failed')
        self.assertIsNone(saved['result'])
        self.assertIsNone(saved['processing'])

    def test_connect_diagnostics_never_include_exception_message_or_secret(self):
        saved, _ = self.run_attempt([], connect_error=OSError('offline-secret 私人原话'))
        diagnostics = json.loads(saved['processing'])['diagnostics']
        self.assertEqual(diagnostics['phase'], 'connect')
        self.assertEqual(diagnostics['exception_counts'], {'connect:OSError': 1})
        self.assertNotIn('offline-secret', json.dumps(diagnostics))
        self.assertNotIn('私人原话', json.dumps(diagnostics, ensure_ascii=False))
        self.assertEqual(diagnostics['sent_pcm_bytes'], 0)
        self.assertIsNone(self.service._claim())

    def test_initial_source_failure_is_classified_without_provider_connection(self):
        self.upstream.status = 502
        factory = unittest.mock.Mock(side_effect=AssertionError('provider must not start'))
        with patch.dict(sys.modules, websocket=types.SimpleNamespace(create_connection=factory)):
            self.service._run(self.row)
        factory.assert_not_called()
        diagnostics = json.loads(self.service._row(self.gid, self.sid, 0)['processing'])['diagnostics']
        self.assertEqual(diagnostics['phase'], 'source')
        self.assertEqual(diagnostics['exception_counts'], {'source:AsrError': 1})

    def test_persistence_failure_is_classified_and_never_requeued(self):
        with patch.object(self.store, 'transaction', side_effect=OSError('private database error')):
            saved, _ = self.run_attempt([final()])
        self.assertEqual(saved['state'], 'unknown')
        diagnostics = json.loads(saved['processing'])['diagnostics']
        self.assertEqual(diagnostics['phase'], 'persist')
        self.assertEqual(diagnostics['exception_counts'], {'persist:OSError': 1})
        self.assertNotIn('private database error', json.dumps(diagnostics))
        self.assertIsNone(self.service._claim())

    def test_existing_terminal_job_is_not_claimed_or_rewritten(self):
        before = dict(state='failed', result=b'[]', provider_closure='incomplete',
                      error_code='ASR_PROVIDER_OR_PROTOCOL_FAILED', processing=asr.encoded(dict(state='skipped', items=[])))
        with self.store.connect() as db:
            db.execute('UPDATE asr_jobs SET state=?,result=?,provider_closure=?,error_code=?,processing=?', tuple(before.values()))
        self.assertIsNone(self.service._claim())
        after = self.service._row(self.gid, self.sid, 0)
        self.assertEqual({key: after[key] for key in before}, before)


if __name__ == '__main__':
    unittest.main()
