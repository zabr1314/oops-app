#!/usr/bin/env python3
"""One-file local Mac agent upgrade. Default: read-only preflight; --apply restarts launchd.

Requires freshly reviewed server/source hashes. No token is parsed or printed,
and no generation, upload or job-poll API is called by this installer. The SSH
probe reads persisted queues only, with host-key verification enabled. During
restart a temporary pause prevents the new process from taking work. All job
bytes, configuration, helper scripts and launchd configuration are preserved.
Only the old Python source is backed up/restored; job trees are never restored.

Example (substitute the reviewed hashes and SSH alias):
 python3 deploy/mac-agent-recovery-upgrade.py --server-host ALIAS \
   --server-source-sha256 HASH --candidate-sha256 HASH [--apply]
"""
import argparse
import ast
from contextlib import contextmanager
from dataclasses import dataclass
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import stat
import subprocess
import sys
import tempfile
import time

LABEL = 'local.oops.mac-agent'
INSTALLED_SHA256 = '7990a1c7baf3b2ba9084db4098140bde9b0c9c5b999efb72c665cfd6955d6cbc'
PYTHON = '/opt/homebrew/opt/python@3.14/bin/python3.14'
HEX = re.compile(r'[a-f0-9]{64}')


class GateError(RuntimeError):
    """Fixed, non-secret reason codes only."""


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def safe(path):
    path = Path(path).absolute()
    if path.is_symlink() or any(p.is_symlink() for p in path.parents):
        raise GateError('symlink_requires_review')
    return path


