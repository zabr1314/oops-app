#!/usr/bin/env python3
"""Fresh-install only the isolated Apple mobile gateway; never restart the backend.

This installer is for a separately authorized, reviewed production operation.
It never prints credentials, environment contents or upstream response bodies.
"""
import argparse
import ast
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

SERVICE = 'oops-apple-mobile.service'
BACKEND = 'oops-backend.service'
CODE_DIR = Path('/opt/oops/apple-mobile')
DATA_DIR = Path('/var/lib/oops-apple-mobile')
UNIT = Path('/etc/systemd/system') / SERVICE
ENABLE_LINK = Path('/etc/systemd/system/multi-user.target.wants') / SERVICE
LOCATIONS = Path('/etc/oops-meeting/locations.conf')
ROUTE = Path('/etc/oops-meeting/apple-mobile-locations.conf')
INCLUDE = b'include /etc/oops-meeting/apple-mobile-locations.conf;'
PREFIX = '/oops-meeting/apple-mobile'
PORT = 8799
CANDIDATES = {
    'scripts/apple_mobile_gateway.py': CODE_DIR / 'apple_mobile_gateway.py',
    'deploy/apple-mobile/oops-apple-mobile.service': UNIT,
    'deploy/apple-mobile/nginx-hk-apple-mobile.conf': ROUTE,
    'deploy/apple-mobile/install.py': None,
}


class InstallError(Exception):
    def __init__(self, code):
        self.code = code


def require(condition, code):
    if not condition:
        raise InstallError(code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def run(args, timeout=20, required=True):
    result = subprocess.run(args, capture_output=True, timeout=timeout)
    if required and result.returncode:
        raise InstallError('COMMAND_FAILED_' + Path(args[0]).name.upper())
    return result


def systemctl(*args, required=True):
    return run(['/usr/bin/systemctl', *args], required=required)


def backend_pid():
    require(systemctl('is-active', BACKEND).stdout.strip() == b'active', 'ORIGINAL_BACKEND_NOT_ACTIVE')
    raw = systemctl('show', BACKEND, '-p', 'MainPID', '--value').stdout.strip()
    require(raw.isdigit() and int(raw) > 1, 'ORIGINAL_BACKEND_PID_INVALID')
    return int(raw)


def require_backend_pid(expected):
    require(backend_pid() == expected, 'ORIGINAL_BACKEND_PID_CHANGED')


def source_token(pid):
    # Read process state in memory only; select just this variable, never copy env.
    with open('/proc/' + str(pid) + '/environ', 'rb') as stream:
        raw = stream.read(1_048_577)
    require(len(raw) <= 1_048_576, 'ORIGINAL_ENV_TOO_LARGE')
    matches = [entry.split(b'=', 1)[1] for entry in raw.split(b'\0') if entry.startswith(b'OOPS_API_TOKEN=')]
    require(len(matches) == 1, 'ORIGINAL_BACKEND_TOKEN_MISSING')
    token = matches[0].strip()
    require(0 < len(token) <= 4096 and b'\r' not in token and b'\n' not in token, 'ORIGINAL_BACKEND_TOKEN_INVALID')
    try:
        token.decode('ascii')
    except UnicodeError:
        raise InstallError('ORIGINAL_BACKEND_TOKEN_INVALID') from None
    return token


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def get_json(path, port, token=None):
    headers = {'Accept': 'application/json'}
    if token is not None:
        headers['Authorization'] = 'Bearer ' + token.decode('ascii')
    req = urllib.request.Request('http://127.0.0.1:' + str(port) + path, headers=headers)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(req, timeout=5) as response:
            raw = response.read(262145)
            require(response.status == 200 and len(raw) <= 262144, 'LOOPBACK_HEALTH_INVALID')
            value = json.loads(raw)
    except (OSError, ValueError, urllib.error.HTTPError):
        raise InstallError('LOOPBACK_HEALTH_UNAVAILABLE') from None
    require(isinstance(value, dict), 'LOOPBACK_HEALTH_INVALID')
    return value


def backend_health(token):
    value = get_json('/healthz', 8787, token)
    require(value.get('status') == 'ok' and type(value.get('archive_policy_version')) is int
            and value['archive_policy_version'] >= 1, 'ORIGINAL_BACKEND_POLICY_UNSUPPORTED')
    return {'status': 'ok', 'archive_policy_version': value['archive_policy_version']}


def safe_existing_file(path):
    require(path.is_file() and not path.is_symlink() and path.resolve() == path, 'UNSAFE_EXISTING_PATH')
    info = path.stat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022, 'UNSAFE_EXISTING_FILE_PERMISSIONS')
    return info


