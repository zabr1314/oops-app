#!/usr/bin/env python3
"""Upgrade only the existing Apple mobile service to the main app's ASR adapter.

The staged credential is private and never printed. Existing backend code,
configuration, runtime dependencies, meeting files and service are left in place.
"""
import argparse
import ast
import datetime as dt
import hashlib
import io
import json
import os
from pathlib import Path
import pwd
import shutil
import sqlite3
import subprocess
import tempfile
import time
import urllib.request
import zipfile

CODE = Path('/opt/oops/apple-mobile')
DATA = Path('/var/lib/oops-apple-mobile')
UNIT = Path('/etc/systemd/system/oops-apple-mobile.service')
BACKUPS = Path('/var/backups/oops-apple-mobile')
CONFIG = DATA / 'asr-config.json'
VENDOR = CODE / 'vendor-asr-v1'
FILES = ('apple_mobile_gateway.py', 'apple_mobile_asr.py', 'asr_words_probe.py')
WHEEL = 'websocket_client-1.9.2-py3-none-any.whl'
WHEEL_SHA = 'e1a673830a9c7bfa47b1cd3d5e4178f4c9651d80a4eab02c9c23a1c3ec6250ce'


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def command(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=30).stdout.strip()


def main_pid(name):
    require(command('systemctl', 'is-active', name) == 'active', 'Required service is not active')
    value = command('systemctl', 'show', name, '--property=MainPID', '--value')
    require(value.isdigit() and int(value) > 0, 'Required service has no PID')
    return value


def atomic(path, raw, mode, uid, gid):
    fd, name = tempfile.mkstemp(prefix='.asr-upgrade-', dir=path.parent)
    try:
        os.fchmod(fd, mode)
        os.fchown(fd, uid, gid)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def read_json(url, token=None):
    headers = {'Authorization': 'Bearer ' + token} if token else {}
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=10) as response:
        return json.load(response)


