#!/usr/bin/env python3
"""Pinned, five-file personal Feishu upgrade; no deployment unless --apply.

Host: python3 feishu-mobile-upgrade.py baseline > baseline.json
Mac:  python3 deploy/feishu-mobile-upgrade.py build STAGE --baseline baseline.json --checks checks.json
Host: python3 STAGE/feishu-mobile-upgrade.py STAGE [--apply]

Configure OAuth securely and install cryptography before capturing the baseline.
This tool never writes configuration or prints its values. Tests run as oops in
an isolated network namespace with loopback only, using synthetic fixtures.
"""
import argparse
from contextlib import contextmanager
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import urllib.request
from urllib.parse import urlsplit

FILES = ('local_backend.py', 'feishu_actions.py', 'feishu_accounts.py', 'feishu_mobile.py', 'minutes_delivery.py')
NEW = frozenset(('feishu_accounts.py', 'feishu_mobile.py', 'minutes_delivery.py'))
TESTS = ('test_feishu_accounts.py', 'test_feishu_mobile.py', 'test_minutes_delivery.py', 'test_feishu_actions.py')
CHECKS = ('accounts_fake', 'delivery_fake', 'mobile_boundaries', 'automatic_sending_disabled', 'source_baseline_review')
CAPABILITIES = {'feishu_mobile_version': 1, 'minutes_delivery_confirmation_required': True}
VOLATILE = {'jev_stats', 'mac_agent_online'}
INSTALLER = 'feishu-mobile-upgrade.py'
HEX = re.compile(r'[a-f0-9]{64}')


class GateError(RuntimeError):
    """Only fixed, non-secret reason codes may cross the command boundary."""


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def safe_path(path):
    path = Path(path).absolute()
    if path.is_symlink() or any(p.is_symlink() for p in path.parents):
        raise GateError('symlink_requires_review')
    return path


def file_hash(path):
    path = safe_path(path)
    if path.exists() and not path.is_file():
        raise GateError('regular_file_required')
    return digest(path.read_bytes()) if path.exists() else None


def atomic_write(path, raw, mode, uid=None, gid=None, *, new=False):
    path = safe_path(path)
    fd, temporary = tempfile.mkstemp(prefix='.feishu-mobile-stage-', dir=str(path.parent))
    try:
        os.fchmod(fd, mode)
        if uid is not None and os.geteuid() == 0:
            os.fchown(fd, uid, gid)
        with os.fdopen(fd, 'wb') as out:
            out.write(raw); out.flush(); os.fsync(out.fileno())
        if new:
            os.link(temporary, path)  # no replacement of a file appearing after the gate
            os.unlink(temporary)
        else:
            os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def json_file(path):
    path = safe_path(path)
    if not path.is_file():
        raise GateError('required_state_missing')
    try:
        value = json.loads(path.read_bytes())
    except (ValueError, OSError):
        raise GateError('state_unreadable_requires_review') from None
    if not isinstance(value, dict):
        raise GateError('state_object_required')
    return value


def timestamp(value):
    if not value:
        return None
    try:
        value = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        if value.tzinfo is None:
            raise ValueError()
        return value
    except (AttributeError, TypeError, ValueError):
        raise GateError('state_timestamp_requires_review') from None


def source_snapshot(live):
    return {name: file_hash(Path(live) / name) for name in FILES}


def configuration_paths(args):
    paths = [Path(args.env_file), Path(args.jev_env_file), Path(args.feishu_env_file), Path(args.unit_file)]
    folder = safe_path(args.dropin_dir)
    if folder.exists() and not folder.is_dir():
        raise GateError('dropin_directory_invalid')
    if folder.exists():
        # Back up every existing drop-in, not only a presumed filename.
        for path in sorted(folder.rglob('*')):
            safe_path(path)
            if path.is_file():
                paths.append(path)
    return paths


