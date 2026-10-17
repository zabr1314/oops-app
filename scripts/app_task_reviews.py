"""App access to the existing per-person task reviews; never a second answer store.

The caller must pass the authenticated phone identity. Client display names,
reviewer names, source URLs and arbitrary meeting IDs are never credentials.
"""
import json
import contextlib
import os
import re
import queue
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

import label_app_tasks as source


# The legacy meeting projection can wait behind live transcription and minutes
# work. Never let it hold up a fresh read from the independent review source.
# At most one uncached projection may run; timed-out results are discarded.
_meeting_reader = threading.BoundedSemaphore(1)


def _meeting_candidates_result(backend, mobile, token):
    if not _meeting_reader.acquire(blocking=False):
        return None, 'meeting_read_busy'
    result = queue.Queue(maxsize=1)

    def read():
        try:
            rows = (backend.meeting_tasks(allowed_sessions=mobile.session_scope(token), personal=token)
                    if hasattr(mobile, 'session_scope') else backend.meeting_tasks())
            if not isinstance(rows, list):
                raise ValueError('invalid_meeting_candidate_result')
            result.put((rows, None))
        except Exception:
            # Fixed reason codes only: no exception messages, source text, or
            # account data are propagated through this display endpoint.
            result.put((None, 'meeting_read_failed'))
        finally:
            _meeting_reader.release()

    threading.Thread(target=read, daemon=True, name='task-meeting-read').start()
    try:
        return result.get(timeout=2.0)
    except queue.Empty:
        return None, 'meeting_read_timeout'


def _meeting_candidates(backend, mobile, token):
    # Preserve the original three-argument/list-or-None contract for callers.
    return _meeting_candidates_result(backend, mobile, token)[0]


class ReviewError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code = status, code


def _identity(backend, token, mid=None, write=False):
    mobile = getattr(backend, 'mobile_feishu', None)
    if not mobile or not token:
        raise ReviewError(401, 'TASK_ACCOUNT_REQUIRED', '请先连接本人的飞书账号')
    principal = mobile.accounts.principal_readonly_snapshot(token)
    account_state = mobile.accounts.status_readonly_snapshot(token)
    if account_state.get('status') != 'bound':
        raise ReviewError(409, 'TASK_ACCOUNT_REQUIRED', '请先连接本人的飞书账号')
    account = account_state.get('account') or {}
    people = getattr(getattr(backend, 'people', None), 'data', None) or {}
    mapping = dict(people.get('people') or {})
    own = people.get('self') or {}
    if own.get('name') and own.get('open_id'):
        mapping.setdefault(own['name'], own['open_id'])
    names = [name for name, uid in mapping.items() if uid and uid == account.get('open_id')]
    actor = names[0] if len(names) == 1 else None
    if hasattr(mobile.owners, 'readable_ids'):
        allowed = mobile.owners.readable_ids('label_meeting', principal)
    else:
        # The deployed bridge explicitly authorizes these three legacy source
        # meetings for the mapped team. Do not turn an arbitrary OAuth display
        # name, admin role or phone's selfName into a reviewer identity.
        allowed = frozenset(source.MEETINGS) if actor else frozenset()
    if mid is not None and mid not in allowed:
        raise ReviewError(403, 'TASK_SOURCE_FORBIDDEN', '当前账号没有这场会议的核对权限')
    if write and actor is None:
        raise ReviewError(409, 'TASK_REVIEWER_UNVERIFIED', '本人飞书账号与核对姓名尚未核实，请先完成账号关联')
    binding = (principal, account_state.get('binding_revision'), account.get('open_id'), account.get('tenant_key'))
    return mobile, actor, allowed, binding


@contextlib.contextmanager
def _write_guard(mobile, token, binding):
    # Only a real answer write takes the credential lock. Listing and reading
    # must not queue behind a slow Feishu delivery holding that same lock.
    with mobile.accounts._transaction() as data:
        state = mobile.accounts._status(mobile.accounts._session(data, token))
        account = state.get('account') or {}
        current = (state.get('principal_id'), state.get('binding_revision'), account.get('open_id'), account.get('tenant_key'))
        if state.get('status') != 'bound' or current != binding:
            raise ReviewError(409, 'TASK_BINDING_CHANGED', '飞书账号或授权已变化，请重新核对')
        yield


