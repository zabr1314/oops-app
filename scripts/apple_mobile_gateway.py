#!/usr/bin/env python3
"""Narrow Apple mobile gateway; upstream credentials never leave the trusted host.

Only formal meetings created by this grant are addressable. Explicit PCM jobs
reuse Oops' Volc ASR and existing utterance processing; no capture, Feishu
delivery, arbitrary URL proxy, or automatic write retry is implemented.
"""
import argparse
import datetime as dt
import hashlib
import http.client
import http.server
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from contextlib import contextmanager
from zoneinfo import ZoneInfo

from apple_mobile_asr import AsrError, AsrService, purge_revoked

JSON_LIMIT = 2_000_000
CHUNK_LIMIT = 1_100_000
RESPONSE_LIMIT = 8_000_000
FILES = {'audio.pcm': 4_000_000_000, 'finals.jsonl': 200_000_000,
         'asr.jsonl': 1_000_000_000, 'timing.jsonl': 200_000_000, 'meta.json': 100_000}
POLICY_FIELDS = ('recording_mode', 'cloud_save_confirmed', 'archive_started_at',
                 'audio_retention_days', 'transcript_retention_days')
SHA = re.compile(r'[a-f0-9]{64}')
SID = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}')


class GatewayError(Exception):
    def __init__(self, status, code, message, **extra):
        self.status, self.value = status, {'error': dict(code=code, message=message, **extra)}


def fail(status, code, message, **extra):
    raise GatewayError(status, code, message, **extra)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate JSON key')
        result[key] = value
    return result


def decode(raw):
    def invalid(_):
        raise ValueError('nonfinite number')
    return json.loads(raw, object_pairs_hook=unique_object, parse_constant=invalid)


def instant(value):
    if not isinstance(value, str) or len(value) > 60:
        fail(400, 'INVALID_TIME', '日期须为含时区的 ISO 8601 格式')
    try:
        normalized = value[:-1] + '+00:00' if value.endswith('Z') else value
        normalized = re.sub(r'\.(\d+)(?=[+-]\d{2}:\d{2}$)',
                            lambda m: '.' + m[1][:6].ljust(6, '0'), normalized)
        parsed = dt.datetime.fromisoformat(normalized)
        if parsed.tzinfo is None:
            raise ValueError()
        return parsed.astimezone(dt.timezone.utc)
    except (ValueError, OverflowError):
        fail(400, 'INVALID_TIME', '日期须为含时区的 ISO 8601 格式')


def request_id(value):
    try:
        parsed = uuid.UUID(value) if isinstance(value, str) else None
        if parsed is None or str(parsed) != value.lower():
            raise ValueError()
        return str(parsed)
    except (ValueError, AttributeError):
        fail(400, 'INVALID_REQUEST_ID', '每次独立写操作须有 UUID request ID')


def frozen_policy(body, now=None):
    if body.get('recording_mode') != 'meeting' or body.get('cloud_save_confirmed') is not True:
        fail(400, 'CONSENT_REQUIRED', '首版仅接收本次明确选择云保存的正式会议')
    began = instant(body.get('archive_started_at', body.get('started_at')))
    if began > (now or dt.datetime.now(dt.timezone.utc)) + dt.timedelta(minutes=5):
        fail(400, 'INVALID_TIME', '开始时间不能在未来')
    days = {}
    for field in ('audio_retention_days', 'transcript_retention_days'):
        value = body.get(field, 30)
        if type(value) is not int or value not in (7, 30, 90):
            fail(400, 'INVALID_RETENTION', '原音与全文期限须分别选择 7、30 或 90 天')
        days[field] = value
    return dict(version=1, recording_mode='meeting', cloud_save_confirmed=True,
                archive_started_at=began.isoformat(), **days,
                audio_expires_at=(began + dt.timedelta(days=days['audio_retention_days'])).isoformat(),
                transcript_expires_at=(began + dt.timedelta(days=days['transcript_retention_days'])).isoformat())


def require_live(policy, asset):
    expires = policy[asset + '_expires_at']
    if instant(expires) <= dt.datetime.now(dt.timezone.utc):
        fail(410, 'ASSET_EXPIRED', '本场对应资产已到期，不再上传或返回旧回执', asset=asset, expires_at=expires)


def fingerprint(method, path, raw):
    return hashlib.sha256(method.encode() + b'\0' + path.encode() + b'\0' + raw).hexdigest()


