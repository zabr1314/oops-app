"""Personally reviewed delivery of an existing agent result; never runs an agent.

Uses the minutes journal in a separate directory. Selected original files use
IM File.Create and Message.Create with the same personally bound user token.
"""
import copy
import hashlib
import json
import os
import re
import stat
import uuid

from minutes_delivery import DeliveryError, MinutesDelivery, _now


def result_manifest(directory, job_id):
    """Read only regular, bounded artifacts inside this job's managed directory."""
    if not re.fullmatch(r'[a-f0-9]{32}', job_id or ''):
        raise DeliveryError(400, 'BAD_JOB_ID', '成果编号无效')
    root = os.path.join(directory, 'files', job_id)
    if os.path.islink(root) or not os.path.isdir(root):
        raise DeliveryError(409, 'MINUTES_NOT_READY', '原成果文件尚未收齐')
    files, content = [], None
    names = sorted(os.listdir(root))
    if len(names) > 32:
        raise DeliveryError(409, 'MINUTES_SOURCE_CHANGED', '成果文件数量异常')
    for name in names:
        path = os.path.join(root, name)
        if os.path.basename(name) != name or os.path.islink(path):
            raise DeliveryError(409, 'MINUTES_SOURCE_CHANGED', '成果文件已变化')
        fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
        with os.fdopen(fd, 'rb') as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > 20 * 1024 * 1024:
                raise DeliveryError(409, 'MINUTES_SOURCE_CHANGED', '成果文件无效或过大')
            data = source.read(20 * 1024 * 1024 + 1)
        if len(data) != info.st_size:
            raise DeliveryError(409, 'MINUTES_SOURCE_CHANGED', '成果文件读取时已变化')
        entry = dict(name=name, size=len(data), sha256=hashlib.sha256(data).hexdigest())
        if name == '结果.md':
            try:
                content = data.decode('utf-8')
            except UnicodeError as error:
                raise DeliveryError(409, 'MINUTES_SOURCE_CHANGED', '成果正文编码无效') from error
            entry['kind'] = 'body'
        else:
            entry['kind'] = 'file'
        files.append(entry)
    if not content or not content.strip() or len(content) > 200000:
        raise DeliveryError(409, 'MINUTES_NOT_READY', '成果正文尚未收齐')
    manifest = dict(version=1, files=files)
    manifest['fingerprint'] = hashlib.sha256(json.dumps(manifest, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    return manifest, content


class AgentDelivery(MinutesDelivery):
    def __init__(self, directory, auth, jobs, owner_fn, source_fn):
        # No shared CLI, inferred recipients or model is available to this class.
        super().__init__(directory, auth, None, None, None)
        self.jobs, self.job_owner, self.job_source = jobs, owner_fn, source_fn

    def _source(self, principal, job_id):
        try:
            job = self.jobs.load(job_id)
        except (ValueError, FileNotFoundError) as error:
            raise DeliveryError(404, 'JOB_NOT_FOUND', '找不到这份成果') from error
        # The callback MUST verify source-meeting ownership even for legacy jobs.
        # requesters, names and shared service tokens never establish ownership.
        if (job.get('owner_principal') not in (None, principal) or
                not self.job_owner(job, principal)):
            raise DeliveryError(403, 'MEETING_OWNER_REQUIRED', '这份成果尚未核实为本人所有')
        payload = job.get('payload') or {}
        if not payload.get('session_id'):
            raise DeliveryError(403, 'MEETING_OWNER_REQUIRED', '旧成果缺少可核实的会议归属')
        try:
            self.job_source(job)
        except (ValueError, FileNotFoundError) as error:
            raise DeliveryError(409, 'MINUTES_SOURCE_CHANGED', '成果依据已失效，保留历史但不能继续发送') from error
        frozen_source = payload.get('minutes_source_fingerprint') or payload.get('source_fingerprint')
        if not frozen_source or payload.get('source_expired'):
            raise DeliveryError(409, 'MINUTES_SOURCE_CHANGED', '旧成果没有有效的生成来源快照')
        legacy_ready = job.get('generation_status') is None and job.get('status') == 'failed'
        if job.get('generation_status') not in (None, 'ready') or (job.get('status') not in ('done', 'delivering') and not legacy_ready):
            raise DeliveryError(409, 'MINUTES_NOT_READY', '成果尚未生成完成')
        manifest, content = result_manifest(self.jobs.dir, job_id)
        frozen = job.get('result_manifest')
        if frozen and frozen != manifest:
            raise DeliveryError(409, 'MINUTES_SOURCE_CHANGED', '原成果文件已变化，不能沿用旧核对')
        fingerprint = hashlib.sha256(json.dumps(dict(source=frozen_source,
            revision=job.get('result_revision', 1), result=manifest), sort_keys=True).encode()).hexdigest()
        return dict(job, artifact_manifest=manifest, result_content=content), fingerprint

    def prepare(self, token, job_id):
        with self._state(token) as (principal, state, save):
            job, fingerprint = self._source(principal, job_id)
            binding = self._binding(token)
            old = state['drafts'].get(job_id)
            if old and not old.get('source_invalidated') and old['source_fingerprint'] == fingerprint and all(old.get(k) == v for k, v in binding.items()):
                return self._view(state, job_id)
            content = job['result_content']
            if len(content) > 50000 or content.count('\n') > 1000:
                raise DeliveryError(409, 'RESULT_TOO_LARGE', '成果超出本轮正文发送范围，原文件仍保留')
            state['drafts'][job_id] = dict(session_id=job_id, job_id=job_id,
                source_session_id=job['payload']['session_id'],
                revision=(old or {}).get('revision', 0) + 1, result_revision=job.get('result_revision', 1),
                title=(job.get('title') or '工作成果')[:120], content=content, recipients=[], permission='view',
                attachments=[], artifacts=copy.deepcopy(job['artifact_manifest']['files']),
                source_fingerprint=fingerprint, review_status='current', updated_at=_now(), **binding)
            save()
            return self._view(state, job_id)

    def save_review(self, token, job_id, body):
        with self._state(token) as (principal, state, save):
            draft = self._draft(state, job_id, body.get('revision'))
            self._check_current(token, principal, job_id, draft)
            title, content = body.get('title'), body.get('content')
            if not isinstance(title, str) or not title.strip() or len(title) > 120:
                raise DeliveryError(400, 'BAD_TITLE', '请填写120字以内的成果标题')
            if not isinstance(content, str) or not content.strip() or len(content) > 50000 or content.count('\n') > 1000:
                raise DeliveryError(400, 'BAD_CONTENT', '成果正文过长或为空')
            permission, recipients = body.get('permission', 'view'), body.get('recipients', [])
            if permission not in ('view', 'edit'):
                raise DeliveryError(400, 'BAD_PERMISSION', '共享权限只能选择可查看或可编辑')
            if (not isinstance(recipients, list) or len(recipients) > 30 or
                    any(not isinstance(x, str) or not re.fullmatch(r'ou_[A-Za-z0-9_-]{1,128}', x) for x in recipients)):
                raise DeliveryError(400, 'BAD_RECIPIENTS', '请核对收件人')
            recipients = list(dict.fromkeys(recipients))
            names = self.auth.recipient_identities(token, recipients) if recipients else {}
            if set(names) != set(recipients):
                raise DeliveryError(400, 'BAD_RECIPIENTS', '收件人身份或组织尚未核实')
            attachments = body.get('attachments', [])
            allowed = {f['name'] for f in draft['artifacts'] if f['kind'] == 'file'}
            if (not isinstance(attachments, list) or any(not isinstance(x, str) or x not in allowed for x in attachments)):
                raise DeliveryError(400, 'BAD_ATTACHMENTS', '请选择本版本真实存在的原成果文件')
            attachments = list(dict.fromkeys(attachments))
            if attachments and body.get('attachment_copies_confirmed') is not True:
                raise DeliveryError(400, 'FILE_COPY_CONFIRMATION_REQUIRED', '原文件将作为可下载副本发送，不受文档查看权限控制；请明确确认')
            draft.update(title=title.strip(), content=content, recipients=recipients, permission=permission,
                         recipient_names=names,
                         attachments=attachments, attachment_copies_confirmed=bool(attachments),
                         revision=draft['revision'] + 1, updated_at=_now())
            save()
            return self._view(state, job_id)

    def confirm_async(self, token, job_id, body):
        if body.get('confirmed') is not True:
            raise DeliveryError(400, 'CONFIRMATION_REQUIRED', '请核对成果正文、账号和收件人后明确确认')
        return super().confirm_async(token, job_id, body)

    @staticmethod
    def _operation_view(op):
        out = MinutesDelivery._operation_view(op)
        if out:
            out['job_id'] = op['session_id']
            out['source_session_id'] = op['draft'].get('source_session_id')
            out['result_revision'] = op['draft'].get('result_revision')
            out['progress'] = {key: step['status'] for key, step in op['steps'].items()}
            out['attachments'] = copy.deepcopy(op['draft'].get('attachments', []))
        return out

    def _view(self, state, job_id):
        out = super()._view(state, job_id)
        out.update(job_id=job_id, file_delivery_available=True,
                   source_session_id=(out.get('draft') or {}).get('source_session_id'),
                   file_delivery_notice='原文件作为可下载副本发送；文档查看/编辑权限不限制已发送的文件副本。')
        return out

    def _step(self, token, principal, sid, op, save, key, method, path, body=None, params=None, read=False):
        if key.startswith('message:') and body and body.get('msg_type') == 'interactive':
            body = copy.deepcopy(body)
            card = json.loads(body['content'])
            card['body']['elements'][0]['content'] = '工作成果正文和本次收件人已由发送人核对。原文件按本次明确选择单独发送。'
            card['body']['elements'][1]['text']['content'] = '查看工作成果'
            body['content'] = json.dumps(card, ensure_ascii=False)
        return super()._step(token, principal, sid, op, save, key, method, path, body, params, read)

    def _deliver(self, token, principal, job_id, op, save):
        super()._deliver(token, principal, job_id, op, save)
        for name in op['draft'].get('attachments', []):
            if not op['draft'].get('attachment_copies_confirmed'):
                raise DeliveryError(409, 'FILE_COPY_CONFIRMATION_REQUIRED', '请重新核对原文件发送范围')
            entry = next(f for f in op['draft']['artifacts'] if f['name'] == name)
            artifact_id = hashlib.sha256((name + ':' + entry['sha256']).encode()).hexdigest()
            key = 'file:' + artifact_id
            step = op['steps'].get(key)
            if step and step['status'] == 'done':
                uploaded = step['data']
            else:
                self._check_current(token, principal, job_id, op['draft'], require_bound=True)
                content = self.artifact(token, job_id, name)
                op['steps'][key] = dict(status='pending', read=False, at=_now())
                save()
                try:
                    expected = {k: op['draft'].get(k) for k in ('binding_revision', 'account_open_id', 'tenant_key')}
                    reply = self.auth.user_file_request_for_principal(principal, name, content,
                        expected_binding=expected, expected_recipients=op['recipients'],
                        expected_recipient_names=self._recipient_names(op['draft']),
                        # Directory lookup/token refresh may wait on network.
                        # Re-read the frozen source AND file manifest under the
                        # account's binding lock immediately before upload.
                        before_request=lambda: self._check_current(token, principal, job_id, op['draft'],
                                                                   require_bound=True, binding=expected))
                    uploaded = reply.get('data') or {}
                    if reply.get('code', 0) != 0 or not uploaded.get('file_key'):
                        raise RuntimeError('file upload receipt missing')
                    op['steps'][key] = dict(status='done', at=_now(), data=uploaded)
                    save()
                except Exception as error:
                    if not getattr(error, 'uncertain', not isinstance(error, DeliveryError)):
                        op['steps'][key] = dict(status='failed', at=_now())
                        save()
                    raise
            for recipient in op['recipients']:
                sent = self._step(token, principal, job_id, op, save, 'message:file:' + artifact_id + ':' + recipient,
                    'POST', '/open-apis/im/v1/messages',
                    dict(receive_id=recipient, msg_type='file', content=json.dumps(dict(file_key=uploaded['file_key'])),
                         uuid=str(uuid.uuid5(uuid.NAMESPACE_URL, op['op_id'] + ':file:' + artifact_id + ':' + recipient))),
                    dict(receive_id_type='open_id'))
                if not sent.get('message_id'):
                    raise RuntimeError('file message receipt missing')

    def artifact(self, token, job_id, name):
        """Owner-only original bytes; callers must use a private no-store response."""
        principal = self._principal_snapshot(token)
        job, _ = self._source(principal, job_id)
        entry = next((f for f in job['artifact_manifest']['files'] if f['name'] == name), None)
        if not entry:
            raise DeliveryError(404, 'FILE_NOT_FOUND', '找不到原成果文件')
        path = os.path.join(self.jobs.dir, 'files', job_id, name)
        fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
        with os.fdopen(fd, 'rb') as source:
            data = source.read(20 * 1024 * 1024 + 1)
        if len(data) != entry['size'] or hashlib.sha256(data).hexdigest() != entry['sha256']:
            raise DeliveryError(409, 'MINUTES_SOURCE_CHANGED', '成果文件已变化')
        return data
