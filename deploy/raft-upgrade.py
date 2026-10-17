#!/usr/bin/env python3
"""Install a pinned Raft addition on the existing backend, preserving its live baseline."""
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

LIVE = Path('/opt/oops/app/scripts')
STATE = Path('/var/lib/oops/backend')
ENV = Path('/var/lib/oops/raft.env')
DROPIN = Path('/etc/systemd/system/oops-backend.service.d/raft.conf')
FILES = ('local_backend.py', 'raft_api.py', 'raft_outbox.py', 'raft_collaboration.py', 'raft_task_binding.py')

def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def run(*args): return subprocess.check_output(args, text=True, timeout=25).strip()
def health():
    token = next(line.split('=', 1)[1].strip().strip('\"\'') for line in
                 Path('/var/lib/oops/backend.env').read_text().splitlines() if line.startswith('OOPS_API_TOKEN='))
    request = urllib.request.Request('http://127.0.0.1:8787/healthz', headers={'Authorization': 'Bearer ' + token})
    with urllib.request.urlopen(request, timeout=10) as response: return json.load(response)

def main(stage):
    manifest = json.loads((stage / 'manifest.json').read_text())
    if run('hostname') != manifest['hostname'] or ENV.exists() or DROPIN.exists() or (STATE/'raft').exists():
        raise RuntimeError('Existing integration or host identity requires separate readback')
    if set(manifest['after']) != set(FILES): raise RuntimeError('Unexpected deployment scope')
    for name, expected in manifest['before'].items():
        if sha(LIVE/name) != expected: raise RuntimeError('Production source changed: ' + name)
    for name in FILES:
        if sha(stage/name) != manifest['after'][name]: raise RuntimeError('Release changed: ' + name)
        if name not in manifest['before'] and (LIVE/name).exists(): raise RuntimeError('New module already exists: ' + name)
        compile((stage/name).read_bytes(), name, 'exec')
    for name, expected in manifest['protected'].items():
        if sha(Path(name)) != expected: raise RuntimeError('Production configuration changed')
    original_health = health()
    original_pid = run('systemctl', 'show', 'oops-backend', '-p', 'MainPID', '--value')
    meetings = set((STATE/'meetings').glob('*.json'))
    operations = set((STATE/'operations').glob('*.json'))
    account = pwd.getpwnam('oops')
    backup = Path('/var/backups/oops-meeting') / ('raft-' + dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    backup.mkdir(mode=0o700, parents=True)
    shutil.copy2(LIVE/'local_backend.py', backup/'local_backend.py')
    (backup/'manifest.json').write_text(json.dumps(manifest, indent=2))
    changed = []
    try:
        for name in FILES:
            target = LIVE/name
            info = target.stat() if target.exists() else None
            fd, temporary = tempfile.mkstemp(prefix='.'+name, dir=LIVE)
            with os.fdopen(fd, 'wb') as stream:
                stream.write((stage/name).read_bytes()); stream.flush(); os.fsync(stream.fileno())
            os.chmod(temporary, (info.st_mode & 0o777) if info else 0o644)
            os.chown(temporary, info.st_uid if info else 0, info.st_gid if info else account.pw_gid)
            os.replace(temporary, target); changed.append(target)
        ENV.write_bytes((stage/'raft.env').read_bytes()); os.chmod(ENV, 0o600); os.chown(ENV, account.pw_uid, account.pw_gid)
        DROPIN.parent.mkdir(exist_ok=True)
        DROPIN.write_bytes((stage/'raft.conf').read_bytes()); os.chmod(DROPIN, 0o644)
        run('systemctl', 'daemon-reload')
        run('systemctl', 'restart', 'oops-backend', '--no-block')
        for attempt in range(40):
            try:
                current = health()
                pid = run('systemctl', 'show', 'oops-backend', '-p', 'MainPID', '--value')
                if current.get('status') == 'ok' and pid not in ('0', original_pid): break
            except OSError: pass
            if attempt == 39: raise RuntimeError('Backend not ready after narrow deployment')
            time.sleep(.5)
        # Counters and the other worker's current heartbeat change during normal use.
        contract = lambda value: {key: item for key, item in value.items() if key not in ('jev_stats', 'mac_agent_online')}
        if contract(current) != contract(original_health): raise RuntimeError('Existing health contract changed')
        preserved = {name: expected for name, expected in manifest['before'].items() if name not in FILES}
        if any(sha(LIVE/name) != expected for name, expected in preserved.items()): raise RuntimeError('Unrelated source changed')
        if any(sha(Path(name)) != expected for name, expected in manifest['protected'].items()): raise RuntimeError('Existing configuration changed')
        if not meetings.issubset(set((STATE/'meetings').glob('*.json'))) or not operations.issubset(set((STATE/'operations').glob('*.json'))):
            raise RuntimeError('Existing business state disappeared')
        result = dict(status='deployed', backup=str(backup), pid=pid, files=FILES,
                      preserved_sources=len(preserved), preserved_configurations=len(manifest['protected']),
                      existing_meetings=len(meetings), existing_operations=len(operations), health_unchanged=True)
        (backup/'result.json').write_text(json.dumps(result, indent=2))
        print(json.dumps(result))
    except Exception:
        for target in changed:
            if target.name == 'local_backend.py': shutil.copy2(backup/target.name, target)
            elif target.exists(): target.unlink()
        for path in (ENV, DROPIN):
            if path.exists(): path.unlink()
        run('systemctl', 'daemon-reload'); run('systemctl', 'restart', 'oops-backend', '--no-block')
        # Preserve any newly registered Raft tasks/receipts; never erase business state during rollback.
        raise
    finally:
        if (stage/'raft.env').exists(): (stage/'raft.env').unlink()

if __name__ == '__main__':
    with open('/run/oops-raft-upgrade.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        main(Path(sys.argv[1]).resolve())