def upgrade(stage):
    require(os.geteuid() == 0 and os.uname().sysname == 'Linux', 'Requires the approved Linux root target')
    require(stage.is_dir() and stage.resolve() == stage and not stage.stat().st_mode & 0o022,
            'Stage must be a private trusted directory')
    manifest = json.loads((stage / 'manifest.json').read_text())
    require(set(manifest['files']) == set(FILES), 'Unexpected code file list')
    for name in FILES:
        p = stage / name
        require(p.is_file() and not p.is_symlink() and digest(p) == manifest['files'][name], 'Staged code hash mismatch')
        ast.parse(p.read_text(), filename=name)
    require(digest(stage / WHEEL) == WHEEL_SHA, 'Dependency wheel hash mismatch')
    require(digest(CODE / 'apple_mobile_gateway.py') == manifest['baseline_gateway_sha256'], 'Gateway baseline changed')
    require(digest(UNIT) == manifest['baseline_unit_sha256'], 'Mobile unit baseline changed')
    require(not VENDOR.exists() and not CONFIG.exists(), 'ASR upgrade already exists; inspect rather than overwrite')
    for name in ('apple_mobile_asr.py', 'asr_words_probe.py'):
        require(not (CODE / name).exists(), 'Unexpected existing ASR module')
    private = stage / 'asr-config.json'
    require(private.is_file() and not private.is_symlink() and not private.stat().st_mode & 0o077,
            'Staged ASR credential must be private')
    config = json.loads(private.read_text())
    keys = {'VOLC_API_KEY', 'VOLC_APP_ID', 'VOLC_ACCESS_TOKEN', 'VOLC_RESOURCE_ID'}
    require(set(config) == keys and all(isinstance(v, str) for v in config.values()), 'Invalid private ASR config')
    require(bool(config['VOLC_API_KEY'] or config['VOLC_APP_ID'] and config['VOLC_ACCESS_TOKEN']), 'ASR credential missing')
    oops = pwd.getpwnam('oops')
    backend_pid = main_pid('oops-backend')
    main_pid('oops-apple-mobile')
    production = Path('/opt/oops/app/scripts')
    backend_hashes = {str(p): digest(p) for p in production.glob('*.py')}
    require(backend_hashes, 'Primary backend source unavailable')
    guard = (production / 'feishu_actions.py').read_text()
    require('needs_review' in guard and 'ledger_pending' in guard, 'Production delivery guard unavailable')
    token = (DATA / 'backend-token').read_text().strip()
    require(read_json('http://127.0.0.1:8787/healthz', token).get('archive_policy_version', 0) >= 1,
            'Storage contract unavailable')
    stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    backup = BACKUPS / ('ASR_' + stamp)
    backup.mkdir(mode=0o700, parents=True)
    originals = {}
    for path in [UNIT, *(CODE / name for name in FILES), CONFIG]:
        if path.exists():
            info = path.stat()
            raw = path.read_bytes()
            saved = backup / (path.name + '.before')
            saved.write_bytes(raw); saved.chmod(0o600)
            originals[path] = (raw, info.st_mode & 0o777, info.st_uid, info.st_gid)
        else:
            originals[path] = None
    metadata = {'backend_pid': backend_pid, 'backend_hashes': backend_hashes,
                'original_files': {str(p): bool(v) for p, v in originals.items()},
                'database_backup_is_recovery_only': True}
    (backup / 'metadata.json').write_text(json.dumps(metadata, indent=2))
    (backup / 'metadata.json').chmod(0o600)
    unit = UNIT.read_text()
    require('ExecStart=/usr/bin/python3 ' in unit and '--asr-config-file' not in unit, 'Unexpected service command')
    lines = unit.splitlines()
    lines = [line + ' --asr-config-file ' + str(CONFIG) if line.startswith('ExecStart=') else line for line in lines]
    service_index = lines.index('[Service]')
    lines.insert(service_index + 1, 'Environment=PYTHONPATH=' + str(VENDOR))
    changed = False
    try:
        command('systemctl', 'stop', 'oops-apple-mobile')
        changed = True
        # Keep a consistent private recovery snapshot. Never restore over newer receipts automatically.
        database = DATA / 'gateway.sqlite'
        require(database.is_file() and not database.is_symlink(), 'Existing private database missing')
        source = sqlite3.connect('file:' + str(database) + '?mode=ro', uri=True)
        target = sqlite3.connect(str(backup / 'gateway.sqlite.before'))
        try:
            source.backup(target)
        finally:
            target.close(); source.close()
        (backup / 'gateway.sqlite.before').chmod(0o600)
        VENDOR.mkdir(mode=0o755)
        with zipfile.ZipFile(io.BytesIO((stage / WHEEL).read_bytes())) as archive:
            for entry in archive.infolist():
                rel = Path(entry.filename)
                require(not rel.is_absolute() and '..' not in rel.parts and rel.parts[0] in
                        ('websocket', 'websocket_client-1.9.2.dist-info'), 'Unexpected wheel member')
                if entry.is_dir():
                    (VENDOR / rel).mkdir(mode=0o755, parents=True, exist_ok=True)
                else:
                    dest = VENDOR / rel
                    dest.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
                    dest.write_bytes(archive.read(entry)); dest.chmod(0o644)
        # The private process umask must not make the public code dependency
        # directories inaccessible to the existing unprivileged service user.
        for directory in [VENDOR, *(p for p in VENDOR.rglob('*') if p.is_dir())]:
            directory.chmod(0o755)
        for name in FILES:
            atomic(CODE / name, (stage / name).read_bytes(), 0o640, 0, oops.pw_gid)
        atomic(CONFIG, json.dumps(config).encode(), 0o600, oops.pw_uid, oops.pw_gid)
        atomic(UNIT, ('\n'.join(lines) + '\n').encode(), originals[UNIT][1], originals[UNIT][2], originals[UNIT][3])
        command('systemctl', 'daemon-reload')
        command('systemctl', 'start', 'oops-apple-mobile')
        health = None
        for _ in range(15):
            try:
                health = read_json('http://127.0.0.1:8799/oops-meeting/apple-mobile/healthz')
                if health.get('status') == 'ok':
                    break
            except (OSError, ValueError):
                pass
            time.sleep(0.4)
        require(health and health.get('status') == 'ok', 'Mobile health unavailable')
        require(main_pid('oops-backend') == backend_pid, 'Primary backend PID changed during mobile upgrade')
        require({str(p): digest(p) for p in production.glob('*.py')} == backend_hashes,
                'Primary backend source changed during mobile upgrade')
        require(main_pid('oops-apple-mobile'), 'Mobile service unavailable')
        require(read_json('http://127.0.0.1:8787/healthz', token).get('archive_policy_version', 0) >= 1,
                'Primary backend health unavailable')
        private.unlink()
        return {'status': 'upgraded', 'backup': str(backup), 'backend_pid_unchanged': True,
                'backend_sources_unchanged': True, 'asr_credentials_included_in_receipt': False,
                'only_mobile_service_restarted': True, 'dependency': 'websocket-client==1.9.2',
                'asr_called': False, 'code_hashes': manifest['files']}
    except BaseException:
        if changed:
            subprocess.run(['systemctl', 'stop', 'oops-apple-mobile'], capture_output=True)
            for path, saved in originals.items():
                if saved is None:
                    path.unlink(missing_ok=True)
                else:
                    atomic(path, *saved)
            if VENDOR.exists():
                shutil.rmtree(VENDOR)
            subprocess.run(['systemctl', 'daemon-reload'], capture_output=True)
            subprocess.run(['systemctl', 'start', 'oops-apple-mobile'], capture_output=True)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', required=True)
    parser.add_argument('--confirm-upgrade', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    require(args.confirm_upgrade, 'Upgrade confirmation flag required')
    try:
        result = upgrade(Path(args.stage))
    except (OSError, ValueError, KeyError, RuntimeError, sqlite3.Error, subprocess.SubprocessError, zipfile.BadZipFile) as error:
        reason = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        print(json.dumps({'status': 'failed', 'reason': reason,
                          'message': 'ASR upgrade stopped; inspect the private backup and service metadata. No credential values were logged.'}))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