def protected_snapshot(args):
    paths = configuration_paths(args) + [Path(args.state_dir) / 'people.json', Path(args.state_dir) / 'voiceprints.json']
    archives = safe_path(Path(args.state_dir) / 'archive-policies')
    if archives.exists() and not archives.is_dir():
        raise GateError('archive_policy_directory_invalid')
    if archives.exists():
        for path in sorted(archives.rglob('*')):
            safe_path(path)
            if path.is_file(): paths.append(path)
    result = {str(path.absolute()): file_hash(path) for path in paths}
    result['directory:' + str(archives.absolute())] = archives.is_dir()
    result['directory:' + str(Path(args.dropin_dir).absolute())] = Path(args.dropin_dir).is_dir()
    return result


def pending_work(state_dir, now=None):
    """Read persisted queues only; never construct Backend, OAuth or a worker."""
    base = safe_path(state_dir)
    # Inspect only queues read by this gate. Raw recordings may have legitimate
    # offload links and are not opened, followed or modified by this installer.
    for name in ('feishu', 'meetings', 'agent-jobs', 'operations', 'mobile-feishu/deliveries'):
        folder = safe_path(base / name)
        if folder.exists() and not folder.is_dir():
            raise GateError('queue_directory_invalid')
        if folder.exists():
            for path in folder.iterdir():
                safe_path(path)
    now = now or dt.datetime.now(dt.timezone.utc)
    bot = json_file(base / 'feishu/state.json')
    since = timestamp(bot.get('since'))
    if since is None:
        raise GateError('feishu_baseline_time_missing')
    counts = dict(active_meetings=0, minutes=0, ledger=0, jobs=0, operations=0, deliveries=0, questions=0)
    for path in (base / 'meetings').glob('*.json'):
        row = json_file(path)
        if row.get('transcript_status') == 'expired': continue
        ended, last = timestamp(row.get('ended_at')), timestamp(row.get('last_sync_at'))
        if not ended:
            started = timestamp(row.get('started_at'))
            if last and len(row.get('utterances') or []) >= 5 and now - last > dt.timedelta(minutes=20):
                if started is None: raise GateError('meeting_start_time_missing')
                ended = started + dt.timedelta(milliseconds=max(u['end_ms'] for u in row['utterances']))
            else:
                observed = last or started
                if observed is None or now - observed < dt.timedelta(minutes=30): counts['active_meetings'] += 1
                continue
        if ended <= since: continue
        entry = bot.get('meetings', {}).get(row.get('session_id', path.stem), {})
        if not entry.get('done') and (entry.get('failures') or 0) < 6: counts['minutes'] += 1
        if entry.get('ledger_pending') and (entry.get('ledger_failures') or 0) < 6: counts['ledger'] += 1
    for folder, key, statuses in [('agent-jobs', 'jobs', {'queued', 'preparing', 'running', 'delivering'}),
                                  ('operations', 'operations', {'pending', 'creating', 'sending', 'unknown', 'polling'})]:
        for path in (base / folder).glob('*.json'):
            if json_file(path).get('status') in statuses: counts[key] += 1
    for path in (base / 'mobile-feishu/deliveries').glob('*.json'):
        state = json_file(path)
        counts['deliveries'] += sum(op.get('status') in {'pending', 'sending', 'partial', 'unknown'}
                                   for op in state.get('operations', {}).values())
    for entry in bot.get('questions', {}).values():
        if isinstance(entry, dict) and entry.get('status') in {'pending', 'running', 'sending'}: counts['questions'] += 1
    return counts


def baseline(args):
    return dict(schema=1, sources=source_snapshot(args.live_dir), protected=protected_snapshot(args))


def release_id(manifest):
    body = {key: manifest[key] for key in ('files', 'baseline', 'protected', 'tests', 'checks', 'installer_sha256')}
    return digest(json.dumps(body, sort_keys=True, separators=(',', ':')).encode())


