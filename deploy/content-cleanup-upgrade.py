#!/usr/bin/env python3
"""Source-bound content cleanup; default is read-only preflight.

On host: ``python3 content-cleanup-upgrade.py baseline > baseline.json``.
Locally: ``python3 deploy/content-cleanup-upgrade.py build STAGE --baseline baseline.json --checks checks.json --data-root build/cleanup-20261013``.
Upload STAGE, then on host: ``python3 content-cleanup-upgrade.py STAGE``.
Only an explicit ``--apply`` stops services, backs up, installs and verifies.
Only four new sidecars may appear; original ASR, proposals, answers, operations,
Feishu records, environment and systemd files must stay byte-identical.
No model, task, minutes-generation, human-answer or Feishu API is called.
"""
import argparse
import datetime as dt
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import subprocess
import sys
import time
import urllib.request


BASES = {'backend': Path('/opt/oops/app/scripts'), 'label': Path('/opt/oops/label')}
FILES = {'backend': ('local_backend.py', 'meeting_features.py', 'item_quality.py', 'meeting_curation.py'),
         'label': ('team_label.py', 'team_label_ui.html', 'label_items.py', 'label_curation.py', 'content_curation.py')}
NEW = {'meeting_curation.py', 'label_curation.py', 'content_curation.py'}
PRIVATE = (Path('/var/lib/oops/backend'), Path('/var/lib/oops-label'))
MIDS = ('0235', '0236', '0238')
DATA_FILES = ('label/curation/0235.json', 'label/curation/0236.json', 'label/curation/0238.json',
              'backend/task-visibility.json')
CONFIG = (Path('/var/lib/oops/backend.env'), Path('/var/lib/oops/jev.env'),
          Path('/etc/systemd/system/oops-backend.service'), Path('/etc/systemd/system/oops-label.service'),
          Path('/etc/systemd/system/oops-label-import.service'), Path('/etc/systemd/system/oops-label-import.timer'))
SERVICES = ('oops-backend', 'oops-label')
TIMER, WORKER = 'oops-label-import.timer', 'oops-label-import.service'
VOLATILE = {'jev_stats', 'mac_agent_online'}
CAPABILITIES = {'content_curation_version': 1}
CHECKS = ('curation_integration', 'source_preservation', 'owner_gate', 'ui_checks', 'private_pending_review')
TEST_OPERATION_ID = '03f69dec-b746-49a6-afa6-cb653ccfa432'
TEST_OPERATION_TITLE = '[Oops服务器验收] 手机连接香港后端（测试）'
TEST_OPERATION_REQUEST_HASH = 'e80e2b0db92b819b1bec035e887dbb79ccb123a74a1f0f164c786a58dcdb11c3'


def data_target(relative):
    scope, name = relative.split('/', 1)
    if relative not in DATA_FILES:
        raise RuntimeError('unexpected_data_path')
    return PRIVATE[1 if scope == 'label' else 0] / name


def data_snapshot():
    out = {}
    for relative in DATA_FILES:
        path = data_target(relative)
        if path.is_symlink() or any(parent.is_symlink() for parent in path.parents):
            raise RuntimeError('data_symlink_requires_review')
        if path.exists() and not path.is_file():
            raise RuntimeError('data_not_regular_file')
        out[relative] = sha(path) if path.is_file() else None
    return out


def label_inputs_snapshot(folder=None):
    """Exact source files used for plan validation, without logging contents."""
    folder = Path(folder) if folder is not None else PRIVATE[1]
    return {mid + '/' + name: sha(path) if path.is_file() else None
            for mid in MIDS for name in ('meeting.json', 'items.json', 'suggestions.json', 'voice.json', 'roles.json')
            for path in (folder / 'meetings' / mid / name,)}


def _load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    # Avoid creating __pycache__ during a read-only preflight.
    exec(compile(Path(path).read_bytes(), str(path), 'exec'), module.__dict__)
    return module