def ensure_absent(path):
    require(not os.path.lexists(path), 'NEW_TARGET_ALREADY_EXISTS_' + path.name.replace('.', '_').upper())
    require(path.parent.resolve() == path.parent, 'SYMLINK_IN_NEW_TARGET_PARENT')


def atomic_write(path, raw, mode, uid=0, gid=0, new=False):
    fd, temporary = tempfile.mkstemp(prefix='.apple-mobile-', dir=path.parent)
    try:
        os.fchmod(fd, mode)
        os.fchown(fd, uid, gid)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        if new:
            # Atomic no-replace creation: an unexpected target is never overwritten.
            os.link(temporary, path)
            os.unlink(temporary)
        else:
            os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def load_candidates(stage):
    require(stage.is_dir() and not stage.stat().st_mode & 0o022 and stage.stat().st_uid == 0,
            'STAGE_MUST_BE_ROOT_OWNED_AND_NOT_WRITABLE_BY_OTHERS')
    manifest_path = stage / 'deploy/apple-mobile/manifest.json'
    require(manifest_path.is_file() and not manifest_path.is_symlink(), 'PACKAGE_MANIFEST_MISSING')
    manifest = json.loads(manifest_path.read_bytes())
    require(isinstance(manifest, dict) and manifest.get('version') == 1 and isinstance(manifest.get('files'), dict)
            and set(manifest['files']) == set(CANDIDATES), 'PACKAGE_MANIFEST_INVALID')
    result = {}
    for relative in CANDIDATES:
        source = stage / relative
        require(source.is_file() and not source.is_symlink() and source.resolve().is_relative_to(stage)
                and source.stat().st_uid == 0 and not source.stat().st_mode & 0o022, 'UNSAFE_PACKAGE_FILE')
        raw = source.read_bytes()
        expected = manifest['files'][relative]
        require(isinstance(expected, str) and re.fullmatch(r'[a-f0-9]{64}', expected) and sha(raw) == expected,
                'PACKAGE_HASH_MISMATCH')
        if source.suffix == '.py':
            ast.parse(raw, filename=relative)
        result[relative] = raw
    require(Path(__file__).resolve() == (stage / 'deploy/apple-mobile/install.py').resolve(), 'INSTALLER_NOT_FROM_REVIEWED_STAGE')
    return result


def make_backup(original, info, candidates):
    base = Path('/var/backups/oops-apple-mobile')
    require(not base.is_symlink() and base.parent.resolve() == base.parent, 'UNSAFE_BACKUP_ROOT')
    base.mkdir(mode=0o700, exist_ok=True)
    require(base.stat().st_uid == 0 and not base.stat().st_mode & 0o077, 'UNSAFE_BACKUP_PERMISSIONS')
    stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    backup = base / stamp
    backup.mkdir(mode=0o700)
    atomic_write(backup / 'locations.before', original, 0o600)
    before = {str(LOCATIONS): dict(existed=True, backup='locations.before', sha256=sha(original),
                                  mode=stat.S_IMODE(info.st_mode), uid=info.st_uid, gid=info.st_gid)}
    for path in (UNIT, ENABLE_LINK, ROUTE, CODE_DIR, DATA_DIR, CODE_DIR / 'apple_mobile_gateway.py', DATA_DIR / 'backend-token'):
        before[str(path)] = {'existed': False}
    atomic_write(backup / 'restore.json', json.dumps(before, indent=2).encode(), 0o600)
    atomic_write(backup / 'candidate-hashes.json', json.dumps({k: sha(v) for k, v in candidates.items()}, indent=2).encode(), 0o600)
    return backup


def remove_new_directory(path, allowed):
    if not path.exists():
        return
    require(path.is_dir() and not path.is_symlink() and path.resolve() == path, 'ROLLBACK_UNSAFE_DIRECTORY')
    for child in path.iterdir():
        require(child.name in allowed and child.is_file() and not child.is_symlink(), 'ROLLBACK_UNEXPECTED_NEW_FILE')
    shutil.rmtree(path)


