#!/usr/bin/env python3
"""Install three pinned backend fixes; never call models or modify business data/config.

manifest.json: {"before": {filename: sha256}, "after": {filename: sha256},
                "protected": {absolute_extra_file: sha256_or_null}}
Only the three FILES may occur in before/after. Extra protected files are read only.
"""
import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import socket
import stat
import subprocess
import tempfile
import time
import urllib.request


LIVE = Path('/opt/oops/app/scripts')
FILES = ('feishu_actions.py', 'minutes_vote.py', 'recordings.py')
SERVICE = 'oops-backend'
UNIT = Path('/etc/systemd/system/oops-backend.service')
DROPINS = Path('/etc/systemd/system/oops-backend.service.d')
MINUTES_CONFIG = Path('/var/lib/oops/.config/oops/minutes-model.json')
RUNTIME_HEALTH = {'jev_stats', 'mac_online', 'mac_agent_online'}


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def file_state(path):
    """Include metadata/link identity so replacing a protected file is also detected."""
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return None
    value = dict(mode=stat.S_IMODE(metadata.st_mode), uid=metadata.st_uid,
                 gid=metadata.st_gid)
    if path.is_symlink():
        value.update(kind='symlink', link=os.readlink(path))
        value['sha256'] = sha(path.read_bytes()) if path.is_file() else None
    elif path.is_file():
        value.update(kind='file', sha256=sha(path.read_bytes()))
    elif path.is_dir():
        value.update(kind='directory', children=sorted(p.name for p in path.iterdir()))
    else:
        raise RuntimeError('unsupported protected file type: ' + str(path))
    return value


def command(*args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=10)
    if result.returncode:
        raise RuntimeError('service command failed: ' + args[0])
    return result.stdout.strip()


def active_pid():
    pid = command('systemctl', 'show', SERVICE, '-p', 'MainPID', '--value')
    if not pid.isdigit() or int(pid) <= 0:
        raise RuntimeError('backend has no active PID')
    return pid


def active_token():
    pid = active_pid()
    for entry in Path('/proc/' + pid + '/environ').read_bytes().split(b'\0'):
        if entry.startswith(b'OOPS_API_TOKEN='):
            value = entry.split(b'=', 1)[1].decode()
            if value:
                return value
    raise RuntimeError('active health credential unavailable')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def health():
    request = urllib.request.Request('http://127.0.0.1:8787/healthz',
        headers={'Authorization': 'Bearer ' + active_token()})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(request, timeout=3) as response:
        raw = response.read(1024 * 1024 + 1)
    if len(raw) > 1024 * 1024:
        raise RuntimeError('oversize health response')
    value = json.loads(raw)
    if not isinstance(value, dict) or value.get('status') != 'ok':
        raise RuntimeError('backend health unavailable')
    # Compare all capabilities/gates/static versions, including previously unknown fields.
    return {key: content for key, content in value.items() if key not in RUNTIME_HEALTH}


def wait_health(expected, previous_pid):
    deadline = time.monotonic() + 30
    while True:
        try:
            if command('systemctl', 'is-active', SERVICE) != 'active' or active_pid() == previous_pid:
                raise RuntimeError('backend restart has not completed')
            current = health()
            if current != expected:
                raise RuntimeError('backend capabilities changed')
            return current
        except Exception:
            if time.monotonic() >= deadline:
                raise RuntimeError('backend failed to recover matching health') from None
            time.sleep(0.5)


