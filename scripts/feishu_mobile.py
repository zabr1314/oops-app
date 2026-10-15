"""Phone-scoped Feishu binding and explicitly reviewed minutes delivery.

The shared service credential is not a person's identity. Only a server-issued
opaque mobile session may own a new meeting or approve its delivery.
"""
import contextlib
import copy
import hashlib
import json
import os
import re
import sqlite3
import time
from urllib.parse import parse_qs, urlsplit, unquote

from calendar_delivery import CalendarDelivery, CalendarError
from agent_delivery import AgentDelivery

from feishu_accounts import Accounts, AccountError
from minutes_delivery import MinutesDelivery
from action_sources import has_source


class PersonalArtifact(bytes):
    def __new__(cls, data, name):
        value = super().__new__(cls, data)
        value.download_name = name
        return value


class MobileError(ValueError):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


class MeetingOwners:
    def __init__(self, directory):
        os.makedirs(directory, mode=0o700, exist_ok=True)
        self.path = os.path.join(directory, 'meeting-owners.sqlite3')
        with self.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS owners (sid TEXT PRIMARY KEY, principal TEXT NOT NULL, account TEXT)')
            db.execute('CREATE TABLE IF NOT EXISTS voice_owners (name TEXT PRIMARY KEY, principal TEXT NOT NULL, account TEXT NOT NULL, verified_by TEXT NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS receipts (receipt TEXT PRIMARY KEY, principal TEXT NOT NULL, expires REAL NOT NULL)')
            # Separate, explicit read grants for the review-site bridge. No HTTP
            # route may create these from a name, assignee or a service token.
            db.execute('CREATE TABLE IF NOT EXISTS read_grants (kind TEXT NOT NULL, object_id TEXT NOT NULL, principal TEXT NOT NULL, granted_by TEXT NOT NULL, granted_at REAL NOT NULL, PRIMARY KEY(kind,object_id,principal))')
        os.chmod(self.path, 0o600)

    @contextlib.contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        try:
            with db:
                yield db
        finally:
            db.close()

    def reserve(self, sid, principal, existing):
        if not isinstance(sid, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', sid):
            raise MobileError(400, 'BAD_REQUEST', '会议编号无效')
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT principal FROM owners WHERE sid=?', (sid,)).fetchone()
            if row:
                if row[0] != principal:
                    raise MobileError(403, 'MEETING_OWNER_MISMATCH', '这场会议属于另一位用户')
            elif not existing:
                db.execute('INSERT INTO owners(sid,principal) VALUES (?,?)', (sid, principal))
            # Older meetings have no reliable phone identity. They are never
            # silently assigned to the next phone that happens to sync them.

    def owned_ids(self, principal):
        with self.connect() as db:
            return frozenset(row[0] for row in db.execute('SELECT sid FROM owners WHERE principal=?', (principal,)))

    def grant_read(self, kind, object_id, principal, granted_by):
        """Server-only explicit migration; never inferred from a display name."""
        valid_id = isinstance(object_id, str) and (bool(re.fullmatch(r'[A-Za-z0-9_-]{1,100}', object_id))
                    if kind != 'voice_profile' else bool(object_id.strip()) and len(object_id) <= 60 and '/' not in object_id)
        if kind not in ('label_meeting', 'meeting', 'voice_profile') or not valid_id or not principal or not granted_by:
            raise ValueError('读取授权必须指定来源、本人身份与核实人')
        with self.connect() as db:
            db.execute('INSERT OR REPLACE INTO read_grants VALUES (?,?,?,?,?)',
                       (kind, object_id, principal, granted_by, time.time()))

    def readable_ids(self, kind, principal):
        with self.connect() as db:
            return frozenset(row[0] for row in db.execute(
                'SELECT object_id FROM read_grants WHERE kind=? AND principal=?', (kind, principal)))

    def revoke_read(self, kind, object_id, principal):
        with self.connect() as db:
            db.execute('DELETE FROM read_grants WHERE kind=? AND object_id=? AND principal=?', (kind, object_id, principal))

    def set_voice_owner(self, name, principal, account, verified_by):
        """Explicit server-side identity verification; no client-facing grant API."""
        if not all(isinstance(value, str) and value.strip() for value in (name, principal, account, verified_by)):
            raise ValueError('声纹归属需要明确核实身份和账号')
        with self.connect() as db:
            db.execute('INSERT OR REPLACE INTO voice_owners VALUES (?,?,?,?)', (name, principal, account, verified_by))

    def voice_names(self, principal, account):
        with self.connect() as db:
            return frozenset(row[0] for row in db.execute(
                'SELECT name FROM voice_owners WHERE principal=? AND account=?', (principal, account)))

    def check(self, sid, principal, account=None):
        if not isinstance(sid, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', sid):
            raise MobileError(400, 'BAD_REQUEST', '会议编号无效')
        def verify(row):
            if not row:
                raise MobileError(403, 'MEETING_OWNER_UNVERIFIED', '这场记录尚未核实所属账号，请先完成明确归属核对')
            if row[0] != principal:
                raise MobileError(403, 'MEETING_OWNER_MISMATCH', '只能访问本人有权使用的记录')
            if account and row[1] and row[1] != account:
                raise MobileError(403, 'MEETING_ACCOUNT_MISMATCH', '请重新连接这场会议原来绑定的飞书账号')
        with self.connect() as db:
            row = db.execute('SELECT principal,account FROM owners WHERE sid=?', (sid,)).fetchone()
            verify(row)
            if account and not row[1]:
                # Only the first account pin is a write. Recheck under the
                # writer lock; ordinary status/source reads never take it.
                db.execute('BEGIN IMMEDIATE')
                row = db.execute('SELECT principal,account FROM owners WHERE sid=?', (sid,)).fetchone()
                verify(row)
                if not row[1]:
                    db.execute('UPDATE owners SET account=? WHERE sid=?', (account, sid))
        return True


class MobileFeishu:
    def __init__(self, backend, directory, accounts=None):
        self.backend = backend
        self.accounts = accounts or Accounts(directory)
        self.owners = MeetingOwners(directory)
        self.delivery = MinutesDelivery(os.path.join(directory, 'deliveries'), self.accounts,
            self.load_minutes, self.fingerprint, self.markdown, owner_fn=self.check_owner)
        self.calendar = CalendarDelivery(os.path.join(directory, 'calendars'), self.accounts,
            self.load_minutes, self.fingerprint, owner_fn=self.check_owner)
        bot = getattr(self.backend, 'feishu', None)
        self.assistant = (AgentDelivery(os.path.join(directory, 'assistant-deliveries'), self.accounts,
            bot.jobs, self.check_job_owner, self.check_job_source) if bot and hasattr(bot, 'jobs') else None)

    @staticmethod
    def require_external_source(row):
        if row.get('private') or row.get('review_export_scope') in ('private', 'none', 'revoked'):
            raise MobileError(409, 'MINUTES_SOURCE_UNAVAILABLE', '来源已设为私有或撤回，旧核对不能继续用于对外操作')

    def load_minutes(self, sid):
        bot = getattr(self.backend, 'feishu', None)
        if bot is None:
            raise MobileError(503, 'MINUTES_UNAVAILABLE', '纪要服务尚未就绪，可以稍后重试')
        with self.backend.meetings.lock:
            row, analysis = bot.current_minutes(sid)
            self.require_external_source(row)
            return dict(row, delivery_analysis=analysis)

    def fingerprint(self, row):
        # Scope withdrawal is not part of the older minutes text fingerprint;
        # explicitly recheck it at every delivery boundary nevertheless.
        fresh = self.load_minutes(row['session_id'])
        data = dict(source=self.backend.feishu.minutes_fingerprint(fresh), minutes=fresh['delivery_analysis'])
        return hashlib.sha256(json.dumps(data, ensure_ascii=False, sort_keys=True).encode()).hexdigest()

    def check_job_source(self, job):
        sid = (job.get('payload') or {}).get('session_id')
        with self.backend.meetings.lock:
            self.backend.feishu.current_job_minutes(job)
            self.require_external_source(self.backend.meetings.load(sid))

    def markdown(self, row):
        return self.backend.feishu.minutes_markdown(row, row['delivery_analysis'])

    def check_owner(self, sid, principal):
        # UI status must remain readable while a worker holds the OAuth store
        # lock during an external request. The worker rechecks it atomically.
        return self.owners.check(sid, principal)

    def bind_receipt(self, token, receipt):
        if not receipt:
            return
        principal = self.accounts.principal_readonly_snapshot(token)
        with self.owners.connect() as db:
            db.execute('DELETE FROM receipts WHERE expires<?', (time.time(),))
            db.execute('INSERT INTO receipts(receipt,principal,expires) VALUES (?,?,?)',
                (hashlib.sha256(receipt.encode()).hexdigest(), principal, time.time() + 300))

    def check_action_owner(self, token, body, draft=False):
        principal = self.accounts.principal_readonly_snapshot(token)
        if not draft and not has_source(body):
            if body.get('session_id'):
                self.require_session(token, body['session_id'])
            return  # A genuinely manual task has no meeting to claim.
        sid = body.get('session_id')
        if not isinstance(sid, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', sid):
            raise MobileError(400, 'BAD_REQUEST', '来源会话编号无效')
        if draft:
            self.require_session(token, sid, create=True)
        if os.path.isfile(self.backend.meetings.path(sid)):
            self.owners.check(sid, principal, self.account_key(self.accounts.status_readonly_snapshot(token)))
        elif not draft:
            receipt = body.get('source_receipt')
            if not isinstance(receipt, str):
                raise MobileError(409, 'SOURCE_CHANGED', '请从本人的当前原话重新起草')
            with self.owners.connect() as db:
                row = db.execute('SELECT principal,expires FROM receipts WHERE receipt=?',
                    (hashlib.sha256(receipt.encode()).hexdigest(),)).fetchone()
            if not row or row[0] != principal or row[1] <= time.time():
                raise MobileError(403, 'ACTION_SOURCE_OWNER_MISMATCH', '这份原话草稿不属于当前用户或已过期')

    @staticmethod
    def account_key(status):
        a = status.get('account') or {}
        return (a.get('tenant_key', '') + ':' + a.get('open_id', '')) if a.get('open_id') else None

    def session_scope(self, token, include_shared=True):
        # Object reads do not require live OAuth or wait on an in-flight send.
        principal = self.accounts.principal_readonly_snapshot(token)
        owned = self.owners.owned_ids(principal)
        if not include_shared:
            return owned
        granted = set()
        for sid in self.owners.readable_ids('meeting', principal) - owned:
            try:
                with open(self.backend.meetings.path(sid), encoding='utf-8') as stream:
                    row = json.load(stream)
                if not row.get('private') and row.get('review_export_scope') not in ('private', 'none', 'revoked'):
                    granted.add(sid)
            except (OSError, ValueError, TypeError):
                continue
        return owned | granted

    def require_session(self, token, sid, create=False, read=False):
        principal = self.accounts.principal_readonly_snapshot(token)
        if not isinstance(sid, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', sid):
            raise MobileError(400, 'BAD_REQUEST', '会话编号无效')
        if create:
            # A recording-only or tombstoned old object is not a new session.
            # Keep the old owners schema and explicit admin migrations intact.
            meetings = self.backend.meetings
            with meetings.lock:
                path = meetings.path(sid)
                state = os.path.dirname(meetings.dir)
                existing = (os.path.exists(path) or os.path.exists(path + '.deleted') or
                            os.path.exists(os.path.join(state, 'recordings', sid)) or
                            os.path.exists(os.path.join(state, 'archive-policies', sid + '.json')))
                self.owners.reserve(sid, principal, existing)
                account = self.account_key(self.accounts.status_readonly_snapshot(token)) if not existing else None
                self.owners.check(sid, principal, account)
        elif not read or sid not in self.session_scope(token):
            self.owners.check(sid, principal)
        return principal

    def reserve_meeting(self, token, body):
        self.require_session(token, body.get('session_id'), create=True)

    def check_operation(self, token, op):
        principal = self.accounts.principal_readonly_snapshot(token)
        binding = (op or {}).get('personal_binding') or {}
        if binding.get('principal_id') != principal:
            raise MobileError(403, 'ACTION_ACCOUNT_MISMATCH', '不能读取其他账号或未核实归属的操作回执')
        account = self.accounts.status_readonly_snapshot(token).get('account') or {}
        if (binding.get('account_open_id') != account.get('open_id') or
                binding.get('tenant_key') != account.get('tenant_key')):
            raise MobileError(403, 'ACTION_ACCOUNT_MISMATCH', '请连接原飞书账号后查看这次操作')

    def meeting_view(self, token, row):
        """A source-read grant does not grant other users' task receipts."""
        principal = self.accounts.principal_readonly_snapshot(token)
        account = self.accounts.status_readonly_snapshot(token).get('account') or {}
        value = copy.deepcopy(row)
        tasks = []
        for task in value.get('tasks') or []:
            op = self.backend.ops.load(task.get('op_id'))
            binding = (op or {}).get('personal_binding') or {}
            if (binding.get('principal_id') == principal and binding.get('account_open_id') == account.get('open_id')
                    and binding.get('tenant_key') == account.get('tenant_key')):
                tasks.append(task)
        if 'tasks' in value:
            value['tasks'] = tasks
        for item in value.get('items') or []:
            task = next((task for task in tasks if set((task.get('evidence') or {}).get('utterance_ids') or []) == set(item.get('ids') or [])), None)
            item['task_status'] = (task or {}).get('status')
            item['task_url'] = ((task or {}).get('feishu_task') or {}).get('url')
        for utterance in (value.get('digest') or {}).get('commitment', []):
            task = next((task for task in tasks if utterance['id'] in (task.get('evidence') or {}).get('utterance_ids', [])), None)
            utterance['task_status'] = (task or {}).get('status')
            utterance['task_url'] = ((task or {}).get('feishu_task') or {}).get('url')
        return value

    def parsed_tasks(self, token, loader):
        principal = self.accounts.principal_readonly_snapshot(token)
        allowed = self.owners.readable_ids('label_meeting', principal)
        counts = {key: 0 for key in ('unreviewed', 'confirmed', 'rejected', 'merged', 'source_changed')}
        if not allowed:
            return dict(parsed_items=[], parsed_status=dict(state='disabled', reason_code='personal_scope_required',
                        meetings=[], counts=dict(total=0), review_counts=counts))
        value = loader()
        # A bridge read may take several seconds; withdrawn grants must not
        # survive in its final response or in aggregate counts.
        allowed = allowed & self.owners.readable_ids('label_meeting', principal)
        items = [item for item in value.get('parsed_items', [])
                 if (item.get('source_meeting') or {}).get('id') in allowed]
        meetings = [item for item in value.get('parsed_status', {}).get('meetings', []) if item.get('id') in allowed]
        for item in items:
            for review in item.get('reviews') or []:
                if review.get('verdict') in counts:
                    counts[review['verdict']] += 1
        statuses = {item.get('status') for item in meetings}
        state = 'ready' if statuses == {'ready'} else 'partial' if 'ready' in statuses else 'unavailable'
        return dict(parsed_items=items, parsed_status=dict(state=state, meetings=meetings,
                    counts=dict(total=len(items)), review_counts=counts))

    def voice_names(self, token):
        principal = self.accounts.principal_readonly_snapshot(token)
        status = self.accounts.status_readonly_snapshot(token)
        account = status.get('account') or {}
        owned = set()
        if status.get('status') == 'bound' and account.get('open_id'):
            key = self.account_key(status)
            owned.update(self.owners.voice_names(principal, key))
            # Existing preconfigured open_id mapping is evidence; a matching
            # display name, client selfName or tenant alone is not.
            data = getattr(getattr(self.backend, 'people', None), 'data', None) or {}
            mapping = dict(data.get('people') or {})
            configured_self = data.get('self') or {}
            if configured_self.get('name') and configured_self.get('open_id'):
                mapping.setdefault(configured_self['name'], configured_self['open_id'])
            matches = [name for name, open_id in mapping.items() if open_id and open_id == account['open_id']]
            if len(matches) == 1:
                owned.add(matches[0])
        shared = self.owners.readable_ids('voice_profile', principal)
        return frozenset(owned), frozenset(owned) | shared

    def require_voice(self, token, name):
        owned, _ = self.voice_names(token)
        if name not in owned:
            raise MobileError(403, 'VOICE_OWNER_UNVERIFIED', '请先核实本人账号与声音档案归属，不能修改他人的声纹')

    def voice_catalog(self, token, value):
        owned, readable = self.voice_names(token)
        people = [dict(row) if row.get('name') in owned else
                  dict(name=row['name'], registered=bool(row.get('registered')), shared=True)
                  for row in value.get('people', []) if row.get('name') in readable]
        return dict(value, people=people, person=next(iter(owned)) if len(owned) == 1 else None,
                    can_manage=bool(owned))

    @staticmethod
    def redact_voice(value, readable):
        if isinstance(value, list):
            return [MobileFeishu.redact_voice(item, readable) for item in value
                    if not isinstance(item, dict) or not item.get('name') or item['name'] in readable]
        if not isinstance(value, dict):
            return value
        result = {key: MobileFeishu.redact_voice(item, readable) for key, item in value.items()}
        if isinstance(value.get('scores'), list) and any(not isinstance(item, dict) for item in value['scores']):
            result['scores'] = []
        for key in ('speaker', 'closest'):
            if isinstance(result.get(key), str) and result[key] not in readable:
                result[key] = None
        if value.get('closest') and value['closest'] not in readable:
            result.update(score=None, margin=None, reason='未获许可的声音身份不展示')
        return result

    def check_job_owner(self, job, principal):
        # A legacy requester name or shared Bot recipient is not a personal grant.
        if job.get('owner_principal') != principal:
            return False
        sid = (job.get('payload') or {}).get('session_id')
        try:
            return self.owners.check(sid, principal)
        except MobileError:
            return False

    def assistant_jobs(self, token):
        principal = self.accounts.principal_readonly_snapshot(token)
        if self.assistant is None:
            return dict(items=[], state='unavailable', reason='assistant_unavailable')
        values = []
        journal = self.assistant._read(principal)
        for job in self.assistant.jobs.all():
            if not self.check_job_owner(job, principal):
                continue
            if not (job.get('generation_status') == 'ready' or job.get('private_result') is True):
                continue
            sid = (job.get('payload') or {}).get('session_id')
            source_status = 'current'
            try:
                self.assistant.job_source(job)
            except (ValueError, FileNotFoundError):
                source_status = 'unavailable'
            delivery = self.assistant._view(journal, job['id']).get('delivery')
            values.append(dict(job_id=job['id'], delivery=delivery, kind=job.get('kind'), title=job.get('title') or '工作成果',
                status=job.get('status'), generation_status=job.get('generation_status'),
                delivery_status=(delivery or {}).get('status') or job.get('delivery_status') or 'needs_personal_review',
                result_revision=job.get('result_revision', 1), source_status=source_status,
                session_id=sid, finished_at=job.get('finished_at'), private_result=bool(job.get('private_result'))))
        values.sort(key=lambda value: value.get('finished_at') or '', reverse=True)
        return dict(items=values, state='ready')

    def invalidate_sources(self, sid, reason='source_changed', purge_content=False):
        self.delivery.invalidate(sid, reason, purge_content=purge_content)
        self.calendar.invalidate(sid, reason, purge_content=purge_content)
        if self.assistant:
            for job in self.assistant.jobs.all():
                if (job.get('payload') or {}).get('session_id') == sid:
                    self.assistant.invalidate(job['id'], reason, purge_content=purge_content)

    @staticmethod
    def matches(path):
        return (path.startswith('/v1/feishu/') or path.startswith('/v1/assistant/jobs') or
                bool(re.fullmatch(r'/v1/meetings/[^/]+/(?:delivery|calendar)(?:/(?:save|confirm|status))?', path)))

    def dispatch(self, method, raw_path, token, body=None):
        parsed = urlsplit(raw_path)
        path, query = parsed.path, parse_qs(parsed.query)
        body = body or {}
        if method == 'POST' and path == '/v1/feishu/session':
            return self.accounts.create_session()
        if path == '/v1/feishu/status' and method == 'GET':
            return self.accounts.status_readonly_snapshot(token)
        if path == '/v1/feishu/connect' and method == 'POST':
            return self.accounts.begin(token)
        if path == '/v1/feishu/disconnect' and method == 'POST':
            return self.accounts.disconnect(token)
        if path == '/v1/feishu/recipients' and method == 'GET':
            return self.accounts.recipients(token, query.get('q', [''])[0])
        if path == '/v1/assistant/jobs' and method == 'GET':
            return self.assistant_jobs(token)
        artifact = re.fullmatch(r'/v1/assistant/jobs/([a-f0-9]{32})/files/([^/]+)', path)
        if artifact and method == 'GET':
            if self.assistant is None:
                raise MobileError(503, 'ASSISTANT_UNAVAILABLE', '工作成果服务尚未就绪')
            job_id, encoded_name = artifact.groups()
            name = unquote(encoded_name)
            if not name or os.path.basename(name) != name or '\\' in name or any(ord(char) < 32 for char in name):
                raise MobileError(400, 'BAD_ARTIFACT_NAME', '原成果文件名无效')
            return PersonalArtifact(self.assistant.artifact(token, job_id, name), name)
        assistant = re.fullmatch(r'/v1/assistant/jobs/([a-f0-9]{32})/delivery(?:/(save|confirm|status))?', path)
        if assistant:
            if self.assistant is None:
                raise MobileError(503, 'ASSISTANT_UNAVAILABLE', '工作成果服务尚未就绪')
            job_id, action = assistant.groups()
            # Authenticate even if a caller guesses a legacy job id.
            self.accounts.principal_readonly_snapshot(token)
            if action in (None, 'status') and method == 'GET':
                result = self.assistant.prepare(token, job_id) if action is None else self.assistant.status(token, job_id)
            elif action == 'save' and method == 'POST':
                result = self.assistant.save_review(token, job_id, body)
            elif action == 'confirm' and method == 'POST':
                result = self.assistant.confirm_async(token, job_id, body)
            else:
                raise MobileError(405, 'METHOD_NOT_ALLOWED', '请求方式无效')
            return dict(result, job_id=job_id)
        calendar = re.fullmatch(r'/v1/meetings/([^/]+)/calendar(?:/(save|confirm|status))?', path)
        if calendar:
            sid, action = calendar.groups()
            principal = self.accounts.principal_readonly_snapshot(token)
            status = self.accounts.status_readonly_snapshot(token)
            self.owners.check(sid, principal, self.account_key(status))
            followup_id = query.get('followup_id', ['manual'])[0]
            if action in (None, 'status') and method == 'GET':
                result = self.calendar.prepare(token, sid, followup_id) if action is None else self.calendar.status(token, sid, followup_id)
            elif action == 'save' and method == 'POST':
                result = self.calendar.save_review(token, sid, body, followup_id)
            elif action == 'confirm' and method == 'POST':
                result = dict(calendar=self.calendar.confirm_async(token, sid, body, followup_id))
            else:
                raise MobileError(405, 'METHOD_NOT_ALLOWED', '请求方式无效')
            return dict(result, session_id=sid, followup_id=followup_id)
        match = re.fullmatch(r'/v1/meetings/([^/]+)/delivery(?:/(save|confirm|status))?', path)
        if match:
            sid, action = match.groups()
            principal = self.accounts.principal_readonly_snapshot(token)
            status = self.accounts.status_readonly_snapshot(token)
            self.owners.check(sid, principal, self.account_key(status))
            if action in (None, 'status') and method == 'GET':
                result = self.delivery.prepare(token, sid) if action is None else self.delivery.status(token, sid)
            elif action == 'save' and method == 'POST':
                result = self.delivery.save_review(token, sid, body)
            elif action == 'confirm' and method == 'POST':
                if body.get('confirmed') is not True:
                    raise MobileError(400, 'CONFIRMATION_REQUIRED', '请核对纪要内容与收件人后明确确认发送')
                if status.get('status') != 'bound':
                    raise MobileError(409, 'FEISHU_AUTH_EXPIRED' if status.get('status') == 'expired' else 'FEISHU_NOT_CONNECTED',
                                      '请重新连接本人的飞书账号，再核对内容和收件人')
                result = self.delivery.confirm_async(token, sid, body)
            else:
                raise MobileError(405, 'METHOD_NOT_ALLOWED', '请求方式无效')
            return dict(result, session_id=sid)
        raise MobileError(404, 'NOT_FOUND', '没有这个飞书接口')