def build(stage, baseline_file, checks_file):
    root = Path(__file__).resolve().parents[1]
    before = json_file(baseline_file); checks = json_file(checks_file)
    if before.get('schema') != 1 or set(before.get('sources', {})) != set(FILES) or not before.get('protected'):
        raise GateError('baseline_manifest_invalid')
    if set(checks) != set(CHECKS) or any(value is not True for value in checks.values()):
        raise GateError('completed_checks_required')
    stage = safe_path(stage); stage.mkdir(mode=0o755, parents=True, exist_ok=False)
    manifest = dict(schema=1, baseline=before['sources'], protected=before['protected'], checks=checks, files={}, tests={})
    for key, names in [('files', FILES), ('tests', TESTS)]:
        for name in names:
            source = safe_path(root / 'scripts' / name)
            raw = source.read_bytes(); compile(raw, name, 'exec')
            atomic_write(stage / name, raw, 0o644, new=True)
            manifest[key][name] = digest(raw)
    atomic_write(stage / INSTALLER, Path(__file__).read_bytes(), 0o644, new=True)
    manifest['installer_sha256'] = file_hash(stage / INSTALLER)
    manifest['release_id'] = release_id(manifest)
    atomic_write(stage / 'manifest.json', (json.dumps(manifest, indent=2) + '\n').encode(), 0o644, new=True)
    return dict(status='stage_built', files=len(FILES), fake_tests=len(TESTS), release_id=manifest['release_id'])


# Root creates an isolated namespace and enables its loopback; then permanently
# drops to oops before importing candidates/tests. No inherited provider settings.
TEST_RUNNER = r'''
import fcntl, os, pwd, runpy, socket, struct, sys, unittest
stage, live, user = sys.argv[1:]
with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as control:
    flags = struct.unpack_from('16sH', fcntl.ioctl(control, 0x8913, struct.pack('16sH22x', b'lo', 0)))[1]
    fcntl.ioctl(control, 0x8914, struct.pack('16sH22x', b'lo', flags | 1))
account = pwd.getpwnam(user)
os.setgroups([]); os.setgid(account.pw_gid); os.setuid(account.pw_uid)
if os.geteuid() != account.pw_uid or os.geteuid() == 0: raise SystemExit('fake_tests_must_run_as_oops')
os.environ.clear(); os.environ.update(PATH='/usr/bin:/bin', PYTHONDONTWRITEBYTECODE='1')
sys.dont_write_bytecode = True
sys.path[:0] = [stage, live]
from cryptography.fernet import Fernet
# Defense in depth: names, TCP, UDP and subprocesses also stay inside netns.
connect, connect_ex, getaddrinfo, sendto = socket.socket.connect, socket.socket.connect_ex, socket.getaddrinfo, socket.socket.sendto
def permitted(address):
    if isinstance(address, tuple) and address[0] not in ('127.0.0.1', 'localhost', '::1'): raise AssertionError('external_network_forbidden')
def local_connect(self, address): permitted(address); return connect(self, address)
def local_connect_ex(self, address): permitted(address); return connect_ex(self, address)
def local_getaddrinfo(host, *a, **k): permitted((host, 0)); return getaddrinfo(host, *a, **k)
def local_sendto(self, data, *a): permitted(a[-1]); return sendto(self, data, *a)
socket.socket.connect = local_connect; socket.socket.connect_ex = local_connect_ex
socket.getaddrinfo = local_getaddrinfo; socket.socket.sendto = local_sendto
suite = unittest.defaultTestLoader.loadTestsFromNames(['test_feishu_accounts', 'test_feishu_mobile', 'test_minutes_delivery'])
result = unittest.TextTestRunner(verbosity=1).run(suite)
if not result.wasSuccessful() or result.skipped: raise SystemExit(1)
runpy.run_path(os.path.join(stage, 'test_feishu_actions.py'), run_name='__main__')
'''


def health_matches(before, after, *, upgraded):
    ignored = VOLATILE | (set(CAPABILITIES) if upgraded else set())
    old = {k:v for k,v in before.items() if k not in ignored}
    new = {k:v for k,v in after.items() if k not in ignored}
    if old != new or any(type(new[k]) is not type(v) for k,v in old.items()):return False
    return not upgraded or all(type(after.get(k)) is type(v) and after.get(k)==v for k,v in CAPABILITIES.items())