def install(stage):
    require(sys.platform.startswith('linux') and os.geteuid() == 0, 'ROOT_ON_EXISTING_LINUX_HOST_REQUIRED')
    os.umask(0o077)
    candidates = load_candidates(stage)
    account = pwd.getpwnam('oops')
    require(account.pw_uid > 0, 'EXISTING_OOPS_ACCOUNT_REQUIRED')
    require(systemctl('is-active', 'nginx.service').stdout.strip() == b'active', 'EXISTING_NGINX_NOT_ACTIVE')
    pid = backend_pid()
    user = systemctl('show', BACKEND, '-p', 'User', '--value').stdout.strip()
    require(user == b'oops', 'ORIGINAL_BACKEND_ACCOUNT_UNEXPECTED')
    arguments = Path('/proc/' + str(pid) + '/cmdline').read_bytes().split(b'\0')
    require(b'/opt/oops/app/scripts/local_backend.py' in arguments, 'ORIGINAL_BACKEND_PROCESS_UNEXPECTED')
    token = source_token(pid)
    require_backend_pid(pid)
    baseline = backend_health(token)
    # nginx -T is read-only; never print/store its output, which can contain private config.
    current_nginx = run(['/usr/sbin/nginx', '-T'], timeout=20).stdout
    require(PREFIX.encode() not in current_nginx, 'CONFLICTING_NGINX_PREFIX_ALREADY_PRESENT')
    for path in (CODE_DIR, DATA_DIR, UNIT, ENABLE_LINK, ROUTE):
        ensure_absent(path)
    load_state = systemctl('show', SERVICE, '-p', 'LoadState', '--value', required=False).stdout.strip()
    require(load_state == b'not-found', 'UNKNOWN_EXISTING_MOBILE_SERVICE')
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        try:
            probe.bind(('127.0.0.1', PORT))
        except OSError:
            raise InstallError('MOBILE_PORT_ALREADY_IN_USE') from None
    info = safe_existing_file(LOCATIONS)
    original = LOCATIONS.read_bytes()
    require(INCLUDE not in original and PREFIX.encode() not in original, 'CONFLICTING_LOCATION_INCLUDE')
    updated = original + (b'' if original.endswith(b'\n') else b'\n') + b'\n' + INCLUDE + b'\n'
    require_backend_pid(pid)
    backup = make_backup(original, info, candidates)
    touched = set()
    service_touched = False
    try:
        # Recheck after backup so another operator cannot be overwritten silently.
        require(LOCATIONS.read_bytes() == original, 'LOCATIONS_CHANGED_DURING_PREPARATION')
        for path in (CODE_DIR, DATA_DIR, UNIT, ENABLE_LINK, ROUTE):
            ensure_absent(path)
        CODE_DIR.mkdir(mode=0o750)
        touched.add('code')
        os.chmod(CODE_DIR, 0o750)
        os.chown(CODE_DIR, 0, account.pw_gid)
        DATA_DIR.mkdir(mode=0o700)
        touched.add('data')
        os.chown(DATA_DIR, account.pw_uid, account.pw_gid)
        atomic_write(CODE_DIR / 'apple_mobile_gateway.py', candidates['scripts/apple_mobile_gateway.py'], 0o640, 0, account.pw_gid, new=True)
        atomic_write(DATA_DIR / 'backend-token', token, 0o600, account.pw_uid, account.pw_gid, new=True)
        touched.add('unit')
        atomic_write(UNIT, candidates['deploy/apple-mobile/oops-apple-mobile.service'], 0o644, new=True)
        touched.add('route')
        atomic_write(ROUTE, candidates['deploy/apple-mobile/nginx-hk-apple-mobile.conf'], 0o644, new=True)
        require_backend_pid(pid)
        require(LOCATIONS.read_bytes() == original, 'LOCATIONS_CHANGED_BEFORE_APPEND')
        touched.add('locations')
        atomic_write(LOCATIONS, updated, stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid)
        run(['/usr/sbin/nginx', '-t'])
        systemctl('daemon-reload')
        require_backend_pid(pid)
        service_touched = True
        systemctl('enable', SERVICE)
        systemctl('start', SERVICE)
        deadline = time.monotonic() + 15
        while True:
            try:
                health = get_json(PREFIX + '/healthz', PORT)
                require(health.get('status') == 'ok' and health.get('api_version') == 1 and health.get('modes') == ['meeting'],
                        'MOBILE_HEALTH_INVALID')
                break
            except InstallError:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.25)
        require(systemctl('is-active', SERVICE).stdout.strip() == b'active', 'MOBILE_SERVICE_NOT_ACTIVE')
        require_backend_pid(pid)
        # Only the reverse proxy reloads. The original backend is never restarted.
        systemctl('reload', 'nginx.service')
        require_backend_pid(pid)
        require(backend_health(token) == baseline, 'ORIGINAL_BACKEND_POLICY_CHANGED')
        final_health = get_json(PREFIX + '/healthz', PORT)
        require(final_health.get('status') == 'ok' and final_health.get('api_version') == 1, 'FINAL_MOBILE_HEALTH_INVALID')
        result = dict(status='installed', service=SERVICE, port=PORT, prefix=PREFIX,
                      backup=str(backup), original_backend_pid_unchanged=True,
                      original_backend_health=baseline, mobile_loopback_health='ok',
                      upstream_token_copied_privately=True, pairing_code_issued=False,
                      upstream_business_writes=0, japan_config_changed=False)
        atomic_write(backup / 'result.json', json.dumps(result, indent=2).encode(), 0o600)
        return result
    except BaseException as error:
        problems = []
        if service_touched:
            for action in ('stop', 'disable'):
                try:
                    failed = systemctl(action, SERVICE, required=False).returncode != 0
                except (OSError, subprocess.SubprocessError):
                    failed = True
                if failed:
                    problems.append('mobile_' + action + '_failed')
        try:
            if 'locations' in touched:
                current = LOCATIONS.read_bytes()
                require(current in (original, updated), 'ROLLBACK_LOCATIONS_CHANGED_BY_OTHER_OPERATOR')
                if current != original:
                    atomic_write(LOCATIONS, original, stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid)
            if 'route' in touched and os.path.lexists(ROUTE):
                require(ROUTE.read_bytes() == candidates['deploy/apple-mobile/nginx-hk-apple-mobile.conf'], 'ROLLBACK_ROUTE_CHANGED')
                ROUTE.unlink()
            run(['/usr/sbin/nginx', '-t'])
            if 'locations' in touched:
                systemctl('reload', 'nginx.service')
            require('mobile_stop_failed' not in problems, 'ROLLBACK_CANNOT_REMOVE_RUNNING_SERVICE')
            if os.path.lexists(ENABLE_LINK):
                require(ENABLE_LINK.is_symlink() and ENABLE_LINK.resolve() == UNIT, 'ROLLBACK_ENABLE_LINK_CHANGED')
                ENABLE_LINK.unlink()
            if 'unit' in touched and os.path.lexists(UNIT):
                require(UNIT.read_bytes() == candidates['deploy/apple-mobile/oops-apple-mobile.service'], 'ROLLBACK_UNIT_CHANGED')
                UNIT.unlink()
            if 'code' in touched:
                code = CODE_DIR / 'apple_mobile_gateway.py'
                require(not code.exists() or code.read_bytes() == candidates['scripts/apple_mobile_gateway.py'], 'ROLLBACK_CODE_CHANGED')
                remove_new_directory(CODE_DIR, {'apple_mobile_gateway.py'})
            if 'data' in touched:
                remove_new_directory(DATA_DIR, {'backend-token', 'gateway.sqlite', 'gateway.sqlite-journal', 'gateway.sqlite-wal', 'gateway.sqlite-shm'})
            systemctl('daemon-reload')
        except (InstallError, OSError, subprocess.SubprocessError):
            problems.append('rollback_incomplete_inspect_private_backup')
        report = dict(status='failed', backup=str(backup), rollback_errors=problems,
                      reason=error.code if isinstance(error, InstallError) else 'INSTALL_OPERATION_FAILED',
                      original_backend_restart_attempted=False)
        try:
            atomic_write(backup / 'failure.json', json.dumps(report, indent=2).encode(), 0o600)
        except OSError:
            report['rollback_errors'].append('failure_receipt_unwritable')
        return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage', required=True, help='Reviewed root-owned extracted package root')
    parser.add_argument('--confirm-install', action='store_true', help='Use only after explicit authorization for this exact install')
    args = parser.parse_args(argv)
    if not args.confirm_install:
        print(json.dumps({'status': 'not_run', 'reason': 'EXPLICIT_INSTALL_FLAG_REQUIRED'}))
        return 2
    try:
        result = install(Path(args.stage).resolve())
    except InstallError as error:
        result = dict(status='not_installed', reason=error.code)
    except (OSError, ValueError, KeyError, SyntaxError, subprocess.SubprocessError):
        result = dict(status='not_installed', reason='PREPARATION_FAILED_NO_CREDENTIALS_LOGGED')
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result['status'] == 'installed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