def validate_sidecars(stage, *, live=True, fixture=None):
    """Pure validation only: do not construct Backend, Operations or a model."""
    curation = _load_module('_cleanup_source_validation', stage / 'label/content_curation.py')
    folder = PRIVATE[1] if live else Path(fixture)
    if live:
        old_path, old_bytecode = list(sys.path), sys.dont_write_bytecode
        try:
            sys.dont_write_bytecode = True
            sys.path[:0] = [str(stage / 'label'), str(BASES['label'])]
            # Data(recover_similarity=False) reads existing source snapshots only.
            label = _load_module('_cleanup_label_validation', stage / 'label/team_label.py')
            items_helper = _load_module('_cleanup_items_validation', stage / 'label/label_items.py')
            data = label.Data(str(folder), recover_similarity=False)
            inputs = {}
            for mid in MIDS:
                record = data.meetings.get(mid)
                if not record or record.get('imported'):
                    raise RuntimeError('label_source_unavailable:' + mid)
                rows = record['rows']
                reserved = items_helper.blind_ids(str(folder), mid, rows)
                doc = items_helper.load_items(str(folder / 'meetings' / mid / 'items.json'), rows, mid, reserved)
                if not doc or doc.get('status') != 'ready':
                    raise RuntimeError('label_items_not_ready:' + mid)
                inputs[mid] = rows, doc['items'], reserved
        finally:
            sys.path[:] = old_path
            sys.dont_write_bytecode = old_bytecode
    else:
        inputs = {}
        for mid in MIDS:
            source = folder / 'meetings' / mid
            rows = json.loads((source / 'meeting.json').read_text())['utterances']
            doc = json.loads((source / 'items.json').read_text())
            inputs[mid] = rows, doc['items'], doc.get('blind_ids', [])
    counts = {}
    for mid, (rows, items, reserved) in inputs.items():
        canonical = [dict(item, evidence_ids=list(dict.fromkeys(uid for span in item.get('evidence', []) for uid in span)))
                     for item in items]
        plan = json.loads((stage / 'data/label/curation' / (mid + '.json')).read_text())
        verdict = curation.validate_plan(plan, rows, canonical, meeting_id=mid)
        if verdict['status'] != 'ready':
            raise RuntimeError('curation_plan_invalid:' + mid + ':' + ','.join(verdict['errors']))
        blind = set(reserved)
        if any(set(s['evidence_ids']) & blind for s in plan['summary']) or any(
                set(op.get('evidence_ids', [])) & blind for op in plan['item_ops'] if op['action'] in ('merge', 'rewrite')):
            raise RuntimeError('curation_reveals_reserved_source:' + mid)
        counts[mid] = dict(sentences=len(rows), original_items=len(items), plan_hash=verdict['plan_hash'])
    policy = json.loads((stage / 'data/backend/task-visibility.json').read_text())
    validate_visibility(policy, live=live)
    return counts


