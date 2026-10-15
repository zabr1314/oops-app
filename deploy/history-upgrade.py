#!/usr/bin/env python3
"""Install the isolated read-only history viewer without replacing the backend."""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = Path('/opt/oops/history')
DATA = Path('/var/lib/oops-history')
SOURCE = Path('/var/lib/oops/backend')
UNIT = Path('/etc/systemd/system/oops-history.service')
LOCATIONS = Path('/etc/oops-meeting/locations.conf')
HISTORY_LOCATION = Path('/etc/oops-meeting/history-locations.conf')
CODE = ('replay_history.py', 'funnel_replay.py')
ASSETS = ('funnel.html', 'funnel.js', 'funnel-after.js', 'funnel.css', 'funnel-sample.json',
          'funnel-web.js', 'funnel-crawler.js', 'funnel-dashboard.js',
          *('funnel-desks/desk-%d.png' % n for n in range(1, 7)),
          'funnel-studio.js', 'funnel-studio.css', 'funnel-after-studio.js', 'funnel-after-studio.css', 'brand/mascot.png',
          'icons/desk.svg', 'icons/desktop.svg', 'icons/file-text.svg', 'icons/microphone.svg',
          'icons/magnifying-glass.svg', 'icons/note-pencil.svg', 'icons/paper-plane-tilt.svg', 'icons/check-circle.svg')


def run(*args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True, **kwargs).stdout.strip()


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def preserve_copy(source, destination):
    # Linux cp -a preserves the root:oops ownership required by the old service.
    # shutil.copytree preserves modes but would restore root:root on rollback.
    run('cp', '-a', str(source), str(destination))


def source_manifest():
    paths = list((SOURCE / 'meetings').glob('*.json')) + [SOURCE / 'feishu' / 'state.json']
    return {str(p.relative_to(SOURCE)): sha(p) for p in paths if p.is_file()}


def request(path):
    try:
        with urllib.request.urlopen('http://127.0.0.1:8797' + path, timeout=10) as response:
            return response.status, response.headers, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.headers, error.read()