class Upgrade:
    def __init__(self, args, *, command=None, health=None, token=None, tests=None):
        self.args = args; self.stage = safe_path(args.target[0]); self.live = safe_path(args.live_dir)
        self.command = command or self.run_command; self.health = health or self.read_health
        self.token = token or self.running_token; self.tests = tests or self.fake_tests
        self.new, self.old, self.attrs, self.config, self.test_output = {}, {}, {}, {}, b''

    @staticmethod
    def run_command(*parts):
        result = subprocess.run(list(parts), capture_output=True, text=True, timeout=60)
        if result.returncode: raise GateError('service_command_failed')
        return result.stdout.strip()

    def running_token(self):
        pid = self.command('systemctl', 'show', self.args.service, '-p', 'MainPID', '--value')
        if not str(pid).isdigit() or int(pid) <= 1: raise GateError('backend_process_unavailable')
        for item in Path('/proc/' + pid + '/environ').read_bytes().split(b'\0'):
            if item.startswith(b'OOPS_API_TOKEN='):
                value=item.split(b'=', 1)[1].decode()
                if value:return value
        raise GateError('authenticated_health_unavailable')

    def read_health(self, token):
        parsed = urlsplit(self.args.health_url)
        if parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', '::1') or parsed.path != '/healthz' or parsed.query or parsed.fragment or parsed.username:
            raise GateError('health_must_be_literal_loopback')
        # Refuse redirects rather than forwarding the Authorization header.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs): return None
        request = urllib.request.Request(self.args.health_url, headers={'Authorization': 'Bearer ' + token})
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        with opener.open(request, timeout=3) as response: value = json.load(response)
        if not isinstance(value, dict) or value.get('status') != 'ok': raise GateError('backend_unhealthy')
        return value

    def fake_tests(self):
        env = {'PATH': '/usr/bin:/bin', 'PYTHONDONTWRITEBYTECODE': '1', 'LANG': 'C.UTF-8'}
        result = subprocess.run(['unshare', '--net', '--', self.args.python, '-I', '-B', '-c', TEST_RUNNER,
                                 str(self.stage), str(self.live), 'oops'], cwd=str(self.stage), env=env,
                                capture_output=True, timeout=180)
        self.test_output = result.stdout + result.stderr
        if result.returncode: raise GateError('isolated_fake_regressions_or_crypto_failed')

    def validate(self):
        if self.args.service != 'oops-backend': raise GateError('unexpected_service')
        manifest = json_file(self.stage / 'manifest.json')
        keys = {'schema','files','baseline','protected','tests','checks','installer_sha256','release_id'}
        if set(manifest) != keys or manifest.get('schema') != 1 or set(manifest.get('files', {})) != set(FILES) or set(manifest.get('baseline', {})) != set(FILES) or set(manifest.get('tests', {})) != set(TESTS):
            raise GateError('manifest_file_set_invalid')
        if manifest['release_id'] != release_id(manifest) or not HEX.fullmatch(manifest['release_id']):
            raise GateError('release_id_invalid')
        if manifest['installer_sha256'] != file_hash(__file__) or file_hash(self.stage / INSTALLER) != manifest['installer_sha256']:
            raise GateError('installer_checksum_mismatch')
        if set(manifest['checks']) != set(CHECKS) or any(value is not True for value in manifest['checks'].values()):
            raise GateError('completed_checks_required')
        allowed = set(FILES) | set(TESTS) | {INSTALLER,'manifest.json'}
        if {p.name for p in self.stage.iterdir()} != allowed or any(p.is_dir() or p.is_symlink() for p in self.stage.iterdir()):
            raise GateError('stage_contains_unlisted_paths')
        for key, names in [('files',FILES),('tests',TESTS)]:
            for name in names:
                if not isinstance(manifest[key][name], str) or not HEX.fullmatch(manifest[key][name]) or file_hash(self.stage / name) != manifest[key][name]:
                    raise GateError('staged_checksum_mismatch')
                compile((self.stage / name).read_bytes(), name, 'exec')
        for name, expected in manifest['baseline'].items():
            if not (isinstance(expected, str) and HEX.fullmatch(expected)) and not (name in NEW and expected is None):
                raise GateError('baseline_hash_invalid')
        if source_snapshot(self.live) != manifest['baseline']: raise GateError('live_source_drift_requires_review')
        if protected_snapshot(self.args) != manifest['protected']: raise GateError('protected_configuration_drift_requires_review')
        self.manifest = manifest; self.backup = safe_path(Path(self.args.backup_root) / manifest['release_id'])
        if self.backup.exists(): raise GateError('release_already_attempted')
        return manifest

    def idle(self):
        counts = pending_work(self.args.state_dir)
        if any(counts.values()): raise GateError('pending_meeting_or_external_work')
        return counts

    def healthy(self, token, before, *, upgraded):
        deadline = time.monotonic() + 20
        while True:
            try:
                after = self.health(token)
                if health_matches(before,after,upgraded=upgraded): return after
            except Exception: pass
            if time.monotonic() >= deadline: raise GateError('health_flags_not_preserved')
            time.sleep(.5)

    def capture_backup(self):
        self.backup.mkdir(mode=0o700, parents=True, exist_ok=False)
        ref = (self.live / 'local_backend.py').stat()
        for name in FILES:
            path = self.live / name
            self.old[name] = path.read_bytes() if path.exists() else None
            entry = path.stat() if path.exists() else ref
            self.attrs[name] = dict(mode=stat.S_IMODE(entry.st_mode), uid=entry.st_uid, gid=entry.st_gid)
            self.new[name] = (self.stage / name).read_bytes()
            if self.old[name] is not None: atomic_write(self.backup / name, self.old[name], 0o600, new=True)
        for path in configuration_paths(self.args):
            raw = path.read_bytes() if path.exists() else None
            entry = path.stat() if path.exists() else None
            self.config[str(path.absolute())] = dict(raw=raw, attrs=None if entry is None else dict(mode=stat.S_IMODE(entry.st_mode),uid=entry.st_uid,gid=entry.st_gid))
            if raw is not None:
                target = self.backup / 'config' / str(path.absolute()).lstrip('/')
                target.parent.mkdir(mode=0o700,parents=True,exist_ok=True);atomic_write(target,raw,0o600,new=True)
        if source_snapshot(self.live) != self.manifest['baseline'] or protected_snapshot(self.args) != self.manifest['protected']:
            raise GateError('source_or_configuration_changed_during_backup')
        self.report('backed_up')
        atomic_write(self.backup / 'fake-tests.log', self.test_output, 0o600, new=True)

    def report(self, status):
        value = dict(schema=1,status=status,release_id=self.manifest['release_id'],sources=self.manifest['files'],baseline=self.manifest['baseline'],protected_hashes=self.manifest['protected'])
        atomic_write(self.backup / 'result.json', (json.dumps(value,indent=2)+'\n').encode(),0o600)

    def rollback(self, changed, token, before):
        self.command('systemctl','stop',self.args.service)
        # Do not clobber an unrelated operator's edit to either code or config.
        if protected_snapshot(self.args) != self.manifest['protected']: raise GateError('rollback_configuration_concurrent_change')
        for name in reversed(changed):
            path = self.live/name
            current = file_hash(path)
            if current == self.manifest['baseline'][name]: continue
            if current != self.manifest['files'][name]: raise GateError('rollback_source_concurrent_change')
            if self.old[name] is None: path.unlink()
            else: atomic_write(path,self.old[name],**self.attrs[name])
        # Exact configuration snapshots are restored; the tool never creates a new drop-in.
        for filename,entry in self.config.items():
            if entry['raw'] is not None: atomic_write(Path(filename),entry['raw'],**entry['attrs'])
        if source_snapshot(self.live) != self.manifest['baseline'] or protected_snapshot(self.args) != self.manifest['protected']:
            raise GateError('rollback_hash_mismatch')
        self.command('systemctl','daemon-reload');self.command('systemctl','start',self.args.service)
        self.healthy(token,before,upgraded=False);self.report('rolled_back')

    def install(self):
        self.validate()
        if self.command('systemctl','show',self.args.service,'-p','User','--value') != 'oops': raise GateError('service_must_run_as_oops')
        if self.command('systemctl','is-active',self.args.service) != 'active': raise GateError('backend_must_be_active')
        self.idle();self.tests();self.validate();self.idle()
        token = self.token();before = self.health(token)
        if before.get('status') != 'ok': raise GateError('backend_unhealthy')
        if before.get('feishu_bot') is not True: raise GateError('existing_feishu_bot_must_remain_enabled')
        if not self.args.apply: return dict(status='preflight_passed',source_files=5,protected_unchanged=True,external_requests=0)
        self.capture_backup();changed=[];stopped=False
        try:
            stopped=True;self.command('systemctl','stop',self.args.service)
            if self.command('systemctl','show',self.args.service,'-p','ActiveState','--value') not in ('inactive','failed'):
                raise GateError('backend_did_not_stop')
            if source_snapshot(self.live) != self.manifest['baseline'] or protected_snapshot(self.args) != self.manifest['protected']:
                raise GateError('source_or_configuration_changed_before_replace')
            self.idle()
            for name in FILES:
                changed.append(name);atomic_write(self.live/name,self.new[name],**self.attrs[name],new=self.old[name] is None)
            if source_snapshot(self.live) != self.manifest['files']: raise GateError('installed_hash_mismatch')
            self.command('systemctl','start',self.args.service);stopped=False
            self.healthy(token,before,upgraded=True)
            if self.command('systemctl','show',self.args.service,'-p','User','--value') != 'oops': raise GateError('runtime_user_changed')
            if protected_snapshot(self.args) != self.manifest['protected']: raise GateError('protected_state_changed')
            self.idle();self.report('installed_verified')
            return dict(status='installed_verified',source_files=5,protected_unchanged=True,existing_health_flags_preserved=True,new_capabilities=CAPABILITIES,external_requests=0)
        except BaseException:
            try:
                if changed or stopped: self.rollback(changed,token,before)
                else: self.report('failed_before_source_change')
            except BaseException:
                self.report('rollback_requires_attention');raise GateError('rollback_failed_service_requires_attention') from None
            raise GateError('upgrade_failed_source_config_restored') from None