def validate_visibility(policy, *, live=True):
    if (not isinstance(policy, dict) or set(policy) != {'schema', 'entries'} or type(policy.get('schema')) is not int
            or policy['schema'] != 1 or not isinstance(policy.get('entries'), dict) or len(policy['entries']) != 1):
        raise RuntimeError('visibility_policy_invalid')
    for op_id, entry in policy['entries'].items():
        if (not isinstance(op_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', op_id)
                or not isinstance(entry, dict) or set(entry) != {'action', 'request_hash', 'reason'}
                or entry.get('action') != 'archive' or not isinstance(entry.get('request_hash'), str)
                or not re.fullmatch('[a-f0-9]{64}', entry['request_hash'])
                or not isinstance(entry.get('reason'), str) or not 0 < len(entry['reason']) <= 300):
            raise RuntimeError('visibility_entry_invalid')
        if op_id != TEST_OPERATION_ID or entry['request_hash'] != TEST_OPERATION_REQUEST_HASH:
            raise RuntimeError('visibility_operation_not_approved_test')
        if not live:
            continue
        path = PRIVATE[0] / 'operations' / (op_id + '.json')
        if not path.is_file() or path.is_symlink():
            raise RuntimeError('visibility_operation_missing')
        op = json.loads(path.read_text())
        canonical = op.get('request_canonical')
        if (op.get('op_id') != op_id or not isinstance(canonical, str) or
                hashlib.sha256(canonical.encode()).hexdigest() != entry['request_hash']):
            raise RuntimeError('visibility_operation_changed')
        if json.loads(canonical) != op.get('request'):
            raise RuntimeError('visibility_canonical_request_mismatch')
        title = ((op.get('request') or {}).get('draft') or {}).get('what')
        if title != TEST_OPERATION_TITLE:
            raise RuntimeError('visibility_operation_not_explicit_test')
        if op.get('status') not in ('success', 'succeeded', 'done', 'created') or not isinstance(op.get('feishu_task'), dict):
            raise RuntimeError('visibility_operation_not_settled')


def run(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.PIPE).strip()


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def source_snapshot():
    result = {}
    for scope, base in BASES.items():
        for name in FILES[scope]:
            path = base / name
            if path.is_symlink() or any(parent.is_symlink() for parent in path.parents):
                raise RuntimeError('source_symlink_requires_review')
            if path.exists() and not path.is_file():
                raise RuntimeError('source_not_regular_file')
            result[scope + '/' + name] = sha(path) if path.is_file() else None
    return result


def label_catalog():
    return {path.parent.name: bool(json.loads(path.read_text()).get('imported'))
            for path in (PRIVATE[1] / 'meetings').glob('*/meeting.json')}


def protected():
    entries = {p for folder in PRIVATE for p in folder.rglob('*')}
    if any(p.is_symlink() for p in entries):
        raise RuntimeError('protected_symlink_requires_review')
    paths = {p for p in entries if p.is_file()}
    paths.update(p for p in CONFIG if p.is_file())
    if any(p.is_symlink() for p in paths):
        raise RuntimeError('protected_symlink_requires_review')
    return {str(p): sha(p) for p in sorted(paths)}


def active(unit):
    return run('systemctl', 'show', unit, '-p', 'ActiveState', '--value') == 'active'


def quiescent(unit):
    return run('systemctl', 'show', unit, '-p', 'ActiveState', '--value') in ('inactive', 'failed')


def timestamp(value):
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00')) if value else None


def pending_work():
    """Reproduce scheduling eligibility from JSON, without constructing Backend/State."""
    base = PRIVATE[0]
    path = base / 'feishu/state.json'
    if not path.is_file():
        raise RuntimeError('feishu_state_missing_requires_review')
    data = json.loads(path.read_text())
    since, now = timestamp(data.get('since')), dt.datetime.now(dt.timezone.utc)
    if since is None:
        raise RuntimeError('feishu_since_missing_requires_review')
    counts = dict(generate=0, send_cached=0, ledger=0, active_questions=0, jobs=0, operations=0, label_transactions=0)
    for path in (base / 'meetings').glob('*.json'):
        row = json.loads(path.read_text())
        if row.get('transcript_status') == 'expired':
            continue
        ended, last = timestamp(row.get('ended_at')), timestamp(row.get('last_sync_at'))
        utterances = row.get('utterances') or []
        if not ended and last and len(utterances) >= 5 and now - last > dt.timedelta(minutes=20):
            ended = timestamp(row['started_at']) + dt.timedelta(milliseconds=max(u['end_ms'] for u in utterances))
        if not ended:
            if last and last > now - dt.timedelta(minutes=10):
                counts['active_questions'] += 1
            continue
        if ended <= since:
            continue
        state = data.get('meetings', {}).get(row.get('session_id', path.stem), {})
        if not state.get('done') and (state.get('failures') or 0) < 6:
            key = 'generate' if not state.get('analysis') or state['analysis'].get('version') != 5 else 'send_cached'
            counts[key] += 1  # includes future retries: do not bring them forward by restarting
        if state.get('done') and state.get('ledger_pending') and (state.get('ledger_failures') or 0) < 6:
            counts['ledger'] += 1
    for path in (base / 'agent-jobs').glob('*.json'):
        if json.loads(path.read_text()).get('status') in ('queued', 'running', 'delivering'):
            counts['jobs'] += 1
    for path in (base / 'operations').glob('*.json'):
        if json.loads(path.read_text()).get('status') in ('pending', 'creating', 'sending'):
            counts['operations'] += 1
    # /api/me reads progress, whose normal read path recovers prepared group
    # answers. Refuse such a pending transaction before restarting or probing.
    for path in (PRIVATE[1] / 'similarity_requests').rglob('*.json'):
        state = json.loads(path.read_text()).get('status')
        if state == 'prepared':
            counts['label_transactions'] += 1
        elif state != 'committed':
            raise RuntimeError('label_transaction_state_requires_review')
    return counts


def compile_if_python(path):
    if path.suffix == '.py':
        compile(path.read_bytes(), str(path), 'exec')


def build(stage, baseline, checks, data_root):
    root = Path(__file__).resolve().parent.parent
    baseline = json.loads(Path(baseline).read_text())
    previous = baseline['sources']
    checked = json.loads(Path(checks).read_text())
    if any(checked.get(key) is not True for key in CHECKS):
        raise ValueError('incomplete_completed_checks')
    expected = {scope + '/' + name for scope in FILES for name in FILES[scope]}
    if set(previous) != expected:
        raise ValueError('unexpected_baseline_file_set')
    if baseline.get('new_data') != {name: None for name in DATA_FILES}:
        raise ValueError('new_sidecars_must_be_absent')
    if set(baseline.get('label_inputs', {})) != set(label_inputs_snapshot(Path(data_root) / 'fixture-data')):
        raise ValueError('label_inputs_baseline_missing')
    stage = Path(stage).resolve()
    stage.mkdir(parents=True, exist_ok=False)
    hashes = {}
    for relative in sorted(expected):
        scope, name = relative.split('/')
        digest = previous[relative]
        if not (isinstance(digest, str) and re.fullmatch('[a-f0-9]{64}', digest)) and not (digest is None and name in NEW):
            raise ValueError('invalid_baseline:' + relative)
        target = stage / relative
        target.parent.mkdir(exist_ok=True)
        shutil.copyfile(root / 'scripts' / name, target)
        compile_if_python(target)
        hashes[relative] = sha(target)
    data_hashes = {}
    for relative in DATA_FILES:
        scope, name = relative.split('/', 1)
        source = Path(data_root) / ('plans/label/' + Path(name).name if scope == 'label' else name)
        if source.is_symlink() or not source.is_file():
            raise ValueError('data_input_missing_or_symlink:' + relative)
        target = stage / 'data' / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        json.loads(target.read_text())
        data_hashes[relative] = sha(target)
    plan_counts = validate_sidecars(stage, live=False, fixture=Path(data_root) / 'fixture-data')
    shutil.copyfile(__file__, stage / 'content-cleanup-upgrade.py')
    manifest = dict(schema=1, files=hashes, baseline=previous, label_catalog=baseline['label_catalog'], checks=checked,
                    data_files=data_hashes, new_data_baseline=baseline['new_data'], label_inputs=baseline['label_inputs'],
                    plan_counts=plan_counts, installer_sha256=sha(stage / 'content-cleanup-upgrade.py'))
    (stage / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps(dict(built=str(stage), source_files=len(hashes), new_data_files=len(data_hashes), plan_counts=plan_counts)))


def validate(stage):
    manifest = json.loads((stage / 'manifest.json').read_text())
    expected = {scope + '/' + name for scope in FILES for name in FILES[scope]}
    if manifest.get('schema') != 1 or set(manifest.get('files', {})) != expected or set(manifest.get('baseline', {})) != expected:
        raise RuntimeError('unexpected_release_file_set')
    if (set(manifest.get('data_files', {})) != set(DATA_FILES)
            or manifest.get('new_data_baseline') != {name: None for name in DATA_FILES}):
        raise RuntimeError('unexpected_release_data_set')
    if sha(__file__) != manifest.get('installer_sha256'):
        raise RuntimeError('installer_checksum_mismatch')
    for relative, digest in manifest['baseline'].items():
        if not (isinstance(digest, str) and re.fullmatch('[a-f0-9]{64}', digest)) and not (digest is None and relative.split('/')[1] in NEW):
            raise RuntimeError('invalid_baseline:' + relative)
    for relative, digest in manifest['files'].items():
        source = stage / relative
        if source.is_symlink() or source.parent.is_symlink() or sha(source) != digest:
            raise RuntimeError('release_checksum_mismatch:' + relative)
        compile_if_python(source)
    for relative, digest in manifest['data_files'].items():
        source = stage / 'data' / relative
        if source.is_symlink() or any(p.is_symlink() for p in source.parents) or sha(source) != digest:
            raise RuntimeError('release_data_checksum_mismatch:' + relative)
    if source_snapshot() != manifest['baseline']:
        raise RuntimeError('live_source_drift_requires_review')
    if data_snapshot() != manifest['new_data_baseline']:
        raise RuntimeError('live_new_sidecar_drift_requires_review')
    if label_inputs_snapshot() != manifest.get('label_inputs'):
        raise RuntimeError('live_label_input_drift_requires_review')
    if any(manifest.get('checks', {}).get(key) is not True for key in CHECKS):
        raise RuntimeError('incomplete_completed_checks')
    catalog = label_catalog()
    if catalog != manifest.get('label_catalog') or set(catalog) != {'0235', '0236', '0238'} or any(catalog.values()):
        raise RuntimeError('label_catalog_changed_or_imported_revision_requires_review')
    if validate_sidecars(stage) != manifest.get('plan_counts'):
        raise RuntimeError('plan_validation_snapshot_mismatch')
    return manifest


def preflight(stage):
    if os.geteuid() != 0 or any(not p.is_dir() for p in BASES.values()):
        raise RuntimeError('existing_host_root_required')
    manifest = validate(stage)
    if not all(active(unit) for unit in SERVICES):
        raise RuntimeError('existing_services_must_be_active')
    pending = pending_work()
    if any(pending.values()):
        raise RuntimeError('pending_external_or_paid_work:' + json.dumps(pending, sort_keys=True))
    return manifest, pending


def get_json(url, headers=None):
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers or {}), timeout=5) as response:
        return json.load(response)


