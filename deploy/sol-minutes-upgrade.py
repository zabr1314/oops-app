#!/usr/bin/env python3
"""Deploy only minutes model selection and schedule voting against pinned server sources."""
import argparse
import datetime as dt
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import tempfile
import time
import urllib.request

LIVE = Path('/opt/oops/app/scripts')
CONFIG = Path('/var/lib/oops/.config/oops/minutes-model.json')
DROPIN = Path('/etc/systemd/system/oops-backend.service.d/sol-minutes.conf')
SERVICE = 'oops-backend'
FILES = ('minutes_model.py', 'minutes_vote.py', 'feishu_actions.py')
HEALTH_FIELDS = ('status', 'jev', 'voiceprint', 'feishu', 'feishu_bot', 'recordings', 'meetings',
                 'segments_validated', 'strict_a_enabled', 'self_owner_enabled', 'named_owner_enabled')


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


def command(*args):
    value = subprocess.run(args, capture_output=True, text=True, timeout=40)
    if value.returncode:
        raise RuntimeError('service command failed: ' + args[0])
    return value.stdout.strip()


def token():
    pid = command('systemctl', 'show', SERVICE, '-p', 'MainPID', '--value')
    for item in Path('/proc/' + pid + '/environ').read_bytes().split(b'\0'):
        if item.startswith(b'OOPS_API_TOKEN='):
            return item.split(b'=', 1)[1].decode()
    raise RuntimeError('active health credential unavailable')


def health():
    req = urllib.request.Request('http://127.0.0.1:8787/healthz',
                                 headers={'Authorization': 'Bearer ' + token()})
    with urllib.request.urlopen(req, timeout=5) as response:
        value = json.load(response)
    if value.get('status') != 'ok':
        raise RuntimeError('backend health unavailable')
    return {key: value.get(key) for key in HEALTH_FIELDS}


def write(path, raw, mode, uid=0, gid=0):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.sol-upgrade-', dir=path.parent)
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


def main(args):
    if os.geteuid() != 0:
        raise RuntimeError('production deployment requires root')
    stage, config = Path(args.stage).resolve(), Path(args.config).resolve()
    lock = open('/run/oops-sol-minutes-upgrade.lock', 'w')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    manifest = json.loads((stage / 'manifest.json').read_text())
    for name in FILES:
        if sha(stage / name) != manifest['candidate_files'][name]:
            raise RuntimeError('candidate hash mismatch: ' + name)
        if sha(LIVE / name) != manifest['files'][name]:
            raise RuntimeError('production changed; rebuild patch: ' + name)
        compile((stage / name).read_bytes(), name, 'exec')
    spec = importlib.util.spec_from_file_location('sol_candidate_client', stage / 'minutes_model.py')
    client_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(client_module)
    if config.stat().st_mode & 0o077:
        raise RuntimeError('candidate credentials must have mode 0600')
    client = client_module.MinutesModel(json.loads(config.read_text()))
    receipt = stage / 'api-probe.json'
    previous = json.loads(receipt.read_text()) if receipt.exists() else {}
    if (previous.get('config_sha256') != sha(config) or time.time() - previous.get('at', 0) > 900):
        started = time.monotonic()
        result, model = client.complete_json('Return only a JSON object. This is a connectivity check.',
                                             'Return {"ok":true}.')
        if result.get('ok') is not True or model != client.model:
            raise RuntimeError('model connectivity response mismatch')
        previous = dict(at=time.time(), model=model, config_sha256=sha(config),
                        latency_ms=int((time.monotonic() - started) * 1000))
        write(receipt, json.dumps(previous, indent=2).encode(), 0o600)
    print(json.dumps({'api_probe': 'passed', 'model': previous['model'],
                      'latency_ms': previous['latency_ms']}), flush=True)
    if args.probe_only:
        return
    baseline = health()
    protected = [Path('/var/lib/oops/backend/people.json'), Path('/var/lib/oops/backend/voiceprints.json')]
    protected_hashes = {str(p): sha(p) for p in protected}
    backup = Path('/var/backups/oops-meeting') / ('sol-' + dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    backup.mkdir(mode=0o700, parents=True)
    targets = [*(LIVE / name for name in FILES), CONFIG, DROPIN]
    saved = {}
    for n, path in enumerate(targets):
        if path.is_symlink():
            raise RuntimeError('symlink in deployment target')
        if path.exists():
            st = path.stat()
            target = backup / str(n)
            shutil.copyfile(path, target)
            target.chmod(0o600)
            saved[str(path)] = dict(file=str(target), mode=st.st_mode & 0o777, uid=st.st_uid, gid=st.st_gid)
        else:
            saved[str(path)] = None
    (backup / 'restore.json').write_text(json.dumps(saved, indent=2))
    account = pwd.getpwnam('oops')
    try:
        for name in FILES:
            write(LIVE / name, (stage / name).read_bytes(), 0o640, 0, account.pw_gid)
        CONFIG.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chown(CONFIG.parent, account.pw_uid, account.pw_gid)
        write(CONFIG, config.read_bytes(), 0o600, account.pw_uid, account.pw_gid)
        write(DROPIN, ('[Service]\nEnvironment=OOPS_MINUTES_CONFIG=' + str(CONFIG) + '\n').encode(), 0o644)
        command('systemctl', 'daemon-reload')
        command('systemctl', 'restart', SERVICE)
        for attempt in range(40):
            try:
                if health() != baseline:
                    raise RuntimeError('backend capability changed')
                break
            except (OSError, RuntimeError):
                if attempt == 39:
                    raise
                time.sleep(0.5)
        if any(sha(Path(name)) != value for name, value in protected_hashes.items()):
            raise RuntimeError('protected identity configuration changed')
        pid = command('systemctl', 'show', SERVICE, '-p', 'MainPID', '--value')
        expected = ('OOPS_MINUTES_CONFIG=' + str(CONFIG)).encode()
        if expected not in Path('/proc/' + pid + '/environ').read_bytes().split(b'\0'):
            raise RuntimeError('minutes selection missing from running process')
        report = dict(status='deployed', model=client.model, backup=str(backup),
                      source_hashes={n: sha(LIVE / n) for n in FILES},
                      health=baseline, previous_minutes_rewritten=False, external_send=False)
        (backup / 'result.json').write_text(json.dumps(report, indent=2))
        print(json.dumps(report, indent=2))
    except BaseException:
        for path, old in saved.items():
            path = Path(path)
            if old:
                write(path, Path(old['file']).read_bytes(), old['mode'], old['uid'], old['gid'])
            elif path.exists():
                path.unlink()
        command('systemctl', 'daemon-reload')
        command('systemctl', 'restart', SERVICE)
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--stage', required=True)
    parser.add_argument('--config', required=True)
    parser.add_argument('--probe-only', action='store_true')
    try:
        main(parser.parse_args())
    except Exception as error:
        print(json.dumps({'status': 'failed', 'reason': str(error)[:200]}))
        raise SystemExit(1)