def main(stage):
    stage = Path(stage).resolve()
    if os.geteuid() != 0 or not SOURCE.is_dir() or not LOCATIONS.is_file():
        raise RuntimeError('Existing Oops host and root access required')
    for name in CODE:
        compile((stage / 'scripts' / name).read_bytes(), name, 'exec')
    for name in ASSETS:
        if not (stage / 'public' / name).is_file():
            raise RuntimeError('Missing static asset: ' + name)
    stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup = Path('/var/backups/oops-history') / stamp
    backup.mkdir(parents=True, mode=0o700)
    previous = {}
    for target in (ROOT, UNIT, HISTORY_LOCATION, LOCATIONS):
        previous[str(target)] = target.exists()
        if target.exists():
            saved = backup / target.relative_to('/')
            saved.parent.mkdir(parents=True, exist_ok=True)
            preserve_copy(target, saved)
    enabled_before = subprocess.run(['systemctl', 'is-enabled', 'oops-history'], capture_output=True).returncode == 0
    sources_before = source_manifest()
    backends_before = {n: sha(Path('/opt/oops/app/scripts') / n) for n in ('local_backend.py', 'feishu_actions.py')}
    account = pwd.getpwnam('oops')
    try:
        DATA.mkdir(mode=0o700, exist_ok=True)
        os.chown(DATA, account.pw_uid, account.pw_gid)
        for folder in ('scripts', 'public'):
            (ROOT / folder).mkdir(parents=True, exist_ok=True)
            os.chmod(ROOT / folder, 0o750)
            os.chown(ROOT / folder, 0, account.pw_gid)
        os.chmod(ROOT, 0o750)
        os.chown(ROOT, 0, account.pw_gid)
        for folder, names in (('scripts', CODE), ('public', ASSETS)):
            for name in names:
                target = ROOT / folder / name
                if target.parent != ROOT / folder:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    os.chmod(target.parent, 0o750)
                    os.chown(target.parent, 0, account.pw_gid)
                temporary = target.with_name('.' + target.name + '.new')
                shutil.copyfile(stage / folder / name, temporary)
                os.chmod(temporary, 0o640)
                os.chown(temporary, 0, account.pw_gid)
                os.replace(temporary, target)
        shutil.copyfile(stage / 'deploy' / 'oops-history.service', UNIT)
        os.chmod(UNIT, 0o644)
        shutil.copyfile(stage / 'deploy' / 'nginx-hk-history.conf', HISTORY_LOCATION)
        os.chmod(HISTORY_LOCATION, 0o644)
        include = 'include /etc/oops-meeting/history-locations.conf;'
        original = LOCATIONS.read_text()
        if include not in original:
            LOCATIONS.write_text(original.rstrip() + '\n\n' + include + '\n')
        run('nginx', '-t')
        run('systemctl', 'daemon-reload')
        run('systemctl', 'enable', 'oops-history')
        run('systemctl', 'restart', 'oops-history')
        for attempt in range(30):
            try:
                status, _, raw = request('/healthz')
                if status == 200 and json.loads(raw).get('read_only'):
                    break
            except OSError:
                pass
            if attempt == 29:
                raise RuntimeError('History service did not become healthy')
            time.sleep(.2)
        if request('/api/meetings')[0] != 401:
            raise RuntimeError('History must require its separate scoped session')
        if request('/')[0] != 200:
            raise RuntimeError('History viewer unavailable')
        for name in ('funnel-web.js', 'funnel-crawler.js', 'funnel-dashboard.js', 'funnel-desks/desk-1.png',
          'funnel-studio.js', 'funnel-studio.css', 'funnel-after-studio.js', 'funnel-after-studio.css', 'brand/mascot.png'):
            if request('/' + name)[0] != 200:
                raise RuntimeError('Studio viewer asset unavailable: ' + name)
        if source_manifest() != sources_before:
            raise RuntimeError('Owning meeting store changed during installation; inspect before publishing')
        if any(sha(Path('/opt/oops/app/scripts') / n) != value for n, value in backends_before.items()):
            raise RuntimeError('Backend source changed during installation')
        run('systemctl', 'reload', 'nginx')
        for service in ('oops-backend', 'oops-label', 'oops-history', 'nginx'):
            if run('systemctl', 'is-active', service) != 'active':
                raise RuntimeError('Service is not active: ' + service)
        result = dict(status='deployed', backup=str(backup), read_only=True, unauthenticated_status=401,
            provider_calls=0, source_files_unchanged=len(sources_before), backend_source_unchanged=True,
            source_sha256={n: sha(ROOT / 'scripts' / n) for n in CODE},
            static_sha256={n: sha(ROOT / 'public' / n) for n in ASSETS})
        (backup / 'result.json').write_text(json.dumps(result, indent=2))
        print(json.dumps(result, indent=2))
    except Exception:
        subprocess.run(['systemctl', 'stop', 'oops-history'], capture_output=True)
        for target in (ROOT, UNIT, HISTORY_LOCATION, LOCATIONS):
            saved = backup / target.relative_to('/')
            if previous[str(target)]:
                if target.is_dir():
                    shutil.rmtree(target)
                    preserve_copy(saved, target)
                else:
                    preserve_copy(saved, target)
            elif target.exists():
                if target.is_dir():
                    shutil.rmtree(target)
                else:
                    target.unlink()
        run('systemctl', 'daemon-reload')
        if enabled_before:
            run('systemctl', 'restart', 'oops-history')
        else:
            subprocess.run(['systemctl', 'disable', 'oops-history'], capture_output=True)
        run('nginx', '-t')
        run('systemctl', 'reload', 'nginx')
        raise


if __name__ == '__main__':
    main(sys.argv[1])
