#!/usr/bin/env python3
"""Grant-scoped, single-attempt adapter for Oops' existing Volc streaming ASR.

No capture, meeting sync, task creation, speaker identification or delivery is
performed here. Only explicitly submitted PCM is transcribed. Provider secrets
and raw provider errors never enter job responses or logs.
"""
import datetime as dt
import gzip
import hashlib
import http.client
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import ssl
import stat
import threading
import time
import unicodedata
import uuid

ENGINE = 'volc-bigmodel-async'
ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async'
MAX_CHUNK_MS = 32_000
MAX_SESSION_MS = 1_800_000
MAX_PCM_BYTES = 1_100_000
MAX_PENDING = 64
MAX_SESSION_JOBS = 128
MAX_FINALS = 128
MAX_RESULT_BYTES = 1_000_000
CONFIG_KEYS = {'VOLC_API_KEY', 'VOLC_APP_ID', 'VOLC_ACCESS_TOKEN', 'VOLC_RESOURCE_ID'}
FILLERS = set('嗯呃额啊哦噢唉哎诶欸哈嘿唔')
TAGS = {'commitment', 'decision', 'idea', 'constraint', 'chitchat', 'uncertain'}
SAFE_EXCEPTION_TYPES = {'AsrError', 'ValueError', 'TypeError', 'OverflowError', 'RuntimeError',
                        'OSError', 'PermissionError', 'FileNotFoundError', 'TimeoutError',
                        'ConnectionError', 'SSLError', 'JSONDecodeError', 'UnicodeDecodeError',
                        'OperationalError', 'IntegrityError', 'WebSocketException',
                        'WebSocketTimeoutException', 'WebSocketConnectionClosedException',
                        'WebSocketBadStatusException'}


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(',', ':'), allow_nan=False).encode()


def timestamp(value):
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


class AsrError(Exception):
    def __init__(self, status, code, message):
        self.status, self.code, self.message = status, code, message


def reject(status, code, message):
    raise AsrError(status, code, message)


def configuration(filename):
    if not filename:
        return None
    path = Path(filename)
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return None
    with os.fdopen(fd, 'rb') as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid not in (0, os.geteuid()):
            raise ValueError('ASR configuration must be a trusted private 0600 regular file')
        raw = source.read(65_537)
    if len(raw) > 65_536:
        raise ValueError('ASR configuration is too large')
    values = json.loads(raw)
    if not isinstance(values, dict) or set(values) - CONFIG_KEYS or any(
            not isinstance(v, str) or len(v) > 4096 or '\r' in v or '\n' in v for v in values.values()):
        raise ValueError('ASR configuration must contain only VOLC string fields')
    values = {key: values.get(key, '').strip() for key in CONFIG_KEYS}
    if not (values['VOLC_API_KEY'] or values['VOLC_APP_ID'] and values['VOLC_ACCESS_TOKEN']):
        return None
    values['VOLC_RESOURCE_ID'] = values['VOLC_RESOURCE_ID'] or 'volc.seedasr.sauc.duration'
    return values


def purge_revoked(store, gid):
    """CLI revocation also removes ASR plaintext without starting a worker."""
    spool = Path(store.path).parent / 'asr-pcm'
    with store.transaction() as db:
        if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='asr_jobs'").fetchone():
            return
        paths = [r[0] for r in db.execute('SELECT pcm_path FROM asr_jobs WHERE grant_id=? AND pcm_path IS NOT NULL', (gid,))]
        db.execute("UPDATE asr_jobs SET state='failed',result=NULL,processing=NULL,pcm_path=NULL,provider_closure=NULL,error_code='GRANT_UNAVAILABLE',updated=? WHERE grant_id=?",
                   (time.time(), gid))
        db.execute('UPDATE requests SET response=NULL WHERE grant_id=? AND id IN (SELECT request_id FROM asr_request_jobs WHERE grant_id=?)', (gid, gid))
    for name in paths:
        path = Path(name)
        if path.parent != spool or not re.fullmatch(r'[a-f0-9]{32}\.pcm', path.name):
            continue
        try:
            if stat.S_ISREG(path.lstat().st_mode):
                path.unlink()
        except FileNotFoundError:
            pass


