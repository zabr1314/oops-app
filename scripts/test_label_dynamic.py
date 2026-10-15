"""Hot catalog, frozen legacy groups and imported identity/TTL guards on temporary data."""
import copy
import datetime as dt
import json
import os
from pathlib import Path
import shutil
import threading
import urllib.error
import urllib.request
import wave
from concurrent.futures import ThreadPoolExecutor
from http.server import ThreadingHTTPServer
from unittest import mock
import unittest

import team_label as tl
from label_shared_identity import shared_roster
from label_workflow import row_fingerprint
from test_team_label_workflow import ALICE, BOB, SECRET, WorkflowFixture


class DynamicCatalogTest(WorkflowFixture):
    def policy(self, audio_hours=24, transcript_hours=24):
        now = dt.datetime.now(dt.timezone.utc)
        return {'version': 1, 'recording_mode': 'meeting', 'cloud_save_confirmed': True,
                'audio_expires_at': (now + dt.timedelta(hours=audio_hours)).isoformat(),
                'transcript_expires_at': (now + dt.timedelta(hours=transcript_hours)).isoformat()}

    def document(self, rows=None, **extra):
        row = dict(id='u1-1', parent='u1', text='我明天负责提交这次申请。', start_ms=500, end_ms=1800)
        return dict(id='0990', session='new-session', title='新导入的正式会议', imported=True,
                    utterances=[row] if rows is None else rows, processing={'stage': 'ready'},
                    shared_roster=[ALICE, BOB], audio_available=True, storage_policy=self.policy(), **extra)

    def publish(self, doc, mid='0990', audio_name='audio.wav'):
        folder = Path(self.folder) / 'meetings' / mid
        folder.mkdir(exist_ok=True)
        if doc.get('audio_available'):
            with wave.open(str(folder / audio_name), 'wb') as audio:
                audio.setnchannels(1)
                audio.setsampwidth(2)
                audio.setframerate(16000)
                audio.writeframes(b'\0\0' * 16000 * 4)
        stage = folder / '.meeting.next'
        stage.write_text(json.dumps(doc, ensure_ascii=False))
        os.replace(stage, folder / 'meeting.json')

    def server(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), tl.make_handler(self.data, SECRET))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return 'http://127.0.0.1:' + str(server.server_port)

    def get(self, base, path):
        request = urllib.request.Request(base + path,
            headers={'Authorization': 'Bearer ' + tl.make_key(SECRET, ALICE)})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                raw = response.read()
                return response.status, json.loads(raw) if 'json' in response.headers['Content-Type'] else raw
        except urllib.error.HTTPError as error:
            with error:
                return error.code, json.loads(error.read())

    def test_http_sees_new_meeting_clip_replacement_and_directory_removal_without_restart(self):
        base = self.server()
        before = self.get(base, '/api/me')[1]['catalog_revision']
        name = 'audio-' + 'a' * 64 + '.wav'
        doc = self.document(audio_file=name, items_file='items-' + 'b' * 64 + '.json')
        self.publish(doc, audio_name=name)
        result = self.get(base, '/api/me')[1]
        self.assertNotEqual(before, result['catalog_revision'])
        entry = next(m for m in result['meetings'] if m['id'] == '0990')
        self.assertEqual({'stage': 'ready'}, entry['processing'])
        self.assertTrue(entry['audio_available'])
        self.assertEqual(doc['items_file'], self.data.meetings['0990']['items_file'])
        self.assertEqual(200, self.get(base, '/clip/0990/u1-1.wav')[0])
        doc['utterances'][0]['id'] = 'replacement'
        self.publish(doc, audio_name=name)
        self.assertEqual(404, self.get(base, '/clip/0990/u1-1.wav')[0])
        self.assertEqual(200, self.get(base, '/clip/0990/replacement.wav')[0])
        shutil.rmtree(Path(self.folder) / 'meetings' / '0990')
        self.assertNotIn('0990', [m['id'] for m in self.get(base, '/api/me')[1]['meetings']])
        self.assertEqual(404, self.get(base, '/clip/0990/replacement.wav')[0])

    def test_imported_placeholder_is_listed_without_audio_but_legacy_still_requires_it(self):
        doc = self.document(rows=[])
        doc.update(audio_available=False, processing={'stage': 'waiting_audio'})
        self.publish(doc)
        legacy = Path(self.folder) / 'meetings' / '0991'
        legacy.mkdir()
        (legacy / 'meeting.json').write_text(json.dumps(dict(utterances=[], title='不完整旧会议')))
        self.data.refresh()
        self.assertIn('0990', self.data.meetings)
        self.assertNotIn('0991', self.data.meetings)
        self.assertEqual([], self.data.meetings['0990']['rows'])
        self.assertFalse(self.data.meetings['0990']['audio_available'])

    def test_imported_audio_cannot_be_cached_past_a_source_withdrawal(self):
        base = self.server()
        self.publish(self.document())
        headers = {'Authorization': 'Bearer ' + tl.make_key(SECRET, ALICE)}
        request = urllib.request.Request(base + '/clip/0990/u1-1.wav', headers=headers)
        with urllib.request.urlopen(request, timeout=10) as response:
            self.assertEqual('no-store', response.headers['Cache-Control'])
            self.assertGreater(len(response.read()), 44)
        legacy = urllib.request.Request(base + '/clip/0235/a1.wav', headers=headers)
        with urllib.request.urlopen(legacy, timeout=10) as response:
            self.assertEqual('private, max-age=86400', response.headers['Cache-Control'])
            response.read()
        shutil.rmtree(Path(self.folder) / 'meetings' / '0990')
        self.assertEqual(404, self.get(base, '/clip/0990/u1-1.wav')[0])

    def test_partial_json_or_missing_versioned_asset_keeps_last_good_snapshot(self):
        doc = self.document()
        self.publish(doc)
        self.data.refresh()
        target = Path(self.folder) / 'meetings' / '0990' / 'meeting.json'
        target.write_text('{"utterances":')
        self.data.refresh()
        self.assertEqual(doc['title'], self.data.meetings['0990']['title'])
        broken = dict(doc, title='尚未完整提交', audio_file='audio-' + 'b' * 64 + '.wav')
        target.write_text(json.dumps(broken))
        self.data.refresh()
        self.assertEqual(doc['title'], self.data.meetings['0990']['title'])
        broken['audio_file'] = '../private.wav'
        target.write_text(json.dumps(broken))
        self.data.refresh()
        self.assertEqual(doc['title'], self.data.meetings['0990']['title'])
        doc['title'] = '完整的新快照'
        self.publish(doc)
        self.data.refresh()
        self.assertEqual(doc['title'], self.data.meetings['0990']['title'])

    def test_imported_voice_and_role_letters_do_not_expand_or_invalidate_legacy_confirmations(self):
        self.data.review_identity(ALICE, self.identity_body())
        before = {gid: group['fingerprint'] for gid, group in self.data.groups.items()}
        doc = self.document()
        doc['utterances'][0].update(voice=ALICE, role='A')
        self.publish(doc)
        self.write_json(str(Path(self.folder) / 'meetings' / '0990' / 'voice.json'),
                        {'rows': {'u1-1': {'name': ALICE}}})
        self.write_json(str(Path(self.folder) / 'meetings' / '0990' / 'roles.json'),
                        {'rows': {'u1-1': {'role': 'A'}}, 'roles': {'A': {}}})
        self.data.refresh()
        self.assertEqual(before, {gid: group['fingerprint'] for gid, group in self.data.groups.items()})
        self.assertTrue(next(g for g in self.data.identity_payload(BOB)['groups'] if g['id'] == 'role:A')['current'])
        self.assertEqual({}, self.data.resolved_speakers('0990'))
        self.assertEqual([ALICE], shared_roster(self.data))

    def test_source_bound_backend_manual_identity_and_personal_exception_precedence(self):
        doc = self.document()
        row = doc['utterances'][0]
        row['confirmed_speaker'] = ALICE
        row['speaker_source'] = dict(mode='backend_manual', fingerprint=row_fingerprint(row), by=BOB,
            at=dt.datetime.now(dt.timezone.utc).isoformat(), source_session_id='new-session', source_utterance_id='u1')
        self.publish(doc)
        self.data.refresh()
        identity = self.data.resolved_speakers('0990', BOB)['u1-1']
        self.assertEqual(ALICE, identity['speaker'])
        self.assertEqual('backend_manual', identity['speaker_source']['origin'])
        self.set_row('u1-1', 'speaker', BOB, mid='0990', name=BOB)
        self.assertEqual(BOB, self.data.resolved_speakers('0990', BOB)['u1-1']['speaker'])
        self.assertEqual(ALICE, self.data.resolved_speakers('0990', ALICE)['u1-1']['speaker'])
        self.set_row('u1-1', 'speaker', None, mid='0990', name=BOB)
        self.assertEqual({'speaker_excluded': True}, self.data.resolved_speakers('0990', BOB)['u1-1'])
        row['text'] += '来源修订。'
        self.publish(doc)
        self.data.refresh()
        self.assertEqual({}, self.data.resolved_speakers('0990', ALICE))
        row['speaker_source']['fingerprint'] = row_fingerprint(row)
        doc['shared_roster'] = [BOB]
        self.publish(doc)
        self.data.refresh()
        self.assertEqual({}, self.data.resolved_speakers('0990', ALICE))

    def test_ttl_and_missing_policy_block_assets_in_http_without_mutating_answers(self):
        base = self.server()
        doc = self.document()
        doc['storage_policy'] = self.policy(audio_hours=-1)
        self.publish(doc)
        self.assertEqual(410, self.get(base, '/clip/0990/u1-1.wav')[0])
        self.assertTrue(self.data.meetings['0990']['rows'])
        doc['storage_policy'] = self.policy(transcript_hours=-1)
        self.publish(doc)
        entry = next(m for m in self.get(base, '/api/me')[1]['meetings'] if m['id'] == '0990')
        self.assertEqual('expired', entry['processing']['stage'])
        self.assertEqual([], self.get(base, '/api/meeting/0990')[1]['rows'])
        self.assertEqual(410, self.get(base, '/clip/0990/u1-1.wav')[0])
        doc['storage_policy'] = None
        self.publish(doc)
        entry = next(m for m in self.get(base, '/api/me')[1]['meetings'] if m['id'] == '0990')
        self.assertEqual('waiting_policy', entry['processing']['stage'])
        self.assertFalse(entry['audio_available'])

    def test_expiry_is_rechecked_even_when_catalog_files_do_not_change(self):
        doc = self.document()
        self.publish(doc)
        self.data.refresh()
        revision = self.data.catalog_revision
        future = dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=2)
        with mock.patch('team_label.dt.datetime', wraps=dt.datetime) as clock:
            clock.now.return_value = future
            self.data.refresh()
        self.assertNotEqual(revision, self.data.catalog_revision)
        self.assertEqual([], self.data.meetings['0990']['rows'])
        self.assertFalse(self.data.meetings['0990']['audio_available'])

    def test_import_without_audio_and_aliased_backend_identity_are_supported(self):
        doc = self.document()
        doc.update(audio_file=None, audio_available=False)
        row = doc['utterances'][0]
        row.update(origin_id='native-original', confirmed_speaker=ALICE)
        row['speaker_source'] = dict(mode='backend_manual', fingerprint=row_fingerprint(row), by=BOB,
            at=dt.datetime.now(dt.timezone.utc).isoformat(), source_session_id='new-session',
            source_utterance_id='native-original')
        self.publish(doc)
        self.data.refresh()
        self.assertIn('0990', self.data.meetings)
        self.assertFalse(self.data.meetings['0990']['audio_available'])
        self.assertEqual('existing_summary', self.data.meetings['0990']['source_kind'])
        self.assertEqual(ALICE, self.data.resolved_speakers('0990')['u1-1']['speaker'])

    def test_legacy_zero_duration_context_is_preserved_but_new_import_is_rejected(self):
        source = Path(self.folder) / 'meetings' / '0235' / 'meeting.json'
        legacy = json.loads(source.read_text())
        legacy['utterances'][0]['end_ms'] = legacy['utterances'][0]['start_ms']
        source.write_text(json.dumps(legacy))
        self.data.refresh()
        self.assertIn('0235', self.data.meetings)
        doc = self.document()
        doc['utterances'][0]['end_ms'] = doc['utterances'][0]['start_ms']
        self.publish(doc)
        self.data.refresh()
        self.assertNotIn('0990', self.data.meetings)

    def test_managed_source_guard_blocks_withdrawal_and_fails_closed_without_writes(self):
        doc = self.document()
        doc.update(source_managed=True, source_backend=self.folder,
                   source_minutes_fingerprint='a' * 64, source_revision='b' * 64,
                   source_audio_sha256='c' * 64)
        self.publish(doc)
        with mock.patch('label_auto_import.live_guard', create=True, return_value=None) as guard:
            self.data.refresh()
            self.assertTrue(self.data.meetings['0990']['rows'])
            guard.assert_called_with(self.folder, self.folder, 'new-session', 'a' * 64,
                                     expected_revision='b' * 64, expected_audio_sha256='c' * 64)
        before = Path(self.folder, 'meetings', '0990', 'meeting.json').read_bytes()
        with mock.patch('label_auto_import.live_guard', create=True,
                        return_value={'stage': 'stale', 'reason_code': 'source_deleted'}):
            self.data.refresh()
            self.assertEqual([], self.data.meetings['0990']['rows'])
            self.assertFalse(self.data.meetings['0990']['audio_available'])
            self.assertEqual('source_deleted', self.data.meetings['0990']['processing']['reason_code'])
        with mock.patch('label_auto_import.live_guard', create=True, side_effect=OSError('unavailable')):
            self.data.refresh()
            self.assertEqual([], self.data.meetings['0990']['rows'])
            self.assertEqual('waiting_policy', self.data.meetings['0990']['processing']['stage'])
        self.assertEqual(before, Path(self.folder, 'meetings', '0990', 'meeting.json').read_bytes())

    def test_managed_ready_snapshot_requires_source_and_audio_version_hashes(self):
        doc = self.document()
        doc.update(source_managed=True, source_backend=self.folder,
                   source_minutes_fingerprint='a' * 64, source_revision='b' * 64,
                   source_audio_sha256='c' * 64)
        for field in ('source_revision', 'source_audio_sha256', 'source_minutes_fingerprint'):
            with self.subTest(field=field):
                invalid = dict(doc, **{field: 'not-a-source-hash'})
                self.publish(invalid)
                with mock.patch('label_auto_import.live_guard', create=True, return_value=None) as guard:
                    self.data.refresh()
                    self.assertFalse(self.data.meetings['0990']['rows'])
                    self.assertFalse(self.data.meetings['0990']['audio_available'])
                    guard.assert_not_called()

    def test_parallel_http_catalog_reads_and_atomic_updates_remain_consistent_and_do_not_generate(self):
        base = self.server()
        doc = self.document()
        self.publish(doc)
        def update():
            for n in range(12):
                current = copy.deepcopy(doc)
                current['title'] = '完整快照' + str(n)
                self.publish(current)
        with mock.patch('label_items.generate', side_effect=AssertionError('GET must not generate')):
            with ThreadPoolExecutor(max_workers=6) as pool:
                writer = pool.submit(update)
                futures = [pool.submit(self.get, base, '/api/me') for _ in range(24)]
                for future in futures:
                    status, body = future.result()
                    self.assertEqual(200, status)
                    self.assertEqual(3, len(body['meetings']))
                    self.assertTrue(body['catalog_revision'])
                writer.result()
            self.assertEqual(200, self.get(base, '/api/meeting/0990/items')[0])


if __name__ == '__main__':
    unittest.main()