def atomic_write(path, raw, metadata):
    fd, temporary = tempfile.mkstemp(prefix='.oops-three-fixes-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            os.fchown(stream.fileno(), metadata['uid'], metadata['gid'])
            os.fchmod(stream.fileno(), metadata['mode'])
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def save_json(path, value):
    atomic_write(path, (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode(),
                 dict(mode=0o600, uid=0, gid=0))


def protected_snapshot(extra):
    paths = {UNIT, DROPINS, MINUTES_CONFIG, *extra}
    paths.update(path for path in LIVE.rglob('*.py') if path not in {LIVE / n for n in FILES})
    if DROPINS.exists():
        paths.update(DROPINS.rglob('*'))
    return {str(path): file_state(path) for path in sorted(paths)}


def source_hashes():
    return {name: sha((LIVE / name).read_bytes()) for name in FILES}


def main(args):
    if os.geteuid() != 0:
        raise RuntimeError('production deployment requires root')
    stage = Path(args.stage).resolve(strict=True)
    with open('/run/oops-backend-three-fixes-upgrade.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        manifest = json.loads((stage / 'manifest.json').read_text())
        if manifest.get('hostname') != socket.gethostname():
            raise RuntimeError('production host identity changed')
        for key in ('before', 'after'):
            if not isinstance(manifest.get(key), dict) or set(manifest[key]) != set(FILES):
                raise RuntimeError('manifest must pin exactly the three source files')
            if any(not isinstance(value, str) or len(value) != 64
                   or any(c not in '0123456789abcdef' for c in value) for value in manifest[key].values()):
                raise RuntimeError('manifest contains an invalid SHA256')
        extra = manifest.get('protected', {})
        if not isinstance(extra, dict):
            raise RuntimeError('manifest protected must be a path-to-hash object')
        extra_paths = []
        for name, expected in extra.items():
            path = Path(name)
            if not path.is_absolute() or '..' in path.parts or path in {LIVE / n for n in FILES}:
                raise RuntimeError('invalid extra protected path')
            current = file_state(path)
            if current is not None and current['kind'] not in ('file', 'symlink'):
                raise RuntimeError('extra protected path must be a file')
            if (current or {}).get('sha256') != expected:
                raise RuntimeError('extra protected file baseline mismatch: ' + name)
            extra_paths.append(path)
        candidates, saved = {}, {}
        for name in FILES:
            target, candidate = LIVE / name, stage / name
            if target.is_symlink() or candidate.is_symlink() or not target.is_file() or not candidate.is_file():
                raise RuntimeError('source must be an existing regular file: ' + name)
            candidates[name] = candidate.read_bytes()
            original = target.read_bytes()
            if sha(original) != manifest['before'][name] or sha(candidates[name]) != manifest['after'][name]:
                raise RuntimeError('source hash mismatch; rebuild patch: ' + name)
            compile(candidates[name], name, 'exec')
            saved[name] = dict(raw=original, metadata=file_state(target))
        baseline = health()
        protected = protected_snapshot(extra_paths)
        stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        backup_parent = Path('/var/backups/oops-meeting')
        backup_parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        backup = Path(tempfile.mkdtemp(prefix='three-fixes-' + stamp + '-', dir=backup_parent))
        backup.chmod(0o700)
        for name in FILES:
            atomic_write(backup / name, saved[name]['raw'], dict(mode=0o600, uid=0, gid=0))
        metadata = {name: value['metadata'] for name, value in saved.items()}
        save_json(backup / 'restore.json', dict(files=metadata, before=manifest['before']))
        receipt = dict(status='prepared', backup=str(backup), before=manifest['before'],
                       after=manifest['after'], health_before=baseline,
                       protected_before=protected, protected_unchanged=True,
                       business_data_modified=False, model_calls=0)
        save_json(backup / 'receipt.json', receipt)
        changed = False
        try:
            if source_hashes() != manifest['before'] or protected_snapshot(extra_paths) != protected:
                raise RuntimeError('production changed during preparation')
            for name in FILES:
                # Set before attempting the first write: even an fsync failure requires restoration.
                changed = True
                atomic_write(LIVE / name, candidates[name], metadata[name])
            if source_hashes() != manifest['after']:
                raise RuntimeError('installed source hash mismatch')
            if protected_snapshot(extra_paths) != protected:
                raise RuntimeError('protected source or service configuration changed')
            previous_pid = active_pid()
            command('systemctl', 'restart', SERVICE, '--no-block')
            receipt['health_after'] = wait_health(baseline, previous_pid)
            receipt['protected_unchanged'] = protected_snapshot(extra_paths) == protected
            if not receipt['protected_unchanged'] or source_hashes() != manifest['after']:
                raise RuntimeError('source or protected configuration changed after restart')
            receipt.update(status='deployed', installed=source_hashes())
            save_json(backup / 'receipt.json', receipt)
            print(json.dumps(dict(status='deployed', backup=str(backup), installed=receipt['installed'],
                                  health=receipt['health_after'], protected_unchanged=True)), flush=True)
        except BaseException as error:
            # Do not restore data, configs or any unrelated source, even if another operator changed them.
            receipt.update(status='failed_before_install', error_type=type(error).__name__,
                           reason=str(error) if type(error) is RuntimeError else 'preparation or service operation failed')
            if changed:
                restoration_errors = []
                for name in FILES:
                    try:
                        atomic_write(LIVE / name, saved[name]['raw'], metadata[name])
                    except Exception as restore_error:
                        restoration_errors.append(name + ':' + type(restore_error).__name__)
                try:
                    try:
                        previous_pid = active_pid()
                    except Exception:
                        previous_pid = None
                    command('systemctl', 'restart', SERVICE, '--no-block')
                    receipt['health_restored'] = wait_health(baseline, previous_pid)
                    if restoration_errors or source_hashes() != manifest['before']:
                        raise RuntimeError('source restoration incomplete')
                    receipt['status'] = 'rolled_back'
                except Exception as recovery_error:
                    receipt.update(status='rollback_failed', recovery_error_type=type(recovery_error).__name__)
                receipt['restoration_errors'] = restoration_errors
            receipt['protected_unchanged'] = protected_snapshot(extra_paths) == protected
            save_json(backup / 'receipt.json', receipt)
            print(json.dumps(dict(status=receipt['status'], backup=str(backup),
                                  protected_unchanged=receipt['protected_unchanged'],
                                  error_type=receipt['error_type'], reason=receipt['reason'])), flush=True)
            raise RuntimeError('deployment failed; see private receipt: ' + str(backup / 'receipt.json')) from None


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--stage', required=True)
    try:
        main(parser.parse_args())
    except Exception as error:
        # Exception text may include third-party HTTP data; only emit its safe class here.
        print(json.dumps(dict(status='failed', error_type=type(error).__name__,
                              reason=str(error) if type(error) is RuntimeError else 'deployment preflight failed')), flush=True)
        raise SystemExit(1)