@contextmanager
def deployment_lock(path):
    import fcntl
    path=safe_path(path)
    fd=os.open(path,os.O_RDWR|os.O_CREAT|getattr(os,'O_NOFOLLOW',0),0o600)
    try:
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);yield
    finally:os.close(fd)


def arguments(argv=None):
    parser=argparse.ArgumentParser(description=__doc__,formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('target',nargs='+');parser.add_argument('--baseline');parser.add_argument('--checks');parser.add_argument('--apply',action='store_true')
    parser.add_argument('--live-dir',default='/opt/oops/app/scripts');parser.add_argument('--state-dir',default='/var/lib/oops/backend')
    parser.add_argument('--env-file',default='/var/lib/oops/backend.env');parser.add_argument('--jev-env-file',default='/var/lib/oops/jev.env')
    parser.add_argument('--feishu-env-file',default='/etc/oops/feishu-mobile.env')
    parser.add_argument('--unit-file',default='/etc/systemd/system/oops-backend.service');parser.add_argument('--dropin-dir',default='/etc/systemd/system/oops-backend.service.d')
    parser.add_argument('--backup-root',default='/var/backups/oops-feishu-mobile');parser.add_argument('--service',default='oops-backend')
    parser.add_argument('--health-url',default='http://127.0.0.1:8787/healthz');parser.add_argument('--python',default='/opt/oops/venv/bin/python')
    parser.add_argument('--lock-file',default='/run/lock/oops-feishu-mobile-upgrade.lock');return parser.parse_args(argv)


def main(argv=None):
    args=arguments(argv)
    try:
        if args.target[0]=='build':
            if len(args.target)!=2 or not args.baseline or not args.checks:raise GateError('build_arguments_required')
            result=build(args.target[1],args.baseline,args.checks)
        elif args.target==['baseline']:
            if os.geteuid()!=0:raise GateError('server_root_required')
            result=baseline(args)
        else:
            if len(args.target)!=1 or os.geteuid()!=0:raise GateError('server_root_required')
            with deployment_lock(args.lock_file):result=Upgrade(args).install()
        print(json.dumps(result,sort_keys=True))
    except Exception as error:
        print(json.dumps(dict(status='failed',reason=str(error) if isinstance(error,GateError) else type(error).__name__)))
        raise SystemExit(1) from None


if __name__=='__main__':main()
