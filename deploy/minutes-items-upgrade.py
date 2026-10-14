#!/usr/bin/env python3
"""Deploy minutes items: after a meeting people check items (to do / decided / still open) built from the stored
minutes, instead of sentences. Adds POST /v1/meetings/items and the minutes prompt's `undecided` field.

On the Mac, inside the repo (builds the release directory; changes nothing else):
    python3 deploy/minutes-items-upgrade.py build /tmp/items-release [--baseline-rev <commit now live>]
On the HK host as root, after uploading that directory:
    python3 minutes-items-upgrade.py /opt/oops/releases/items             # preflight only
    python3 minutes-items-upgrade.py /opt/oops/releases/items --apply     # back up, replace, restart, verify, or roll back

Replaces only the listed source files (and adds minutes_items.py). Never touches people, voiceprints, environment
files, meetings, recordings, minutes state, Feishu tasks or the proxy. Existing minutes are not regenerated: items are
derived from them on read. The smoke test only reads and sends item reviews that must fail without writing.
The old app keeps working with the new server (it simply ignores `items`).
"""
import argparse
import base64
import datetime as dt
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

FILES = ('scripts/local_backend.py', 'scripts/meeting_features.py', 'scripts/feishu_actions.py', 'scripts/minutes_vote.py',
         'scripts/minutes_items.py')
NEW = ('scripts/minutes_items.py',)
APP = Path('/opt/oops/app')
BASE = 'http://127.0.0.1:8787'
PROTECTED = (Path('/var/lib/oops/backend/people.json'), Path('/var/lib/oops/backend/voiceprints.json'),
             Path('/var/lib/oops/backend.env'), Path('/var/lib/oops/jev.env'))


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def build(out, rev):
    root = Path(__file__).resolve().parent.parent
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    manifest = {'schema': 1, 'files': {}, 'baseline': {}}
    for name in FILES:
        target = out / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(root / name, target)
        compile(target.read_bytes(), str(target), 'exec')
        manifest['files'][name] = sha(target)
        if name in NEW:
            manifest['baseline'][name] = None
            continue
        old = subprocess.check_output(['git', '-C', str(root), 'show', f'{rev}:{name}'])
        manifest['baseline'][name] = hashlib.sha256(old).hexdigest()
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    shutil.copyfile(Path(__file__).resolve(), out / 'minutes-items-upgrade.py')
    print(json.dumps({'built': str(out), 'baseline_rev': rev, 'files': manifest['files']}, indent=1))


