#!/usr/bin/env python3
"""Candidate quality upgrade; default is read-only preflight, never regeneration.

On the host: ``python3 item-quality-upgrade.py baseline > baseline.json``.
Locally: ``python3 deploy/item-quality-upgrade.py build STAGE --baseline baseline.json --checks checks.json``.
Upload STAGE, then on the host: ``python3 item-quality-upgrade.py STAGE``.
Only an explicit ``--apply`` stops services, backs up, installs and verifies.
No model, meeting-list, task, minutes-generation or Feishu API is called.
"""
import argparse
import datetime as dt
import hashlib
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
FILES = {'backend': ('local_backend.py', 'meeting_features.py', 'feishu_actions.py', 'task_resolver.py',
                     'task_board.py', 'item_quality.py', 'minutes_quality.py'),
         'label': ('label_minutes_import.py', 'item_quality.py', 'minutes_quality.py')}
NEW = {'item_quality.py', 'minutes_quality.py'}
PRIVATE = (Path('/var/lib/oops/backend'), Path('/var/lib/oops-label'))
CONFIG = (Path('/var/lib/oops/backend.env'), Path('/var/lib/oops/jev.env'),
          Path('/etc/systemd/system/oops-backend.service'), Path('/etc/systemd/system/oops-label.service'),
          Path('/etc/systemd/system/oops-label-import.service'), Path('/etc/systemd/system/oops-label-import.timer'))
SERVICES = ('oops-backend', 'oops-label')
TIMER, WORKER = 'oops-label-import.timer', 'oops-label-import.service'
VOLATILE = {'jev_stats', 'mac_agent_online'}
CAPABILITIES = {'item_quality_version': 1, 'asr_closure_version': 1}
CHECKS = ('quality_regressions', 'backend_integration', 'android_h5', 'minutes_import',
          'source_baseline_review', 'private_state_and_pending_review')


def run(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.PIPE).strip()


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def source_snapshot():
    return {scope + '/' + name: sha(base / name) if (base / name).is_file() else None
            for scope, base in BASES.items() for name in FILES[scope]}


def label_catalog():
    return {path.parent.name: bool(json.loads(path.read_text()).get('imported'))
            for path in (PRIVATE[1] / 'meetings').glob('*/meeting.json')}


def protected():
    paths = {p for folder in PRIVATE for p in folder.rglob('*') if p.is_file()}
    paths.update(p for p in CONFIG if p.is_file())
    if any(p.is_symlink() for p in paths):
        raise RuntimeError('protected_symlink_requires_review')
    return {str(p): sha(p) for p in sorted(paths)}


def active(unit):
    return run('systemctl', 'show', unit, '-p', 'ActiveState', '--value') == 'active'


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
    counts = dict(generate=0, send_cached=0, ledger=0, active_questions=0, jobs=0, operations=0)
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
    return counts


