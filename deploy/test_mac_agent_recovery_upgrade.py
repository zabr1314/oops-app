"""Offline publication-gate tests. All services, queues and files are synthetic."""
import copy
from contextlib import redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import plistlib
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('mac_recovery_upgrade', Path(__file__).with_name('mac-agent-recovery-upgrade.py'))
gate = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = gate
SPEC.loader.exec_module(gate)

CANDIDATE = b'''import os
def inside(path, name):
    return os.path.isfile(os.path.join(path, name))
def clean_old(now=None):
    for name in os.listdir(WORK):
        path = os.path.join(WORK, name)
        if not inside(path, 'accepted.json'):
            continue
        remove_old(path)
'''


class FakeSystem:
    def __init__(self, paths):
        self.p = paths
        self.pid = 100
        self.started = {100: 'original-start'}
        self.rows = {100: dict(parent=1, start='original-start', agent=True)}
        self.report = dict(schema=1, source_sha256='c' * 64, legacy_closed=True,
                           queue_sha256='d' * 64, jobs=2, pending=0, active_meetings=0, pending_questions=0)
        self.calls, self.hooks, self.probes = [], {}, 0

    def remote(self):
        self.probes += 1
        callback = self.hooks.get('probe' + str(self.probes))
        if callback:
            callback()
        return copy.deepcopy(self.report)

    def service_state(self):
        return self.pid

    def processes(self):
        return copy.deepcopy(self.rows)

    def stop(self):
        self.calls.append('stop')
        self.pid = None
        self.rows = {}
        if callback := self.hooks.get('stop'):
            callback()

    def start(self):
        self.calls.append('start')
        if callback := self.hooks.get('before_start'):
            callback()
        self.pid = 200 if 200 not in self.started else 300
        self.started[self.pid] = 'started-' + str(self.pid)
        self.rows = {self.pid: dict(parent=1, start=self.started[self.pid], agent=True)}
        if callback := self.hooks.get('start'):
            callback()

    def wait(self):
        if callback := self.hooks.pop('wait', None):
            callback()


class UpgradeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name).resolve()
        self.p = gate.Paths(installed=root/'agent/oops_mac_agent.py', config=root/'agent/config.json',
                            jobs=root/'jobs', plist=root/'launch.plist', candidate=root/'candidate.py')
        self.p.installed.parent.mkdir(mode=0o700)
        self.p.jobs.mkdir()
        self.old = b'old-source\n'
        self.p.installed.write_bytes(self.old)
        self.p.candidate.write_bytes(CANDIDATE)
        self.p.config.write_bytes(b'{"token":"SECRET_NEVER_PRINT","server":"not-contacted"}')
        self.p.config.chmod(0o600)
        (self.p.installed.parent/'oops_slides.py').write_bytes(b'untouched-helper')
        self.p.plist.write_bytes(plistlib.dumps(dict(Label=gate.LABEL,
            ProgramArguments=[gate.PYTHON, '-u', str(self.p.installed)], EnvironmentVariables={'PATH':'/bin'},
            KeepAlive=True, RunAtLoad=True)))
        legacy = self.p.jobs/'old-legacy'
        legacy.mkdir()
        (legacy/'result.md').write_bytes(b'original meeting result\x00\xff')
        os.utime(legacy, (1, 1))  # legacy contents must survive regardless of age
        self.original_jobs = gate.tree(self.p.jobs)
        self.original_config = self.p.config.read_bytes()
        self.sys = FakeSystem(self.p)

    def upgrade(self):
        return gate.Upgrade(self.p, self.sys, gate.digest(self.old), gate.digest(CANDIDATE), 'c'*64, now=1800000000)

    def assert_preserved(self):
        self.assertEqual(gate.tree(self.p.jobs), self.original_jobs)
        self.assertEqual(self.p.config.read_bytes(), self.original_config)
        self.assertEqual(stat.S_IMODE(self.p.config.stat().st_mode), 0o600)

    def test_default_preflight_is_readonly(self):
        before = gate.tree(Path(self.tmp.name).resolve())
        result = self.upgrade().install()
        self.assertEqual(result['status'], 'preflight_passed')
        self.assertEqual(self.sys.calls, [])
        self.assertEqual(gate.tree(Path(self.tmp.name).resolve()), before)
        self.assertNotIn('SECRET', json.dumps(result))

    def test_running_idle_upgrade_stops_and_starts_paused_then_restores_state(self):
        def paused_at_start():
            self.assertTrue(self.p.pause.is_file())
            self.assertEqual(self.p.installed.read_bytes(), CANDIDATE)
        self.sys.hooks['before_start'] = paused_at_start
        result = self.upgrade().install(True)
        self.assertEqual(result['status'], 'source_upgraded')
        self.assertFalse(result['paused'])
        self.assertFalse(self.p.pause.exists())
        self.assertEqual(self.sys.calls, ['stop','start'])
        self.assertEqual(Path(result['backup_source']).read_bytes(), self.old)
        self.assertEqual(stat.S_IMODE(Path(result['backup_source']).stat().st_mode), 0o600)
        self.assert_preserved()

    def test_original_pause_bytes_remain_unchanged(self):
        self.p.pause.write_bytes(b'user private pause reason')
        self.p.pause.chmod(0o600)
        result = self.upgrade().install(True)
        self.assertTrue(result['paused'])
        self.assertEqual(self.p.pause.read_bytes(), b'user private pause reason')
        self.assert_preserved()

    def test_queue_active_meeting_and_questions_refuse_before_stop(self):
        for key in ('pending', 'active_meetings', 'pending_questions'):
            with self.subTest(key=key):
                self.sys.report[key] = 1
                with self.assertRaisesRegex(gate.GateError, 'server_work_pending'):
                    self.upgrade().install(True)
                self.sys.report[key] = 0
        self.assertEqual(self.sys.calls, [])
        self.assertFalse(self.p.backups.exists())

    def test_wrong_source_or_reopened_legacy_guard_refuses(self):
        for key, value in [('source_sha256','f'*64), ('legacy_closed',False)]:
            before = self.sys.report[key]
            self.sys.report[key] = value
            with self.assertRaisesRegex(gate.GateError, 'server_reviewed_source'):
                self.upgrade().install(True)
            self.sys.report[key] = before

    def test_local_child_or_second_agent_refuses(self):
        for row in [dict(parent=100,start='child',agent=False), dict(parent=1,start='parallel',agent=True)]:
            self.sys.rows[101] = row
            with self.assertRaises(gate.GateError):
                self.upgrade().install(True)
        self.assertEqual(self.sys.calls, [])

    def test_unknown_local_generation_or_transfer_refuses(self):
        folder = self.p.jobs/'interrupted'
        folder.mkdir()
        for name in ('generation-started.json','generated.json','transfer.json'):
            marker = folder/name
            marker.write_bytes(b'{}')
            with self.assertRaisesRegex(gate.GateError, 'local_unacknowledged'):
                self.upgrade().install(True)
            marker.unlink()

    def test_acknowledged_old_cleanup_refuses_but_legacy_old_is_preserved(self):
        folder = self.p.jobs/'old-legacy'
        (folder/'accepted.json').write_bytes(b'{}')
        os.utime(folder, (1,1))
        with self.assertRaisesRegex(gate.GateError, 'startup_would_cleanup'):
            self.upgrade().install(True)

    def test_unsafe_cleanup_candidate_refuses(self):
        bad = CANDIDATE.replace(b"if not inside(path, 'accepted.json'):", b"if inside(path, 'generated.json'):")
        self.p.candidate.write_bytes(bad)
        upgrade = gate.Upgrade(self.p,self.sys,gate.digest(self.old),gate.digest(bad),'c'*64)
        with self.assertRaisesRegex(gate.GateError, 'preserve_unacknowledged_legacy'):
            upgrade.install(True)

    def test_config_modes_symlink_and_runtime_override_refuse(self):
        self.p.config.chmod(0o644)
        with self.assertRaisesRegex(gate.GateError,'0600'):
            self.upgrade().install(True)
        self.p.config.chmod(0o600)
        (self.p.jobs/'link').symlink_to(self.p.config)
        with self.assertRaisesRegex(gate.GateError,'symlink'):
            self.upgrade().install(True)
        (self.p.jobs/'link').unlink()
        launch = plistlib.loads(self.p.plist.read_bytes())
        launch['EnvironmentVariables']['OOPS_AGENT_WORK'] = '/different/jobs'
        self.p.plist.write_bytes(plistlib.dumps(launch))
        with self.assertRaisesRegex(gate.GateError,'runtime_path'):
            self.upgrade().install(True)

    def test_installed_or_candidate_hash_drift_refuses(self):
        self.p.installed.write_bytes(b'parallel')
        with self.assertRaisesRegex(gate.GateError,'installed_source_hash'):
            self.upgrade().install(True)
        self.p.installed.write_bytes(self.old)
        self.p.candidate.write_bytes(b'changed candidate')
        with self.assertRaisesRegex(gate.GateError,'candidate_source_hash'):
            self.upgrade().install(True)

    def test_jobs_change_after_stop_never_restores_jobs(self):
        new = self.p.jobs/'new.txt'
        self.sys.hooks['stop'] = lambda:new.write_bytes(b'concurrent user bytes')
        result = self.upgrade().install(True)
        self.assertEqual(result['status'],'failed')
        self.assertEqual(result['rollback'],'source_and_original_service_restored')
        self.assertEqual(new.read_bytes(),b'concurrent user bytes')
        self.assertEqual(self.p.installed.read_bytes(),self.old)
        self.assertEqual(self.sys.calls,['stop','start'])
        self.assertFalse(self.p.pause.exists())

    def test_queue_change_after_stop_restores_original_service(self):
        self.sys.hooks['stop'] = lambda:self.sys.report.update(queue_sha256='e'*64)
        result = self.upgrade().install(True)
        self.assertEqual(result['status'],'failed')
        self.assertEqual(result['reason'],'parallel_server_queue_change')
        self.assertEqual(result['rollback'],'source_and_original_service_restored')
        self.assertEqual(self.p.installed.read_bytes(),self.old)
        self.assert_preserved()

    def test_post_start_drift_rolls_back_source_not_config(self):
        self.sys.hooks['start'] = lambda:self.p.config.write_bytes(b'new-private-config')
        result = self.upgrade().install(True)
        self.assertEqual(result['status'],'failed')
        self.assertEqual(result['rollback'],'source_and_original_service_restored')
        self.assertEqual(self.p.installed.read_bytes(),self.old)
        self.assertEqual(self.p.config.read_bytes(),b'new-private-config')
        self.assertEqual(gate.tree(self.p.jobs),self.original_jobs)

    def test_parallel_source_edit_is_never_overwritten(self):
        self.sys.hooks['start'] = lambda:self.p.installed.write_bytes(b'parallel user source')
        result = self.upgrade().install(True)
        self.assertEqual(result['rollback'],'manual_review_parallel_source')
        self.assertEqual(self.p.installed.read_bytes(),b'parallel user source')
        self.assertTrue(self.p.pause.exists())
        self.assert_preserved()

    def test_parallel_service_replacement_is_never_stopped(self):
        def replace_on_wait():
            self.sys.pid = 999
            self.sys.rows = {999:dict(parent=1,start='other-service',agent=True)}
        def on_start():
            self.sys.hooks['wait'] = replace_on_wait
        self.sys.hooks['start'] = on_start
        result = self.upgrade().install(True)
        self.assertEqual(result['rollback'],'manual_review_parallel_service')
        self.assertEqual(self.sys.pid,999)
        self.assertEqual(self.sys.calls,['stop','start'])

    def test_start_failure_restores_source_and_original_service(self):
        attempts = []
        def fail_once():
            attempts.append(1)
            if len(attempts)==1:
                raise gate.GateError('service_start_failed')
        self.sys.hooks['before_start'] = fail_once
        result = self.upgrade().install(True)
        self.assertEqual(result['rollback'],'source_and_original_service_restored')
        self.assertEqual(self.p.installed.read_bytes(),self.old)
        self.assert_preserved()

    def test_stop_error_after_actual_exit_still_restores_original_service(self):
        def fail_after_stop():
            raise gate.GateError('normal_service_stop_failed')
        self.sys.hooks['stop'] = fail_after_stop
        result = self.upgrade().install(True)
        self.assertEqual(result['rollback'],'source_and_original_service_restored')
        self.assertEqual(self.sys.calls,['stop','start'])
        self.assertEqual(self.p.installed.read_bytes(),self.old)
        self.assert_preserved()

    def test_pause_parallel_edit_retained_and_not_deleted(self):
        self.sys.hooks['start'] = lambda:self.p.pause.write_bytes(b'user changed pause')
        result = self.upgrade().install(True)
        self.assertEqual(result['status'],'failed')
        self.assertEqual(self.p.pause.read_bytes(),b'user changed pause')

    def test_remote_command_is_readonly_strict_and_does_not_use_poll(self):
        system = gate.System(self.p,'reviewed-host')
        calls = []
        def run(args,**kwargs):
            calls.append((args,kwargs))
            return type('Reply',(),dict(returncode=0,stdout=json.dumps(self.sys.report).encode()))()
        system.run = run
        self.assertEqual(system.remote(),self.sys.report)
        self.assertIn('StrictHostKeyChecking=yes',calls[0][0])
        self.assertIn('BatchMode=yes',calls[0][0])
        code = calls[0][1]['data'].decode()
        self.assertNotIn('/v1/agent/poll',code)
        self.assertNotIn('config.json',code)
        self.assertNotIn('urllib',code)
        self.assertNotIn('subprocess',code)
        with self.assertRaises(gate.GateError):
            gate.System(self.p,'-oProxyCommand=anything')

    def probe_fixture(self, *, job=None, meeting=None, questions=None, closed=True):
        root = self.p.jobs.parent/'remote'
        root.mkdir(exist_ok=True)
        (root/'agent-jobs').mkdir(exist_ok=True)
        (root/'meetings').mkdir(exist_ok=True)
        (root/'feishu').mkdir(exist_ok=True)
        source = root/'feishu_actions.py'
        source.write_text('class FeishuActions:\n    def hand_to_mac(self):\n        '+
                          ('raise ValueError()' if closed else 'return 1')+'\n')
        if job is not None:
            (root/'agent-jobs'/('a'*32+'.json')).write_text(json.dumps(job))
        if meeting is not None:
            (root/'meetings/m.json').write_text(json.dumps(meeting))
        (root/'feishu/state.json').write_text(json.dumps(dict(questions=questions or {})))
        code = gate.REMOTE_PROBE.replace("'/opt/oops/app/scripts/feishu_actions.py'",repr(str(source)))\
                                .replace("'/var/lib/oops/backend'",repr(str(root)))
        output = io.StringIO()
        with redirect_stdout(output):
            try:
                exec(compile(code,'<offline-readonly-probe>','exec'),{})
            except SystemExit:
                pass
        return json.loads(output.getvalue())

    def test_remote_probe_reads_terminal_queue_and_tracks_meeting_state_changes(self):
        result = self.probe_fixture(job=dict(status='done',generation_status='ready'),
                                    meeting=dict(ended_at='2026-01-01T00:00:00Z'))
        self.assertTrue(result['legacy_closed'])
        self.assertEqual(result['pending'],0)
        self.assertEqual(result['active_meetings'],0)
        changed = self.probe_fixture(job=dict(status='done',generation_status='ready'),
            meeting=dict(ended_at='2026-01-01T00:00:00Z',display_title='changed'))
        self.assertNotEqual(result['queue_sha256'],changed['queue_sha256'])

    def test_remote_probe_rejects_unresolved_status_and_counts_unscanned_questions(self):
        for state in ('queued','running','awaiting_upload','generation_unknown','delivering','unknown'):
            result = self.probe_fixture(job=dict(status=state),meeting=dict(started_at='2099-01-01T00:00:00Z'),
                                        questions=dict(m=dict(u=dict(status='wait'))))
            self.assertGreater(result['pending'],0)
            self.assertEqual(result['active_meetings'],1)
            self.assertEqual(result['pending_questions'],1)
        result = self.probe_fixture(job=dict(status='done',generation_status='ready_locally'))
        self.assertGreater(result['pending'],0)
        self.assertFalse(self.probe_fixture(closed=False)['legacy_closed'])

    def test_remote_probe_symlink_and_bad_json_never_echo_contents(self):
        self.probe_fixture()
        target = self.p.jobs.parent/'remote/agent-jobs'/('b'*32+'.json')
        target.write_text('SECRET_NEVER_PRINT')
        result = self.probe_fixture()
        self.assertEqual(result,dict(error='remote_json_invalid'))
        target.unlink()
        target.symlink_to(self.p.config)
        self.assertEqual(self.probe_fixture(),dict(error='remote_queue_special_file'))

    def test_cli_errors_never_expose_exception_contents(self):
        # Unexpected errors become type names; even provider/OS messages stay private.
        with patch.object(gate.sys,'platform','darwin'),patch.object(gate.os,'getuid',return_value=501),\
                patch.object(gate.Path,'home',return_value=Path('/Users/a1234')),\
                patch.object(gate.Upgrade,'install',side_effect=OSError('SECRET_NEVER_PRINT')),\
                patch('builtins.print') as printed:
            result = gate.main(['--server-host','host','--server-source-sha256','c'*64,'--candidate-sha256','b'*64])
        self.assertEqual(result,1)
        self.assertNotIn('SECRET',str(printed.call_args))


if __name__ == '__main__':
    unittest.main()
