#!/usr/bin/env python3
"""Install a pinned task-list/review patch without replacing other production code."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import urllib.request

LIVE = Path('/opt/oops/app/scripts')
FILES = ('local_backend.py', 'app_task_reviews.py')


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


def health():
    pid = subprocess.check_output(['systemctl', 'show', 'oops-backend', '-p', 'MainPID', '--value'], text=True).strip()
    values = Path('/proc/' + pid + '/environ').read_bytes().split(b'\0')
    token = next(row.split(b'=', 1)[1].decode() for row in values if row.startswith(b'OOPS_API_TOKEN='))
    request = urllib.request.Request('http://127.0.0.1:8787/healthz', headers={'Authorization': 'Bearer ' + token})
    with urllib.request.urlopen(request, timeout=3) as response:
        return json.load(response)


def write(path, raw):
    metadata = path.stat() if path.exists() else None
    fd, temp = tempfile.mkstemp(prefix='.task-upgrade-', dir=path.parent)
    try:
        os.fchmod(fd, metadata.st_mode & 0o777 if metadata else 0o644)
        if metadata:
            os.fchown(fd, metadata.st_uid, metadata.st_gid)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def main(stage):
    if os.geteuid() != 0:
        raise RuntimeError('root required for the existing service update')
    manifest = json.loads((stage / 'manifest.json').read_text())
    for name in FILES:
        if sha(LIVE / name) != manifest['before'][name] or sha(stage / name) != manifest['after'][name]:
            raise RuntimeError('production or patch changed; rebuild pinned patch: ' + name)
        compile((stage / name).read_bytes(), name, 'exec')
    before = health()
    if before.get('status') != 'ok':
        raise RuntimeError('backend is not healthy before deployment')
    batch_hash = sha(LIVE / 'label_app_tasks.py')
    backup = Path('/var/backups/oops-meeting') / ('task-review-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    backup.mkdir(mode=0o700, parents=True)
    for name in FILES:
        if (LIVE / name).exists():
            shutil.copy2(LIVE / name, backup / name)
    try:
        for name in FILES:
            write(LIVE / name, (stage / name).read_bytes())
        subprocess.run(['systemctl', 'restart', 'oops-backend'], check=True, timeout=25)
        after = None
        for _ in range(8):
            try:
                after = health()
                if after.get('status') == 'ok':
                    break
            except Exception:
                pass
            time.sleep(1)
        if not after or after.get('status') != 'ok' or after.get('task_review_version') != 1:
            raise RuntimeError('updated service did not return its capability receipt')
        if sha(LIVE / 'label_app_tasks.py') != batch_hash:
            raise RuntimeError('existing batch adapter changed during deployment')
    except BaseException:
        for name in FILES:
            if (backup / name).exists():
                write(LIVE / name, (backup / name).read_bytes())
            elif manifest['before'][name] is None and sha(LIVE / name) == manifest['after'][name]:
                (LIVE / name).unlink()
        subprocess.run(['systemctl', 'restart', 'oops-backend'], check=True, timeout=25)
        raise
    receipt = dict(backup=str(backup), status=after['status'], task_review_version=after.get('task_review_version'),
                   task_candidates_version=after.get('task_candidates_version'), preserved_batch_adapter=True,
                   files=manifest['after'])
    (backup / 'receipt.json').write_text(json.dumps(receipt, indent=2))
    print(json.dumps(receipt))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('stage', type=Path)
    main(parser.parse_args().stage.resolve())
