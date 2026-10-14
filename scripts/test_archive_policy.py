"""No network/model/real data: consent, independent TTLs, expiry copies and legacy non-migration."""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import shutil
import select
import subprocess
import sys
import tempfile
import threading
import types
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from unittest.mock import patch

from archive_policy import ArchivePolicies, ArchivePolicyError, policy_from_request
from cleanup_archives import cleanup, mirror_lock, pull_and_cleanup
from meeting_features import Meetings
from recordings import Recordings, RecordingError
from local_backend import Backend, Handler, Operations, TagCache, SplitJobs
from feishu_actions import FeishuActions, State, Jobs, MinutesSourceChanged


def sha(value): return hashlib.sha256(value).hexdigest()


class ArchivePolicyTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.now = dt.datetime.now(dt.timezone.utc)
        self.sid = 'policy-session-01'
        self.contract = dict(recording_mode='meeting', cloud_save_confirmed=True,
                             archive_started_at=self.now.isoformat(), audio_retention_days=30, transcript_retention_days=30)
        self.registry = ArchivePolicies(str(self.root / 'archive-policies'))
        self.ops = Operations(str(self.root / 'operations'))
        self.meetings = Meetings(str(self.root / 'meetings'), self.ops, policies=self.registry, require_storage_policy=True)
        self.recordings = Recordings(str(self.root / 'recordings'), policies=self.registry, require_storage_policy=True)
        self.quote = '我们确认用紫色品牌。'
        self.secret = '这段只是临时讨论，不应被保留为全场记录。'
        self.rows = [dict(id='u1', text=self.quote, start_ms=0, end_ms=1000, tag='decision'),
                     dict(id='u2', text=self.secret, start_ms=1000, end_ms=2000, tag='chitchat')]
        self.body = dict(session_id=self.sid, started_at=self.now.isoformat(), utterances=self.rows, **self.contract)
        self.audio = b'\0\0' * 32000
        self.finals = (json.dumps(self.rows, ensure_ascii=False) + '\n').encode()
        self.files = [dict(name='audio.pcm', size=len(self.audio), sha256=sha(self.audio)),
                      dict(name='finals.jsonl', size=len(self.finals), sha256=sha(self.finals)),
                      dict(name='asr.jsonl', size=len(self.finals), sha256=sha(self.finals))]

    def upload(self, contract=None):
        self.recordings.manifest(self.sid, dict(files=self.files, meta={'diagnostic': self.secret}, **(contract or self.contract)))
        for name, value in (('audio.pcm', self.audio), ('finals.jsonl', self.finals), ('asr.jsonl', self.finals)):
            self.recordings.chunk(self.sid, name, 0, value, sha(value))
        self.recordings.complete(self.sid)

    def test_daily_unconfirmed_and_missing_contract_never_write_archives(self):
        for updates in ({'recording_mode': 'daily'}, {'cloud_save_confirmed': False},
                        {'cloud_save_confirmed': 'true'}):
            with self.subTest(updates=updates):
                with self.assertRaises(ArchivePolicyError): self.meetings.sync(dict(self.body, **updates))
                with self.assertRaises(RecordingError): self.recordings.manifest(self.sid, dict(files=self.files, **dict(self.contract, **updates)))
        with self.assertRaises(ArchivePolicyError):
            self.meetings.sync({key: value for key, value in self.body.items() if key not in self.contract})
        with self.assertRaises(RecordingError): self.recordings.manifest(self.sid, {'files': self.files})
        self.assertFalse(Path(self.meetings.path(self.sid)).exists())
        self.assertFalse(Path(self.recordings.folder(self.sid)).exists())

    def test_defaults_are_separate_30_days_and_retries_cannot_extend(self):
        minimal = {key: value for key, value in self.body.items() if key not in ('audio_retention_days', 'transcript_retention_days')}
        first = self.meetings.sync(minimal)['storage_policy']
        expected = (self.now + dt.timedelta(days=30)).isoformat()
        self.assertEqual(expected, first['audio_expires_at'])
        self.assertEqual(expected, first['transcript_expires_at'])
        self.assertEqual(first, self.meetings.sync(minimal)['storage_policy'])
        self.upload()
        with self.assertRaises(RecordingError) as wrong:
            self.recordings.manifest(self.sid, dict(files=self.files, **dict(self.contract, audio_retention_days=90)))
        self.assertEqual(409, wrong.exception.status)
        self.assertEqual(first, self.recordings.status(self.sid)['storage_policy'])

    def test_invalid_days_future_or_rebased_session_fail_closed(self):
        for value in (0, 180, True, '30', None):
            with self.subTest(days=value):
                with self.assertRaises(ArchivePolicyError): policy_from_request(dict(self.contract, audio_retention_days=value))
        with self.assertRaises(ArchivePolicyError):
            policy_from_request(dict(self.contract, archive_started_at=(self.now + dt.timedelta(hours=1)).isoformat()))
        with self.assertRaises(ArchivePolicyError):
            policy_from_request(dict(self.contract, started_at=(self.now - dt.timedelta(minutes=5)).isoformat()))

    def test_legacy_history_stays_unexpired_and_is_not_silently_migrated(self):
        old = (self.now - dt.timedelta(days=365)).isoformat()
        legacy = Meetings(str(self.root / 'legacy'), retention_days=0)
        legacy.sync(dict(session_id='old', started_at=old, utterances=self.rows))
        strict = Meetings(legacy.dir, require_storage_policy=True)
        strict.cleanup(self.now + dt.timedelta(days=90))
        self.assertEqual(2, len(strict.load('old')['utterances']))
        strict.sync(dict(session_id='old', started_at=old, utterances=[]))
        self.assertNotIn('storage_policy', strict.load('old'))
        with self.assertRaises(ArchivePolicyError): strict.sync(dict(self.body, session_id='old', started_at=old))

    def test_audio_expiry_keeps_longer_transcript_and_cannot_be_revived(self):
        contract = dict(self.contract, audio_retention_days=7, transcript_retention_days=90)
        self.meetings.sync(dict(self.body, **contract))
        self.upload(contract)
        self.recordings.cleanup(self.now + dt.timedelta(days=8))
        folder = Path(self.recordings.folder(self.sid))
        self.assertFalse((folder / 'audio.pcm').exists())
        self.assertEqual(self.finals, (folder / 'finals.jsonl').read_bytes())
        self.assertEqual({'audio': 'expired', 'transcript': 'available'}, self.recordings.status(self.sid)['assets'])
        for action in (lambda: self.recordings.clip(self.sid, 0, 500),
                       lambda: self.recordings.chunk(self.sid, 'audio.pcm', 0, self.audio, sha(self.audio)),
                       lambda: self.recordings.manifest(self.sid, dict(files=self.files, **contract))):
            with self.assertRaises(RecordingError) as gone: action()
            self.assertEqual(410, gone.exception.status)
            self.assertEqual('audio', gone.exception.extra['asset'])
        self.assertEqual(2, len(self.meetings.load(self.sid)['utterances']))

    def test_fulltext_expiry_purges_every_raw_text_copy_but_keeps_audio(self):
        contract = dict(self.contract, audio_retention_days=90, transcript_retention_days=7)
        self.meetings.sync(dict(self.body, **contract))
        self.upload(contract)
        # Simulate a legacy writer which accidentally persisted derived items.
        path = Path(self.meetings.path(self.sid))
        legacy = json.loads(path.read_text())
        legacy['items'] = [dict(title='派生事项', evidence=[dict(text=self.secret)])]
        path.write_text(json.dumps(legacy, ensure_ascii=False))
        future = self.now + dt.timedelta(days=8)
        self.meetings.cleanup(future); self.recordings.cleanup(future)
        row = self.meetings.load(self.sid)
        self.assertEqual([], row['utterances'])
        self.assertEqual('expired', row['transcript_status'])
        self.assertNotIn('items', row)
        self.assertNotIn(self.secret, Path(self.meetings.path(self.sid)).read_text())
        folder = Path(self.recordings.folder(self.sid))
        self.assertFalse((folder / 'finals.jsonl').exists())
        self.assertFalse((folder / 'asr.jsonl').exists())
        self.assertNotIn(self.secret, (folder / 'manifest.json').read_text())
        self.assertTrue((folder / 'audio.pcm').exists())
        self.assertEqual('available', self.recordings.status(self.sid)['assets']['audio'])
        self.assertGreater(len(self.recordings.clip(self.sid, 0, 500)), 44)
        with self.assertRaises(ArchivePolicyError) as refused: self.meetings.sync(dict(self.body, **contract))
        self.assertEqual(410, refused.exception.status)
        with self.assertRaises(RecordingError) as refused:
            self.recordings.chunk(self.sid, 'finals.jsonl', 0, self.finals, sha(self.finals))
        self.assertEqual('transcript', refused.exception.extra['asset'])

    def test_confirmed_summary_short_evidence_and_task_survive_fulltext_expiry(self):
        self.meetings.sync(self.body)
        self.meetings.set_project(dict(session_id=self.sid, project='Oops'))
        self.meetings.review(dict(session_id=self.sid, utterance_id='u1', verdict='confirmed'))
        self.meetings.retain(dict(session_id=self.sid, confirm=True, evidence=[dict(id='u1', quote=self.quote, expected_text_hash=sha(self.quote.encode()))],
                                  summaries=[dict(id='summary-1', text='品牌使用紫色。', source_ids=['u1'])]))
        self.ops.save(dict(op_id='confirmed-task-01', status='created', request=dict(session_id=self.sid,
                           draft={'what': '更新品牌页面'}, evidence={'quote': self.quote, 'utterance_ids': ['u1']})))
        self.meetings.cleanup(self.now + dt.timedelta(days=31))
        row = self.meetings.load(self.sid)
        self.assertEqual([], row['utterances'])
        self.assertEqual('品牌使用紫色。', row['retained_summaries'][0]['text'])
        self.assertEqual('expired', row['retained_evidence'][0]['source_status'])
        self.assertEqual(self.quote, row['retained_evidence'][0]['text'])
        self.assertEqual(1, len(row['tasks']))
        self.assertTrue(Path(self.ops.path('confirmed-task-01')).exists())
        self.assertNotIn(self.secret, json.dumps(row, ensure_ascii=False))
        decision = self.meetings.project('Oops')['decisions'][0]
        self.assertEqual(self.quote, decision['text'])
        self.assertEqual('saved_excerpt', decision['source_kind'])
        self.assertEqual('retained', decision['source_status'])  # independently retained, still usable as evidence

    def test_changed_source_does_not_turn_old_confirmation_into_new_summary(self):
        self.meetings.sync(self.body)
        self.meetings.review(dict(session_id=self.sid, utterance_id='u1', verdict='confirmed'))
        self.meetings.sync(dict(self.body, utterances=[dict(self.rows[0], text='现在只是在比较蓝色方案。')]))
        self.meetings.cleanup(self.now + dt.timedelta(days=31))
        row = self.meetings.load(self.sid)
        self.assertEqual([], row['retained_evidence'])
        self.assertNotIn('蓝色方案', json.dumps(row, ensure_ascii=False))

    def test_expiry_does_not_revalidate_an_independent_quote_changed_before_expiry(self):
        self.meetings.sync(self.body)
        self.meetings.set_project(dict(session_id=self.sid, project='Oops'))
        self.meetings.retain(dict(session_id=self.sid, confirm=True, evidence=[dict(id='u1', quote=self.quote, expected_text_hash=sha(self.quote.encode()))],
                                  summaries=[dict(id='summary-1', text='紫色品牌。', source_ids=['u1'])]))
        self.meetings.sync(dict(self.body, utterances=[dict(self.rows[0], text=self.quote + '但这个决定随后取消。')]))
        self.meetings.cleanup(self.now + dt.timedelta(days=31))
        row = self.meetings.load(self.sid)
        self.assertEqual('changed', row['retained_evidence'][0]['source_status'])
        self.assertEqual('changed', row['retained_summaries'][0]['source_status'])
        self.assertEqual([], self.meetings.project('Oops')['decisions'])

    def test_independent_retention_requires_current_exact_short_quote_and_confirmation(self):
        self.meetings.sync(self.body)
        for body in (dict(confirm=False, evidence=[]), dict(confirm=True, evidence=[dict(id='u1', quote='不存在的原话')]),
                     dict(confirm=True, evidence=[dict(id='u1', quote='a' * 281)]),
                     dict(confirm=True, summaries=[dict(id='s1', text='结论', source_ids=['missing'])])):
            with self.subTest(body=body):
                with self.assertRaises(ValueError): self.meetings.retain(dict(session_id=self.sid, **body))
        self.assertFalse(self.meetings.load(self.sid).get('retained_summaries'))

    def test_retention_rejects_stale_fulltext_hash_even_when_quote_is_still_present(self):
        self.meetings.sync(self.body)
        request = dict(session_id=self.sid, confirm=True,
                       evidence=[dict(id='u1', quote=self.quote, expected_text_hash=sha(self.quote.encode()))],
                       summaries=[dict(id='summary-1', text='品牌使用紫色。', source_ids=['u1'])])
        self.meetings.retain(request)
        repeated = self.meetings.retain(request)
        self.assertEqual(1, len(repeated['retained_evidence']))
        self.assertEqual(1, len(repeated['retained_summaries']))
        changed = self.quote + '但这个决定随后取消。'
        self.meetings.sync(dict(self.body, utterances=[dict(self.rows[0], text=changed), self.rows[1]]))
        before = Path(self.meetings.path(self.sid)).read_bytes()
        with self.assertRaises(ArchivePolicyError) as refused: self.meetings.retain(request)
        self.assertEqual(409, refused.exception.status)
        self.assertEqual('transcript', refused.exception.extra['asset'])
        self.assertEqual(before, Path(self.meetings.path(self.sid)).read_bytes())
        self.assertEqual('changed', self.meetings.load(self.sid)['retained_summaries'][0]['source_status'])
        for invalid in (None, '', 'A' * 64, 'not-a-hash'):
            bad = dict(request, evidence=[dict(id='u1', quote=self.quote, expected_text_hash=invalid)])
            with self.assertRaises(ValueError): self.meetings.retain(bad)
        fresh = dict(request, evidence=[dict(id='u1', quote=self.quote, expected_text_hash=sha(changed.encode()))], summaries=[])
        self.assertEqual('available', self.meetings.retain(fresh)['retained_evidence'][0]['source_status'])
        self.assertEqual('changed', self.meetings.load(self.sid)['retained_summaries'][0]['source_status'])
        self.meetings.cleanup(self.now + dt.timedelta(days=31))
        self.assertEqual('changed', self.meetings.load(self.sid)['retained_summaries'][0]['source_status'])

    def test_new_summary_cannot_reuse_an_old_quote_without_current_source_confirmation(self):
        self.meetings.sync(self.body)
        self.meetings.retain(dict(session_id=self.sid, confirm=True,
            evidence=[dict(id='u1', quote=self.quote, expected_text_hash=sha(self.quote.encode()))]))
        before = Path(self.meetings.path(self.sid)).read_bytes()
        with self.assertRaises(ValueError):
            self.meetings.retain(dict(session_id=self.sid, confirm=True,
                evidence=[dict(id='u2', quote=self.secret, expected_text_hash=sha(self.secret.encode()))],
                summaries=[dict(id='summary-2', text='重新使用旧依据', source_ids=['u1'])]))
        self.assertEqual(before, Path(self.meetings.path(self.sid)).read_bytes())

    def test_replacing_the_selected_excerpt_does_not_reconfirm_its_old_summary(self):
        original = self.quote + self.secret
        self.meetings.sync(dict(self.body, utterances=[dict(self.rows[0], text=original)]))
        quote = dict(id='u1', quote=self.quote, expected_text_hash=sha(original.encode()))
        self.meetings.retain(dict(session_id=self.sid, confirm=True, evidence=[quote],
                                summaries=[dict(id='summary-1', text='使用紫色。', source_ids=['u1'])]))
        self.meetings.retain(dict(session_id=self.sid, confirm=True, evidence=[dict(quote, quote=self.secret)]))
        self.assertEqual('changed', self.meetings.load(self.sid)['retained_summaries'][0]['source_status'])
        self.meetings.cleanup(self.now + dt.timedelta(days=31))
        self.assertEqual('changed', self.meetings.load(self.sid)['retained_summaries'][0]['source_status'])

    def test_service_start_and_offline_mirror_cleanup_share_the_same_rules(self):
        self.meetings.sync(self.body); self.upload()
        mirror = self.root / 'mirror'
        shutil.copytree(self.root / 'meetings', mirror / 'meetings')
        shutil.copytree(self.root / 'recordings', mirror / 'recordings')
        result = cleanup(str(mirror), self.now + dt.timedelta(days=31))
        self.assertEqual(1, result['transcripts'])
        self.assertEqual(3, result['recording_files'])
        self.assertFalse((mirror / 'recordings' / self.sid / 'audio.pcm').exists())
        with self.assertRaises(ValueError): cleanup('https://untrusted.invalid/archive')
        backend = Backend.__new__(Backend)
        backend.meetings, backend.recordings, backend.feishu = self.meetings, self.recordings, None
        real_cleanup = backend.cleanup_storage
        periodic = threading.Event()
        def checked_cleanup():
            result = real_cleanup()
            if called.call_count >= 2: periodic.set()
            return result
        with patch.object(backend, 'cleanup_storage', side_effect=checked_cleanup) as called:
            stop = backend.start_storage_cleanup()
            try:
                self.assertTrue(periodic.wait(6))  # actual five-second service loop; no HTTP reads
                self.assertGreaterEqual(called.call_count, 2)
            finally: stop.set()

    def expired_mirror_fixture(self, destination):
        shutil.copytree(self.root / 'meetings', destination / 'meetings')
        shutil.copytree(self.root / 'recordings', destination / 'recordings')
        for path in [destination / 'meetings' / (self.sid + '.json'),
                     destination / 'recordings' / self.sid / 'manifest.json']:
            row = json.loads(path.read_text())
            for asset in ('audio', 'transcript'):
                row['storage_policy'][asset + '_expires_at'] = (self.now - dt.timedelta(seconds=1)).isoformat()
            path.write_text(json.dumps(row, ensure_ascii=False))

    def test_existing_mac_cleanup_entry_enforces_ttl_without_contacting_server(self):
        self.meetings.sync(self.body); self.upload()
        mirror = self.root / 'mac-mirror'
        self.expired_mirror_fixture(mirror)
        repo = Path(__file__).resolve().parent.parent
        env = dict(os.environ, OOPS_ARCHIVE_DEST=str(mirror), OOPS_ARCHIVE_REPO=str(repo),
                   OOPS_ARCHIVE_PYTHON=sys.executable, OOPS_ARCHIVE_HOST='unreachable.invalid')
        result = subprocess.run(['/bin/sh', str(repo / 'deploy/mac/oops-archive-pull.sh'), '--cleanup-only'],
                                env=env, capture_output=True, text=True, check=True)
        self.assertEqual(3, json.loads(result.stdout)['recording_files'])
        self.assertFalse((mirror / 'recordings' / self.sid / 'audio.pcm').exists())
        self.assertEqual([], json.loads((mirror / 'meetings' / (self.sid + '.json')).read_text())['utterances'])

    def test_failed_mirror_pull_still_cleans_expired_assets_it_just_copied(self):
        self.meetings.sync(self.body); self.upload()
        mirror = self.root / 'mirror'
        (mirror / 'meetings').mkdir(parents=True); (mirror / 'recordings').mkdir()
        source = self.root / 'expired-source'
        self.expired_mirror_fixture(source)
        import shlex
        script = self.root / 'fake-pull.sh'
        script.write_text('cp -R ' + shlex.quote(str(source / 'meetings')) + ' ' + shlex.quote(str(mirror)) + '\n' +
                          'cp -R ' + shlex.quote(str(source / 'recordings')) + ' ' + shlex.quote(str(mirror)) + '\nexit 9\n')
        with mirror_lock(str(mirror)):
            with self.assertRaises(subprocess.CalledProcessError): pull_and_cleanup(str(mirror), str(script))
        self.assertFalse((mirror / 'recordings' / self.sid / 'audio.pcm').exists())
        self.assertEqual([], json.loads((mirror / 'meetings' / (self.sid + '.json')).read_text())['utterances'])

    def test_mirror_sweep_waits_for_another_process_holding_the_pull_lock(self):
        child_code = ('from cleanup_archives import mirror_lock\nimport sys\n' +
                      "print('ready', flush=True)\nwith mirror_lock(sys.argv[1]): print('locked', flush=True)\n")
        with mirror_lock(str(self.root)):
            child = subprocess.Popen([sys.executable, '-c', child_code, str(self.root)],
                                     cwd=Path(__file__).resolve().parent, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            self.addCleanup(lambda: child.kill() if child.poll() is None else None)
            self.assertEqual('ready', child.stdout.readline().strip())
            self.assertEqual([], select.select([child.stdout], [], [], .1)[0])
        out, err = child.communicate(timeout=3)
        self.assertEqual(0, child.returncode, err)
        self.assertEqual('locked', out.strip())

    def test_expiry_purges_helper_fulltext_and_stops_pending_delivery_preserving_results(self):
        self.meetings.sync(self.body)
        state = State(str(self.root / 'feishu'))
        jobs = Jobs(str(self.root / 'agent-jobs'))
        state.put({'overview': '旧候选纪要'}, 'meetings', self.sid, 'analysis')
        pending, _ = jobs.add('report', dict(session_id=self.sid, transcript=self.secret, context=self.secret), ['person'])
        done, _ = jobs.add('research', dict(session_id=self.sid, context=self.secret, quote=self.quote), ['person'])
        done.update(status='done', result={'text': '已独立形成的成果'}); jobs.save(done)
        self.meetings.cleanup(self.now + dt.timedelta(days=31))
        holder = types.SimpleNamespace(state=state, jobs=jobs)
        FeishuActions.expire_meeting_sources(holder, self.sid)
        self.assertIsNone(state.get('meetings', self.sid, 'analysis'))
        pending = jobs.load(pending['id'])
        self.assertEqual('failed', pending['status'])
        self.assertEqual('source_expired', pending['reason'])
        self.assertNotIn(self.secret, json.dumps(pending, ensure_ascii=False))
        self.assertEqual('已独立形成的成果', jobs.load(done['id'])['result']['text'])
        with self.assertRaises(MinutesSourceChanged): FeishuActions.current_job_minutes(holder, pending)

    def test_late_automatic_minutes_cannot_recreate_expired_candidate_cache(self):
        self.meetings.sync(self.body)
        row = self.meetings.load(self.sid)
        state, jobs = State(str(self.root / 'feishu')), Jobs(str(self.root / 'agent-jobs'))
        def delayed_analysis(_):
            self.meetings.cleanup(self.now + dt.timedelta(days=31))
            return dict(overview=self.secret)
        holder = types.SimpleNamespace(backend=types.SimpleNamespace(meetings=self.meetings), state=state, jobs=jobs,
            log=lambda _: None, participants=lambda _: [], analyse=delayed_analysis,
            minutes_fingerprint=FeishuActions.minutes_fingerprint)
        FeishuActions.after_meeting(holder, row)
        self.assertIsNone(state.get('meetings', self.sid, 'analysis'))
        # A prior worker/version may have written late even after the tombstone: repeated cleanup must purge it.
        state.put(dict(transcript_expired=True, analysis={'overview': self.secret}), 'meetings', self.sid)
        pending, _ = jobs.add('report', dict(session_id=self.sid, source_expired=True, transcript=self.secret), ['person'])
        FeishuActions.expire_meeting_sources(holder, self.sid)
        self.assertIsNone(state.get('meetings', self.sid, 'analysis'))
        self.assertNotIn(self.secret, json.dumps(jobs.load(pending['id']), ensure_ascii=False))

    def test_temporary_analysis_caches_expire_in_five_minutes_without_persistent_records(self):
        backend = Backend.__new__(Backend)
        backend.speaker_state_lock = threading.RLock()
        backend.speaker_evidence = {('daily', 'u1'): dict(text=self.secret, at=10, segments=[])}
        backend.trial_evidence = {('daily', 'u1'): dict(text=self.secret, at=10, segments=[])}
        backend.task_cache = {('daily', 'u1', self.secret): ['old']}
        backend.task_cache_at = {next(iter(backend.task_cache)): 10}
        backend.task_cache_at[('evicted', self.secret)] = 10
        backend.tags = TagCache()
        backend.tags.values['old'], backend.tags.saved_at['old'] = {'task_clause': self.secret}, 10
        backend.speaker_cache = TagCache()
        backend.speaker_cache.values['old'], backend.speaker_cache.saved_at['old'] = {'segments': [self.secret]}, 10
        backend.prune_transient_caches(now=310)
        self.assertEqual({}, backend.speaker_evidence)
        self.assertEqual({}, backend.trial_evidence)
        self.assertEqual({}, backend.task_cache)
        self.assertEqual({}, backend.task_cache_at)
        self.assertEqual({}, backend.tags.values)
        self.assertEqual({}, backend.speaker_cache.values)

    def test_authenticated_http_refuses_daily_sync_and_returns_contract(self):
        backend = Backend.__new__(Backend)
        backend.meetings, backend.recordings, backend.jev = self.meetings, self.recordings, None
        backend.speaker_state_lock = threading.RLock()
        backend.manual_speakers = {}
        class Protected(Handler): api_token = 'offline-test-key'
        Protected.backend = backend
        server = ThreadingHTTPServer(('127.0.0.1', 0), Protected)
        worker = threading.Thread(target=server.serve_forever, daemon=True); worker.start()
        self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
        url = 'http://127.0.0.1:' + str(server.server_port)
        def request(path, body):
            req = urllib.request.Request(url + path, data=json.dumps(body).encode(),
                  headers={'Authorization': 'Bearer offline-test-key', 'Content-Type': 'application/json'})
            try:
                with urllib.request.urlopen(req) as response: return response.status, json.load(response)
            except urllib.error.HTTPError as error: return error.code, json.load(error)
        self.assertEqual(400, request('/v1/meetings/sync', dict(self.body, recording_mode='daily'))[0])
        status, result = request('/v1/meetings/sync', self.body)
        self.assertEqual(200, status)
        self.assertEqual(30, result['storage_policy']['audio_retention_days'])
        self.assertEqual('available', result['transcript_status'])
        status, result = request('/v1/recordings/' + self.sid + '/manifest', dict(files=self.files, **self.contract))
        self.assertEqual(200, status)
        self.assertEqual('meeting', result['storage_policy']['recording_mode'])
        retain = dict(session_id=self.sid, confirm=True,
                      evidence=[dict(id='u1', quote=self.quote, expected_text_hash=sha(self.quote.encode()))], summaries=[])
        self.assertEqual(400, request('/v1/meetings/retain', dict(retain, evidence=[dict(id='u1', quote=self.quote)]))[0])
        self.assertEqual(200, request('/v1/meetings/retain', retain)[0])
        self.assertEqual(200, request('/v1/meetings/sync', dict(self.body,
                             utterances=[dict(self.rows[0], text=self.quote + '但随后取消。')]))[0])
        status, result = request('/v1/meetings/retain', retain)
        self.assertEqual(409, status)
        self.assertEqual('ARCHIVE_POLICY', result['error']['code'])
        self.assertEqual('transcript', result['error']['asset'])


if __name__ == '__main__': unittest.main()
