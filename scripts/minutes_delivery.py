"""Private minutes review and explicitly confirmed personal Feishu delivery.

No CLI/bot fallback. The caller supplies an authenticated meeting owner check,
current minutes fingerprint/renderer, and Accounts' user-token API transport.
Each external write is journalled before submission. An uncertain write is never
replayed, including after a process crash; known completed steps can be resumed.
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

from archive_policy import expired
from feishu_accounts import AccountError


class DeliveryError(ValueError):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def _now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def _hash(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def _write(path, data):
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path))
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as target:
            json.dump(data, target, ensure_ascii=False)
            target.flush()
            os.fsync(target.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


class MinutesDelivery:
    def __init__(self, directory, auth, meeting_loader, source_fingerprint_fn, markdown_fn, owner_fn=None):
        self.directory, self.auth = directory, auth
        self.load_meeting = meeting_loader
        self.fingerprint, self.render = source_fingerprint_fn, markdown_fn
        self.owner = owner_fn or (lambda sid, principal: False)
        self.lock = threading.RLock()
        self.workers_lock = threading.Lock()
        self.workers = {}
        os.makedirs(directory, mode=0o700, exist_ok=True)

    @contextlib.contextmanager
    def _state(self, token=None, principal=None, nonblocking=False):
        principal = principal or self.auth.principal(token)
        path = os.path.join(self.directory, _hash(principal) + '.json')
        if not self.lock.acquire(blocking=not nonblocking):
            raise DeliveryError(409, 'DELIVERY_BUSY', '当前发送正在处理中，请稍后查看原请求状态')
        try:
            with open(path + '.lock', 'a', encoding='utf-8') as lock:
                os.chmod(path + '.lock', 0o600)
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | (fcntl.LOCK_NB if nonblocking else 0))
                except BlockingIOError as error:
                    raise DeliveryError(409, 'DELIVERY_BUSY', '当前发送正在处理中，请稍后查看原请求状态') from error
                try:
                    state = self._read(principal)
                    yield principal, state, lambda: _write(path, state)
                finally:
                    fcntl.flock(lock, fcntl.LOCK_UN)
        finally:
            self.lock.release()

    def _read(self, principal):
        path = os.path.join(self.directory, _hash(principal) + '.json')
        try:
            with open(path, encoding='utf-8') as source:
                return json.load(source)
        except FileNotFoundError:
            return {'drafts': {}, 'operations': {}}

    def _principal_snapshot(self, token):
        return self.auth.principal_readonly_snapshot(token)

    def _source(self, principal, sid):
        if not isinstance(sid, str) or not sid or not self.owner(sid, principal):
            raise DeliveryError(403, 'MEETING_OWNER_REQUIRED', '只能核对和发送本人会议；旧会议须先由管理员核实归属')
        try:
            row = self.load_meeting(sid)
        except (ValueError, KeyError) as error:
            if getattr(error, 'status', None) == 503:
                raise DeliveryError(503, 'MINUTES_NOT_READY', '纪要服务尚未就绪') from error
            raise DeliveryError(409, 'MINUTES_SOURCE_CHANGED', '纪要依据已变化，请重新核对') from error
        policy = row.get('storage_policy') or {}
        if (row.get('transcript_status') == 'expired' or policy.get('recording_mode', row.get('recording_mode')) == 'daily' or
                policy.get('mode') in ('daily', 'daily_temporary') or (policy.get('transcript_expires_at') and expired(policy, 'transcript'))):
            raise DeliveryError(409, 'MINUTES_SOURCE_UNAVAILABLE', '当前会议依据不可用于发送')
        if not row.get('ended_at'):
            raise DeliveryError(409, 'MEETING_IN_PROGRESS', '请结束会议后核对纪要')
        try:
            fingerprint = self.fingerprint(row)
        except (ValueError, KeyError) as error:
            raise DeliveryError(409, 'MINUTES_SOURCE_CHANGED', '纪要依据已变化，请重新核对') from error
        if not isinstance(fingerprint, str) or not fingerprint:
            raise DeliveryError(409, 'MINUTES_NOT_READY', '纪要尚未就绪')
        return row, fingerprint

    def _binding(self, token, readonly=False):
        binding = self.auth.status_readonly_snapshot(token) if readonly else self.auth.status(token)
        return {'binding_revision': binding.get('binding_revision'),
                'account_open_id': (binding.get('account') or {}).get('open_id'),
                'tenant_key': (binding.get('account') or {}).get('tenant_key')}

    def _check_current(self, token, principal, sid, draft, require_bound=False, binding=None):
        _, fingerprint = self._source(principal, sid)
        if draft.get('source_invalidated') or draft['source_fingerprint'] != fingerprint:
            raise DeliveryError(409, 'MINUTES_SOURCE_CHANGED', '纪要依据已变化，请重新核对当前内容和收件人')
        binding = binding if binding is not None else self._binding(token)
        if any(draft.get(k) != binding[k] for k in binding):
            raise DeliveryError(409, 'FEISHU_BINDING_CHANGED', '飞书账号或授权已变化，请重新核对账号、内容和收件人')
        if require_bound and not binding['account_open_id']:
            raise DeliveryError(409, 'FEISHU_NOT_CONNECTED', '请先绑定本人的飞书账号')

    @staticmethod
    def _draft(state, sid, revision=None):
        draft = state['drafts'].get(sid)
        if not draft:
            raise DeliveryError(409, 'REVIEW_REQUIRED', '请先打开纪要核对')
        if type(revision) is not int or revision != draft['revision']:
            raise DeliveryError(409, 'REVIEW_REVISION_CHANGED', '核对稿已更新，请读取最新版本再确认')
        return draft

    @staticmethod
    def _operation_view(op):
        if op is None:
            return None
        return {k: copy.deepcopy(op.get(k)) for k in
                ('op_id', 'session_id', 'revision', 'status', 'doc_url', 'created_at', 'updated_at', 'reason', 'message', 'recipients', 'permission', 'source_status', 'binding_status')}

    def _view(self, state, sid):
        draft = state['drafts'].get(sid)
        ops = [op for op in state['operations'].values() if op['session_id'] == sid]
        op = ops[-1] if ops else None
        return {'session_id': sid, 'draft': copy.deepcopy(draft), 'delivery': self._operation_view(op)}

    def prepare(self, token, sid):
        with self._state(token) as (principal, state, save):
            row, fingerprint = self._source(principal, sid)
            binding = self._binding(token)
            old = state['drafts'].get(sid)
            if old and not old.get('source_invalidated') and old['source_fingerprint'] == fingerprint and all(old.get(k) == binding[k] for k in binding):
                return self._view(state, sid)
            content = self.render(row)
            if not isinstance(content, str) or not content.strip() or len(content) > 50000 or content.count('\n') > 1000:
                raise DeliveryError(409, 'MINUTES_NOT_READY', '纪要尚未就绪')
            state['drafts'][sid] = dict(session_id=sid, revision=(old or {}).get('revision', 0) + 1,
                title=('会议纪要 · ' + (row.get('display_title') or '会议'))[:120], content=content,
                recipients=[], permission='view', source_fingerprint=fingerprint, review_status='current', updated_at=_now(), **binding)
            save()
            return self._view(state, sid)

    def save_review(self, token, sid, body):
        with self._state(token) as (principal, state, save):
            draft = self._draft(state, sid, body.get('revision'))
            self._check_current(token, principal, sid, draft)
            title, content = body.get('title'), body.get('content')
            if not isinstance(title, str) or not title.strip() or len(title) > 120:
                raise DeliveryError(400, 'BAD_TITLE', '请填写120字以内的纪要标题')
            if not isinstance(content, str) or not content.strip() or len(content) > 50000:
                raise DeliveryError(400, 'BAD_CONTENT', '请填写50000字以内的纪要正文')
            permission, recipients = body.get('permission', 'view'), body.get('recipients', [])
            if permission not in ('view', 'edit'):
                raise DeliveryError(400, 'BAD_PERMISSION', '共享权限只能选择可查看或可编辑')
            if (not isinstance(recipients, list) or len(recipients) > 30 or
                    any(not isinstance(x, str) or not re.fullmatch(r'ou_[A-Za-z0-9_-]{1,128}', x) for x in recipients)):
                raise DeliveryError(400, 'BAD_RECIPIENTS', '请从本人的飞书联系人中选择最多30位收件人')
            recipients = list(dict.fromkeys(recipients))
            names = self.auth.recipient_identities(token, recipients) if recipients else {}
            if set(names) != set(recipients):
                raise DeliveryError(400, 'BAD_RECIPIENTS', '收件人身份或组织尚未核实')
            draft.update(title=title.strip(), content=content, recipients=recipients, permission=permission,
                         recipient_names=names, revision=draft['revision'] + 1, updated_at=_now())
            save()
            return self._view(state, sid)

    def status(self, token, sid):
        """Read an atomic journal snapshot without waiting for a network-held lock."""
        principal = self._principal_snapshot(token)
        state = self._read(principal)
        try:
            _, fingerprint = self._source(principal, sid)
            draft = state['drafts'].get(sid)
            if draft:
                if draft.get('source_invalidated') or draft['source_fingerprint'] != fingerprint:
                    self._withdraw(state, sid, 'source_changed')
                elif any(draft.get(k) != v for k, v in self._binding(token, readonly=True).items()):
                    draft['review_status'] = 'binding_changed'
                    for op in state['operations'].values():
                        if op['session_id'] == sid:
                            op['binding_status'] = 'changed'
        except FileNotFoundError:
            self._withdraw(state, sid, 'source_deleted', purge_content=True)
        except DeliveryError as error:
            if error.code not in ('MINUTES_SOURCE_CHANGED', 'MINUTES_SOURCE_UNAVAILABLE', 'MINUTES_NOT_READY'):
                raise
            self._withdraw(state, sid, error.code.lower(), purge_content=error.code == 'MINUTES_SOURCE_UNAVAILABLE')
        # Source mutation/TTL hooks persist withdrawal independently; status is a
        # read-only projection so it never races or stalls the sending journal.
        return self._view(state, sid)

    @staticmethod
    def _operation_id(body):
        op_id = body.get('op_id')
        if not isinstance(op_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{8,100}', op_id):
            raise DeliveryError(400, 'BAD_OPERATION_ID', '请使用稳定的发送请求编号')
        return op_id

    @staticmethod
    def _recipient_names(draft):
        names = draft.get('recipient_names')
        if not isinstance(names, dict) or set(names) != set(draft['recipients']) or any(not isinstance(name, str) or not name for name in names.values()):
            raise DeliveryError(409, 'RECIPIENTS_CHANGED', '请重新保存核对稿，核实当前飞书收件人姓名')
        return names

    @staticmethod
    def _find_operation(state, sid, revision, op_id):
        op = state['operations'].get(op_id)
        if op and (op['session_id'] != sid or op['revision'] != revision):
            raise DeliveryError(409, 'OPERATION_CONFLICT', '此发送请求编号已用于其他核对版本')
        previous = [o for o in state['operations'].values() if o['session_id'] == sid]
        if not op:
            op = next((o for o in reversed(previous) if o['revision'] == revision), None)
            if op is None and any(o['status'] in ('unknown', 'sending', 'partial') for o in previous):
                raise DeliveryError(409, 'PREVIOUS_DELIVERY_UNRESOLVED', '上次发送尚未核实，请先查看原发送记录')
        return op

    def confirm_async(self, token, sid, body):
        """Validate before queueing and immediately return a durable sending receipt."""
        principal = self._principal_snapshot(token)
        op_id = self._operation_id(body)
        snapshot = self._read(principal)
        draft = self._draft(snapshot, sid, body.get('revision'))
        self._check_current(token, principal, sid, draft, require_bound=True, binding=self._binding(token, readonly=True))
        if not draft['recipients']:
            raise DeliveryError(400, 'RECIPIENTS_REQUIRED', '请先选择并核对收件人')
        op = self._find_operation(snapshot, sid, draft['revision'], op_id)
        if op:
            view = self._operation_view(op)
            if op['status'] in ('sent', 'unknown', 'invalidated'):
                return view
            self._start_worker(principal, token, sid, {'revision': op['revision'], 'op_id': op['op_id']})
            return view
        self._recipient_names(draft)
        # No blocking wait behind another document/network call. A concurrent
        # request can safely try the same operation again after the busy response.
        with self._state(principal=principal, nonblocking=True) as (_, state, save):
            draft = self._draft(state, sid, body.get('revision'))
            self._check_current(token, principal, sid, draft, require_bound=True, binding=self._binding(token, readonly=True))
            op = self._find_operation(state, sid, draft['revision'], op_id)
            if op is None:
                op = dict(op_id=op_id, session_id=sid, revision=draft['revision'], status='sending',
                          draft=copy.deepcopy(draft), recipients=draft['recipients'][:], permission=draft['permission'],
                          created_at=_now(), updated_at=_now(), steps={})
                state['operations'][op_id] = op
                save()
            view = self._operation_view(op)
        if op['status'] not in ('sent', 'unknown', 'invalidated'):
            self._start_worker(principal, token, sid, {'revision': op['revision'], 'op_id': op['op_id']})
        return view

    def _start_worker(self, principal, token, sid, body):
        key = (principal, body['op_id'])
        with self.workers_lock:
            if key in self.workers:
                return
            def run():
                try:
                    self.confirm(token, sid, body)
                except Exception as error:
                    # Includes preflight failures after the queue receipt: they
                    # must leave a durable terminal state instead of stuck sending.
                    with self._state(principal=principal) as (_, state, save):
                        op = state['operations'].get(body['op_id'])
                        if op and op['status'] not in ('sent', 'unknown', 'invalidated'):
                            pending = any(s['status'] == 'pending' and not s.get('read') for s in op['steps'].values())
                            code = getattr(error, 'code', 'DELIVERY_WORKER_FAILED')
                            invalidated = code in ('MINUTES_SOURCE_CHANGED', 'MINUTES_SOURCE_UNAVAILABLE', 'FEISHU_BINDING_CHANGED',
                                'FEISHU_AUTH_EXPIRED', 'FEISHU_NOT_CONNECTED', 'MEETING_OWNER_REQUIRED', 'RECIPIENTS_UNVERIFIED')
                            op.update(status='unknown' if pending else ('invalidated' if invalidated else 'failed'),
                                      reason=code, message='发送未完成，请核实原请求状态', updated_at=_now())
                            save()
                finally:
                    with self.workers_lock:
                        self.workers.pop(key, None)
            worker = threading.Thread(target=run, name='minutes-delivery-' + body['op_id'][:12], daemon=True)
            self.workers[key] = worker
            try:
                worker.start()
            except Exception as error:
                self.workers.pop(key, None)
                # Scheduling itself is a known non-submission failure. Persist
                # it so the queued operation does not remain sending forever.
                with self._state(principal=principal, nonblocking=True) as (_, state, save):
                    op = state['operations'].get(body['op_id'])
                    if op and not op['steps']:
                        op.update(status='failed', reason='DELIVERY_SCHEDULING_FAILED',
                                  message='发送尚未开始，可恢复原发送请求', updated_at=_now())
                        save()
                raise DeliveryError(503, 'DELIVERY_SCHEDULING_FAILED', '发送尚未开始，请稍后恢复原发送请求') from error

    @staticmethod
    def _withdraw(state, sid, reason, purge_content=False):
        draft = state['drafts'].get(sid)
        if draft:
            draft.update(source_invalidated=True, review_status='source_changed')
            if purge_content:
                draft.update(content='', title='会议纪要')
        for op in state['operations'].values():
            if op['session_id'] != sid:
                continue
            op['source_status'] = reason
            op['draft']['source_invalidated'] = True
            if purge_content:
                op['draft'].update(content='', title='会议纪要')
            # A historical success/unknown receipt remains truthful. Further
            # steps are blocked independently by the withdrawn source permit.
            if op['status'] not in ('sent', 'unknown'):
                op.update(status='invalidated', reason=reason)

    def invalidate(self, sid, reason='source_changed', purge_content=False):
        """Called by source revision/deletion/TTL cleanup, without impersonating its owner."""
        with self.lock:
            for name in os.listdir(self.directory):
                if not re.fullmatch(r'[a-f0-9]{64}\.json', name):
                    continue
                path = os.path.join(self.directory, name)
                with open(path + '.lock', 'a', encoding='utf-8') as lock:
                    fcntl.flock(lock, fcntl.LOCK_EX)
                    try:
                        with open(path, encoding='utf-8') as source:
                            state = json.load(source)
                        if sid in state['drafts'] or any(o['session_id'] == sid for o in state['operations'].values()):
                            self._withdraw(state, sid, reason, purge_content)
                            _write(path, state)
                    finally:
                        fcntl.flock(lock, fcntl.LOCK_UN)

    def confirm(self, token, sid, body):
        with self._state(token) as (principal, state, save):
            op_id = self._operation_id(body)
            draft = self._draft(state, sid, body.get('revision'))
            self._check_current(token, principal, sid, draft, require_bound=True)
            if not draft['recipients']:
                raise DeliveryError(400, 'RECIPIENTS_REQUIRED', '请先选择并核对收件人')
            op = self._find_operation(state, sid, draft['revision'], op_id)
            if op and op['status'] in ('sent', 'unknown', 'invalidated'):
                return self._operation_view(op)
            checked = self.auth.validate_recipients(token, draft['recipients'], expected_names=self._recipient_names(draft))
            if set(checked) != set(draft['recipients']):
                raise DeliveryError(409, 'RECIPIENTS_CHANGED', '收件人身份或组织已变化，请重新选择')
            if op is None:
                op = dict(op_id=op_id, session_id=sid, revision=draft['revision'], status='sending',
                          draft=copy.deepcopy(draft), recipients=draft['recipients'][:], permission=draft['permission'],
                          created_at=_now(), steps={})
                state['operations'][op_id] = op
                save()
            if op['status'] in ('sent', 'unknown', 'invalidated'):
                return self._operation_view(op)
            if any(step['status'] == 'pending' and not step.get('read') for step in op['steps'].values()):
                op.update(status='unknown', reason='write_outcome_unknown', updated_at=_now(),
                          message='上次请求结果尚未核实，未重复创建文档或发送消息')
                save()
                return self._operation_view(op)
            try:
                self._deliver(token, principal, sid, op, save)
                op.update(status='sent', reason=None, message='已按核对内容和收件人发送', updated_at=_now())
            except Exception as error:  # retain write journal even for token/source withdrawal mid-delivery
                uncertain = getattr(error, 'uncertain', not isinstance(error, DeliveryError))
                invalidated = getattr(error, 'code', None) in ('MINUTES_SOURCE_CHANGED', 'MINUTES_SOURCE_UNAVAILABLE', 'FEISHU_BINDING_CHANGED', 'FEISHU_AUTH_EXPIRED', 'FEISHU_NOT_CONNECTED', 'MEETING_OWNER_REQUIRED', 'RECIPIENTS_CHANGED', 'RECIPIENTS_UNVERIFIED')
                shared = any(k.startswith(('grant:', 'message:')) and v['status'] == 'done' for k, v in op['steps'].items())
                op.update(status='invalidated' if invalidated else ('unknown' if uncertain else ('partial' if shared else 'failed')),
                          reason=getattr(error, 'code', 'delivery_failed'), updated_at=_now(),
                          message='发送结果未知，请核实原请求，未重复发送' if uncertain else '发送未全部完成，请查看原请求状态')
            save()
            return self._operation_view(op)

    def _step(self, token, principal, sid, op, save, key, method, path, body=None, params=None, read=False):
        step = op['steps'].get(key)
        if step and step['status'] == 'done' and not read:
            return step['data']
        self._check_current(token, principal, sid, op['draft'], require_bound=True)
        op['steps'][key] = {'status': 'pending', 'read': read, 'at': _now()}
        save()
        try:
            # Accounts validates and submits under the same binding lock. A
            # concurrent A -> B rebind cannot execute A's review with B's token.
            expected = {key: op['draft'].get(key) for key in ('binding_revision', 'account_open_id', 'tenant_key')}
            response = self.auth.user_request_for_principal(principal, method, path, body=body, params=params,
                expected_binding=expected, expected_recipients=op['recipients'],
                expected_recipient_names=self._recipient_names(op['draft']),
                # Search/token refresh may block. Recheck source immediately
                # before HTTP, without reentering the Accounts file lock.
                before_request=lambda: self._check_current(token, principal, sid, op['draft'], require_bound=True, binding=expected))
            if not isinstance(response, dict) or response.get('code', 0) != 0:
                raise DeliveryError(502, 'FEISHU_API_REJECTED', '飞书未确认该操作成功')
            data = response.get('data') or {}
            op['steps'][key] = {'status': 'done', 'at': _now(), 'data': data}
            save()
            return data
        except Exception as error:
            if read or not getattr(error, 'uncertain', not isinstance(error, DeliveryError)):
                failure = {'status': 'failed', 'at': _now(),
                           'code': error.code if isinstance(error, (AccountError, DeliveryError)) else 'DELIVERY_STEP_FAILED'}
                provider_code = getattr(error, 'provider_code', None)
                if isinstance(provider_code, int) and not isinstance(provider_code, bool) and 0 <= provider_code <= 2147483647:
                    failure['provider_code'] = provider_code
                op['steps'][key] = failure
                save()
            if read:
                if getattr(error, 'code', None) in ('MINUTES_SOURCE_CHANGED', 'MINUTES_SOURCE_UNAVAILABLE', 'MEETING_OWNER_REQUIRED', 'FEISHU_BINDING_CHANGED', 'FEISHU_AUTH_EXPIRED', 'FEISHU_AUTH_REQUIRED', 'RECIPIENTS_CHANGED', 'RECIPIENTS_UNVERIFIED'):
                    raise
                raise DeliveryError(502, 'FEISHU_READ_FAILED', '飞书读取未完成，可恢复原发送请求') from error
            raise

    @staticmethod
    def _text_blocks(content, encoding):
        # Feishu text.elements and text_run.content are required. Use an ordinary
        # space for a visually blank paragraph, never elements=[]/an empty run.
        # https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document-block/create
        lines = (content.split('\n') if encoding == 'legacy_lf_lines' else
                 content.replace('\r\n', '\n').replace('\r', '\n').split('\n'))
        return [{'block_type': 2, 'text': {'elements': [{'text_run': {'content': line[i:i + 1600] or ' '}}]}}
                for line in lines for i in range(0, max(1, len(line)), 1600)]

    def _deliver(self, token, principal, sid, op, save):
        draft = op['draft']
        created = self._step(token, principal, sid, op, save, 'document', 'POST', '/open-apis/docx/v1/documents', {'title': draft['title']})
        doc = created.get('document') or {}
        document_id = doc.get('document_id')
        if not isinstance(document_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{3,160}', document_id):
            # The write may have succeeded even if its receipt was malformed.
            raise RuntimeError('document creation receipt missing')
        op['document_id'] = document_id
        path_id = quote(document_id, safe='')
        self._step(token, principal, sid, op, save, 'privacy', 'PATCH', f'/open-apis/drive/v1/permissions/{path_id}/public',
                   {'external_access': False, 'link_share_entity': 'closed', 'share_entity': 'only_full_access'}, {'type': 'docx'})
        privacy = self._step(token, principal, sid, op, save, 'privacy_check', 'GET', f'/open-apis/drive/v1/permissions/{path_id}/public',
                             params={'type': 'docx'}, read=True).get('permission_public') or {}
        if (privacy.get('link_share_entity') != 'closed' or privacy.get('external_access') is not False or
                privacy.get('share_entity') != 'only_full_access'):
            raise DeliveryError(502, 'DOCUMENT_PRIVACY_UNVERIFIED', '未能核实文档仅向选定人员开放')
        if 'content_encoding' not in op:
            # Keep the batch boundaries of old partially-written documents.
            # Explicitly rejected content writes can adopt the corrected shape
            # while retaining the original document and stable client token.
            already_written = any(key.startswith('content:') and step['status'] == 'done'
                                  for key, step in op['steps'].items())
            op['content_encoding'] = 'legacy_lf_lines' if already_written else 'plain_text_lines_v2'
            save()
        if op['content_encoding'] not in ('legacy_lf_lines', 'plain_text_lines_v2'):
            raise DeliveryError(409, 'CONTENT_ENCODING_UNVERIFIED', '正文写入格式无法核实，请保留原操作记录')
        blocks = self._text_blocks(draft['content'], op['content_encoding'])
        for offset in range(0, len(blocks), 40):
            self._step(token, principal, sid, op, save, f'content:{offset}', 'POST',
                f'/open-apis/docx/v1/documents/{path_id}/blocks/{path_id}/children',
                {'children': blocks[offset:offset + 40], 'index': -1},
                {'document_revision_id': -1, 'client_token': str(uuid.uuid5(uuid.NAMESPACE_URL, op['op_id'] + f':{offset}'))})
        meta = self._step(token, principal, sid, op, save, 'metadata', 'POST', '/open-apis/drive/v1/metas/batch_query',
            {'request_docs': [{'doc_token': document_id, 'doc_type': 'docx'}], 'with_url': True}, read=True)
        metadata = next((m for m in meta.get('metas', []) if m.get('doc_token') == document_id and m.get('doc_type') == 'docx'), {})
        url = metadata.get('url') or doc.get('url')
        parsed = urlparse(url or '')
        if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or
                not (parsed.hostname.endswith('.feishu.cn') or parsed.hostname == 'feishu.cn') or
                parsed.path != '/docx/' + document_id):
            raise DeliveryError(502, 'DOCUMENT_URL_UNAVAILABLE', '飞书未返回可核实的纪要链接')
        op['doc_url'] = url
        save()
        for recipient in op['recipients']:
            # The creating user's owner role is already stronger than view/edit;
            # Feishu rejects member:create on the owner with error 1063003.
            if recipient == draft['account_open_id']:
                op['steps']['grant:' + recipient] = {'status': 'skipped', 'reason': 'document_owner', 'at': _now()}
                save()
                continue
            self._step(token, principal, sid, op, save, 'grant:' + recipient, 'POST',
                f'/open-apis/drive/v1/permissions/{path_id}/members',
                {'member_type': 'openid', 'member_id': recipient, 'perm': op['permission'], 'type': 'user'},
                {'type': 'docx', 'need_notification': False})
        # Cards contain only the reviewed title and an explicit URL, never stale
        # generated snippets, inferred mentions or arbitrary source markup.
        card = {'schema': '2.0', 'header': {'title': {'tag': 'plain_text', 'content': draft['title']}},
                'body': {'elements': [{'tag': 'markdown', 'content': '纪要内容和本次收件人已由发送人核对。'},
                  {'tag': 'button', 'text': {'tag': 'plain_text', 'content': '查看纪要'},
                   'behaviors': [{'type': 'open_url', 'default_url': url}]}]}}
        for recipient in op['recipients']:
            sent = self._step(token, principal, sid, op, save, 'message:' + recipient, 'POST', '/open-apis/im/v1/messages',
                {'receive_id': recipient, 'msg_type': 'interactive', 'content': json.dumps(card, ensure_ascii=False),
                 'uuid': str(uuid.uuid5(uuid.NAMESPACE_URL, op['op_id'] + ':' + recipient))}, {'receive_id_type': 'open_id'})
            if not sent.get('message_id'):
                raise RuntimeError('message receipt missing')