def service_token():
    pid = run('systemctl', 'show', 'oops-backend', '-p', 'MainPID', '--value')
    values = dict(entry.split(b'=', 1) for entry in Path('/proc/' + pid + '/environ').read_bytes().split(b'\0') if b'=' in entry)
    return values.get(b'OOPS_API_TOKEN', b'').decode()


def health(token):
    return get_json('http://127.0.0.1:8787/healthz', {'Authorization': 'Bearer ' + token})


def wait_ready(token):
    for attempt in range(30):
        try:
            h = health(token)
            label = get_json('http://127.0.0.1:8798/api/me', {'X-Labeler': '%E6%9E%97%E6%98%A5%E6%BA%90'})
            mids = [m['id'] for m in label['meetings']]
            if sorted(mids) != sorted(MIDS):
                raise RuntimeError('label_meeting_catalog_changed')
            return h, len(mids)
        except (OSError, ValueError, KeyError):
            if attempt == 29:
                raise
            time.sleep(.3)


def private_matches(before, data_files):
    expected = dict(before)
    expected.update({str(data_target(relative)): digest for relative, digest in data_files.items()})
    return protected() == expected


def atomic_install(source, target, attrs, *, new=False):
    """Publish a full fsynced file; never reuse or truncate an existing temp."""
    temporary = target.with_name('.content-cleanup-stage-' + target.name)
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, 'wb') as output, Path(source).open('rb') as input_file:
            shutil.copyfileobj(input_file, output)
            output.flush()
            os.fsync(output.fileno())
            os.fchmod(output.fileno(), attrs['mode'])
            os.fchown(output.fileno(), attrs['uid'], attrs['gid'])
        if new:
            # link() is an atomic no-replace publication on the same filesystem.
            os.link(temporary, target)
            temporary.unlink()
        else:
            os.replace(temporary, target)
    finally:
        if temporary.exists():
            temporary.unlink()