def record(path):
    path = safe(path)
    before = path.stat()
    if not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or before.st_nlink != 1:
        raise GateError('owned_regular_file_required')
    raw = path.read_bytes()
    after = path.stat()
    if (before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
            after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
        raise GateError('file_changed_during_read')
    return dict(sha256=digest(raw), size=len(raw), mode=stat.S_IMODE(after.st_mode), uid=after.st_uid)


def tree(path):
    """Bounded byte/mode snapshot; no contents or filenames leave the private manifest."""
    base = safe(path)
    if not base.is_dir():
        raise GateError('jobs_directory_required')
    rows, total = {}, 0
    for item in [base, *sorted(base.rglob('*'))]:
        safe(item)
        info = item.stat()
        if info.st_uid != os.getuid():
            raise GateError('job_owner_requires_review')
        name = str(item.relative_to(base))
        if stat.S_ISDIR(info.st_mode):
            rows[name] = dict(kind='dir', mode=stat.S_IMODE(info.st_mode), uid=info.st_uid)
        elif stat.S_ISREG(info.st_mode):
            total += info.st_size
            if total > 8 * 1024**3 or len(rows) > 100000:
                raise GateError('jobs_snapshot_limit_requires_review')
            rows[name] = dict(kind='file', **record(item))
        else:
            raise GateError('job_special_file_requires_review')
    return rows


def local_pending(jobs):
    for folder in safe(jobs).iterdir():
        if not folder.is_dir():
            continue
        if any((folder / name).exists() for name in ('generation-started.json', 'generated.json', 'transfer.json')):
            if not (folder / 'accepted.json').is_file():
                raise GateError('local_unacknowledged_result_or_generation')


def cleanup_safe(candidate, jobs, now):
    """Validate the candidate's preservation contract without importing/running it."""
    try:
        module = ast.parse(candidate)
        clean = next(n for n in module.body if isinstance(n, ast.FunctionDef) and n.name == 'clean_old')
    except (SyntaxError, StopIteration):
        raise GateError('candidate_cleanup_contract_missing') from None
    # The reviewed candidate must skip every old folder lacking accepted.json.
    guards = [n for n in ast.walk(clean) if isinstance(n, ast.If)
              and isinstance(n.test, ast.UnaryOp) and isinstance(n.test.op, ast.Not)
              and isinstance(n.test.operand, ast.Call) and isinstance(n.test.operand.func, ast.Name)
              and n.test.operand.func.id == 'inside' and len(n.test.operand.args) == 2
              and isinstance(n.test.operand.args[1], ast.Constant)
              and n.test.operand.args[1].value == 'accepted.json'
              and len(n.body) == 1 and isinstance(n.body[0], ast.Continue)]
    if not guards:
        raise GateError('candidate_must_preserve_unacknowledged_legacy_directories')
    for folder in safe(jobs).iterdir():
        # Startup still performs cleanup. Preserve acknowledged old folders too;
        # reject this release rather than changing any existing job timestamps.
        if folder.is_dir() and (folder / 'accepted.json').exists() and folder.stat().st_mtime < now - 29 * 86400:
            raise GateError('startup_would_cleanup_existing_job')


def atomic(path, raw, mode, *, new=False):
    path = safe(path)
    fd, temporary = tempfile.mkstemp(prefix='.mac-agent-stage-', dir=path.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'wb') as out:
            out.write(raw); out.flush(); os.fsync(out.fileno())
        if new:
            os.link(temporary, path); os.unlink(temporary)
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


@dataclass
class Paths:
    installed: Path = Path('/Users/a1234/.oops-agent/oops_mac_agent.py')
    config: Path = Path('/Users/a1234/.oops-agent/config.json')
    jobs: Path = Path('/Users/a1234/Oops/jobs')
    plist: Path = Path('/Users/a1234/Library/LaunchAgents/local.oops.mac-agent.plist')
    candidate: Path = Path(__file__).resolve().parents[1] / 'scripts/oops_mac_agent.py'

    @property
    def pause(self):
        return self.installed.parent / 'paused'

    @property
    def backups(self):
        return self.installed.parent / 'source-backups'


# Sent as Python stdin over SSH, never via a shell command containing credentials.
# No application import, token/config read, API call or queue mutation is allowed.
REMOTE_PROBE = r'''
import ast, datetime as dt, hashlib, json, os, pathlib, stat, sys
def fail(code):
    print(json.dumps({'error':code}));sys.exit(1)
def raw(path):
    p=pathlib.Path(path)
    if p.is_symlink() or any(x.is_symlink() for x in p.parents):fail('remote_symlink')
    if not p.is_file() or p.stat().st_size>16000000:fail('remote_file_invalid')
    a=p.stat();data=p.read_bytes();b=p.stat()
    if (a.st_ino,a.st_mtime_ns,a.st_ctime_ns,a.st_size)!=(b.st_ino,b.st_mtime_ns,b.st_ctime_ns,b.st_size):fail('remote_read_race')
    return data
def obj(path):
    try:value=json.loads(raw(path))
    except Exception:fail('remote_json_invalid')
    if not isinstance(value,dict):fail('remote_object_required')
    return value
def ts(value):
    if not value:return None
    try:
        result=dt.datetime.fromisoformat(value.replace('Z','+00:00'))
        if result.tzinfo is None:fail('remote_timestamp_invalid')
        return result
    except Exception:fail('remote_timestamp_invalid')
source=raw('/opt/oops/app/scripts/feishu_actions.py')
try:
    module=ast.parse(source)
    cls=next(n for n in module.body if isinstance(n,ast.ClassDef) and n.name=='FeishuActions')
    method=next(n for n in cls.body if isinstance(n,ast.FunctionDef) and n.name=='hand_to_mac')
    body=[n for n in method.body if not (isinstance(n,ast.Expr) and isinstance(n.value,ast.Constant) and isinstance(n.value.value,str))]
    closed=len(body)==1 and isinstance(body[0],ast.Raise)
except Exception:fail('remote_legacy_guard_unverified')
base=pathlib.Path('/var/lib/oops/backend');jobs=base/'agent-jobs'
if not jobs.is_dir() or jobs.is_symlink():fail('remote_jobs_required')
hashes={};count=0;pending=0;now=dt.datetime.now(dt.timezone.utc)
allowed={'done','failed','cancelled','canceled'}
for p in sorted(jobs.rglob('*')):
    if p.is_symlink() or not (p.is_dir() or p.is_file()):fail('remote_queue_special_file')
    if p.is_file():
        hashes[str(p.relative_to(jobs))]=hashlib.sha256(raw(p)).hexdigest();count+=1
    if count>100000:fail('remote_queue_limit')
    if p.parent==jobs and p.suffix=='.json':
        j=obj(p);state=j.get('status')
        if state not in allowed:pending+=1
        if j.get('generation_status') in ('unknown','running','queued','ready_locally'):pending+=1
        if j.get('delivery_status') in ('pending','working','running','sending','unknown','partial','queued','uploading'):pending+=1
        if j.get('lease_until') and state not in allowed and ts(j['lease_until'])>now:pending+=1
active=0
if not (base/'meetings').is_dir():fail('remote_meetings_required')
for p in sorted((base/'meetings').glob('*.json')):
    hashes['meetings/'+p.name]=hashlib.sha256(raw(p)).hexdigest()
    r=obj(p)
    if r.get('transcript_status')=='expired' or r.get('ended_at'):continue
    seen=ts(r.get('last_sync_at') or r.get('started_at'))
    if seen is None or now-seen<dt.timedelta(minutes=30):active+=1
questions=0
state=obj(base/'feishu/state.json')
hashes['feishu/state.json']=hashlib.sha256(raw(base/'feishu/state.json')).hexdigest()
for group in state.get('questions',{}).values():
    entries=group.values() if isinstance(group,dict) else []
    for entry in entries:
        if isinstance(entry,dict) and entry.get('status') in ('research','wait','pending','running','sending') and not entry.get('final'):questions+=1
print(json.dumps(dict(schema=1,source_sha256=hashlib.sha256(source).hexdigest(),legacy_closed=closed,
    queue_sha256=hashlib.sha256(json.dumps(hashes,sort_keys=True).encode()).hexdigest(),jobs=count,
    pending=pending,active_meetings=active,pending_questions=questions)))
'''


class System:
    def __init__(self, paths, host):
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.@-]{0,200}', host):
            raise GateError('ssh_alias_invalid')
        self.paths, self.host = paths, host
        self.domain = 'gui/' + str(os.getuid())
        self.service = self.domain + '/' + LABEL

    def run(self, args, *, data=None, timeout=30):
        try:
            return subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
        except (OSError, subprocess.TimeoutExpired):
            raise GateError('system_command_failed') from None

    def remote(self):
        result = self.run(['/usr/bin/ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
                           '-o', 'ConnectTimeout=10', '--', self.host, 'python3', '-'], data=REMOTE_PROBE.encode())
        try:
            value = json.loads(result.stdout) if len(result.stdout) <= 4096 else None
        except (ValueError, UnicodeDecodeError):
            value = None
        if result.returncode or not isinstance(value, dict) or value.get('schema') != 1:
            raise GateError('readonly_server_queue_probe_failed')
        return value

    def service_state(self):
        result = self.run(['/bin/launchctl', 'print', self.service])
        if result.returncode:
            # A failing launchctl is not automatically proof that the label is absent.
            if b'Could not find service' in result.stderr or b'Could not find service' in result.stdout:
                return None
            raise GateError('launchd_state_unavailable')
        output = result.stdout.decode('utf-8', 'replace')
        match = re.search(r'^\s*pid = (\d+)\s*$', output, re.M)
        if not match:
            raise GateError('launchd_not_running_requires_review')
        return int(match.group(1))

    def processes(self):
        result = self.run(['/bin/ps', '-axo', 'pid=,ppid=,lstart=,args='])
        if result.returncode:
            raise GateError('process_inventory_unavailable')
        rows = {}
        for line in result.stdout.decode('utf-8', 'replace').splitlines():
            parts = line.strip().split(None, 7)
            if len(parts) != 8:
                raise GateError('process_inventory_invalid')
            try:
                pid, parent = int(parts[0]), int(parts[1])
            except ValueError:
                raise GateError('process_inventory_invalid') from None
            # Raw command lines stay in memory only and never enter reports/manifests.
            rows[pid] = dict(parent=parent, start=' '.join(parts[2:7]),
                             agent=str(self.paths.installed) in parts[7])
        return rows

    def stop(self):
        # bootout sends normal TERM and disables KeepAlive while this upgrade owns the stop.
        result = self.run(['/bin/launchctl', 'bootout', self.service], timeout=40)
        if result.returncode:
            raise GateError('normal_service_stop_failed')

    def start(self):
        result = self.run(['/bin/launchctl', 'bootstrap', self.domain, str(self.paths.plist)])
        if result.returncode:
            raise GateError('service_start_failed')

    def wait(self):
        time.sleep(0.25)