def build(stage, baseline, checks):
    root = Path(__file__).resolve().parent.parent
    baseline = json.loads(Path(baseline).read_text())
    previous = baseline['sources']
    checked = json.loads(Path(checks).read_text())
    if any(checked.get(key) is not True for key in CHECKS):
        raise ValueError('incomplete_completed_checks')
    expected = {scope + '/' + name for scope in FILES for name in FILES[scope]}
    if set(previous) != expected:
        raise ValueError('unexpected_baseline_file_set')
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
        compile(target.read_bytes(), str(target), 'exec')
        hashes[relative] = sha(target)
    manifest = dict(schema=1, files=hashes, baseline=previous, label_catalog=baseline['label_catalog'], checks=checked)
    (stage / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    shutil.copyfile(__file__, stage / 'item-quality-upgrade.py')
    print(json.dumps(dict(built=str(stage), source_files=len(hashes))))


def validate(stage):
    manifest = json.loads((stage / 'manifest.json').read_text())
    expected = {scope + '/' + name for scope in FILES for name in FILES[scope]}
    if manifest.get('schema') != 1 or set(manifest.get('files', {})) != expected or set(manifest.get('baseline', {})) != expected:
        raise RuntimeError('unexpected_release_file_set')
    for relative, digest in manifest['files'].items():
        source = stage / relative
        if source.is_symlink() or sha(source) != digest:
            raise RuntimeError('release_checksum_mismatch:' + relative)
        compile(source.read_bytes(), str(source), 'exec')
    if source_snapshot() != manifest['baseline']:
        raise RuntimeError('live_source_drift_requires_review')
    if any(manifest.get('checks', {}).get(key) is not True for key in CHECKS):
        raise RuntimeError('incomplete_completed_checks')
    catalog = label_catalog()
    if catalog != manifest.get('label_catalog') or set(catalog) != {'0235', '0236', '0238'} or any(catalog.values()):
        raise RuntimeError('label_catalog_changed_or_imported_revision_requires_review')
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
            return h, len(label['meetings'])
        except (OSError, ValueError, KeyError):
            if attempt == 29:
                raise
            time.sleep(.3)


def apply(stage, manifest):
    token = service_token()
    before_health = health(token)
    timer_active = active(TIMER)
    backup = Path('/var/backups/oops-meeting') / ('item-quality-' + dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
    backup.mkdir(mode=0o700, parents=True)
    originals, installed = {}, False
    try:
        subprocess.run(['systemctl', 'stop', TIMER, WORKER, *SERVICES], check=True)
        if any(active(unit) for unit in (WORKER, *SERVICES)):
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
        for relative, attrs in originals.items():
            scope, name = relative.split('/')
            target = BASES[scope] / name
            temporary = target.with_name('.item-quality-stage-' + name)
            shutil.copyfile(stage / relative, temporary)
            os.chmod(temporary, attrs['mode']); os.chown(temporary, attrs['uid'], attrs['gid'])
            os.replace(temporary, target)
        if source_snapshot() != manifest['files'] or protected() != before:
            raise RuntimeError('installation_invariant_failed')
        subprocess.run(['systemctl', 'start', *SERVICES], check=True)
        after_health, meeting_count = wait_ready(token)
        if any(after_health.get(key) != version for key, version in CAPABILITIES.items()):
            raise RuntimeError('quality_or_asr_closure_capability_missing')
        ignored = VOLATILE | set(CAPABILITIES)
        if {k: v for k, v in before_health.items() if k not in ignored} != {k: v for k, v in after_health.items() if k not in ignored}:
            raise RuntimeError('health_capabilities_changed')
        if protected() != before or any(pending_work().values()):
            raise RuntimeError('private_state_changed_or_work_appeared')
        result = dict(status='deployed', backup=str(backup), protected_files=len(before), protected_unchanged=True,
                      source_sha256=manifest['files'], label_meetings=meeting_count, model_calls_by_script=0,
                      external_writes_by_script=0, health_check_passed=True)
        result['completed_checks'] = list(CHECKS)
        result['new_capabilities'] = CAPABILITIES
        (backup / 'result.json').write_text(json.dumps(result, indent=2))
        print(json.dumps(result, sort_keys=True))
    except BaseException:
        if installed:
            subprocess.run(['systemctl', 'stop', *SERVICES], check=True)
            for relative, attrs in originals.items():
                scope, name = relative.split('/')
                target = BASES[scope] / name
                if attrs['exists']:
                    shutil.copy2(backup / 'source' / relative, target)
                    os.chown(target, attrs['uid'], attrs['gid'])
                elif target.exists():
                    target.unlink()
            if source_snapshot() != manifest['baseline']:
                raise RuntimeError('rollback_source_verification_failed')
            subprocess.run(['systemctl', 'start', *SERVICES], check=True)
            restored, _ = wait_ready(token)
            if {k: v for k, v in restored.items() if k not in VOLATILE} != {k: v for k, v in before_health.items() if k not in VOLATILE}:
                raise RuntimeError('rollback_health_verification_failed')
            print(json.dumps(dict(status='rolled_back', backup=str(backup), source_restored=True,
                                  private_state_unchanged=protected() == before), sort_keys=True))
        # Never restore private JSON over a concurrent human answer. The backup
        # remains root-only for deliberate recovery of any changed private data.
        raise
    finally:
        subprocess.run(['systemctl', 'start', *SERVICES], check=True)
        if timer_active:
            subprocess.run(['systemctl', 'start', TIMER], check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('target', nargs='+')
    parser.add_argument('--baseline')
    parser.add_argument('--checks')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if args.target == ['baseline']:
        print(json.dumps(dict(sources=source_snapshot(), label_catalog=label_catalog()), sort_keys=True))
        return
    if args.target[0] == 'build':
        if len(args.target) != 2 or not args.baseline or not args.checks or args.apply:
            parser.error('build requires STAGE --baseline FILE --checks FILE, without --apply')
        return build(args.target[1], args.baseline, args.checks)
    if len(args.target) != 1:
        parser.error('one release directory is required')
    stage = Path(args.target[0]).resolve()
    manifest, pending = preflight(stage)
    if args.apply:
        apply(stage, manifest)
    else:
        hashes = protected()
        print(json.dumps(dict(preflight='passed', apply=False, source_files=len(manifest['files']),
                              protected_files=len(hashes), pending=pending), sort_keys=True))


if __name__ == '__main__':
    main()