def apply(stage, manifest):
    token = service_token()
    before_health = health(token)
    timer_active = active(TIMER)
    backup = Path('/var/backups/oops-meeting') / ('content-cleanup-' + dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
    backup.mkdir(mode=0o700, parents=True)
    originals, installed, data_installed, made_dirs = {}, False, [], []
    resume_allowed = True
    try:
        subprocess.run(['systemctl', 'stop', TIMER, WORKER, *SERVICES], check=True)
        if any(not quiescent(unit) for unit in (TIMER, WORKER, *SERVICES)):
            raise RuntimeError('services_did_not_quiesce')
        validate(stage)
        pending = pending_work()
        if any(pending.values()):
            raise RuntimeError('work_arrived_before_stop')
        before = protected()
        for path in before:
            target = backup / 'private' / path.lstrip('/')
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)
        (backup / 'protected.json').write_text(json.dumps(before, indent=2))
        account = pwd.getpwnam('oops')
        for relative in manifest['files']:
            scope, name = relative.split('/')
            target = BASES[scope] / name
            if target.is_symlink():
                raise RuntimeError('source_symlink_requires_review:' + relative)
            stat = target.stat() if target.exists() else None
            originals[relative] = dict(exists=stat is not None, uid=stat.st_uid if stat else 0,
                                       gid=stat.st_gid if stat else account.pw_gid, mode=stat.st_mode & 0o777 if stat else 0o640)
            if stat:
                old = backup / 'source' / relative
                old.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(target, old)
        installed = True
        resume_allowed = False
        for relative, attrs in originals.items():
            scope, name = relative.split('/')
            target = BASES[scope] / name
            atomic_install(stage / relative, target, attrs)
        if source_snapshot() != manifest['files'] or protected() != before:
            raise RuntimeError('installation_invariant_failed')
        for relative in DATA_FILES:
            target = data_target(relative)
            if target.exists() or target.is_symlink():
                raise RuntimeError('data_appeared_before_installation:' + relative)
            if not target.parent.exists():
                target.parent.mkdir(mode=0o750)
                os.chown(target.parent, account.pw_uid, account.pw_gid)
                made_dirs.append(target.parent)
            atomic_install(stage / 'data' / relative, target,
                           dict(mode=0o600, uid=account.pw_uid, gid=account.pw_gid), new=True)
            data_installed.append(relative)
        if data_snapshot() != manifest['data_files'] or not private_matches(before, manifest['data_files']):
            raise RuntimeError('private_data_installation_invariant_failed')
        subprocess.run(['systemctl', 'start', *SERVICES], check=True)
        after_health, meeting_count = wait_ready(token)
        if any(after_health.get(key) != version for key, version in CAPABILITIES.items()):
            raise RuntimeError('content_curation_capability_missing')
        ignored = VOLATILE | set(CAPABILITIES)
        if {k: v for k, v in before_health.items() if k not in ignored} != {k: v for k, v in after_health.items() if k not in ignored}:
            raise RuntimeError('health_capabilities_changed')
        if not private_matches(before, manifest['data_files']) or any(pending_work().values()):
            raise RuntimeError('private_state_changed_or_work_appeared')
        result = dict(status='deployed', backup=str(backup), protected_files=len(before), protected_unchanged=True,
                      source_sha256=manifest['files'], label_meetings=meeting_count, model_calls_by_script=0,
                      new_data_sha256=manifest['data_files'], added_private_files=4,
                      external_writes_by_script=0, health_check_passed=True, original_answers_unchanged=True,
                      source_transcripts_unchanged=True, owner_confirmations_by_script=0)
        result['completed_checks'] = list(CHECKS)
        result['new_capabilities'] = CAPABILITIES
        (backup / 'result.json').write_text(json.dumps(result, indent=2))
        resume_allowed = True
        print(json.dumps(result, sort_keys=True))
    except BaseException:
        if installed:
            subprocess.run(['systemctl', 'stop', *SERVICES], check=True)
            cleanup_safe = True
            for relative in reversed(data_installed):
                target = data_target(relative)
                if target.is_file() and not target.is_symlink() and sha(target) == manifest['data_files'][relative]:
                    target.unlink()
                else:
                    # A changed sidecar may include a concurrent operator's edit.
                    # Never delete or overwrite it to make rollback look clean.
                    cleanup_safe = False
            for folder in reversed(made_dirs):
                try:
                    folder.rmdir()
                except OSError:
                    pass
            for relative, attrs in originals.items():
                scope, name = relative.split('/')
                target = BASES[scope] / name
                if attrs['exists']:
                    atomic_install(backup / 'source' / relative, target, attrs)
                elif target.exists():
                    target.unlink()
            if source_snapshot() != manifest['baseline']:
                raise RuntimeError('rollback_source_verification_failed')
            if any(pending_work().values()):
                raise RuntimeError('rollback_pending_work_requires_manual_resume')
            subprocess.run(['systemctl', 'start', *SERVICES], check=True)
            restored, _ = wait_ready(token)
            if {k: v for k, v in restored.items() if k not in VOLATILE} != {k: v for k, v in before_health.items() if k not in VOLATILE}:
                raise RuntimeError('rollback_health_verification_failed')
            resume_allowed = True
            print(json.dumps(dict(status='rolled_back', backup=str(backup), source_restored=True,
                                  private_state_unchanged=protected() == before,
                                  sidecars_removed_safely=cleanup_safe), sort_keys=True))
        # Never restore private JSON over a concurrent human answer. The backup
        # remains root-only for deliberate recovery of any changed private data.
        raise
    finally:
        if resume_allowed:
            subprocess.run(['systemctl', 'start', *SERVICES], check=True)
            if timer_active:
                subprocess.run(['systemctl', 'start', TIMER], check=True)
        else:
            subprocess.run(['systemctl', 'stop', TIMER, WORKER, *SERVICES], check=True)
            print(json.dumps(dict(status='requires_manual_resume', backup=str(backup), services_left_stopped=True)))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('target', nargs='+')
    parser.add_argument('--baseline')
    parser.add_argument('--checks')
    parser.add_argument('--data-root', default='build/cleanup-20261013')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if args.target == ['baseline']:
        print(json.dumps(dict(sources=source_snapshot(), label_catalog=label_catalog(), new_data=data_snapshot(),
                              label_inputs=label_inputs_snapshot()), sort_keys=True))
        return
    if args.target[0] == 'build':
        if len(args.target) != 2 or not args.baseline or not args.checks or args.apply:
            parser.error('build requires STAGE --baseline FILE --checks FILE, without --apply')
        return build(args.target[1], args.baseline, args.checks, args.data_root)
    if len(args.target) != 1:
        parser.error('one release directory is required')
    stage = Path(args.target[0]).resolve()
    manifest, pending = preflight(stage)
    if args.apply:
        apply(stage, manifest)
    else:
        hashes = protected()
        print(json.dumps(dict(preflight='passed', apply=False, source_files=len(manifest['files']),
                              protected_files=len(hashes), new_data_files=len(manifest['data_files']),
                              pending=pending, plan_counts=manifest['plan_counts']), sort_keys=True))


if __name__ == '__main__':
    main()