class AsrService:
    def __init__(self, store, upstream, config_file=None, workers=2):
        self.store, self.upstream = store, upstream
        self.credentials = configuration(config_file)
        self.available = bool(self.credentials and importlib.util.find_spec('websocket')
                              and importlib.util.find_spec('asr_words_probe'))
        self.spool = Path(store.path).parent / 'asr-pcm'
        self.spool.mkdir(mode=0o700, exist_ok=True)
        info = self.spool.lstat()
        if not stat.S_ISDIR(info.st_mode) or self.spool.resolve() != self.spool or info.st_mode & 0o077 or info.st_uid != os.geteuid():
            raise ValueError('ASR PCM requires a dedicated private owned directory')
        self.stop = threading.Event()
        self.wake = threading.Event()
        self.workers = max(1, min(int(workers), 2))
        self.threads = []
        with store.connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS asr_jobs(
                    grant_id TEXT NOT NULL, session_id TEXT NOT NULL,
                    sequence INTEGER NOT NULL, request_id TEXT NOT NULL,
                    pcm_sha256 TEXT NOT NULL, start_ms INTEGER NOT NULL,
                    end_ms INTEGER NOT NULL, state TEXT NOT NULL,
                    created REAL NOT NULL, updated REAL NOT NULL,
                    attempt_started REAL, pcm_path TEXT, result BLOB,
                    provider_closure TEXT, error_code TEXT, processing BLOB,
                    audio_expires REAL NOT NULL, transcript_expires REAL NOT NULL,
                    source_known INTEGER NOT NULL DEFAULT 0,
                    source_seen_ids BLOB,
                    PRIMARY KEY(grant_id,session_id,sequence));
                CREATE TABLE IF NOT EXISTS asr_request_jobs(
                    grant_id TEXT NOT NULL, request_id TEXT NOT NULL,
                    session_id TEXT NOT NULL, sequence INTEGER NOT NULL,
                    PRIMARY KEY(grant_id,request_id));
                CREATE INDEX IF NOT EXISTS asr_jobs_pending ON asr_jobs(state,created);
            ''')
        with store.transaction() as db:
            # A crash after claiming may have reached the billable provider.
            # Never turn running back into queued or replay its PCM.
            db.execute("UPDATE asr_jobs SET state='unknown',provider_closure='unknown',error_code='PROCESS_RESTARTED',updated=? WHERE state='running'", (time.time(),))
            rows = db.execute('SELECT grant_id,session_id,sequence,processing FROM asr_jobs WHERE processing IS NOT NULL').fetchall()
            for row in rows:
                processing = json.loads(row['processing'])
                if processing.get('state') == 'running':
                    processing['state'] = 'unknown'
                    for item in processing.get('items', []):
                        if item.get('state') in ('pending', 'running'):
                            item.update(state='unknown', error_code='PROCESS_RESTARTED')
                    db.execute('UPDATE asr_jobs SET processing=? WHERE grant_id=? AND session_id=? AND sequence=?',
                               (encoded(processing), row['grant_id'], row['session_id'], row['sequence']))
        self.maintenance()
        # Remove only this module's orphan spool files, never original recordings.
        with store.connect() as db:
            referenced = {r[0] for r in db.execute('SELECT pcm_path FROM asr_jobs WHERE pcm_path IS NOT NULL')}
        for path in self.spool.iterdir():
            if re.fullmatch(r'[a-f0-9]{32}\.pcm', path.name) and str(path) not in referenced:
                self._unlink(str(path))

    def start(self):
        if not self.available:
            return
        for _ in range(self.workers):
            thread = threading.Thread(target=self._worker, daemon=True, name='oops-apple-asr')
            thread.start()
            self.threads.append(thread)

    def close(self):
        self.stop.set()
        self.wake.set()

    def capabilities(self):
        return {'available': self.available, 'engine': ENGINE, 'version': 1,
                'max_chunk_ms': MAX_CHUNK_MS}

    def _unlink(self, name):
        if not name:
            return
        path = Path(name)
        if path.parent != self.spool or not re.fullmatch(r'[a-f0-9]{32}\.pcm', path.name):
            return
        try:
            if stat.S_ISREG(path.lstat().st_mode):
                path.unlink()
        except FileNotFoundError:
            pass

    @staticmethod
    def _key(row):
        return row['grant_id'], row['session_id'], row['sequence']

    def _row(self, gid, sid, sequence):
        with self.store.connect() as db:
            row = db.execute('SELECT * FROM asr_jobs WHERE grant_id=? AND session_id=? AND sequence=?',
                             (gid, sid, sequence)).fetchone()
        if row is None:
            reject(404, 'ASR_CHUNK_NOT_FOUND', '本连接没有此转写分段')
        return dict(row)

    def _invalidate(self, row, code='SOURCE_EXPIRED'):
        with self.store.transaction() as db:
            current = db.execute('SELECT pcm_path FROM asr_jobs WHERE grant_id=? AND session_id=? AND sequence=?', self._key(row)).fetchone()
            db.execute("UPDATE asr_jobs SET state='failed',result=NULL,processing=NULL,pcm_path=NULL,provider_closure=NULL,error_code=?,updated=? WHERE grant_id=? AND session_id=? AND sequence=?",
                       (code, time.time(), *self._key(row)))
            db.execute('UPDATE requests SET response=NULL WHERE grant_id=? AND id IN (SELECT request_id FROM asr_request_jobs WHERE grant_id=? AND session_id=? AND sequence=?)',
                       (row['grant_id'], *self._key(row)))
        if current:
            self._unlink(current['pcm_path'])

    def _local_live(self, row):
        now = time.time()
        with self.store.connect() as db:
            grant = db.execute('SELECT revoked,token_expires FROM grants WHERE id=?', (row['grant_id'],)).fetchone()
        if not grant or grant['revoked'] or not grant['token_expires'] or grant['token_expires'] <= now:
            self._invalidate(row, 'GRANT_UNAVAILABLE')
            reject(401, 'MOBILE_UNAUTHORIZED', '移动连接身份已撤回或已过期')
        if min(row['audio_expires'], row['transcript_expires']) <= now or row['error_code'] in ('SOURCE_EXPIRED', 'SOURCE_INVALID'):
            self._invalidate(row)
            reject(410, 'ASR_SOURCE_UNAVAILABLE', '本场原音或全文已到期或失效')
        return True

    def _source_live(self, row, snapshot=None):
        row.update(self._row(*self._key(row)))
        self._local_live(row)
        if snapshot is None:
            try:
                status, raw = self.upstream.call('GET', '/v1/meetings/' + row['session_id'], timeout=10)
                value = json.loads(raw)
            except (OSError, ValueError, TimeoutError, http.client.HTTPException):
                reject(502, 'ASR_SOURCE_CHECK_FAILED', '无法核对本场来源；不展示缓存或继续处理')
        else:
            status, value = snapshot
        seen = set(json.loads(row['source_seen_ids']) if row['source_seen_ids'] else [])
        if status == 404 and not row['source_known'] and not seen:
            # Registration precedes the first transcript sync. Once any sync
            # succeeded, 404 means deleted rather than a not-yet-created source.
            with self.store.connect() as db:
                synced = db.execute("SELECT 1 FROM requests WHERE grant_id=? AND session_id=? AND route=? AND state='done' AND http_status BETWEEN 200 AND 299 LIMIT 1",
                                    (row['grant_id'], row['session_id'], '/sessions/' + row['session_id'] + '/sync')).fetchone()
            if not synced:
                return status, value
        if status in (404, 410) or status == 200 and isinstance(value, dict) and value.get('transcript_status') == 'expired':
            self._invalidate(row, 'SOURCE_INVALID')
            reject(410, 'ASR_SOURCE_UNAVAILABLE', '本场来源已删除或到期')
        if status != 200 or not isinstance(value, dict) or value.get('session_id') != row['session_id']:
            reject(502, 'ASR_SOURCE_CHECK_FAILED', '无法核对本场来源；不继续处理')
        current_policy = value.get('storage_policy')
        if isinstance(current_policy, dict):
            session = self.store.session(row['grant_id'], row['session_id'])
            if current_policy != session['policy']:
                self._invalidate(row, 'SOURCE_INVALID')
                reject(410, 'ASR_SOURCE_UNAVAILABLE', '本场来源保存合同已变化')
        expected = json.loads(row['result']) if row['result'] else []
        current = value.get('utterances', [])
        if not isinstance(current, list):
            reject(502, 'ASR_SOURCE_CHECK_FAILED', '无法核对本场原话版本')
        by_id = {u.get('id'): u for u in current if isinstance(u, dict) and isinstance(u.get('id'), str)}
        fields = ('id', 'text', 'start_ms', 'end_ms', 'speaker')
        for utterance in expected:
            original = by_id.get(utterance['id'])
            if original is not None and any(original.get(k) != utterance.get(k) for k in fields) or original is None and utterance['id'] in seen:
                self._invalidate(row, 'SOURCE_INVALID')
                reject(410, 'ASR_SOURCE_UNAVAILABLE', '本场已同步原话已修订或撤回；请重新核对来源')
            if original is not None:
                seen.add(utterance['id'])
        with self.store.connect() as db:
            db.execute('UPDATE asr_jobs SET source_known=1,source_seen_ids=? WHERE grant_id=? AND session_id=? AND sequence=?',
                       (encoded(sorted(seen)), *self._key(row)))
        row['source_known'] = 1
        return status, value

    def _sources_live(self, row, previous):
        snapshot = self._source_live(row)
        for earlier in previous:
            self._source_live(earlier, snapshot=snapshot)

    def note_synced(self, gid, sid, utterances, rejected):
        """Remember explicit sync binding so a removed sentence cannot reappear."""
        if not isinstance(rejected, list):
            return  # An unfamiliar receipt cannot establish accepted source IDs.
        excluded = {u.get('id') for u in rejected if isinstance(u, dict) and isinstance(u.get('id'), str)}
        ids = {u.get('id') for u in utterances if isinstance(u, dict) and isinstance(u.get('id'), str)}
        ids -= excluded
        if not ids:
            return
        with self.store.transaction() as db:
            rows = db.execute('SELECT sequence,result,source_seen_ids FROM asr_jobs WHERE grant_id=? AND session_id=? AND result IS NOT NULL', (gid, sid)).fetchall()
            for row in rows:
                related = {u['id'] for u in json.loads(row['result'])} & ids
                if related:
                    seen = set(json.loads(row['source_seen_ids']) if row['source_seen_ids'] else []) | related
                    db.execute('UPDATE asr_jobs SET source_seen_ids=? WHERE grant_id=? AND session_id=? AND sequence=?',
                               (encoded(sorted(seen)), gid, sid, row['sequence']))

    def maintenance(self):
        now = time.time()
        with self.store.connect() as db:
            rows = db.execute('''SELECT j.* FROM asr_jobs j LEFT JOIN grants g ON g.id=j.grant_id
                WHERE (j.result IS NOT NULL OR j.processing IS NOT NULL OR j.pcm_path IS NOT NULL)
                AND (g.id IS NULL OR g.revoked IS NOT NULL OR g.token_expires IS NULL OR g.token_expires<=?
                     OR j.audio_expires<=? OR j.transcript_expires<=?)''', (now, now, now)).fetchall()
        for row in rows:
            self._invalidate(row)

    def enqueue(self, gid, session, sequence, rid, sha, start_ms, end_ms, pcm):
        sid, now = session['id'], time.time()
        if not 0 <= sequence <= 9999 or not 0 <= start_ms < end_ms <= MAX_SESSION_MS or end_ms - start_ms > MAX_CHUNK_MS:
            reject(400, 'INVALID_ASR_TIMING', '分段须为会话绝对时间且最长32秒，单场最多30分钟')
        if not pcm or len(pcm) > MAX_PCM_BYTES or len(pcm) % 2 or abs(len(pcm) - (end_ms - start_ms) * 32) > 32:
            reject(400, 'INVALID_ASR_PCM', '需要与起止时间相符的16k单声道s16le PCM')
        if pcm[:4] in (b'RIFF', b'RIFX', b'RF64'):
            reject(415, 'WAV_CONVERSION_REQUIRED', '须在手机解码并转换PCM，不能上传WAV容器')
        if not re.fullmatch(r'[a-f0-9]{64}', sha) or hashlib.sha256(pcm).hexdigest() != sha:
            reject(400, 'INVALID_CHUNK_HASH', '分段PCM SHA-256不匹配')
        policy = session['policy']
        audio_exp, text_exp = timestamp(policy['audio_expires_at']), timestamp(policy['transcript_expires_at'])
        if min(audio_exp, text_exp) <= now:
            reject(410, 'ASR_SOURCE_UNAVAILABLE', '本场原音或全文已到期')
        route = f'/sessions/{sid}/asr/chunks/{sequence}?start_ms={start_ms}&end_ms={end_ms}'
        fp = hashlib.sha256(b'PUT\0' + route.encode() + b'\0' + pcm).hexdigest()
        pcm_path = None
        try:
            with self.store.transaction() as db:
                self.store.require_grant(db, gid)
                prior = db.execute('SELECT * FROM requests WHERE grant_id=? AND id=?', (gid, rid)).fetchone()
                if prior:
                    return self.store.saved_response(prior, fp)
                old = db.execute('SELECT * FROM asr_jobs WHERE grant_id=? AND session_id=? AND sequence=?', (gid, sid, sequence)).fetchone()
                if old and (old['pcm_sha256'], old['start_ms'], old['end_ms']) != (sha, start_ms, end_ms):
                    reject(409, 'ASR_CHUNK_CONFLICT', '同一分段编号不能更换PCM或会话时间')
                if old and old['state'] == 'unknown':
                    reject(409, 'ASR_OUTCOME_UNKNOWN', '此段已有结果未知的付费尝试；只查询，不重新登记')
                if not old and not self.available:
                    reject(503, 'ASR_UNAVAILABLE', '可信服务器尚未配置主版云转写')
                if not old:
                    pending = db.execute("SELECT COUNT(*) FROM asr_jobs WHERE state IN ('queued','running')").fetchone()[0]
                    total = db.execute('SELECT COUNT(*) FROM asr_jobs WHERE grant_id=? AND session_id=?', (gid, sid)).fetchone()[0]
                    duration = db.execute('SELECT COALESCE(SUM(end_ms-start_ms),0) FROM asr_jobs WHERE grant_id=? AND session_id=?', (gid, sid)).fetchone()[0]
                    if pending >= MAX_PENDING or total >= MAX_SESSION_JOBS or duration + end_ms - start_ms > MAX_SESSION_MS:
                        reject(429, 'ASR_CAPACITY', '转写队列已满；尚未登记或执行本段')
                    pcm_path = str(self.spool / (uuid.uuid4().hex + '.pcm'))
                    fd = os.open(pcm_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                    with os.fdopen(fd, 'wb') as output:
                        output.write(pcm)
                        output.flush()
                        os.fsync(output.fileno())
                    directory_fd = os.open(self.spool, os.O_RDONLY)
                    try:
                        os.fsync(directory_fd)
                    finally:
                        os.close(directory_fd)
                    db.execute('''INSERT INTO asr_jobs(grant_id,session_id,sequence,request_id,pcm_sha256,start_ms,end_ms,state,created,updated,pcm_path,audio_expires,transcript_expires)
                        VALUES(?,?,?,?,?,?,?,'queued',?,?,?,?,?)''',
                               (gid, sid, sequence, rid, sha, start_ms, end_ms, now, now, pcm_path, audio_exp, text_exp))
                canonical_id = old['request_id'] if old else rid
                receipt = encoded(dict(session_id=sid, request_id=canonical_id, sequence=sequence,
                                       pcm_sha256=sha, state='queued' if not old else old['state'],
                                       asr_engine=ENGINE, registration_only=True))
                expires = min(audio_exp, text_exp)
                db.execute('INSERT INTO requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
                           (gid, rid, sid, 'PUT', route, fp, 'done', now, now, 202, receipt, expires))
                db.execute('INSERT INTO asr_request_jobs VALUES(?,?,?,?)', (gid, rid, sid, sequence))
            self.wake.set()
            return 202, receipt
        except BaseException:
            if pcm_path:
                self._unlink(pcm_path)
            raise

    def request_state(self, gid, rid):
        with self.store.connect() as db:
            row = db.execute('''SELECT j.state FROM asr_request_jobs r JOIN asr_jobs j
                ON j.grant_id=r.grant_id AND j.session_id=r.session_id AND j.sequence=r.sequence
                WHERE r.grant_id=? AND r.request_id=?''', (gid, rid)).fetchone()
        return dict(asr_job_state=row['state'], registration_only=True, registration_http_status=202) if row else {}

    def get(self, gid, sid, sequence):
        self.store.session(gid, sid)
        row = self._row(gid, sid, sequence)
        snapshot = self._source_live(row)
        # Reload after the source read: a worker or cleanup may have finished.
        row = self._row(gid, sid, sequence)
        self._local_live(row)
        result = json.loads(row['result']) if row['result'] else []
        processing = json.loads(row['processing']) if row['processing'] else {'state': 'pending' if row['state'] in ('queued', 'running') else 'skipped', 'items': []}
        if processing.get('context_sequences') and (any('tag' in u for u in result) or any('result' in item for item in processing.get('items', []))):
            try:
                for previous_sequence in processing['context_sequences']:
                    self._source_live(self._row(gid, sid, previous_sequence), snapshot=snapshot)
            except AsrError as error:
                if error.status not in (401, 410):
                    raise
                self._clear_processing(result, processing, error.code)
                self._save_processing(row, result, processing)
        return dict(session_id=sid, request_id=row['request_id'], sequence=sequence,
                    pcm_sha256=row['pcm_sha256'], state=row['state'], asr_engine=ENGINE,
                    start_ms=row['start_ms'], end_ms=row['end_ms'],
                    provider_closure=row['provider_closure'], utterances=result,
                    processing=processing, error_code=row['error_code'],
                    rejected_finals=processing.get('rejected_finals', []),
                    diagnostics=processing.get('diagnostics', {}))

    def _claim(self):
        with self.store.transaction() as db:
            row = db.execute('''SELECT j.* FROM asr_jobs j WHERE j.state='queued'
                AND NOT EXISTS(SELECT 1 FROM asr_jobs active WHERE active.grant_id=j.grant_id
                    AND active.session_id=j.session_id AND active.state='running')
                ORDER BY j.created,j.sequence LIMIT 1''').fetchone()
            if row:
                db.execute("UPDATE asr_jobs SET state='running',attempt_started=?,updated=? WHERE grant_id=? AND session_id=? AND sequence=? AND state='queued'",
                           (time.time(), time.time(), *self._key(row)))
                return dict(row, state='running')
            # ASR was durably saved before optional downstream processing.
            rows = db.execute("SELECT * FROM asr_jobs WHERE state IN ('ready','incomplete') AND processing IS NOT NULL ORDER BY created,sequence").fetchall()
            for row in rows:
                processing = json.loads(row['processing'])
                if processing.get('state') == 'pending':
                    processing['state'] = 'running'
                    db.execute('UPDATE asr_jobs SET processing=? WHERE grant_id=? AND session_id=? AND sequence=?', (encoded(processing), *self._key(row)))
                    return dict(row, processing=encoded(processing), processing_only=True)
        return None

    def _worker(self):
        while not self.stop.is_set():
            row = None
            try:
                row = self._claim()
                if row:
                    if row.get('processing_only'):
                        self._process(row)
                    else:
                        self._run(row)
                    continue
            except Exception:
                # No traceback/provider exception or request context is logged.
                if row:
                    try:
                        with self.store.connect() as db:
                            db.execute("UPDATE asr_jobs SET state='unknown',provider_closure='unknown',error_code='WORKER_ABORTED',pcm_path=NULL WHERE grant_id=? AND session_id=? AND sequence=? AND state='running'", self._key(row))
                            current = db.execute('SELECT processing FROM asr_jobs WHERE grant_id=? AND session_id=? AND sequence=?', self._key(row)).fetchone()
                            processing = json.loads(current['processing']) if current and current['processing'] else None
                            if processing and processing.get('state') == 'running':
                                processing['state'] = 'unknown'
                                for item in processing.get('items', []):
                                    if item.get('state') in ('pending', 'running'):
                                        item.update(state='unknown', error_code='WORKER_ABORTED')
                                db.execute('UPDATE asr_jobs SET processing=? WHERE grant_id=? AND session_id=? AND sequence=?',
                                           (encoded(processing), *self._key(row)))
                        self._unlink(row.get('pcm_path'))
                    except Exception:
                        pass
            self.wake.wait(0.5)
            self.wake.clear()

    def _normalize(self, row, finals):
        output, rejected = [], []
        stats = dict(rejected_final_count=0, rejected_overflow_count=0,
                     normalization_reason_counts={}, word_timing_incomplete_count=0)
        rejected_bytes = 2
        duration = row['end_ms'] - row['start_ms']

        def reject_final(index, final, reason):
            nonlocal rejected_bytes
            stats['rejected_final_count'] += 1
            counts = stats['normalization_reason_counts']
            counts[reason] = counts.get(reason, 0) + 1
            # This is isolated source material, never a timed utterance. Preserve the
            # provider's actual value (including missing/null/NaN) as a JSON literal,
            # not a fabricated coordinate. The enclosing response remains strict JSON.
            coordinates = {key: dict(present=key in final,
                                     raw_json=json.dumps(final.get(key), ensure_ascii=False, allow_nan=True))
                           for key in ('start_time', 'end_time')}
            item = dict(index=index, text=final.get('text') if isinstance(final.get('text'), str) else '',
                        reason=reason, provider_coordinates=coordinates)
            size = len(encoded(item)) + 1
            if len(rejected) < MAX_FINALS and rejected_bytes + size <= MAX_RESULT_BYTES:
                rejected.append(item)
                rejected_bytes += size
            else:
                # Explicitly report resource omissions. Never call an empty/truncated
                # rejection list silence or a complete transcription.
                stats['rejected_overflow_count'] += 1

        for index, final in enumerate(finals):
            if not isinstance(final, dict):
                reject_final(index, {}, 'invalid_final')
                continue
            a, b, text = final.get('start_time'), final.get('end_time'), final.get('text')
            reason = ('invalid_text' if not isinstance(text, str) or not text.strip() else
                      'text_limit' if len(text) > 8000 else
                      'invalid_coordinates' if type(a) is not int or type(b) is not int or not 0 <= a < b <= duration else
                      'final_count_limit' if len(output) >= MAX_FINALS else None)
            if reason:
                reject_final(index, final, reason)
                continue
            key = f'volc:{row["sequence"]}:{a}:{b}:' + hashlib.sha256(text.encode()).hexdigest()
            words = []
            provider_words = final.get('words')
            missing_word_times = provider_words is not None and not isinstance(provider_words, list)
            for word in provider_words if isinstance(provider_words, list) else []:
                t = word.get('text', word.get('word', '')) if isinstance(word, dict) else None
                if isinstance(t, str) and not t.strip():
                    continue  # Provider whitespace sentinel timestamps are not words.
                x, y = (word.get('start_time'), word.get('end_time')) if isinstance(word, dict) else (None, None)
                if not isinstance(t, str) or len(t) > 1000 or type(x) is not int or type(y) is not int or not a <= x <= y <= b:
                    missing_word_times = True
                    continue  # Keep the real final text; never invent an invalid word time.
                words.append(dict(text=t, start_ms=row['start_ms'] + x, end_ms=row['start_ms'] + y))
            item = dict(id=str(uuid.uuid5(uuid.UUID(row['session_id']), key)),
                        start_ms=row['start_ms'] + a, end_ms=row['start_ms'] + b,
                        text=text, words=words, speaker=None)
            if missing_word_times:
                item['word_timing_incomplete'] = True
                stats['word_timing_incomplete_count'] += 1
            if len(encoded(output + [item])) > MAX_RESULT_BYTES:
                reject_final(index, final, 'result_limit')
                continue
            output.append(item)
        output.sort(key=lambda u: (u['start_ms'], u['end_ms'], u['id']))
        return output, rejected, stats

    def _run(self, row):
        stream = socket = None
        reader = None
        error_code, phase = None, 'source'
        diagnostics = dict(version=1, phase=phase, sent_pcm_bytes=0, received_final_count=0,
                           eos_attempted=False, eos_sent=False, server_last=False,
                           provider_acknowledged=False, exception_counts={})
        diagnostic_lock = threading.Lock()

        def note_exception(stage, error):
            # Exception messages, provider payloads and credentials are never copied.
            name = type(error).__name__
            name = name if name in SAFE_EXCEPTION_TYPES else 'OtherError'
            with diagnostic_lock:
                key = stage + ':' + name
                counts = diagnostics['exception_counts']
                counts[key] = counts.get(key, 0) + 1
                diagnostics.setdefault('failure_phase', stage)

        try:
            self._source_live(row)
            phase = 'pcm'
            fd = os.open(row['pcm_path'], os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fd, 'rb') as source:
                info = os.fstat(source.fileno())
                if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600:
                    raise ValueError('unsafe PCM file')
                pcm = source.read(MAX_PCM_BYTES + 1)
            if len(pcm) > MAX_PCM_BYTES or hashlib.sha256(pcm).hexdigest() != row['pcm_sha256']:
                raise ValueError('PCM integrity failure')
            import websocket
            from asr_words_probe import ProbeStream, frame, request_json
            headers = {'X-Api-Resource-Id': self.credentials['VOLC_RESOURCE_ID'],
                       'X-Api-Connect-Id': str(uuid.uuid4())}
            if self.credentials['VOLC_API_KEY']:
                headers['X-Api-Key'] = self.credentials['VOLC_API_KEY']
            else:
                headers.update({'X-Api-App-Key': self.credentials['VOLC_APP_ID'],
                                'X-Api-Access-Key': self.credentials['VOLC_ACCESS_TOKEN']})
            # Exact, fixed TLS endpoint. No URL or provider credential comes from the phone.
            phase = 'connect'
            socket = websocket.create_connection(ENDPOINT, header=headers, timeout=15,
                                                 enable_multithread=True, http_proxy_host=None,
                                                 http_no_proxy=['*'], sslopt={'cert_reqs': ssl.CERT_REQUIRED, 'check_hostname': True})
            socket.settimeout(35)
            stream = ProbeStream(socket, self.credentials.values())

            def receive():
                receive_phase = 'receive'
                try:
                    while not stream.done.is_set():
                        receive_phase = 'receive'
                        raw = socket.recv()
                        if not raw:
                            stream.fail('socket closed without terminal acknowledgement', 'closed_without_ack')
                            return
                        if not isinstance(raw, bytes) or len(raw) > MAX_RESULT_BYTES:
                            stream.fail('invalid provider response', 'protocol_error')
                            return
                        receive_phase = 'decode'
                        offset = (raw[0] & 15) * 4 if raw else 0
                        if len(raw) >= 12 and raw[0] >> 4 == 1 and raw[1] >> 4 == 15 and offset >= 4 and len(raw) >= offset + 8:
                            # Fixed-width protocol status only; never provider text.
                            diagnostics['provider_error_code'] = int.from_bytes(raw[offset:offset + 4], 'big')
                        stream.receive(raw)
                        if len(stream.finals) > MAX_FINALS:
                            stream.fail('too many provider finals', 'protocol_error')
                except Exception as error:
                    with stream.lock:
                        if not stream.done.is_set():
                            note_exception(receive_phase, error)
                            stream.fail('provider receive failed', 'receive_error')

            phase = 'send_initial'
            request = request_json()
            request['user']['uid'] = row['session_id']
            sent = socket.send_binary(frame(1, gzip.compress(encoded(request)), compressed=True))
            if sent is False or type(sent) is int and sent <= 0:
                raise ValueError('initial ASR request send failed')
            reader = threading.Thread(target=receive, daemon=True, name='oops-apple-asr-receive')
            reader.start()
            began = time.monotonic()
            phase = 'send_audio'
            for offset in range(0, len(pcm), 3200):  # 100 ms, identical raw format to the main app.
                if stream.done.is_set():
                    break
                if self.stop.is_set():
                    stream.fail('service stopping', 'cancelled')
                    break
                if offset % 32000 == 0:
                    phase = 'source'
                    self._local_live(row)
                    phase = 'send_audio'
                chunk = pcm[offset:offset + 3200]
                if not stream.send_audio(chunk):
                    break
                diagnostics['sent_pcm_bytes'] += len(chunk)
                delay = began + (offset + len(chunk)) / 32000 - time.monotonic()
                if delay > 0:
                    stream.done.wait(delay)
            if not stream.done.is_set():
                phase = 'eos'
                stream.finish()  # One empty EOS, never pad or resend samples.
                deadline = time.monotonic() + 30
                while not stream.done.wait(0.5):
                    phase = 'source'
                    self._local_live(row)
                    phase = 'eos'
                    if self.stop.is_set() or time.monotonic() >= deadline:
                        stream.fail('terminal acknowledgement unavailable', 'finish_timeout')
        except AsrError as error:
            note_exception(phase, error)
            error_code = error.code
        except Exception as error:
            note_exception(phase, error)
            error_code = 'ASR_PROVIDER_OR_PROTOCOL_FAILED'
        finally:
            if stream and not stream.done.is_set():
                stream.fail('attempt ended without acknowledgement', 'incomplete')
            if socket:
                try:
                    socket.close()
                except Exception as error:
                    note_exception('close', error)
            if reader and reader.ident is not None:
                reader.join(1)

        finals = []
        if stream:
            with stream.lock:
                finals = list(stream.finals)
                diagnostics.update(eos_attempted=stream.eos_attempted, eos_sent=stream.eos_sent,
                                   server_last=stream.server_last,
                                   provider_acknowledged=bool(stream.eos_sent and stream.server_last and
                                       stream.termination == 'acknowledged' and not stream.errors))
                # Only this protocol-owned enum is retained, never stream.errors.
                diagnostics['termination'] = stream.termination if stream.termination in {
                    'acknowledged', 'incomplete', 'receive_error', 'protocol_error',
                    'closed_without_ack', 'cancelled', 'finish_timeout', 'premature_server_end'} else 'unknown'
        diagnostics['received_final_count'] = len(finals)
        utterances, rejected, normalization = self._normalize(row, finals)
        diagnostics.update(normalization)
        if normalization['rejected_final_count']:
            state, closure = 'incomplete', 'incomplete'
            error_code = error_code or 'ASR_FINALS_REJECTED'
            diagnostics.setdefault('failure_phase', 'normalize')
        elif error_code:
            state, closure = ('incomplete' if utterances else 'failed'), 'incomplete'
        elif diagnostics['provider_acknowledged']:
            state, closure = 'ready', 'acknowledged'
        else:
            state, closure, error_code = 'incomplete', 'incomplete', 'ASR_INCOMPLETE'
        diagnostics['phase'] = diagnostics.get('failure_phase', 'complete' if state == 'ready' else 'eos')
        processing = dict(state='pending' if utterances else 'skipped',
                          items=[{'utterance_id': u['id'], 'state': 'pending'} for u in utterances],
                          rejected_finals=rejected, diagnostics=diagnostics)
        try:
            # A paid attempt's captured result is durable before another remote read.
            # Temporary source 502s still block GET/Sol via their existing gates, but
            # cannot erase paid ASR text. Expiry/revocation/invalidation still wins.
            self._local_live(self._row(*self._key(row)))
            with self.store.transaction() as db:
                self.store.require_grant(db, row['grant_id'])
                current = db.execute('SELECT * FROM asr_jobs WHERE grant_id=? AND session_id=? AND sequence=?', self._key(row)).fetchone()
                if current is None or current['state'] != 'running':
                    return
                if min(current['audio_expires'], current['transcript_expires']) <= time.time() or current['error_code'] in ('SOURCE_EXPIRED', 'SOURCE_INVALID'):
                    db.execute("UPDATE asr_jobs SET state='failed',result=NULL,processing=NULL,pcm_path=NULL,provider_closure=NULL,error_code='SOURCE_EXPIRED',updated=? WHERE grant_id=? AND session_id=? AND sequence=?", (time.time(), *self._key(row)))
                    db.execute('UPDATE requests SET response=NULL WHERE grant_id=? AND id IN (SELECT request_id FROM asr_request_jobs WHERE grant_id=? AND session_id=? AND sequence=?)', (row['grant_id'], *self._key(row)))
                    return
                db.execute('''UPDATE asr_jobs SET state=?,updated=?,pcm_path=NULL,result=?,provider_closure=?,error_code=?,processing=?
                    WHERE grant_id=? AND session_id=? AND sequence=? AND state='running' ''',
                           (state, time.time(), encoded(utterances), closure, error_code, encoded(processing), *self._key(row)))
        except Exception as error:
            try:
                self._local_live(self._row(*self._key(row)))
            except AsrError as invalid:
                if invalid.status in (401, 410):
                    return  # a grant/TTL race must clear, never save fallback plaintext
            except Exception:
                pass  # database failures still cannot make a paid attempt runnable
            note_exception('persist', error)
            diagnostics['phase'] = 'persist'
            # A persistence failure must never make the billable attempt runnable again.
            with self.store.connect() as db:
                db.execute("UPDATE asr_jobs SET state='unknown',result=NULL,pcm_path=NULL,provider_closure='unknown',error_code='RESULT_NOT_COMMITTED',processing=? WHERE grant_id=? AND session_id=? AND sequence=? AND state='running'",
                           (encoded(dict(state='skipped', items=[], diagnostics=diagnostics)), *self._key(row)))
        finally:
            # Commit first; a cleanup failure cannot discard captured paid ASR text.
            try:
                self._unlink(row.get('pcm_path'))
            except OSError:
                pass  # the private orphan is removed by startup/TTL cleanup

    @staticmethod
    def _filler(text):
        letters = [c for c in text if not c.isspace() and not unicodedata.category(c).startswith('P')]
        return all(c in FILLERS for c in letters)

    def _save_processing(self, row, utterances, processing):
        self._local_live(row)
        with self.store.connect() as db:
            db.execute('UPDATE asr_jobs SET result=?,processing=?,updated=? WHERE grant_id=? AND session_id=? AND sequence=? AND result IS NOT NULL',
                       (encoded(utterances), encoded(processing), time.time(), *self._key(row)))

    @staticmethod
    def _clear_processing(utterances, processing, code):
        for utterance in utterances:
            for key in ('tag', 'tag_prob', 'tag_engine', 'task_clause', 'task_quality'):
                utterance.pop(key, None)
        processing.update(state='failed', error_code=code,
                          items=[dict(utterance_id=u['id'], state='failed', error_code=code) for u in utterances])

    def _process(self, row):
        utterances = json.loads(row['result']) if row['result'] else []
        processing = json.loads(row['processing'])
        deadline = time.monotonic() + 90
        history = []
        previous = []
        try:
            with self.store.connect() as db:
                previous = [dict(r) for r in db.execute('''SELECT * FROM asr_jobs WHERE grant_id=? AND session_id=?
                    AND sequence<>? AND start_ms<? AND result IS NOT NULL
                    AND length(result)>2 AND audio_expires>? AND transcript_expires>?
                    ORDER BY start_ms DESC LIMIT 4''',
                                      (*self._key(row), row['start_ms'], time.time(), time.time())).fetchall()]
            self._sources_live(row, previous)
            processing['context_sequences'] = [earlier['sequence'] for earlier in previous]
            earlier = [u for previous_row in previous for u in json.loads(previous_row['result'])]
            earlier.sort(key=lambda u: (u['start_ms'], u['end_ms'], u['id']))
            history = earlier
            for utterance, item in zip(utterances, processing['items']):
                if self._filler(utterance['text']):
                    item['state'] = 'skipped'
                    item['reason'] = 'filler'
                    history.append(utterance)
                    continue
                if self.stop.is_set() or time.monotonic() >= deadline:
                    item.update(state='failed', error_code='PROCESSING_BUDGET')
                    continue
                self._sources_live(row, previous)
                item['state'] = 'running'
                self._save_processing(row, utterances, processing)
                body = dict(session_id=row['session_id'], utterance_id=utterance['id'],
                            start_ms=utterance['start_ms'], end_ms=utterance['end_ms'],
                            text=utterance['text'], speaker=None,
                            context=[{'text': u['text'], 'speaker': None} for u in history if u['end_ms'] <= utterance['start_ms']][-4:])
                try:
                    status, raw = self.upstream.call('POST', '/v1/utterances', encoded(body), timeout=10)
                    if status >= 500:
                        item.update(state='unknown', error_code='PROCESSING_OUTCOME_UNKNOWN')
                        history.append(utterance)
                        self._save_processing(row, utterances, processing)
                        continue
                    value = json.loads(raw)
                    if status != 200 or not isinstance(value, dict) or value.get('utterance_id') != utterance['id']:
                        raise ValueError('invalid processing response')
                    probability = value.get('prob')
                    if value.get('tag') not in TAGS or probability is not None and (type(probability) not in (int, float) or not math.isfinite(probability) or not 0 <= probability <= 1):
                        raise ValueError('invalid tag')
                    if not isinstance(value.get('engine'), str) or len(value['engine']) > 80 or len(raw) > MAX_RESULT_BYTES:
                        raise ValueError('invalid processing metadata')
                    self._sources_live(row, previous)
                    # Keep the real response separate from ASR completeness.
                    safe = {k: value[k] for k in ('utterance_id', 'tag', 'prob', 'engine', 'task_clause', 'task_quality', 'original_tag', 'timing_ms') if k in value}
                    item.update(state='ready', result=safe)
                    utterance.update(tag=value['tag'], tag_prob=probability, tag_engine=value['engine'])
                    for key in ('task_clause', 'task_quality'):
                        if key in value:
                            utterance[key] = value[key]
                except AsrError:
                    raise
                except (OSError, TimeoutError, http.client.HTTPException):
                    item.update(state='unknown', error_code='PROCESSING_OUTCOME_UNKNOWN')
                except Exception:
                    item.update(state='failed', error_code='PROCESSING_FAILED')
                history.append(utterance)
                self._save_processing(row, utterances, processing)
            states = {item['state'] for item in processing['items']}
            processing['state'] = 'ready' if states <= {'ready', 'skipped'} else 'partial' if 'ready' in states else 'unknown' if 'unknown' in states else 'failed'
            self._sources_live(row, previous)
            self._save_processing(row, utterances, processing)
        except Exception as error:
            # Preserve committed ASR. An uncertain tag request is never repeated.
            invalid_source = isinstance(error, AsrError) and error.status in (401, 410)
            if invalid_source:
                self._clear_processing(utterances, processing, error.code)
            else:
                processing['state'] = 'unknown'
                processing['error_code'] = error.code if isinstance(error, AsrError) else 'PROCESSING_OUTCOME_UNKNOWN'
                for item in processing['items']:
                    if item['state'] in ('pending', 'running'):
                        item.update(state='unknown', error_code=processing['error_code'])
            try:
                self._save_processing(row, utterances, processing)
            except Exception:
                pass