def _config(backend):
    state = getattr(getattr(backend, 'args', None), 'state_dir', None)
    try:
        config = source._configuration(os.path.join(state, 'label-app-tasks.json') if state else None)
    except (OSError, ValueError, TypeError, source.ReadUnavailable):
        config = None
    if config is None:
        raise ReviewError(503, 'TASK_REVIEW_UNAVAILABLE', '会议核对来源暂不可用，请稍后重新读取')
    return config


def _approved(config, mid, uid):
    fp = config.get('authorized_tasks', {}).get(mid, {}).get(uid)
    if not fp:
        raise ReviewError(403, 'TASK_SOURCE_FORBIDDEN', '这件事不在已授权核对范围内')
    return fp


def _current(config, mid, uid, actor):
    try:
        args = [config['base_url'], mid, actor, time.monotonic() + source.SNAPSHOT_DEADLINE_SECONDS]
        if config.get('batch_key'):
            args.append(config['batch_key'])
        value = source._read(*args)
    except (OSError, ValueError, source.ReadUnavailable):
        raise ReviewError(503, 'TASK_REVIEW_UNAVAILABLE', '原话和核对状态暂时读不到，请重新读取') from None
    fp = _approved(config, mid, uid)
    item = next((row for row in value['items'] if row.get('id') == uid), None)
    if value.get('status') != 'ready' or not item or item.get('fingerprint') != fp:
        raise ReviewError(409, 'TASK_SOURCE_CHANGED', '这件事或原话已变化，请重新核对来源')
    return value, item


def _result(value, item, actor, mid):
    evidence = [row for span in item.get('evidence', []) for row in span.get('rows', [])]
    return dict(source='label_review', source_meeting_id=mid, item_id=item['id'],
                fingerprint=item['fingerprint'], revision=value['revision'], reviewer=actor,
                item={key: item.get(key) for key in ('id', 'kind', 'title', 'detail', 'due', 'review')},
                evidence=evidence, owners=value.get('owners', []), source_status='current',
                can_review=True, review_contract_version=1)


def open_review(backend, token, mid, uid):
    if mid not in source.MEETINGS or not re.fullmatch(r'ai-[0-9a-f]{12}', uid or ''):
        raise ReviewError(400, 'BAD_REQUEST', '核对事项编号无效')
    _, actor, _, binding = _identity(backend, token, mid, write=True)
    config = _config(backend)
    value, item = _current(config, mid, uid, actor)
    if _identity(backend, token, mid, write=True)[3] != binding:
        raise ReviewError(409, 'TASK_BINDING_CHANGED', '飞书账号已变化，请重新读取')
    return _result(value, item, actor, mid)