class Store:
    def __init__(self, filename):
        self.path = str(Path(filename).resolve())
        parent = Path(self.path).parent
        parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        # Use a dedicated directory; do not chmod an existing shared parent.
        if parent.stat().st_mode & 0o077:
            raise ValueError('Use a dedicated private 0700 database directory')
        with self.connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS grants(
                    id TEXT PRIMARY KEY, label TEXT NOT NULL, created REAL NOT NULL,
                    token_hash TEXT UNIQUE, token_expires REAL, token_days INTEGER NOT NULL,
                    revoked REAL, code_hash TEXT UNIQUE, code_expires REAL, code_used REAL);
                CREATE TABLE IF NOT EXISTS sessions(
                    id TEXT PRIMARY KEY, grant_id TEXT NOT NULL, created REAL NOT NULL,
                    started_at TEXT NOT NULL, time_zone TEXT NOT NULL, policy TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS requests(
                    grant_id TEXT NOT NULL, id TEXT NOT NULL, session_id TEXT,
                    method TEXT NOT NULL, route TEXT NOT NULL, fingerprint TEXT NOT NULL,
                    state TEXT NOT NULL, created REAL NOT NULL, finished REAL,
                    http_status INTEGER, response BLOB, expires REAL,
                    PRIMARY KEY(grant_id,id));
                CREATE INDEX IF NOT EXISTS sessions_grant ON sessions(grant_id,created);
            ''')
        os.chmod(self.path, 0o600)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA secure_delete=ON')
        try:
            yield db
        finally:
            db.close()

    @contextmanager
    def transaction(self):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            try:
                yield db
                db.execute('COMMIT')
            except BaseException:
                db.execute('ROLLBACK')
                raise

    @staticmethod
    def token_hash(value):
        return hashlib.sha256(value.encode()).hexdigest()

    def make_code(self, label, token_days):
        code, gid, now = secrets.token_urlsafe(24), str(uuid.uuid4()), time.time()
        with self.transaction() as db:
            db.execute('INSERT INTO grants(id,label,created,token_days,code_hash,code_expires) VALUES(?,?,?,?,?,?)',
                       (gid, label, now, token_days, self.token_hash(code), now + 600))
        return dict(grant_id=gid, code=code, code_expires_at=dt.datetime.fromtimestamp(now + 600, dt.timezone.utc).isoformat())

    def exchange(self, code):
        if not isinstance(code, str) or not 24 <= len(code) <= 128:
            fail(401, 'PAIR_CODE_INVALID', '配对码无效、已使用或已过期')
        token, now = secrets.token_urlsafe(32), time.time()
        with self.transaction() as db:
            grant = db.execute('SELECT * FROM grants WHERE code_hash=?', (self.token_hash(code),)).fetchone()
            if not grant or grant['revoked'] or grant['code_used'] or grant['code_expires'] <= now:
                fail(401, 'PAIR_CODE_INVALID', '配对码无效、已使用或已过期')
            expires = now + grant['token_days'] * 86400
            db.execute('UPDATE grants SET token_hash=?,token_expires=?,code_used=?,code_hash=NULL WHERE id=?',
                       (self.token_hash(token), expires, now, grant['id']))
        return dict(api_version=1, mobile_token=token, grant_id=grant['id'],
                    expires_at=dt.datetime.fromtimestamp(expires, dt.timezone.utc).isoformat())

    def authenticate(self, authorization):
        token = authorization[7:] if authorization.startswith('Bearer ') else ''
        if not 32 <= len(token) <= 128:
            fail(401, 'MOBILE_UNAUTHORIZED', '移动连接身份无效或已过期')
        with self.connect() as db:
            grant = db.execute('SELECT * FROM grants WHERE token_hash=?', (self.token_hash(token),)).fetchone()
        if not grant or grant['revoked'] or grant['token_expires'] <= time.time():
            fail(401, 'MOBILE_UNAUTHORIZED', '移动连接身份无效或已过期')
        return grant['id']

    def require_grant(self, db, gid):
        row = db.execute('SELECT revoked,token_expires FROM grants WHERE id=?', (gid,)).fetchone()
        if not row or row['revoked'] or not row['token_expires'] or row['token_expires'] <= time.time():
            fail(401, 'MOBILE_UNAUTHORIZED', '移动连接身份已撤回或已过期')

    def session(self, gid, sid):
        if not SID.fullmatch(sid):
            fail(404, 'SESSION_NOT_FOUND', '没有本连接创建的会话')
        with self.connect() as db:
            self.require_grant(db, gid)
            row = db.execute('SELECT * FROM sessions WHERE id=? AND grant_id=?', (sid, gid)).fetchone()
        if not row:
            fail(404, 'SESSION_NOT_FOUND', '没有本连接创建的会话')
        return dict(row, policy=decode(row['policy']))

    def list_sessions(self, gid):
        with self.connect() as db:
            self.require_grant(db, gid)
            rows = db.execute('SELECT id,created,started_at,time_zone,policy FROM sessions WHERE grant_id=? ORDER BY created DESC LIMIT 100', (gid,)).fetchall()
        # Registration metadata only; no upstream listing/title generation.
        return dict(items=[dict(session_id=r['id'], started_at=r['started_at'], time_zone=r['time_zone'],
                                storage_policy=decode(r['policy'])) for r in rows])

    def create_session(self, gid, rid, body):
        if set(body) - {'request_id', 'started_at', 'time_zone', *POLICY_FIELDS}:
            fail(400, 'INVALID_FIELDS', '新建会话只接受明确的保存合同和开始时间')
        policy = frozen_policy(body)
        if instant(body.get('started_at')) != instant(policy['archive_started_at']):
            fail(400, 'INVALID_TIME', '保存开始必须等于本场录音开始')
        zone = body.get('time_zone')
        if not isinstance(zone, str) or len(zone) > 80:
            fail(400, 'INVALID_TIME_ZONE', '需要有效 IANA 时区')
        try:
            ZoneInfo(zone)
        except (ValueError, KeyError):
            fail(400, 'INVALID_TIME_ZONE', '需要有效 IANA 时区')
        require_live(policy, 'audio'); require_live(policy, 'transcript')
        raw, now = canonical(body), time.time()
        fp = fingerprint('POST', '/sessions', raw)
        with self.transaction() as db:
            self.require_grant(db, gid)
            old = db.execute('SELECT * FROM requests WHERE grant_id=? AND id=?', (gid, rid)).fetchone()
            if old:
                return self.saved_response(old, fp)
            sid = str(uuid.uuid4())
            response = canonical(dict(session_id=sid, started_at=policy['archive_started_at'], time_zone=zone, storage_policy=policy))
            expiry = min(instant(policy[a + '_expires_at']).timestamp() for a in ('audio', 'transcript'))
            db.execute('INSERT INTO sessions VALUES(?,?,?,?,?,?)', (sid, gid, now, policy['archive_started_at'], zone, canonical(policy).decode()))
            db.execute('INSERT INTO requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
                       (gid, rid, sid, 'POST', '/sessions', fp, 'done', now, now, 201, response, expiry))
        return 201, response

    @staticmethod
    def saved_response(row, fp):
        if row['fingerprint'] != fp:
            fail(409, 'REQUEST_ID_CONFLICT', '同一 request ID 不可更换方法、路径或正文')
        if row['expires'] and row['expires'] <= time.time():
            fail(410, 'RECEIPT_EXPIRED', '原请求对应资产期限已过，不返回旧内容或再次写入')
        if row['state'] != 'done':
            fail(409, 'OUTCOME_UNKNOWN', '该请求已经领取或尝试，上游结果尚未知；只查询，不重新发送', request_id=row['id'], state=row['state'])
        if row['response'] is None:
            fail(410, 'RECEIPT_EXPIRED', '原请求来源已到期或失效，不返回旧回执或再次写入')
        return row['http_status'], bytes(row['response'])

    def reserve(self, gid, sid, rid, method, route, fp, expiry):
        with self.transaction() as db:
            self.require_grant(db, gid)
            db.execute('UPDATE requests SET response=NULL WHERE expires IS NOT NULL AND expires<=?', (time.time(),))
            old = db.execute('SELECT * FROM requests WHERE grant_id=? AND id=?', (gid, rid)).fetchone()
            if old:
                return self.saved_response(old, fp)
            unresolved = db.execute("SELECT id,state FROM requests WHERE grant_id=? AND session_id=? AND state IN ('attempted','unknown') LIMIT 1", (gid, sid)).fetchone()
            if unresolved:
                fail(409, 'SESSION_OUTCOME_UNKNOWN', '本场有结果未知的写操作；停止后续写入，先查询原请求与服务器状态', request_id=unresolved['id'], state=unresolved['state'])
            db.execute('INSERT INTO requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
                       (gid, rid, sid, method, route, fp, 'attempted', time.time(), None, None, None, expiry))
        return None

    def finish(self, gid, rid, status=None, response=None, unknown=False):
        with self.transaction() as db:
            db.execute('UPDATE requests SET state=?,finished=?,http_status=?,response=? WHERE grant_id=? AND id=?',
                       ('done' if status is not None and not unknown else 'unknown', time.time(), status, response, gid, rid))

    def purge_expired_receipts(self):
        with self.connect() as db:
            db.execute('UPDATE requests SET response=NULL WHERE response IS NOT NULL AND expires IS NOT NULL AND expires<=?', (time.time(),))

    def request_status(self, gid, rid):
        with self.connect() as db:
            self.require_grant(db, gid)
            row = db.execute('SELECT * FROM requests WHERE grant_id=? AND id=?', (gid, rid)).fetchone()
        if not row:
            fail(404, 'REQUEST_NOT_FOUND', '本连接没有该请求')
        return dict(request_id=rid, session_id=row['session_id'], state=row['state'],
                    method=row['method'], route=row['route'], upstream_http_status=row['http_status'],
                    attempted_at=dt.datetime.fromtimestamp(row['created'], dt.timezone.utc).isoformat())

    def revoke(self, gid):
        with self.transaction() as db:
            changed = db.execute('UPDATE grants SET revoked=?,code_hash=NULL,token_hash=NULL WHERE id=? AND revoked IS NULL',
                                 (time.time(), gid)).rowcount
        purge_revoked(self, gid)
        return dict(grant_id=gid, revoked=bool(changed))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Upstream:
    def __init__(self, base, token):
        parsed = urllib.parse.urlsplit(base)
        try:
            loopback = ipaddress.ip_address(parsed.hostname).is_loopback
        except (ValueError, TypeError):
            loopback = parsed.hostname == 'localhost'
        if parsed.scheme not in ('https', 'http') or (parsed.scheme != 'https' and not loopback) or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError('Upstream must use HTTPS or loopback HTTP, without userinfo/query/fragment')
        if not token or len(token) > 4096 or '\n' in token or '\r' in token:
            raise ValueError('A trusted-host upstream credential is required')
        self.base, self.token = base.rstrip('/'), token
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def call(self, method, path, raw=None, content_type='application/json', sha=None, timeout=45):
        # Every caller supplies a fixed, server-constructed route, never a client URL.
        headers = {'Authorization': 'Bearer ' + self.token, 'Accept': 'application/json'}
        if raw is not None:
            headers['Content-Type'] = content_type
        if sha:
            headers['X-Content-SHA256'] = sha
        req = urllib.request.Request(self.base + path, data=raw, headers=headers, method=method)
        try:
            response = self.opener.open(req, timeout=timeout)
        except urllib.error.HTTPError as error:
            response = error  # A complete HTTP error is a definite reply, not a network timeout.
        with response:
            data = response.read(RESPONSE_LIMIT + 1)
            if len(data) > RESPONSE_LIMIT:
                raise ValueError('upstream response too large')
            value = decode(data)
            if not isinstance(value, (dict, list)) or self.token in json.dumps(value, ensure_ascii=False):
                raise ValueError('unsafe upstream response')
            # Preserve the upstream status/body. No generated/sent/complete result is invented.
            return response.code, data


class Gateway:
    def __init__(self, store, upstream, asr=None):
        self.store, self.upstream, self.asr = store, upstream, asr

    def require_policy_support(self):
        try:
            status, raw = self.upstream.call('GET', '/healthz')
            value = decode(raw)
        except (OSError, ValueError, TimeoutError, http.client.HTTPException):
            fail(502, 'POLICY_CHECK_FAILED', '无法核对后端保存能力；尚未发送本次写请求')
        if status != 200 or not isinstance(value, dict) or type(value.get('archive_policy_version')) is not int or value['archive_policy_version'] < 1:
            fail(503, 'POLICY_UNSUPPORTED', '后端未确认支持正式会议独立保存期限；尚未发送本次写请求')

    @staticmethod
    def validate_reply(status, raw, sid, policy=None):
        if not 200 <= status < 300:
            return
        value = decode(raw)
        if not isinstance(value, dict) or value.get('session_id') != sid:
            raise ValueError('upstream session mismatch')
        if policy is not None and value.get('storage_policy') != policy:
            raise ValueError('upstream contract mismatch')

    def handle(self, method, route, query, headers, raw):
        if method == 'GET' and route == '/healthz' and not query:
            return 200, canonical(dict(status='ok', api_version=1, modes=['meeting'], upstream_checked=False))
        body = None
        if method == 'POST':
            if headers.get('Content-Type', '').split(';')[0].strip().lower() != 'application/json':
                fail(415, 'JSON_REQUIRED', '此接口只接受 application/json')
            try:
                body = decode(raw)
            except (ValueError, UnicodeError):
                fail(400, 'INVALID_JSON', '正文不是有效 JSON')
            if not isinstance(body, dict):
                fail(400, 'INVALID_JSON', '正文须为 JSON 对象')
        if method == 'POST' and route == '/pair' and not query:
            if set(body) != {'code'}:
                fail(400, 'INVALID_FIELDS', '配对仅接受单次配对码')
            return 200, canonical(self.store.exchange(body['code']))
        gid = self.store.authenticate(headers.get('Authorization', ''))
        if method == 'GET' and route == '/capabilities' and not query:
            capability = self.asr.capabilities() if self.asr else dict(available=False, engine='volc-bigmodel-async', version=1, max_chunk_ms=32000)
            return 200, canonical(dict(asr=capability))
        asr_match = re.fullmatch(r'/sessions/([^/]+)/asr/chunks/([0-9]{1,4})', route)
        if query and not (method == 'PUT' and ('/recordings/' in route or asr_match)):
            fail(400, 'INVALID_QUERY', '此路由不接受额外参数')
        if asr_match:
            sid, sequence = asr_match[1], int(asr_match[2])
            session = self.store.session(gid, sid)
            if self.asr is None:
                fail(503, 'ASR_UNAVAILABLE', '可信服务器尚未配置主版云转写')
            if method == 'GET' and not query:
                return 200, canonical(self.asr.get(gid, sid, sequence))
            if method != 'PUT':
                fail(405, 'METHOD_NOT_ALLOWED', 'ASR分段仅支持PUT登记或GET查询')
            if headers.get('Content-Type', '').split(';')[0].strip().lower() not in ('application/octet-stream', 'audio/pcm'):
                fail(415, 'PCM_OR_RAW_REQUIRED', 'ASR分段须为16k单声道s16le PCM')
            try:
                values = urllib.parse.parse_qs(query, strict_parsing=True)
                if set(values) != {'start_ms', 'end_ms'} or any(len(values[k]) != 1 or not re.fullmatch(r'[0-9]{1,7}', values[k][0]) for k in values):
                    raise ValueError()
                start_ms, end_ms = int(values['start_ms'][0]), int(values['end_ms'][0])
            except (ValueError, KeyError):
                fail(400, 'INVALID_ASR_TIMING', '仅接受唯一的非负start_ms与end_ms会话坐标')
            return self.asr.enqueue(gid, session, sequence, request_id(headers.get('X-Request-ID')),
                                    headers.get('X-Content-SHA256', ''), start_ms, end_ms, raw)
        if route == '/sessions':
            if method == 'GET':
                return 200, canonical(self.store.list_sessions(gid))
            if method == 'POST':
                rid = request_id(body.get('request_id'))
                header_id = headers.get('X-Request-ID')
                if header_id and request_id(header_id) != rid:
                    fail(400, 'INVALID_REQUEST_ID', '正文与请求头的 request ID 必须相同')
                return self.store.create_session(gid, rid, body)
        match = re.fullmatch(r'/requests/([a-fA-F0-9-]{36})', route)
        if method == 'GET' and match:
            rid = request_id(match[1])
            value = self.store.request_status(gid, rid)
            if self.asr:
                value.update(self.asr.request_state(gid, rid))
            return 200, canonical(value)
        match = re.fullmatch(r'/sessions/([^/]+)(?:/(sync|minutes|recordings)(?:/(manifest|complete|audio\.pcm|finals\.jsonl|asr\.jsonl|timing\.jsonl|meta\.json))?)?', route)
        if not match:
            fail(404, 'ROUTE_NOT_FOUND', '没有此移动接口')
        sid, resource, suffix = match.groups()
        session = self.store.session(gid, sid)
        policy = session['policy']
        base = '/v1/meetings/' + sid
        if method == 'GET' and suffix is None and resource in (None, 'minutes', 'recordings'):
            # Recording status is metadata: the backend reports audio/transcript
            # expiration independently, even when one asset has already expired.
            if resource != 'recordings':
                require_live(policy, 'transcript')
            path = '/v1/recordings/' + sid if resource == 'recordings' else base + ('/minutes' if resource else '')
            try:
                status, response = self.upstream.call('GET', path)
                self.validate_reply(status, response, sid)
                return status, response
            except (OSError, ValueError, TimeoutError, http.client.HTTPException):
                fail(502, 'UPSTREAM_READ_FAILED', '读取服务失败；未返回旧缓存')
        allowed = (method == 'POST' and resource == 'sync' and suffix is None) or \
                  (method == 'POST' and resource == 'recordings' and suffix in ('manifest', 'complete')) or \
                  (method == 'PUT' and resource == 'recordings' and suffix in FILES)
        if not allowed:
            fail(405, 'METHOD_NOT_ALLOWED', '此路由没有该操作')
        rid = request_id(headers.get('X-Request-ID'))
        content_type, sha = 'application/json', None
        asset = 'transcript' if resource == 'sync' or suffix in FILES and suffix != 'audio.pcm' else 'audio'
        require_live(policy, asset)
        if method == 'POST':
            if resource == 'sync' or suffix == 'manifest':
                expected = {key: policy[key] for key in POLICY_FIELDS}
                if any(key not in body for key in POLICY_FIELDS) or frozen_policy(body) != policy:
                    fail(409, 'CONTRACT_CHANGED', '须原样携带本场已冻结的保存合同')
                if resource == 'sync':
                    allowed_fields = {'session_id', 'started_at', 'time_zone', 'ended_at', 'agenda', 'utterances', 'notices',
                                      'asr_closure', 'asr_error_code', 'asr_error', *POLICY_FIELDS}
                    if set(body) - allowed_fields or body.get('session_id') != sid or instant(body.get('started_at')) != instant(session['started_at']) or body.get('time_zone') != session['time_zone']:
                        fail(400, 'INVALID_SYNC', '会话编号、开始时间、时区或同步字段不符合本场')
                    if not isinstance(body.get('utterances', []), list) or len(body.get('utterances', [])) > 500 or not isinstance(body.get('notices', []), list) or len(body.get('notices', [])) > 100:
                        fail(400, 'INVALID_SYNC', '每批最多 500 句与 100 条提醒')
                    path = '/v1/meetings/sync'
                    body['started_at'] = session['started_at']
                else:
                    if set(body) - {'files', 'meta', 'session_id', 'started_at', *POLICY_FIELDS} or body.get('session_id', sid) != sid:
                        fail(400, 'INVALID_MANIFEST', '清单字段或会话编号无效')
                    if 'started_at' in body and instant(body['started_at']) != instant(session['started_at']):
                        fail(409, 'CONTRACT_CHANGED', '清单开始时间必须等于本场原开始时间')
                    declared = body.get('files')
                    if not isinstance(declared, list) or not 1 <= len(declared) <= len(FILES):
                        fail(400, 'INVALID_MANIFEST', '需要有限的原始录音文件清单')
                    names = set()
                    for entry in declared:
                        if not isinstance(entry, dict) or set(entry) != {'name', 'size', 'sha256'}:
                            fail(400, 'INVALID_MANIFEST', '文件清单须包含 name/size/sha256')
                        name, size, digest = entry['name'], entry['size'], entry['sha256']
                        if name not in FILES or name in names or type(size) is not int or not 0 < size <= FILES[name] or not isinstance(digest, str) or not SHA.fullmatch(digest):
                            fail(400, 'INVALID_MANIFEST', '文件名、大小或 SHA-256 无效')
                        if name != 'audio.pcm':
                            require_live(policy, 'transcript')
                        if name == 'audio.pcm' and size % 2:
                            fail(400, 'INVALID_MANIFEST', 'PCM 数据必须按 16 位样本对齐')
                        names.add(name)
                    if 'audio.pcm' not in names:
                        fail(400, 'INVALID_MANIFEST', '需要 16kHz 单声道 s16le audio.pcm')
                    meta = body.get('meta', {})
                    if not isinstance(meta, dict) or len(meta) > 20 or any(not isinstance(k, str) or len(k) > 80 or isinstance(v, (dict, list)) or len(str(v)) > 200 for k, v in meta.items()):
                        fail(400, 'INVALID_MANIFEST', 'meta 最多 20 项，每项最多 200 字')
                    if meta.get('session_id', sid) != sid or 'started_at' in meta and instant(meta['started_at']) != instant(session['started_at']):
                        fail(409, 'CONTRACT_CHANGED', '录音元数据必须指向本场原会话与开始时间')
                    path = '/v1/recordings/' + sid + '/manifest'
                body.update(expected)
                raw = canonical(body)
            else:
                if body:
                    fail(400, 'INVALID_FIELDS', '完成校验接口只接受空 JSON 对象')
                path = '/v1/recordings/' + sid + '/complete'
                # Upstream completion checks every declared asset and its original TTL.
                raw = b'{}'
        else:
            content_type = headers.get('Content-Type', '').split(';')[0].strip().lower()
            if content_type not in ('application/octet-stream', 'audio/pcm'):
                fail(415, 'PCM_OR_RAW_REQUIRED', '此处上传原始分块；WAV 须先在 iPhone 转为 16k mono s16le PCM')
            try:
                values = urllib.parse.parse_qs(query, strict_parsing=True)
                if set(values) != {'offset'} or len(values['offset']) != 1 or not re.fullmatch(r'[0-9]{1,12}', values['offset'][0]):
                    raise ValueError()
                offset = int(values['offset'][0])
            except (ValueError, KeyError):
                fail(400, 'INVALID_OFFSET', '分块只接受唯一的非负 offset')
            if not raw or len(raw) > CHUNK_LIMIT or offset + len(raw) > FILES[suffix] or suffix == 'audio.pcm' and (offset % 2 or len(raw) % 2):
                fail(400, 'INVALID_CHUNK', '分块过大、为空或未按 PCM 样本对齐')
            if suffix == 'audio.pcm' and offset == 0 and raw[:4] in (b'RIFF', b'RIFX', b'RF64'):
                fail(415, 'WAV_CONVERSION_REQUIRED', '不能把 WAV 文件头作为 PCM 上传；请先在 iPhone 解码并转换格式')
            sha = headers.get('X-Content-SHA256', '')
            if not SHA.fullmatch(sha) or hashlib.sha256(raw).hexdigest() != sha:
                fail(400, 'INVALID_CHUNK_HASH', '分块 SHA-256 不匹配')
            path = '/v1/recordings/' + sid + '/' + suffix + '?offset=' + str(offset)
            content_type = 'application/octet-stream'
        expiry = instant(policy[asset + '_expires_at']).timestamp()
        operation_route = route + ('?' + query if query else '')
        fp = fingerprint(method, operation_route, raw)
        if method == 'POST' and (resource == 'sync' or suffix == 'manifest'):
            # A failed capability read occurs before reserving/sending this write.
            self.require_policy_support()
        saved = self.store.reserve(gid, sid, rid, method, operation_route, fp, expiry)
        if saved is not None:
            return saved
        try:
            status, response = self.upstream.call(method, path, raw, content_type, sha)
            if method == 'POST':
                self.validate_reply(status, response, sid,
                                    policy if resource == 'sync' or suffix == 'manifest' else None)
        except (OSError, ValueError, TimeoutError, http.client.HTTPException):
            self.store.finish(gid, rid)
            fail(409, 'OUTCOME_UNKNOWN', '上游请求已经尝试，但未收到完整有效回包；停止写入并查询原请求，不重发', request_id=rid, state='unknown')
        # A 5xx response (including a proxy timeout) cannot prove no write occurred.
        if self.asr and method == 'POST' and resource == 'sync' and 200 <= status < 300:
            self.asr.note_synced(gid, sid, body.get('utterances', []), decode(response).get('rejected', []))
        self.store.finish(gid, rid, status, response, unknown=status >= 500)
        return status, response


def handler(gateway, prefix):
    class Handler(http.server.BaseHTTPRequestHandler):
        server_version = 'OopsAppleMobile/1'
        sys_version = ''

        def setup(self):
            super().setup()
            self.connection.settimeout(20)

        def log_message(self, *_):
            pass  # No token, code, path, request body, transcript or upstream error logging.

        def dispatch(self):
            try:
                gateway.store.purge_expired_receipts()
                parsed = urllib.parse.urlsplit(self.path)
                route = parsed.path
                if prefix:
                    if not route.startswith(prefix + '/'):
                        fail(404, 'ROUTE_NOT_FOUND', '没有此接口')
                    route = route[len(prefix):]
                if self.headers.get('Transfer-Encoding') or len(self.headers.get_all('Content-Length', [])) > 1:
                    fail(400, 'INVALID_LENGTH', '需要唯一明确的 Content-Length')
                try:
                    size = int(self.headers.get('Content-Length', '0'))
                except ValueError:
                    fail(400, 'INVALID_LENGTH', 'Content-Length 无效')
                limit = CHUNK_LIMIT if self.command == 'PUT' else JSON_LIMIT
                if size < 0 or size > limit or self.command in ('POST', 'PUT') and size == 0 or self.command == 'GET' and size:
                    fail(413, 'BODY_TOO_LARGE', '正文为空、过大或不适用于该方法')
                raw = self.rfile.read(size) if size else b''
                if len(raw) != size:
                    fail(400, 'INCOMPLETE_BODY', '请求正文未完整到达')
                status, data = gateway.handle(self.command, route, parsed.query, self.headers, raw)
            except GatewayError as error:
                status, data = error.status, canonical(error.value)
            except AsrError as error:
                status, data = error.status, canonical({'error': dict(code=error.code, message=error.message)})
            except (sqlite3.Error, OSError, ValueError, TypeError, KeyError, RecursionError):
                status, data = 503, canonical({'error': {'code': 'GATEWAY_UNAVAILABLE', 'message': '移动网关暂不可用；不要更换 request ID 重发未知写操作'}})
            self.send_response(status)
            for key, value in [('Content-Type', 'application/json; charset=utf-8'), ('Content-Length', str(len(data))),
                               ('Cache-Control', 'no-store'), ('X-Content-Type-Options', 'nosniff'),
                               ('Referrer-Policy', 'no-referrer'), ('X-Robots-Tag', 'noindex, nofollow')]:
                self.send_header(key, value)
            self.end_headers()
            try:
                self.wfile.write(data)
            except (OSError, TimeoutError):
                pass  # A lost client reply never causes a second upstream write.

        do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = dispatch
    return Handler


class GatewayServer(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def service_actions(self):
        # Receipts contain only mutation acknowledgements, never request bodies.
        # Clear expired responses even when no phone is making requests.
        if time.monotonic() >= getattr(self, '_next_purge', 0):
            self.gateway_store.purge_expired_receipts()
            self.gateway_asr.maintenance()
            self._next_purge = time.monotonic() + 5

    def handle_error(self, request, client_address):
        # Avoid default tracebacks containing request context or upstream errors.
        sys.stderr.write('Apple mobile request aborted; no request context logged.\n')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', required=True, help='Private SQLite path in a dedicated directory')
    sub = parser.add_subparsers(dest='command', required=True)
    code = sub.add_parser('pair-code', help='Print one 10-minute, single-use code; contains no upstream credential')
    code.add_argument('--label', default='Apple iPhone', help='Local operator label, no account or device identifier needed')
    code.add_argument('--token-days', type=int, choices=range(1, 366), default=30, metavar='1..365')
    revoke = sub.add_parser('revoke', help='Revoke a grant and its pairing code/token')
    revoke.add_argument('--grant-id', required=True)
    sub.add_parser('grants', help='List only grant metadata; never credential hashes or values')
    serve = sub.add_parser('serve')
    serve.add_argument('--port', type=int, default=8799)
    serve.add_argument('--url-prefix', default='', help='Optional reverse-proxy path, e.g. /oops-meeting/apple-mobile')
    serve.add_argument('--upstream-url', required=True, help='Trusted existing backend base URL, HTTPS or loopback HTTP')
    serve.add_argument('--asr-config-file', help='Optional trusted private 0600 JSON containing only the main app VOLC_* configuration')
    token = serve.add_mutually_exclusive_group(required=True)
    token.add_argument('--upstream-token-file', help='Private 0600 file containing only the existing backend token')
    token.add_argument('--upstream-token-env', help='Name of the trusted service environment variable, not its value')
    args = parser.parse_args(argv)
    os.umask(0o077)
    try:
        store = Store(args.db)
        if args.command == 'pair-code':
            if not 1 <= len(args.label) <= 80:
                raise ValueError('Label must be 1..80 characters')
            print(canonical(store.make_code(args.label, args.token_days)).decode())
        elif args.command == 'revoke':
            print(canonical(store.revoke(request_id(args.grant_id))).decode())
        elif args.command == 'grants':
            with store.connect() as db:
                rows = db.execute('SELECT id,label,created,token_expires,revoked,code_used FROM grants ORDER BY created DESC LIMIT 100').fetchall()
            print(canonical({'grants': [dict(r) for r in rows]}).decode())
        else:
            if not 1024 <= args.port <= 65535:
                raise ValueError('Use a nonprivileged valid port')
            if args.upstream_token_file:
                path = Path(args.upstream_token_file)
                mode = path.stat().st_mode
                if not stat.S_ISREG(mode) or mode & 0o077:
                    raise ValueError('Upstream token file must be a private regular file (0600)')
                credential = path.read_text().strip()
            else:
                credential = os.environ.get(args.upstream_token_env, '').strip()
            upstream = Upstream(args.upstream_url, credential)
            prefix = '/' + args.url_prefix.strip('/') if args.url_prefix.strip('/') else ''
            if prefix and not re.fullmatch(r'(?:/[A-Za-z0-9_-]+)+', prefix):
                raise ValueError('Invalid URL prefix')
            asr = AsrService(store, upstream, args.asr_config_file)
            server = GatewayServer(('127.0.0.1', args.port), handler(Gateway(store, upstream, asr), prefix))
            server.gateway_store = store
            server.gateway_asr = asr
            print(f'Apple mobile gateway listening on loopback port {args.port}; HTTP bodies and credentials are not logged.', flush=True)
            asr.start()
            try:
                server.serve_forever()
            finally:
                asr.close()
                server.server_close()
    except GatewayError as error:
        print(canonical(error.value).decode(), file=sys.stderr)
        return 1
    except (OSError, ValueError, sqlite3.Error):
        print('Apple mobile gateway configuration/storage unavailable; no credentials were logged.', file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