class Upgrade:
    def __init__(self, paths, system, expected_installed, expected_candidate, expected_server, now=None):
        self.p, self.sys = paths, system
        self.expected = (expected_installed, expected_candidate, expected_server)
        if any(not HEX.fullmatch(v or '') for v in self.expected):
            raise GateError('reviewed_sha256_required')
        self.now = time.time() if now is None else now
        self.stopped = self.started = self.replaced = self.created_pause = False
        self.started_pid = None
        self.backup = None

    def protected(self):
        config, plist = record(self.p.config), record(self.p.plist)
        if config['mode'] != 0o600:
            raise GateError('config_must_remain_0600')
        try:
            launch = plistlib.loads(self.p.plist.read_bytes())
        except Exception:
            raise GateError('launchd_plist_invalid') from None
        if (launch.get('Label') != LABEL or launch.get('ProgramArguments') != [PYTHON, '-u', str(self.p.installed)]
                or set(launch.get('EnvironmentVariables', {})) - {'PATH'}):
            raise GateError('launchd_runtime_path_requires_review')
        return dict(config=config, plist=plist, slides=record(self.p.installed.parent / 'oops_slides.py'))

    def remote(self):
        value = self.sys.remote()
        if value.get('source_sha256') != self.expected[2] or value.get('legacy_closed') is not True:
            raise GateError('server_reviewed_source_or_legacy_guard_changed')
        if any(type(value.get(k)) is not int or value[k] != 0 for k in ('pending', 'active_meetings', 'pending_questions')):
            raise GateError('server_work_pending_requires_retry')
        if not HEX.fullmatch(value.get('queue_sha256', '')):
            raise GateError('server_queue_fingerprint_invalid')
        return value

    def idle(self, expected_pid):
        if self.sys.service_state() != expected_pid:
            raise GateError('parallel_launchd_change')
        rows = self.sys.processes()
        agents = {pid for pid, row in rows.items() if row['agent']}
        if agents != ({expected_pid} if expected_pid is not None else set()):
            raise GateError('parallel_or_unmanaged_agent_process')
        if expected_pid is not None:
            if expected_pid not in rows or any(row['parent'] == expected_pid for row in rows.values()):
                raise GateError('local_generation_or_transfer_child_running')
            return rows[expected_pid]['start']
        return None

    def unchanged(self, *, candidate=False, pid=None):
        if self.protected() != self.baseline['protected'] or tree(self.p.jobs) != self.baseline['jobs']:
            raise GateError('parallel_config_helper_or_jobs_change')
        source = record(self.p.installed)
        wanted = self.expected[1] if candidate else self.expected[0]
        if source['sha256'] != wanted or source['mode'] != self.baseline['source']['mode']:
            raise GateError('parallel_source_change')
        if record(self.p.candidate) != self.baseline['candidate']:
            raise GateError('candidate_changed_during_upgrade')
        if self.remote() != self.baseline['remote']:
            raise GateError('parallel_server_queue_change')
        started = self.idle(pid)
        if candidate and pid is not None and started != self.started_start:
            raise GateError('parallel_process_identity_change')

    def preflight(self):
        self.baseline = dict(source=record(self.p.installed), candidate=record(self.p.candidate),
                             protected=self.protected(), jobs=tree(self.p.jobs))
        if self.baseline['source']['sha256'] != self.expected[0]:
            raise GateError('installed_source_hash_mismatch')
        if self.baseline['candidate']['sha256'] != self.expected[1]:
            raise GateError('candidate_source_hash_mismatch')
        local_pending(self.p.jobs)
        cleanup_safe(self.p.candidate.read_bytes(), self.p.jobs, self.now)
        self.pause_before = record(self.p.pause) if self.p.pause.exists() else None
        self.baseline['remote'] = self.remote()
        self.old_pid = self.sys.service_state()
        self.old_start = self.idle(self.old_pid)
        self.unchanged(pid=self.old_pid)
        return dict(status='preflight_passed', installed_sha256=self.expected[0], candidate_sha256=self.expected[1],
                    executor_running=self.old_pid is not None, initially_paused=self.pause_before is not None)

    def pause_unchanged(self):
        expected = self.pause_before or (self.pause_created if self.created_pause else None)
        if expected is None:
            if self.p.pause.exists():
                raise GateError('parallel_pause_change')
        elif not self.p.pause.exists() or record(self.p.pause) != expected:
            raise GateError('parallel_pause_change')

    def wait_state(self, running):
        for _ in range(80):
            pid = self.sys.service_state()
            if (pid is not None) == running:
                try:
                    self.idle(pid)
                    return pid
                except GateError as error:
                    if str(error) not in ('parallel_or_unmanaged_agent_process', 'local_generation_or_transfer_child_running'):
                        raise
            self.sys.wait()
        raise GateError('service_transition_timeout')

    def restore_pause(self):
        self.pause_unchanged()
        if self.created_pause:
            self.p.pause.unlink()
            self.created_pause = False

    def rollback(self):
        """Source only. Never overwrite a job, config, helper or parallel source edit."""
        outcome = 'not_needed'
        if self.started:
            if self.sys.service_state() != self.started_pid or self.idle(self.started_pid) != self.started_start:
                return 'manual_review_parallel_service'
            self.sys.stop(); self.wait_state(False); self.started = False
        if self.replaced:
            if record(self.p.installed)['sha256'] != self.expected[1]:
                return 'manual_review_parallel_source'
            atomic(self.p.installed, self.old_raw, self.baseline['source']['mode'])
            self.replaced = False
            outcome = 'source_restored'
        # Restore the old service while paused first. Job/config drift remains
        # untouched and is reported, never used as a reason to restore a backup.
        if self.stopped and self.old_pid is not None:
            if self.sys.service_state() is not None:
                return 'manual_review_parallel_service'
            self.sys.start(); self.wait_state(True)
            outcome = 'source_and_original_service_restored'
        self.restore_pause()
        return outcome

    def install(self, apply=False):
        result = self.preflight()
        if not apply:
            return result
        try:
            self.old_raw = self.p.installed.read_bytes()
            new_raw = self.p.candidate.read_bytes()
            if digest(self.old_raw) != self.expected[0] or digest(new_raw) != self.expected[1]:
                raise GateError('source_changed_before_stage')
            folder = safe(self.p.backups)
            folder.mkdir(mode=0o700, exist_ok=True)
            if stat.S_IMODE(folder.stat().st_mode) != 0o700:
                raise GateError('private_source_backup_directory_required')
            self.backup = folder / ('oops_mac_agent-' + str(time.time_ns()) + '.py')
            atomic(self.backup, self.old_raw, 0o600, new=True)
            if self.pause_before is None:
                atomic(self.p.pause, b'mac-agent-source-upgrade\n', 0o600, new=True)
                self.created_pause = True
                self.pause_created = record(self.p.pause)
            self.pause_unchanged()
            self.unchanged(pid=self.old_pid)
            if self.old_pid is not None:
                if self.idle(self.old_pid) != self.old_start:
                    raise GateError('parallel_process_identity_change')
                try:
                    self.sys.stop()
                    self.stopped = True
                except Exception:
                    if self.sys.service_state() is None:
                        self.stopped = True
                    raise
                self.wait_state(False)
            self.unchanged(pid=None)
            self.sys.wait()
            self.unchanged(pid=None)
            self.pause_unchanged()
            atomic(self.p.installed, new_raw, self.baseline['source']['mode'])
            self.replaced = True
            self.unchanged(candidate=True, pid=None)
            self.sys.start(); self.started = True
            self.started_pid = self.wait_state(True)
            self.started_start = self.idle(self.started_pid)
            self.unchanged(candidate=True, pid=self.started_pid)
            self.sys.wait()
            self.unchanged(candidate=True, pid=self.started_pid)
            self.restore_pause()
            return dict(status='source_upgraded', executor_running=True, paused=self.pause_before is not None,
                        candidate_sha256=self.expected[1], backup_source=str(self.backup),
                        original_job_bytes_preserved=True, config_mode='0600',
                        note='existing_pause_preserved' if self.pause_before else 'original_unpaused_service_restored')
        except Exception as error:
            reason = str(error) if isinstance(error, GateError) else type(error).__name__
            try:
                rollback = self.rollback()
            except Exception:
                rollback = 'manual_review_rollback_failed_pause_retained'
            return dict(status='failed', reason=reason, rollback=rollback, jobs_restored=False,
                        backup_source=str(self.backup) if self.backup else None)


