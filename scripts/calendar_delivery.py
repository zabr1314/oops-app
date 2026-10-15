"""Personally confirmed calendar events with durable, non-replaying write receipts.

Uses the existing Accounts user-token transport; never calls the shared CLI bot.
GET/status only reads local state. Explicit confirm may resume GET verification
of a known event, but an uncertain create/invite is never submitted again.
"""
import contextlib
import copy
import datetime as dt
import fcntl
import hashlib
import json
import os
import re
import tempfile
import threading
import uuid
from urllib.parse import quote, urlparse
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from archive_policy import expired


class CalendarError(ValueError):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def _now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def _digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def _write(path, value):
    fd, temp = tempfile.mkstemp(dir=os.path.dirname(path))
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as target:
            json.dump(value, target, ensure_ascii=False)
            target.flush()
            os.fsync(target.fileno())
        os.replace(temp, path)
        directory = os.open(os.path.dirname(path), os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def _instant(value):
    try:
        result = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        if result.tzinfo is None or result.utcoffset() is None:
            raise ValueError()
        return result
    except (ValueError, TypeError, AttributeError):
        raise CalendarError(400, 'CALENDAR_TIME_INVALID', '请填写带时区的完整开始和结束时间') from None


class CalendarDelivery:
    def __init__(self, directory, auth, meeting_loader, source_fingerprint_fn, owner_fn=None):
        self.directory, self.auth = os.fspath(directory), auth
        self.load_meeting, self.fingerprint = meeting_loader, source_fingerprint_fn
        self.owner = owner_fn or (lambda sid, principal: False)
        self.instance = uuid.uuid4().hex
        self.workers, self.workers_lock = {}, threading.Lock()
        os.makedirs(self.directory, mode=0o700, exist_ok=True)
        os.chmod(self.directory, 0o700)

    def _path(self, principal):
        return os.path.join(self.directory, _digest(principal) + '.json')

    def _read(self, principal):
        try:
            with open(self._path(principal), encoding='utf-8') as source:
                return json.load(source)
        except FileNotFoundError:
            return {'drafts': {}, 'operations': {}}

    @contextlib.contextmanager
    def _state(self, principal, nonblocking=False):
        path = self._path(principal)
        with open(path + '.lock', 'a', encoding='utf-8') as lock:
            os.chmod(path + '.lock', 0o600)
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | (fcntl.LOCK_NB if nonblocking else 0))
            except BlockingIOError:
                raise CalendarError(409, 'CALENDAR_BUSY', '原日程请求正在处理中，请查看原请求状态') from None
            try:
                state = self._read(principal)
                yield state, lambda: _write(path, state)
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)

    def _identity(self, token):
        principal = self.auth.principal_readonly_snapshot(token)
        status = self.auth.status_readonly_snapshot(token)
        account = status.get('account') or {}
        return principal, status, dict(binding_revision=status.get('binding_revision'),
            account_open_id=account.get('open_id'), tenant_key=account.get('tenant_key'))

    @staticmethod
    def _key(sid, followup_id):
        if (not isinstance(sid, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', sid) or
                not isinstance(followup_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', followup_id)):
            raise CalendarError(400, 'CALENDAR_REFERENCE_INVALID', '会议或后续安排编号无效')
        return sid + ':' + followup_id

    def _source(self, principal, sid):
        if not self.owner(sid, principal):
            raise CalendarError(403, 'MEETING_OWNER_REQUIRED', '只能核对本人会议的日程安排')
        try:
            row = self.load_meeting(sid)
            policy = row.get('storage_policy') or {}
            if (row.get('transcript_status') == 'expired' or policy.get('recording_mode', row.get('recording_mode')) == 'daily'
                    or policy.get('mode') in ('daily', 'daily_temporary')
                    or (policy.get('transcript_expires_at') and expired(policy, 'transcript'))):
                raise CalendarError(409, 'CALENDAR_SOURCE_UNAVAILABLE', '会议依据已失效，不能继续创建或邀请')
            if not row.get('ended_at'):
                raise CalendarError(409, 'MEETING_IN_PROGRESS', '请结束会议后核对日程')
            fingerprint = self.fingerprint(row)
            if not isinstance(fingerprint, str) or not fingerprint:
                raise ValueError()
            return row, fingerprint
        except CalendarError:
            raise
        except (ValueError, KeyError, FileNotFoundError):
            raise CalendarError(409, 'CALENDAR_SOURCE_CHANGED', '会议或纪要依据已变化，请重新核对') from None

    @staticmethod
    def _suggestions(row):
        out = []
        zone = row.get('time_zone') or 'UTC'
        by_id = {u['id']: u for u in row.get('utterances', [])}
        for follow in (row.get('delivery_analysis') or {}).get('follow_ups') or []:
            ids = [uid for uid in follow.get('ids', []) if uid in by_id]
            if not ids and follow.get('quote'):
                ids = [uid for uid, u in by_id.items() if follow['quote'] in u.get('text', '')]
            if not ids:
                continue
            try:
                start = _instant(follow.get('start'))
                minutes = follow.get('minutes', 30)
                if type(minutes) is not int or not 10 <= minutes <= 240:
                    continue
            except CalendarError:
                continue
            value = dict(title=str(follow.get('title') or '跟进会议')[:100], start=start.isoformat(),
                end=(start + dt.timedelta(minutes=minutes)).isoformat(), time_zone=zone,
                evidence_ids=ids, quote=str(follow.get('quote') or '')[:280])
            value['followup_id'] = 'fu-' + _digest(value)[:20]
            # Names are clues, never account IDs and never a preselected audience.
            value['attendee_hints'] = [str(name)[:100] for name in follow.get('attendees', [])][:30]
            out.append(value)
        return out

    def _check_source(self, principal, sid, draft):
        # Called inside Accounts' binding lock immediately before HTTP too;
        # do not reenter the account store from this source-only guard.
        _, fingerprint = self._source(principal, sid)
        if draft.get('source_invalidated') or fingerprint != draft['source_fingerprint']:
            raise CalendarError(409, 'CALENDAR_SOURCE_CHANGED', '会议依据已变化，请重新核对日程')

    def _check(self, token, principal, sid, draft, capability=False):
        self._check_source(principal, sid, draft)
        _, status, binding = self._identity(token)
        if any(draft.get(key) != value for key, value in binding.items()):
            raise CalendarError(409, 'FEISHU_BINDING_CHANGED', '本人飞书账号或授权已变化，请重新核对')
        if status.get('status') != 'bound' or not binding['account_open_id']:
            raise CalendarError(409, 'FEISHU_NOT_CONNECTED', '请先连接本人的飞书账号')
        if capability:
            caps = status.get('capabilities') or {}
            if not caps.get('calendar_delivery'):
                raise CalendarError(403, 'CALENDAR_PERMISSION_REQUIRED', '请补充本人日历查询、日程创建与回读权限')
            if draft['attendees'] and not caps.get('calendar_invite'):
                raise CalendarError(403, 'CALENDAR_INVITE_PERMISSION_REQUIRED', '当前授权不能添加已选参与人，请先补充日程更新权限')
        return binding

    @staticmethod
    def _attendee_names(draft):
        names = draft.get('attendee_names', {} if not draft['attendees'] else None)
        if (not isinstance(names, dict) or set(names) != set(draft['attendees'])
                or any(not isinstance(name, str) or not name for name in names.values())):
            raise CalendarError(409, 'RECIPIENTS_CHANGED', '请重新保存日程稿，核实当前参与人姓名')
        return names

    @staticmethod
    def _draft(state, key, revision):
        draft = state['drafts'].get(key)
        if not draft or type(revision) is not int or draft['revision'] != revision:
            raise CalendarError(409, 'CALENDAR_REVIEW_REQUIRED', '请读取最新日程草稿，保存核对后再确认')
        return draft

    @staticmethod
    def _op_view(op, instance=None):
        if op is None:
            return None
        result = {k: copy.deepcopy(op.get(k)) for k in ('op_id', 'session_id', 'followup_id', 'revision', 'status',
            'calendar_id', 'event_id', 'event_url', 'event_verified', 'attendees', 'invitations_verified',
            'created_at', 'updated_at', 'reason', 'message', 'source_status')}
        if op.get('status') == 'queued' and op.get('worker_instance') != instance:
            result.update(status='failed', reason='worker_restarted_before_submission',
                message='原请求尚未提交创建，可明确恢复原请求')
        elif op.get('status') == 'creating' and op.get('worker_instance') != instance:
            result.update(status='created_unverified' if op.get('event_id') else 'unknown',
                reason='worker_restarted', message='原请求已保留；只能核实原日程，不会再次创建')
        return result

    def _view(self, state, key, suggestions=None):
        draft = copy.deepcopy(state['drafts'].get(key))
        ops = [op for op in state['operations'].values() if op['key'] == key]
        sid, fid = key.split(':', 1)
        return dict(session_id=sid, followup_id=fid, draft=draft,
            calendar=self._op_view(ops[-1] if ops else None, self.instance), suggestions=suggestions or [])

    def prepare(self, token, sid, followup_id='manual'):
        key = self._key(sid, followup_id)
        principal, status, binding = self._identity(token)
        row, fingerprint = self._source(principal, sid)
        if status.get('status') != 'bound':
            raise CalendarError(409, 'FEISHU_NOT_CONNECTED', '请先连接本人的飞书账号')
        suggestions = self._suggestions(row)
        selected = next((s for s in suggestions if s['followup_id'] == followup_id), None)
        if followup_id != 'manual' and selected is None:
            raise CalendarError(409, 'CALENDAR_FOLLOWUP_CHANGED', '这条后续安排已变化，请重新选择')
        with self._state(principal) as (state, save):
            old = state['drafts'].get(key)
            if not old or old.get('source_invalidated') or old['source_fingerprint'] != fingerprint or any(old.get(k) != v for k, v in binding.items()):
                state['drafts'][key] = dict(session_id=sid, followup_id=followup_id,
                    revision=(old or {}).get('revision', 0) + 1, source_fingerprint=fingerprint,
                    title=(selected or {}).get('title', '跟进会议'), description='',
                    start=(selected or {}).get('start', ''), end=(selected or {}).get('end', ''),
                    time_zone=(selected or {}).get('time_zone', row.get('time_zone') or 'UTC'),
                    evidence_ids=(selected or {}).get('evidence_ids', []), attendees=[], attendee_names={}, reviewed=False,
                    updated_at=_now(), **binding)
                save()
            return self._view(state, key, suggestions)

    def save_review(self, token, sid, body, followup_id='manual'):
        key = self._key(sid, followup_id)
        principal, _, _ = self._identity(token)
        with self._state(principal) as (state, save):
            draft = self._draft(state, key, body.get('revision'))
            self._check(token, principal, sid, draft)
            if any(op['key'] == key and op.get('create_step') not in (None, 'failed') for op in state['operations'].values()):
                raise CalendarError(409, 'CALENDAR_OPERATION_EXISTS', '原日程已经提交，请先查看原回执；修改请到飞书核对')
            title, description = body.get('title'), body.get('description', '')
            if not isinstance(title, str) or not title.strip() or len(title) > 100:
                raise CalendarError(400, 'CALENDAR_TITLE_INVALID', '请填写100字以内的日程标题')
            if not isinstance(description, str) or len(description) > 2000:
                raise CalendarError(400, 'CALENDAR_DESCRIPTION_INVALID', '日程说明不能超过2000字')
            start, end = _instant(body.get('start')), _instant(body.get('end'))
            zone = body.get('time_zone')
            try:
                if not isinstance(zone, str):
                    raise ValueError()
                tz = ZoneInfo(zone)
            except (ValueError, ZoneInfoNotFoundError):
                raise CalendarError(400, 'CALENDAR_TIMEZONE_INVALID', '请选择有效的日程时区') from None
            if (end <= start or end - start > dt.timedelta(days=7) or
                    start.utcoffset() != start.astimezone(tz).utcoffset() or end.utcoffset() != end.astimezone(tz).utcoffset()):
                raise CalendarError(400, 'CALENDAR_TIME_INVALID', '请核对日程起止时间及所选时区，时长须在7天以内')
            attendees = body.get('attendees')
            if (not isinstance(attendees, list) or len(attendees) > 30 or any(not isinstance(a, str) or
                    not re.fullmatch(r'ou_[A-Za-z0-9_-]{1,128}', a) for a in attendees)):
                raise CalendarError(400, 'CALENDAR_ATTENDEES_INVALID', '请明确选择参与人；仅本人日程请选择空名单')
            attendees = list(dict.fromkeys(attendees))
            names = self.auth.recipient_identities(token, attendees) if attendees else {}
            if set(names) != set(attendees):
                raise CalendarError(409, 'RECIPIENTS_CHANGED', '参与人账号已变化，请重新选择')
            draft.update(title=title.strip(), description=description, start=start.isoformat(), end=end.isoformat(),
                time_zone=zone, attendees=attendees, attendee_names=names, reviewed=True, revision=draft['revision'] + 1, updated_at=_now())
            save()
            return self._view(state, key)

    def status(self, token, sid, followup_id='manual'):
        key = self._key(sid, followup_id)
        principal, _, binding = self._identity(token)
        if not self.owner(sid, principal):
            raise CalendarError(403, 'MEETING_OWNER_REQUIRED', '只能查看本人会议的日程回执')
        result = self._view(self._read(principal), key)
        try:
            _, fingerprint = self._source(principal, sid)
            source_changed = result['draft'] and result['draft'].get('source_fingerprint') != fingerprint
        except CalendarError:
            source_changed = True
        if source_changed:
            result['draft'] = None  # expired source text cannot be resurrected by a status view
            if result['calendar']:
                result['calendar']['source_status'] = 'source_changed'
        if result['draft'] and any(result['draft'].get(k) != v for k, v in binding.items()):
            result['draft']['reviewed'] = False
            result['draft']['review_status'] = 'binding_changed'
        return result

    @staticmethod
    def _operation_id(body):
        op_id = body.get('op_id')
        if not isinstance(op_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{8,100}', op_id):
            raise CalendarError(400, 'BAD_OPERATION_ID', '请使用稳定的日程请求编号')
        if body.get('confirmed') is not True:
            raise CalendarError(400, 'CONFIRMATION_REQUIRED', '请核对日程内容、时间和参与人后明确确认')
        return op_id

    def _reserve(self, token, sid, body, followup_id, nonblocking=False):
        key, op_id = self._key(sid, followup_id), self._operation_id(body)
        principal, _, _ = self._identity(token)
        # Atomic snapshots keep repeated clicks responsive while the worker
        # holds the journal lock during a provider request. Receipts are always
        # immutable in identity, revision and frozen payload.
        snapshot = self._read(principal)
        known = snapshot['operations'].get(op_id)
        if known and (known['key'] != key or known['revision'] != body.get('revision')):
            raise CalendarError(409, 'OPERATION_CONFLICT', '请求编号已用于其他日程或核对版本')
        if not known:
            known = next((o for o in reversed(list(snapshot['operations'].values()))
                if o['key'] == key and o['revision'] == body.get('revision')), None)
        if known:
            if not self.owner(sid, principal):
                raise CalendarError(403, 'MEETING_OWNER_REQUIRED', '只能查看本人会议的日程回执')
            return principal, copy.deepcopy(known)
        with self._state(principal, nonblocking=nonblocking) as (state, save):
            op = state['operations'].get(op_id)
            if op and (op['key'] != key or op['revision'] != body.get('revision')):
                raise CalendarError(409, 'OPERATION_CONFLICT', '请求编号已用于其他日程或核对版本')
            if not op:
                previous = [o for o in state['operations'].values() if o['key'] == key]
                op = next((o for o in reversed(previous) if o['revision'] == body.get('revision')), None)
                if op is None and any(o.get('create_step') not in (None, 'failed') for o in previous):
                    raise CalendarError(409, 'PREVIOUS_CALENDAR_UNRESOLVED', '原日程已提交，请先核实原回执，不能另建重复日程')
            if op:
                # Existing receipts survive source/authorization changes. Any
                # later network step rechecks the original personal binding.
                if not self.owner(sid, principal):
                    raise CalendarError(403, 'MEETING_OWNER_REQUIRED', '只能查看本人会议的日程回执')
                return principal, copy.deepcopy(op)
            draft = self._draft(state, key, body.get('revision'))
            self._check(token, principal, sid, draft, capability=True)
            if not draft.get('reviewed'):
                raise CalendarError(409, 'CALENDAR_REVIEW_REQUIRED', '请先保存并核对日程内容、时间和参与人')
            checked = self.auth.validate_recipients(token, draft['attendees'], expected_names=self._attendee_names(draft))
            if set(checked) != set(draft['attendees']):
                raise CalendarError(409, 'RECIPIENTS_CHANGED', '参与人已变化，请重新选择')
            op = dict(op_id=op_id, key=key, session_id=sid, followup_id=followup_id, revision=draft['revision'],
                draft=copy.deepcopy(draft), status='queued', attendees=draft['attendees'][:],
                idempotency_key=str(uuid.uuid5(uuid.NAMESPACE_URL, principal + ':' + op_id)),
                event_verified=False, invitations_verified=not draft['attendees'], worker_instance=self.instance,
                created_at=_now(), updated_at=_now())
            state['operations'][op_id] = op
            save()  # durable before scheduling, and before any provider write
            return principal, copy.deepcopy(op)

    def confirm_async(self, token, sid, body, followup_id='manual'):
        principal, op = self._reserve(token, sid, body, followup_id, nonblocking=True)
        if op['status'] not in ('created', 'unknown', 'invalidated'):
            key = (principal, op['op_id'])
            with self.workers_lock:
                worker = self.workers.get(key)
                if not worker or not worker.is_alive():
                    def run():
                        try:
                            self._execute(token, principal, op['op_id'])
                        finally:
                            with self.workers_lock:
                                self.workers.pop(key, None)
                    worker = threading.Thread(target=run, daemon=True, name='personal-calendar')
                    self.workers[key] = worker
                    try:
                        worker.start()
                    except Exception:
                        self.workers.pop(key, None)
                        with self._state(principal) as (state, save):
                            current = state['operations'][op['op_id']]
                            current.update(status='failed', reason='CALENDAR_SCHEDULING_FAILED', updated_at=_now())
                            save()
                        raise CalendarError(503, 'CALENDAR_SCHEDULING_FAILED', '日程尚未提交，请稍后恢复原请求') from None
        return self._op_view(op, self.instance)

    def confirm(self, token, sid, body, followup_id='manual'):
        principal, op = self._reserve(token, sid, body, followup_id)
        return self._execute(token, principal, op['op_id'])

    def _request(self, token, principal, op, method, path, body=None, params=None, write=False):
        _, status, current = self._identity(token)
        expected = {k: op['draft'].get(k) for k in ('binding_revision', 'account_open_id', 'tenant_key')}
        if status.get('status') != 'bound' or current != expected:
            raise CalendarError(409, 'FEISHU_BINDING_CHANGED', '本人飞书账号或授权已变化，原日程未继续提交')
        if write:
            self._check(token, principal, op['session_id'], op['draft'], capability=True)
        result = self.auth.user_request_for_principal(principal, method, path, body=body, params=params,
            expected_binding=expected, expected_recipients=op['attendees'],
            expected_recipient_names=self._attendee_names(op['draft']),
            before_request=lambda: self._check_source(principal, op['session_id'], op['draft']))
        if not isinstance(result, dict) or result.get('code', 0) not in (0, '0', None) or not isinstance(result.get('data'), dict):
            raise RuntimeError('invalid provider receipt')
        return result['data']

    @staticmethod
    def _event_path(op):
        return '/open-apis/calendar/v4/calendars/' + quote(op['calendar_id'], safe='') + '/events'

    @staticmethod
    def _event_body(draft):
        return dict(summary=draft['title'], description=draft['description'], need_notification=False,
            start_time=dict(timestamp=str(int(_instant(draft['start']).timestamp())), timezone=draft['time_zone']),
            end_time=dict(timestamp=str(int(_instant(draft['end']).timestamp())), timezone=draft['time_zone']),
            visibility='private', attendee_ability='none', vchat={'vc_type': 'no_meeting'})

    def _verify_event(self, token, principal, op, save):
        got = self._request(token, principal, op, 'GET', self._event_path(op) + '/' + quote(op['event_id'], safe=''),
            params={'user_id_type': 'open_id'})
        event = got.get('event') or {}
        wanted = self._event_body(op['draft'])
        if (event.get('event_id') != op['event_id'] or event.get('status') == 'cancelled'
                or event.get('organizer_calendar_id', op['calendar_id']) != op['calendar_id']
                or event.get('summary') != wanted['summary']
                or event.get('description', '') != wanted['description']
                or any(str((event.get(k) or {}).get('timestamp')) != wanted[k]['timestamp'] for k in ('start_time', 'end_time'))):
            raise CalendarError(502, 'CALENDAR_RECEIPT_MISMATCH', '原日程回读尚未匹配，请核实原日程，未重复创建')
        link = event.get('app_link')
        parsed = urlparse(link) if isinstance(link, str) else None
        host = (parsed.hostname or '').lower() if parsed else ''
        trusted = host in ('feishu.cn', 'larkoffice.com') or host.endswith(('.feishu.cn', '.larkoffice.com'))
        op.update(event_verified=True, event_url=link if parsed and parsed.scheme == 'https' and trusted and not parsed.username and not parsed.password else None,
            status='created_unverified', updated_at=_now())
        save()

    def _verify_attendees(self, token, principal, op):
        got = self._request(token, principal, op, 'GET', self._event_path(op) + '/' + quote(op['event_id'], safe='') + '/attendees',
            params={'user_id_type': 'open_id', 'page_size': 100})
        rows = got.get('items') if isinstance(got.get('items'), list) else got.get('attendees')
        if not isinstance(rows, list) or got.get('has_more'):
            return False
        present = {a.get('user_id') for a in rows if isinstance(a, dict) and a.get('type') == 'user' and a.get('rsvp_status') != 'removed'}
        return set(op['attendees']).issubset(present)

    def _execute(self, token, principal, op_id):
        with self._state(principal) as (state, save):
            op = state['operations'][op_id]
            if op['status'] in ('created', 'unknown', 'invalidated'):
                return self._op_view(op, self.instance)
            if op.get('create_step') == 'pending' and not op.get('event_id'):
                op.update(status='unknown', reason='CALENDAR_CREATE_UNKNOWN', updated_at=_now(),
                    message='上次创建结果未知，未重复创建；请核对本人飞书日历')
                save()
                return self._op_view(op, self.instance)
            try:
                if not op.get('event_id'):
                    self._check(token, principal, op['session_id'], op['draft'], capability=True)
                    if not op.get('calendar_id'):
                        data = self._request(token, principal, op, 'POST', '/open-apis/calendar/v4/calendars/primary')
                        calendars = data.get('calendars') or []
                        calendar = calendars[0].get('calendar') if len(calendars) == 1 and isinstance(calendars[0], dict) else None
                        if not isinstance(calendar, dict) or not isinstance(calendar.get('calendar_id'), str) or not calendar['calendar_id']:
                            raise CalendarError(502, 'CALENDAR_PRIMARY_UNAVAILABLE', '本人主日历尚未核实，未创建日程')
                        if calendar.get('type', 'primary') != 'primary':
                            raise CalendarError(502, 'CALENDAR_PRIMARY_UNAVAILABLE', '返回日历不是本人主日历，未创建日程')
                        op['calendar_id'] = calendar['calendar_id']
                        save()
                    op.update(status='creating', create_step='pending', worker_instance=self.instance, updated_at=_now())
                    save()
                    data = self._request(token, principal, op, 'POST', self._event_path(op),
                        body=self._event_body(op['draft']), params={'idempotency_key': op['idempotency_key'], 'user_id_type': 'open_id'}, write=True)
                    event_id = (data.get('event') or {}).get('event_id')
                    if not isinstance(event_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,200}', event_id):
                        raise RuntimeError('event ID missing')
                    op.update(event_id=event_id, create_step='done', status='created_unverified', updated_at=_now())
                    save()  # ID is durable even if the following GET fails or the process exits
                self._verify_event(token, principal, op, save)
                if op['attendees']:
                    if op.get('invite_step') in ('pending', 'done'):
                        if not self._verify_attendees(token, principal, op):
                            op.update(status='invitation_unknown', reason='CALENDAR_INVITATION_UNKNOWN', updated_at=_now(),
                                message='日程已存在，邀请结果尚未核实；未重复邀请')
                            save()
                            return self._op_view(op, self.instance)
                    else:
                        self._check(token, principal, op['session_id'], op['draft'], capability=True)
                        op.update(invite_step='pending', status='inviting', updated_at=_now())
                        save()
                        try:
                            self._request(token, principal, op, 'POST', self._event_path(op) + '/' + quote(op['event_id'], safe='') + '/attendees',
                                body={'attendees': [{'type': 'user', 'user_id': uid} for uid in op['attendees']],
                                    'need_notification': True, 'add_operator_to_attendee': False},
                                params={'user_id_type': 'open_id'}, write=True)
                        except Exception as error:
                            # Only a definite rejection of THIS invite write may
                            # be submitted again under the original operation.
                            # A later GET failure must not undo a done receipt;
                            # uncertain writes keep pending and recover by GET.
                            if not getattr(error, 'uncertain', not isinstance(error, CalendarError)):
                                op['invite_step'] = 'failed'
                                save()
                            raise
                        op['invite_step'] = 'done'
                        save()
                        if not self._verify_attendees(token, principal, op):
                            raise CalendarError(502, 'CALENDAR_INVITATION_UNVERIFIED', '日程已存在，参与人回读尚未确认')
                    op['invitations_verified'] = True
                op.update(status='created', reason=None, updated_at=_now(), message='已创建并回读本人日程')
            except Exception as error:
                uncertain = getattr(error, 'uncertain', not isinstance(error, CalendarError))
                if op.get('event_id'):
                    if op.get('invite_step') in ('pending', 'done'):
                        status = 'invitation_unknown'
                    else:
                        status = 'created_unverified'
                elif op.get('create_step') == 'pending' and uncertain:
                    status = 'unknown'
                else:
                    status = 'failed'
                    if op.get('create_step') == 'pending':
                        op['create_step'] = 'failed'
                op.update(status=status, reason=getattr(error, 'code', 'CALENDAR_OUTCOME_UNVERIFIED'), updated_at=_now(),
                    message='日程已存在；参与人添加明确失败，可恢复原请求完成邀请' if op.get('invite_step') == 'failed'
                    else '原请求结果尚未核实，未重复创建或邀请；请查看原回执')
            save()
            return self._op_view(op, self.instance)

    def invalidate(self, sid, reason='source_changed', purge_content=False):
        for name in os.listdir(self.directory):
            if not re.fullmatch(r'[a-f0-9]{64}\.json', name):
                continue
            path = os.path.join(self.directory, name)
            with open(path + '.lock', 'a', encoding='utf-8') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                try:
                    with open(path, encoding='utf-8') as source:
                        state = json.load(source)
                    for draft in state['drafts'].values():
                        if draft['session_id'] == sid:
                            draft.update(source_invalidated=True, reviewed=False)
                            if purge_content:
                                draft.update(title='', description='', evidence_ids=[])
                    for op in state['operations'].values():
                        if op['session_id'] != sid:
                            continue
                        op.update(source_status=reason, updated_at=_now())
                        op['draft']['source_invalidated'] = True
                        if purge_content:
                            op['draft'].update(title='', description='', evidence_ids=[])
                        if op['status'] not in ('created', 'unknown'):
                            op.update(status='invalidated', reason=reason)
                    _write(path, state)
                finally:
                    fcntl.flock(lock, fcntl.LOCK_UN)