def save_review(backend, token, body):
    mid, uid = body.get('source_meeting_id'), body.get('item_id')
    if mid not in source.MEETINGS or not re.fullmatch(r'ai-[0-9a-f]{12}', uid or ''):
        raise ReviewError(400, 'BAD_REQUEST', '核对事项编号无效')
    mobile, actor, _, binding = _identity(backend, token, mid, write=True)
    config = _config(backend)
    current, item = _current(config, mid, uid, actor)
    if body.get('fingerprint') != item['fingerprint']:
        raise ReviewError(409, 'TASK_SOURCE_CHANGED', '事项依据已更新，请重新核对')
    action, rid, revision = body.get('action'), body.get('request_id'), body.get('revision')
    if (action not in ('confirm', 'reject', 'merge', 'reopen')
            or not isinstance(rid, str) or not re.fullmatch(r'[A-Za-z0-9_-]{8,100}', rid)
            or type(revision) is not int or revision < 0):
        raise ReviewError(400, 'BAD_REQUEST', '核对操作或版本编号无效')
    outgoing = dict(action=action, item=uid, fingerprint=item['fingerprint'], request_id=rid, revision=revision)
    if action == 'confirm':
        for key, limit in (('kind', 12), ('title', 80), ('detail', 400), ('due', 40), ('owner', 100)):
            val = body.get(key, '')
            if not isinstance(val, str) or len(val) > limit:
                raise ReviewError(400, 'BAD_REQUEST', '核对内容格式或长度无效')
            outgoing[key] = val.strip()
        if outgoing['kind'] not in ('task', 'decision', 'open') or len(outgoing['title']) < 2:
            raise ReviewError(400, 'BAD_REQUEST', '请填写事项并核对类别')
        if outgoing['kind'] == 'task' and outgoing['owner'] not in current.get('owners', []):
            raise ReviewError(400, 'TASK_OWNER_REQUIRED', '请明确选择负责人、大家或暂不确定')
    elif action == 'merge':
        into = body.get('into')
        if into == uid or into not in config['authorized_tasks'][mid]:
            raise ReviewError(400, 'BAD_REQUEST', '请选择同一会议内当前有效的另一件事')
        _current(config, mid, into, actor)
        outgoing['into'] = into
    # The original review server checks the actor-wide revision and persists
    # request_id before returning. Reusing the exact body is safe after a lost
    # response; a newer revision is not guessed or silently substituted here.
    _identity(backend, token, mid, write=True)
    headers = {'X-Labeler': urllib.parse.quote(actor, safe=''), 'Content-Type': 'application/json'}
    if config.get('batch_key'):
        headers['Authorization'] = 'Bearer ' + config['batch_key']
    request = urllib.request.Request(config['base_url'] + '/api/meeting/' + mid + '/items/review',
        data=json.dumps(outgoing, ensure_ascii=False).encode(), method='POST',
        headers=headers)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), source.NoRedirect())
    try:
        with _write_guard(mobile, token, binding):
            latest = _config(backend)
            if latest['base_url'] != config['base_url'] or _approved(latest, mid, uid) != body['fingerprint']:
                raise ReviewError(409, 'TASK_SOURCE_CHANGED', '核对来源或授权已变化，请重新读取')
            with opener.open(request, timeout=source.TIMEOUT_SECONDS) as response:
                raw = response.read(source.MAX_RESPONSE_BYTES + 1)
        if len(raw) > source.MAX_RESPONSE_BYTES:
            raise ValueError('response too large')
        value = json.loads(raw)
        saved = next((row for row in value['items'] if row.get('id') == uid), None)
        if value.get('meeting') != mid or value.get('status') != 'ready' or not saved:
            raise ValueError('invalid receipt')
    except urllib.error.HTTPError as error:
        if error.code == 409:
            raise ReviewError(409, 'TASK_REVIEW_CHANGED', '核对版本已变化，请重新读取后再确认') from None
        raise ReviewError(503, 'TASK_REVIEW_UNCONFIRMED', '未取得保存回执，请重新读取或重试同一次保存') from None
    except (OSError, ValueError, KeyError, TypeError, source.ReadUnavailable):
        raise ReviewError(503, 'TASK_REVIEW_UNCONFIRMED', '未取得保存回执，请重新读取或重试同一次保存') from None
    if _identity(backend, token, mid, write=True)[3] != binding:
        raise ReviewError(409, 'TASK_BINDING_CHANGED', '保存期间账号已变化，请重新读取核对结果')
    return dict(_result(value, saved, actor, mid), request_id=rid, saved=True)


def candidates(backend, token, people):
    started = time.monotonic()
    mobile, actor, allowed, binding = _identity(backend, token)
    config = _config(backend)
    path = os.path.join(backend.args.state_dir, 'label-app-tasks.json')
    if hasattr(mobile, 'parsed_tasks'):
        value = mobile.parsed_tasks(token, lambda: source.read_parsed_tasks(path, people))
    elif actor:
        value = source.read_parsed_tasks(path, people)
    else:
        raise ReviewError(409, 'TASK_REVIEWER_UNVERIFIED', '请先核实本人飞书账号与核对姓名')
    if _identity(backend, token)[3] != binding:
        raise ReviewError(409, 'TASK_BINDING_CHANGED', '账号已变化，请重新读取')
    for item in value.get('parsed_items', []):
        item['read_only'] = actor is None
        item['review_contract_version'] = 1
    source_done = time.monotonic()
    meetings, meeting_reason = _meeting_candidates_result(backend, mobile, token)
    if meetings is None:
        status = value['parsed_status']
        if value.get('parsed_items'):
            status['state'] = 'partial'
        status.setdefault('meetings', []).append(dict(id='app-meetings',
            title='App 会后已确认待办', status='unavailable', reason_code=meeting_reason))
    if _identity(backend, token)[3] != binding:
        raise ReviewError(409, 'TASK_BINDING_CHANGED', '账号已变化，请重新读取')
    return dict(value, meeting_items=meetings or [],
                meeting_items_status='unavailable' if meetings is None else 'ready',
                read_timing_ms=dict(source=round((source_done-started)*1000),
                                    meeting=round((time.monotonic()-source_done)*1000)),
                reviewer=actor, review_contract_version=1)