def request(path, body=None, token='', expected=200):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    req = urllib.request.Request(BASE + path, headers=headers,
                                 data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            code, result = response.status, json.load(response)
    except urllib.error.HTTPError as error:
        code, result = error.code, json.load(error)
        error.close()
    if code != expected:
        raise RuntimeError(f'{path}: HTTP {code}, expected {expected}')
    return result


def service_token():
    pid = subprocess.check_output(['systemctl', 'show', 'oops-backend', '-p', 'MainPID', '--value'], text=True).strip()
    environment = dict(item.split('=', 1) for item in Path(f'/proc/{pid}/environ').read_text().split('\0') if '=' in item)
    return environment['OOPS_API_TOKEN']


VOLATILE = ('jev_stats', 'mac_agent_online')  # counters restart; the Mac helper is back online on its next poll


def strip(health):
    return {k: v for k, v in health.items() if k not in VOLATILE}


def wait_healthy(token):
    for _ in range(30):
        try:
            return request('/healthz', token=token)
        except (OSError, RuntimeError, ValueError):
            time.sleep(1)
    raise RuntimeError('Backend did not recover')


def smoke(token, stamp):
    """Reads, plus calls that must be refused; nothing is written to meetings, recordings or Feishu."""
    missing = 'items-deploy-' + stamp
    body = dict(session_id=missing, item_id='mi-0', fingerprint='0', action='reject')
    request('/v1/meetings/items', body, expected=401)
    request('/v1/meetings/items', body, token, expected=404)
    listing = request('/v1/meetings?limit=10', token=token)
    assert all('review_pending' in item for item in listing['items']), listing
    meetings = []
    for item in listing['items']:
        opened = request('/v1/meetings/' + item['session_id'], token=token)
        assert isinstance(opened.get('review_queue'), list), 'review_queue missing'
        items = opened.get('items')
        if items is not None:
            assert all(i['evidence'] and i['kind'] in ('task', 'decision', 'open') for i in items), 'item without evidence'
            assert all(q['kind'] == 'item' for q in opened['review_queue'])
            # A bad fingerprint must be refused without writing anything.
            if items:
                request('/v1/meetings/items', dict(session_id=item['session_id'], item_id=items[0]['id'], fingerprint='x' * 64,
                                                   action='reject'), token, expected=409)
        meetings.append(dict(session_id=item['session_id'][:8], items=None if items is None else len(items),
                             todo=len(opened['review_queue']), stale=None if not items else sum(i['stale'] for i in items)))
    tasks = request('/v1/tasks?status=all', token=token)['items']
    return {'meetings': listing['count'], 'opened': meetings, 'tasks': len(tasks)}


def apply(release, manifest, token, before, stamp):
    backup = Path('/var/backups/oops-meeting') / ('items-' + stamp)
    backup.mkdir(mode=0o700)
    shutil.copytree(APP, backup / 'app')
    hashes = {str(p): sha(p) for p in PROTECTED if p.exists()}
    changed = False
    try:
        for name in FILES:
            changed = True
            target = APP / name
            stage = target.with_name(target.name + '.items-stage')
            shutil.copyfile(release / name, stage)
            stage.chmod(0o644)
            os.replace(stage, target)
            assert sha(target) == manifest['files'][name]
        subprocess.run(['/opt/oops/venv/bin/python', '-m', 'py_compile', *(str(APP / n) for n in FILES)], check=True)
        subprocess.run(['systemctl', 'restart', 'oops-backend'], check=True)
        after = wait_healthy(token)
        for key in before:
            if key not in VOLATILE and after.get(key) != before[key]:
                raise RuntimeError('Capability changed after restart: ' + key)
        checks = smoke(token, stamp)
        for path, digest in hashes.items():
            assert sha(path) == digest, 'Protected configuration changed'
        result = dict(backup=str(backup), health=after, smoke=checks, protected_configuration_unchanged=True,
                      source_sha256=manifest['files'])
        (backup / 'verification.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps(result, ensure_ascii=False))
    except BaseException:
        if changed:
            for name in FILES:
                original = backup / 'app' / name
                if original.exists():
                    shutil.copy2(original, APP / name)
                elif (APP / name).exists():
                    (APP / name).unlink()
            subprocess.run(['systemctl', 'restart', 'oops-backend'], check=True)
            assert strip(wait_healthy(token)) == strip(before)
            print('ROLLED BACK source; original environment/state retained', flush=True)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('target', nargs='+')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--baseline-rev', default='HEAD')
    args = parser.parse_args()
    if args.target[0] == 'build':
        return build(args.target[1], args.baseline_rev)
    release = Path(args.target[0]).resolve()
    assert os.geteuid() == 0 and APP.is_dir(), 'Existing HK host/root required'
    manifest = json.loads((release / 'manifest.json').read_text())
    assert manifest.get('schema') == 1 and set(manifest['files']) == set(FILES), 'Unexpected release contents'
    for name in FILES:
        assert sha(release / name) == manifest['files'][name], 'Release checksum mismatch: ' + name
        compile((release / name).read_bytes(), str(release / name), 'exec')
    drift = [name for name, digest in manifest['baseline'].items()
             if (sha(APP / name) if (APP / name).exists() else None) != digest]
    assert not drift, 'Live source drifted; review before deploying: ' + ', '.join(drift)
    assert subprocess.check_output(['systemctl', 'is-active', 'oops-backend'], text=True).strip() == 'active'
    token = service_token()
    before = request('/healthz', token=token)
    if not args.apply:
        print(json.dumps(dict(preflight='passed', apply=False, health=before)))
        return
    apply(release, manifest, token, before, dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))


if __name__ == '__main__':
    main()
