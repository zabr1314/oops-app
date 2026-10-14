#!/usr/bin/env python3
"""Scoped label-site upgrade. No model calls, user answers or main backend writes."""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import pwd
import shutil
import stat
import subprocess
import sys
import time
import urllib.parse
import urllib.request


FILES = ('team_label.py', 'team_label_ui.html', 'label_items.py',
         'label_item_identity.py', 'label_shared_identity.py')
CODE = Path('/opt/oops/label')
DATA = Path('/var/lib/oops-label')
SERVICE = 'oops-label'


def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout.strip()


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def protected():
    return {str(path.relative_to(DATA)): sha(path) for path in DATA.rglob('*')
            if path.is_file() and (path.suffix in ('.json', '.env') or path.name == 'open-access')
            and path != DATA / 'identities/shared.json'}


def get(path, name):
    request = urllib.request.Request('http://127.0.0.1:8798' + path,
        headers={'X-Labeler': urllib.parse.quote(name)})
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.load(response)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', required=True)
    parser.add_argument('--source', required=True)
    parser.add_argument('--source-revision', required=True, type=int)
    parser.add_argument('--groups', required=True, type=int)
    args = parser.parse_args()
    stage = Path(args.stage).resolve()
    for name in FILES:
        if not (stage / name).is_file():
            raise ValueError('stage_missing_file')
        if name.endswith('.py'):
            compile((stage / name).read_text(), name, 'exec')
    if run('systemctl', 'is-active', SERVICE) != 'active':
        raise ValueError('label_service_not_active')
    stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = Path('/var/backups/oops-label') / ('shared-identity-' + stamp)
    backup.mkdir(mode=0o700)
    old_files = {}
    for name in FILES:
        target = CODE / name
        old_files[name] = dict(exists=target.exists(), uid=target.stat().st_uid if target.exists() else 0,
                               gid=target.stat().st_gid if target.exists() else pwd.getpwnam('oops').pw_gid)
        if target.exists():
            (backup / 'code').mkdir(exist_ok=True)
            shutil.copy2(target, backup / 'code' / name)
    shared = DATA / 'identities/shared.json'
    lock = DATA / 'identities/.shared.lock'
    shared_existed, lock_existed = shared.exists(), lock.exists()
    stopped = False
    try:
        run('systemctl', 'stop', SERVICE)
        stopped = True
        before = protected()
        for relative in before:
            destination = backup / 'data' / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(DATA / relative, destination)
        if shared_existed:
            shutil.copy2(shared, backup / 'shared.json')
        (backup / 'protected-before.json').write_text(json.dumps(before, indent=2))
        os.chmod(backup / 'protected-before.json', 0o600)
        account = pwd.getpwnam('oops')
        for name in FILES:
            target = CODE / name
            mode = stat.S_IMODE(target.stat().st_mode) if target.exists() else 0o640
            temp = CODE / ('.identity-new-' + name)
            shutil.copyfile(stage / name, temp)
            os.chmod(temp, mode)
            os.chown(temp, old_files[name]['uid'], old_files[name]['gid'])
            os.replace(temp, target)
        sys.path.insert(0, str(CODE))
        from team_label import Data, PEOPLE
        from label_shared_identity import migration_plan, apply_migration
        data = Data(str(DATA), recover_similarity=False)
        plan = migration_plan(data, args.source, args.source_revision, args.groups)
        if plan['target_revision'] != 0:
            raise ValueError('team_identities_already_exist')
        (backup / 'migration-plan.json').write_text(json.dumps(plan, ensure_ascii=False, indent=2))
        os.chmod(backup / 'migration-plan.json', 0o600)
        imported = apply_migration(data, plan, plan['plan_hash'], args.source)
        for path in (shared, lock):
            if path.exists():
                os.chown(path, account.pw_uid, account.pw_gid)
                os.chmod(path, 0o600)
        if protected() != before:
            raise ValueError('protected_state_changed_before_start')
        run('systemctl', 'start', SERVICE)
        stopped = False
        for attempt in range(30):
            try:
                identity = get('/api/identity', PEOPLE[0])
                break
            except (OSError, ValueError):
                if attempt == 29:
                    raise
                time.sleep(0.2)
        identities, meetings = {}, {}
        expected = {gid: approval['speaker'] for gid, approval in plan['approvals'].items()}
        for person in PEOPLE:
            identity = get('/api/identity', person)
            current = {g['id']: g['speaker'] for g in identity['groups'] if g['current']}
            if not identity.get('shared') or current != expected:
                raise ValueError('shared_identity_smoke_failed')
            identities[person] = dict(revision=identity['revision'], names=current)
            meetings[person] = {}
            for mid in data.meetings:
                result = get('/api/meeting/' + mid + '/items', person)
                if result['status'] != 'ready':
                    raise ValueError('items_smoke_failed')
                meetings[person][mid] = dict(items=len(result['items']), counts=result['counts'],
                    revision=result['revision'], speakers=sum(bool(i['speakers']) for i in result['items']),
                    claiming_clues=sum(len(i['claimants']) for i in result['items']))
        if protected() != before:
            raise ValueError('protected_state_changed_after_start')
        result = dict(status='deployed', backup=str(backup), imported=imported,
            protected_files=len(before), protected_unchanged=True, identities=identities, meetings=meetings,
            code={name: sha(CODE / name) for name in FILES}, model_calls=0, user_answer_writes=0)
        (backup / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
        os.chmod(backup / 'result.json', 0o600)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except Exception:
        if not stopped:
            run('systemctl', 'stop', SERVICE)
        try:
            if shared.exists():
                shutil.copy2(shared, backup / 'shared-at-failure.json')
                os.chmod(backup / 'shared-at-failure.json', 0o600)
            for name, previous in old_files.items():
                target = CODE / name
                if previous['exists']:
                    shutil.copy2(backup / 'code' / name, target)
                    os.chown(target, previous['uid'], previous['gid'])
                elif target.exists():
                    target.unlink()
            if shared_existed and (backup / 'shared.json').exists():
                shutil.copy2(backup / 'shared.json', shared)
            elif not shared_existed and shared.exists():
                shared.unlink()
            if not lock_existed and lock.exists():
                lock.unlink()
        finally:
            run('systemctl', 'start', SERVICE)
        raise


if __name__ == '__main__':
    main()
