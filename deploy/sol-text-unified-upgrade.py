#!/usr/bin/env python3
"""Install the six pinned Sol text sources; never call models or restore business data/config.

Stage includes manifest.json, the six candidate files and fresh preflight.json.
Manifest: hostname, before (SHA256/null for new files), after (six SHA256s),
protected (absolute file -> SHA256/null), preflight_sha256 (required).
Preflight is the independently refreshed production snapshot, not a candidate baseline.
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
FILES = ('local_backend.py', 'meeting_features.py', 'feishu_actions.py', 'task_board.py',
         'sol_text.py', 'minutes_long.py')
NEW_FILES = {'sol_text.py', 'minutes_long.py'}
HOSTNAME = 'ser108841712320'
SERVICE = 'oops-backend'
UNIT = Path('/etc/systemd/system/oops-backend.service')
DROPINS = Path('/etc/systemd/system/oops-backend.service.d')
MINUTES_CONFIG = Path('/var/lib/oops/.config/oops/minutes-model.json')
PRIVATE_CONFIG = MINUTES_CONFIG.parent
STATE = Path('/var/lib/oops/backend')
MODEL_REFERENCE = LIVE / 'minutes_model.py'
RUNTIME_HEALTH = {'jev_stats', 'mac_online', 'mac_agent_online'}
SOL_HEALTH = dict(text_processing_provider='sol', text_processing_model='gpt-6.1-sol', text_highlight_version=1)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def same(left, right):
    return json.dumps(left, sort_keys=True, separators=(',', ':')) == json.dumps(right, sort_keys=True, separators=(',', ':'))


def valid_sha(value):
    return isinstance(value, str) and len(value) == 64 and all(c in '0123456789abcdef' for c in value)


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


def active_environment():
    return dict(entry.split(b'=', 1) for entry in Path('/proc/' + active_pid() + '/environ').read_bytes().split(b'\0') if b'=' in entry)


def active_token():
    value = active_environment().get(b'OOPS_API_TOKEN', b'').decode()
    if value:
        return value
    raise RuntimeError('active health credential unavailable')


def verify_model_environment():
    environment = active_environment()
    if environment.get(b'OOPS_MINUTES_PART_CHARS', b'').strip() not in (b'', b'0'):
        raise RuntimeError('long-minutes partitioning must remain disabled')
    configured = environment.get(b'OOPS_MINUTES_CONFIG', b'').decode()
    if configured and Path(configured) != MINUTES_CONFIG:
        raise RuntimeError('unexpected private model configuration path')
    config = json.loads(MINUTES_CONFIG.read_text())
    if (config.get('model') != 'gpt-6.1-sol' or config.get('provider') != 'openai-compatible'
            or stat.S_IMODE(MINUTES_CONFIG.stat().st_mode) & 0o077):
        raise RuntimeError('private Sol configuration is not the approved baseline')


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
            if not same(current, expected):
                raise RuntimeError('backend capabilities changed')
            verify_model_environment()
            return current
        except Exception:
            if time.monotonic() >= deadline:
                raise RuntimeError('backend failed to recover matching health') from None
            time.sleep(0.5)


def atomic_write(path, raw, metadata):
    fd, temporary = tempfile.mkstemp(prefix='.oops-sol-text-', dir=path.parent)
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
    paths = {UNIT, DROPINS, MINUTES_CONFIG, PRIVATE_CONFIG, MODEL_REFERENCE,
             STATE / 'people.json', STATE / 'voiceprints.json', *extra}
    paths.update(path for path in LIVE.rglob('*.py') if path not in {LIVE / n for n in FILES})
    if DROPINS.exists():
        paths.update(DROPINS.rglob('*'))
    if PRIVATE_CONFIG.exists():
        paths.update(PRIVATE_CONFIG.rglob('*'))
    paths.update(path for path in LIVE.parent.glob('*.env') if path.is_file() or path.is_symlink())
    paths.update(path for path in LIVE.parent.glob('.*.env') if path.is_file() or path.is_symlink())
    for name in ('voiceprints', 'voiceprint', 'profiles'):
        folder = STATE / name
        if folder.exists():
            paths.add(folder)
            paths.update(folder.rglob('*'))
    return {str(path): file_state(path) for path in sorted(paths)}


def source_hashes():
    return {name: sha((LIVE / name).read_bytes()) if (LIVE / name).is_file() else None for name in FILES}


def source_inventory():
    return {str(path.relative_to(LIVE)): sha(path.read_bytes()) for path in LIVE.rglob('*.py') if path.is_file()}


def verify_source_states(hashes, metadata):
    for name in FILES:
        current = file_state(LIVE / name)
        if hashes[name] is None:
            if current is not None:
                raise RuntimeError('new source was not removed during rollback: ' + name)
            continue
        if current is None or current['kind'] != 'file' or current['sha256'] != hashes[name]:
            raise RuntimeError('source integrity changed: ' + name)
        if any(current[field] != metadata[name][field] for field in ('mode', 'uid', 'gid')):
            raise RuntimeError('source ownership or permissions changed: ' + name)


def remove_new_source(path):
    if path.exists():
        path.unlink()
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)


def main(args):
    if os.geteuid() != 0:
        raise RuntimeError('production deployment requires root')
    stage = Path(args.stage).resolve(strict=True)
    # Share the previous deployment lock: the overlapping source sets must not race.
    with open('/run/oops-backend-three-fixes-upgrade.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        manifest = json.loads((stage / 'manifest.json').read_text())
        if manifest.get('hostname') != HOSTNAME or socket.gethostname() != HOSTNAME:
            raise RuntimeError('production host identity changed')
        preflight_raw = (stage / 'preflight.json').read_bytes()
        if not valid_sha(manifest.get('preflight_sha256')) or sha(preflight_raw) != manifest['preflight_sha256']:
            raise RuntimeError('fresh production preflight snapshot is not pinned')
        preflight = json.loads(preflight_raw)
        if preflight.get('hostname') != HOSTNAME:
            raise RuntimeError('preflight host identity changed')
        for key in ('before', 'after'):
            if not isinstance(manifest.get(key), dict) or set(manifest[key]) != set(FILES):
                raise RuntimeError('manifest must pin exactly the six source files')
            for name, value in manifest[key].items():
                if not valid_sha(value) and not (key == 'before' and name in NEW_FILES and value is None):
                    raise RuntimeError('manifest contains an invalid SHA256')
        fresh_sources = preflight.get('source_hashes')
        if not isinstance(fresh_sources, dict) or source_inventory() != fresh_sources:
            raise RuntimeError('production Python sources changed since fresh preflight')
        for name in FILES:
            if fresh_sources.get(name) != manifest['before'][name]:
                raise RuntimeError('manifest source baseline is not the fresh preflight: ' + name)
        if active_pid() != preflight.get('pid'):
            raise RuntimeError('backend process changed since fresh preflight')
        if str(preflight.get('part_setting', '')).strip() not in ('', '0'):
            raise RuntimeError('preflight enables long-minutes partitioning')
        verify_model_environment()
        extra = manifest.get('protected', {})
        if not isinstance(extra, dict):
            raise RuntimeError('manifest protected must be a path-to-hash object')
        fresh_protected = preflight.get('protected')
        if not isinstance(fresh_protected, dict) or any(extra.get(name) != digest for name, digest in fresh_protected.items()):
            raise RuntimeError('manifest does not preserve the fresh private/config baseline')
        mandatory = {str(UNIT), str(MINUTES_CONFIG), str(STATE / 'people.json'), str(STATE / 'voiceprints.json')}
        if not mandatory.issubset(extra):
            raise RuntimeError('manifest omits required protected state or configuration')
        extra_paths = []
        for name, expected in extra.items():
            path = Path(name)
            if not path.is_absolute() or '..' in path.parts or path in {LIVE / n for n in FILES}:
                raise RuntimeError('invalid extra protected path')
            if expected is not None and not valid_sha(expected):
                raise RuntimeError('invalid extra protected SHA256')
            current = file_state(path)
            if current is not None and current['kind'] not in ('file', 'symlink'):
                raise RuntimeError('extra protected path must be a file')
            if (current or {}).get('sha256') != expected:
                raise RuntimeError('extra protected file baseline mismatch: ' + name)
            extra_paths.append(path)
        candidates, saved = {}, {}
        reference_metadata = file_state(MODEL_REFERENCE)
        if reference_metadata is None or reference_metadata['kind'] != 'file':
            raise RuntimeError('new source ownership reference must be a regular file')
        for name in FILES:
            target, candidate = LIVE / name, stage / name
            current = file_state(target)
            if candidate.is_symlink() or not candidate.is_file() or current is not None and current['kind'] != 'file':
                raise RuntimeError('source must be a regular file or an explicitly new target: ' + name)
            if (current is None) != (manifest['before'][name] is None):
                raise RuntimeError('source presence differs from pinned baseline: ' + name)
            candidates[name] = candidate.read_bytes()
            original = target.read_bytes() if current is not None else None
            if ((sha(original) if original is not None else None) != manifest['before'][name]
                    or sha(candidates[name]) != manifest['after'][name]):
                raise RuntimeError('source hash mismatch; rebuild patch: ' + name)
            compile(candidates[name], name, 'exec')
            saved[name] = dict(raw=original, metadata=current)
        baseline = health()
        expected_fresh_health = {key: value for key, value in preflight.get('health', {}).items() if key not in RUNTIME_HEALTH}
        if not same(baseline, expected_fresh_health):
            raise RuntimeError('backend health gates changed since fresh preflight')
        if any(key in baseline and not same(baseline[key], value) for key, value in SOL_HEALTH.items()):
            raise RuntimeError('existing text processing capability conflicts with this deployment')
        expected_health = dict(baseline, **SOL_HEALTH)
        protected = protected_snapshot(extra_paths)
        stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        backup_parent = Path('/var/backups/oops-meeting')
        backup_parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        backup = Path(tempfile.mkdtemp(prefix='sol-text-' + stamp + '-', dir=backup_parent))
        backup.chmod(0o700)
        for name in FILES:
            if saved[name]['raw'] is not None:
                atomic_write(backup / name, saved[name]['raw'], dict(mode=0o600, uid=0, gid=0))
        metadata = {name: value['metadata'] for name, value in saved.items()}
        installed_metadata = {name: metadata[name] or reference_metadata for name in FILES}
        save_json(backup / 'restore.json', dict(files=metadata, before=manifest['before'], new_files=[name for name in FILES if metadata[name] is None]))
        receipt = dict(status='prepared', backup=str(backup), before=manifest['before'],
                       after=manifest['after'], health_before=baseline,
                       protected_before=protected, protected_unchanged=True,
                       business_data_modified_by_deployer=False, model_calls_by_deployer=0,
                       long_minutes_partitioning_enabled=False, preflight_sha256=manifest['preflight_sha256'])
        save_json(backup / 'receipt.json', receipt)
        changed = False
        try:
            if source_hashes() != manifest['before'] or not same(protected_snapshot(extra_paths), protected):
                raise RuntimeError('production changed during preparation')
            verify_source_states(manifest['before'], metadata)
            verify_model_environment()
            for name in FILES:
                # Set before attempting the first write: even an fsync failure requires restoration.
                changed = True
                atomic_write(LIVE / name, candidates[name], installed_metadata[name])
            if source_hashes() != manifest['after']:
                raise RuntimeError('installed source hash mismatch')
            verify_source_states(manifest['after'], installed_metadata)
            if not same(protected_snapshot(extra_paths), protected):
                raise RuntimeError('protected source or service configuration changed')
            previous_pid = active_pid()
            command('systemctl', 'restart', SERVICE, '--no-block')
            receipt['health_after'] = wait_health(expected_health, previous_pid)
            receipt['pid_before'], receipt['pid_after'] = previous_pid, active_pid()
            receipt['protected_unchanged'] = same(protected_snapshot(extra_paths), protected)
            if not receipt['protected_unchanged'] or source_hashes() != manifest['after']:
                raise RuntimeError('source or protected configuration changed after restart')
            verify_source_states(manifest['after'], installed_metadata)
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
                        current_hash = source_hashes()[name]
                        if current_hash not in (manifest['before'][name], manifest['after'][name]):
                            raise RuntimeError('target changed by another writer; not overwriting it')
                        if saved[name]['raw'] is None:
                            remove_new_source(LIVE / name)
                        else:
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
                    verify_source_states(manifest['before'], metadata)
                    receipt['status'] = 'rolled_back'
                except Exception as recovery_error:
                    receipt.update(status='rollback_failed', recovery_error_type=type(recovery_error).__name__)
                receipt['restoration_errors'] = restoration_errors
            receipt['protected_unchanged'] = same(protected_snapshot(extra_paths), protected)
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