@contextmanager
def lock(paths):
    path = safe(paths.installed.parent / '.source-upgrade.lock')
    fd = os.open(path, os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        if stat.S_IMODE(os.fstat(fd).st_mode) != 0o600:
            raise GateError('private_upgrade_lock_required')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise GateError('another_source_upgrade_running') from None
        yield
    finally:
        os.close(fd)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--server-host', required=True, help='Reviewed SSH host/alias; strict known-host verification')
    parser.add_argument('--server-source-sha256', required=True, help='Freshly reviewed production feishu_actions.py hash')
    parser.add_argument('--candidate-sha256', required=True)
    parser.add_argument('--installed-sha256', default=INSTALLED_SHA256)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args(argv)
    try:
        if sys.platform != 'darwin' or os.getuid() != 501 or Path.home() != Path('/Users/a1234'):
            raise GateError('only_reviewed_local_mac_account_allowed')
        paths = Paths()
        upgrade = Upgrade(paths, System(paths, args.server_host), args.installed_sha256,
                          args.candidate_sha256, args.server_source_sha256)
        if args.apply:
            with lock(paths):
                result = upgrade.install(True)
        else:
            result = upgrade.install(False)
        print(json.dumps(result, sort_keys=True))
        return 1 if result['status'] == 'failed' else 0
    except Exception as error:
        print(json.dumps(dict(status='failed', reason=str(error) if isinstance(error, GateError) else type(error).__name__)))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
