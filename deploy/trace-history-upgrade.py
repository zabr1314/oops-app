#!/usr/bin/env python3
"""Install exactly four trace-history files against pinned production hashes.

No SSH, model calls, meeting writes, credential output or broad source sync.
Run as root on the server after staging reviewed candidates and both fake tests.
"""
import argparse
from contextlib import contextmanager
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import time
import urllib.request
from urllib.parse import urlsplit

FILES = ('local_backend.py', 'meeting_features.py', 'processing_trace.py', 'replay_history.py')
TESTS = ('test_replay_history', 'test_processing_trace')
HEALTH_FIELDS = ('jev', 'voiceprint', 'feishu', 'speaker_preview', 'segments_validated', 'strict_a_enabled',
    'self_owner_enabled', 'named_owner_enabled', 'notices', 'meetings', 'recordings', 'archive_policy_version',
    'action_source_binding_version', 'item_quality_version', 'asr_closure_version', 'content_curation_version', 'feishu_bot')


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def file_hash(path):
    path = Path(path)
    if path.is_symlink():
        raise RuntimeError('symlink_in_protected_path')
    return sha(path.read_bytes()) if path.is_file() else None


def atomic_write(path, raw, mode, uid=None, gid=None):
    fd, temporary = tempfile.mkstemp(prefix='.trace-upgrade-', dir=str(path.parent))
    try:
        os.fchmod(fd, mode)
        if uid is not None and os.geteuid() == 0:
            os.fchown(fd, uid, gid)
        with os.fdopen(fd, 'wb') as target:
            target.write(raw)
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class Upgrade:
    def __init__(self, args, command=None, health=None, token=None, tests=None):
        self.args = args
        self.stage, self.live = Path(args.stage_dir).resolve(), Path(args.live_dir).resolve()
        self.backup = Path(args.backup_dir)
        self.command = command or self.run_command
        self.health = health or self.read_health
        self.token = token or self.running_token
        self.tests = tests or self.fake_tests
        self.old, self.new, self.metadata, self.report = {}, {}, {}, {}
        self.protected_paths = (Path(args.env_file), Path(args.jev_env_file),
            Path(args.state_dir) / 'people.json', Path(args.state_dir) / 'voiceprints.json')

    @staticmethod
    def run_command(*parts):
        result = subprocess.run(list(parts), capture_output=True, text=True, timeout=45)
        if result.returncode:
            raise RuntimeError('service_command_failed')
        return result.stdout.strip()

    def running_token(self):
        pid = self.command('systemctl', 'show', self.args.service, '-p', 'MainPID', '--value')
        if not str(pid).isdigit() or int(pid) <= 1:
            raise RuntimeError('backend_process_unavailable')
        # Read the active token only in memory, without sourcing/executing env files.
        for entry in Path('/proc/' + str(pid) + '/environ').read_bytes().split(b'\0'):
            if entry.startswith(b'OOPS_API_TOKEN='):
                value = entry.split(b'=', 1)[1].decode()
                if value:
                    return value
        raise RuntimeError('authenticated_health_token_unavailable')

    def read_health(self, token):
        parsed = urlsplit(self.args.health_url)
        if parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost', '::1') or parsed.path != '/healthz':
            raise RuntimeError('health_must_be_loopback')
        request = urllib.request.Request(self.args.health_url, headers={'Authorization': 'Bearer ' + token})
        with urllib.request.urlopen(request, timeout=3) as response:
            result = json.load(response)
        if result.get('status') != 'ok':
            raise RuntimeError('backend_health_not_ok')
        return result

    def fake_tests(self):
        for test in TESTS:
            if not (self.stage / (test + '.py')).is_file():
                raise RuntimeError('staged_fake_tests_missing')
        # Stage comes first; dependencies come from installed production scripts.
        # No provider keys are inherited. External network connects are blocked;
        # localhost is allowed for the gateway's synthetic HTTP tests only.
        script = '''import socket, unittest
original = socket.socket.connect
def local_only(self, address):
    if isinstance(address, tuple) and address[0] not in ('127.0.0.1', 'localhost', '::1'):
        raise AssertionError('external_network_forbidden')
    return original(self, address)
socket.socket.connect = local_only
suite = unittest.defaultTestLoader.loadTestsFromNames(['test_replay_history', 'test_processing_trace'])
result = unittest.TextTestRunner(verbosity=1).run(suite)
raise SystemExit(0 if result.wasSuccessful() else 1)
'''
        env = {key: os.environ[key] for key in ('PATH', 'LANG', 'LC_ALL') if key in os.environ}
        env.update(PYTHONPATH=str(self.stage) + os.pathsep + str(self.live), PYTHONDONTWRITEBYTECODE='1')
        result = subprocess.run([sys.executable, '-B', '-c', script], cwd=str(self.stage), env=env,
                                capture_output=True, timeout=90)
        atomic_write(self.backup / 'preflight-tests.txt', result.stdout + result.stderr, 0o600)
        if result.returncode:
            raise RuntimeError('staged_fake_regressions_failed')

    def validate(self):
        if self.args.service != 'oops-backend':
            raise RuntimeError('only_oops_backend_service_allowed')
        manifest = json.loads(Path(self.args.manifest).read_text())
        if not set(manifest).issubset(FILES) or not {'local_backend.py', 'meeting_features.py'}.issubset(manifest):
            raise RuntimeError('manifest_file_set_invalid')
        for name in FILES:
            candidate, installed = self.stage / name, self.live / name
            if (candidate.is_symlink() or not candidate.is_file() or installed.is_symlink()
                    or (installed.exists() and not installed.is_file())):
                raise RuntimeError('candidate_path_invalid')
            raw = candidate.read_bytes()
            compile(raw, name, 'exec')  # no pycache, source imports or execution
            spec = manifest.get(name, {})
            expected_before = spec.get('before_sha256')
            if name in ('local_backend.py', 'meeting_features.py') and not expected_before:
                raise RuntimeError('existing_source_hash_required')
            if file_hash(installed) != expected_before:
                raise RuntimeError('production_source_hash_changed:' + name)
            if spec.get('after_sha256') is not None and sha(raw) != spec['after_sha256']:
                raise RuntimeError('candidate_source_hash_mismatch:' + name)
            self.new[name] = raw
            if installed.is_file():
                self.old[name] = installed.read_bytes()
                entry = installed.stat()
                self.metadata[name] = dict(mode=stat.S_IMODE(entry.st_mode), uid=entry.st_uid, gid=entry.st_gid)
            else:
                self.old[name] = None
                reference = (self.live / 'local_backend.py').stat()
                self.metadata[name] = dict(mode=stat.S_IMODE(reference.st_mode), uid=reference.st_uid, gid=reference.st_gid)
        self.report = dict(version=1, status='validated', created_at=dt.datetime.now(dt.timezone.utc).isoformat(),
            files={name: dict(before_sha256=sha(self.old[name]) if self.old[name] is not None else None,
                             after_sha256=sha(self.new[name]), **self.metadata[name]) for name in FILES},
            protected_hashes={str(path): file_hash(path) for path in self.protected_paths})

    def save_report(self, status):
        self.report['status'] = status
        atomic_write(self.backup / 'manifest.json', (json.dumps(self.report, indent=2) + '\n').encode(), 0o600)

    def unchanged_protected(self):
        return self.report['protected_hashes'] == {str(path): file_hash(path) for path in self.protected_paths}

    def expected_health(self, before, after):
        return all(before.get(key) == after.get(key) for key in HEALTH_FIELDS if key in before)

    def wait_health(self, token, baseline):
        deadline = time.monotonic() + 20
        for attempt in range(40):
            if attempt and time.monotonic() >= deadline:
                break
            try:
                value = self.health(token)
                if self.expected_health(baseline, value):
                    return value
            except Exception:
                pass
            if attempt != 39:
                time.sleep(.5)
        raise RuntimeError('backend_features_or_health_changed')

    def install(self):
        self.validate()
        self.backup.mkdir(mode=0o700, parents=True, exist_ok=False)
        for name in FILES:
            if self.old[name] is not None:
                atomic_write(self.backup / name, self.old[name], 0o600)
        self.save_report('preflight')
        self.tests()
        if self.command('systemctl', 'is-active', self.args.service) != 'active':
            raise RuntimeError('backend_must_be_active_before_upgrade')
        token = self.token()
        baseline = self.health(token)
        self.report['health_feature_keys'] = [key for key in HEALTH_FIELDS if key in baseline]
        self.save_report('ready')
        if not self.args.apply:
            self.save_report('dry_run_verified')
            return dict(status='dry_run_verified', files=len(FILES), protected_files_unchanged=self.unchanged_protected())
        stopped, changed = False, []
        try:
            self.command('systemctl', 'stop', self.args.service)
            stopped = True
            # Recheck after shutdown; never overwrite a concurrent source edit.
            for name in FILES:
                if file_hash(self.live / name) != self.report['files'][name]['before_sha256']:
                    raise RuntimeError('source_changed_before_replace')
            for name in FILES:
                atomic_write(self.live / name, self.new[name], **self.metadata[name])
                changed.append(name)
            self.save_report('replaced')
            self.command('systemctl', 'start', self.args.service)
            stopped = False
            self.wait_health(token, baseline)
            if self.command('systemctl', 'is-active', self.args.service) != 'active':
                raise RuntimeError('backend_not_active_after_upgrade')
            if any(file_hash(self.live / name) != sha(self.new[name]) for name in FILES):
                raise RuntimeError('installed_hash_verification_failed')
            if not self.unchanged_protected():
                raise RuntimeError('protected_configuration_changed')
            self.save_report('installed_verified')
            return dict(status='installed_verified', files=len(FILES), protected_files_unchanged=True,
                        original_health_features_preserved=True)
        except Exception as error:
            if changed or stopped:
                try:
                    self.command('systemctl', 'stop', self.args.service)
                    for name in reversed(changed):
                        if self.old[name] is None:
                            (self.live / name).unlink(missing_ok=True)
                        else:
                            atomic_write(self.live / name, self.old[name], **self.metadata[name])
                    self.command('systemctl', 'start', self.args.service)
                    self.wait_health(token, baseline)
                    if any(file_hash(self.live / name) != self.report['files'][name]['before_sha256'] for name in FILES):
                        raise RuntimeError('rollback_source_hash_mismatch')
                    self.save_report('rolled_back')
                except Exception:
                    self.save_report('rollback_failed_requires_attention')
                    raise RuntimeError('trace_upgrade_rollback_failed') from None
            raise RuntimeError('trace_upgrade_failed_rolled_back') from error


@contextmanager
def deployment_lock(path):
    import fcntl
    fd = os.open(path, os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage-dir', required=True)
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--backup-dir', required=True)
    parser.add_argument('--live-dir', default='/opt/oops/app/scripts')
    parser.add_argument('--state-dir', default='/var/lib/oops/backend')
    parser.add_argument('--env-file', default='/var/lib/oops/backend.env')
    parser.add_argument('--jev-env-file', default='/var/lib/oops/jev.env')
    parser.add_argument('--service', default='oops-backend')
    parser.add_argument('--health-url', default='http://127.0.0.1:8787/healthz')
    parser.add_argument('--lock-file', default='/var/lock/oops-trace-upgrade.lock')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args(argv)
    try:
        with deployment_lock(args.lock_file):
            result = Upgrade(args).install()
        print(json.dumps(result, sort_keys=True))
    except Exception as error:
        # Never print exception details, env contents, authorization headers or
        # subprocess stdout. Diagnostics are only in the private backup folder.
        print(json.dumps(dict(status='failed', reason=str(error) if isinstance(error, RuntimeError)
                              else type(error).__name__)))
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
