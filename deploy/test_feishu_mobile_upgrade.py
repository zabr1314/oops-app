"""Temporary-files deployment gates; never call a service, provider, network or production path."""
import datetime as dt
import importlib.util
import json
from pathlib import Path
import shutil
import socket
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('feishu_mobile_upgrade',Path(__file__).with_name('feishu-mobile-upgrade.py'))
u=importlib.util.module_from_spec(spec);spec.loader.exec_module(u)


class UpgradeTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name).resolve()
        self.stage=self.root/'stage';self.live=self.root/'live';self.state=self.root/'state';self.dropins=self.root/'dropins'
        for folder in [self.stage,self.live,self.state,self.dropins]:folder.mkdir()
        for folder in ['feishu','meetings','operations','agent-jobs','archive-policies','mobile-feishu/deliveries']:(self.state/folder).mkdir(parents=True)
        self.now=dt.datetime.now(dt.timezone.utc)
        (self.state/'feishu/state.json').write_text(json.dumps({'since':(self.now-dt.timedelta(days=1)).isoformat(),'meetings':{}}))
        for name in ['people.json','voiceprints.json']:(self.state/name).write_text('{"synthetic":"keep"}')
        (self.state/'archive-policies/old.json').write_text('{"synthetic_policy":true}')
        for name in ['backend.env','jev.env','feishu.env','unit.service']:(self.root/name).write_text('synthetic-private-value-never-print\n')
        (self.dropins/'safe.conf').write_text('[Service]\nUser=oops\n')
        self.args=SimpleNamespace(target=[str(self.stage)],live_dir=str(self.live),state_dir=str(self.state),env_file=str(self.root/'backend.env'),jev_env_file=str(self.root/'jev.env'),feishu_env_file=str(self.root/'feishu.env'),unit_file=str(self.root/'unit.service'),dropin_dir=str(self.dropins),backup_root=str(self.root/'backups'),service='oops-backend',health_url='http://127.0.0.1:8787/healthz',python='/usr/bin/python3',apply=True)
        for name in u.FILES:
            (self.stage/name).write_text('VERSION = 2\n')
            if name not in u.NEW:(self.live/name).write_text('VERSION = 1\n')
        for name in u.TESTS:(self.stage/name).write_text('pass\n')
        shutil.copyfile(u.__file__,self.stage/u.INSTALLER)
        self.manifest=dict(schema=1,files={name:u.file_hash(self.stage/name) for name in u.FILES},baseline=u.source_snapshot(self.live),protected=u.protected_snapshot(self.args),tests={name:u.file_hash(self.stage/name) for name in u.TESTS},checks={key:True for key in u.CHECKS},installer_sha256=u.file_hash(u.__file__))
        self.save_manifest();self.commands=[];self.status='active';self.test_runs=0;self.failure=None
        self.guard=patch.object(socket.socket,'connect',side_effect=AssertionError('network forbidden in deployment tests'));self.guard.start()

    def tearDown(self):self.guard.stop();self.temp.cleanup()

    def save_manifest(self):
        self.manifest['release_id']=u.release_id(self.manifest)
        (self.stage/'manifest.json').write_text(json.dumps(self.manifest))

    def command(self,*parts):
        self.commands.append(parts)
        if parts[1]=='show' and parts[4]=='User':return 'oops'
        if parts[1]=='show' and parts[4]=='ActiveState':return self.status
        if parts[1]=='is-active':return self.status
        if parts[1]=='stop':self.status='inactive'
        if parts[1]=='start':self.status='active'
        return ''

    def health(self,token):
        before=dict(status='ok',jev=True,strict_a_enabled=False,archive_policy_version=1,action_source_binding_version=1,feishu_bot=True)
        if u.source_snapshot(self.live)==self.manifest['files']:
            before.update(u.CAPABILITIES)
            if self.failure=='health':before['strict_a_enabled']=True
        return before

    def run_fake_tests(self):self.test_runs+=1

    def installer(self):
        parent=self
        class Immediate(u.Upgrade):
            def healthy(self,token,before,*,upgraded):
                result=self.health(token)
                if not u.health_matches(before,result,upgraded=upgraded):raise u.GateError('health_flags_not_preserved')
                return result
        return Immediate(self.args,command=self.command,health=self.health,token=lambda:'synthetic-token-never-output',tests=self.run_fake_tests)

    def test_exact_install_preserves_unlisted_source_and_private_configuration(self):
        (self.live/'unrelated.py').write_text('USER_WIP = True\n')
        before=u.protected_snapshot(self.args);result=self.installer().install()
        self.assertEqual('installed_verified',result['status']);self.assertEqual(before,u.protected_snapshot(self.args))
        self.assertEqual('USER_WIP = True\n',(self.live/'unrelated.py').read_text())
        self.assertEqual(self.manifest['files'],u.source_snapshot(self.live));self.assertEqual(1,self.test_runs)
        backup=self.root/'backups'/self.manifest['release_id']
        self.assertEqual(0o700,backup.stat().st_mode&0o777)
        self.assertNotIn('synthetic-private',(backup/'result.json').read_text())
        self.assertNotIn('synthetic-token',(backup/'result.json').read_text())
        self.assertTrue(any((backup/'config').rglob('safe.conf')))

    def test_dry_run_never_stops_or_replaces(self):
        self.args.apply=False;before=u.source_snapshot(self.live)
        self.assertEqual('preflight_passed',self.installer().install()['status'])
        self.assertEqual(before,u.source_snapshot(self.live));self.assertFalse(any(c[1] in ['stop','start','restart'] for c in self.commands))
        self.assertFalse((self.root/'backups').exists())

    def test_source_and_configuration_drift_refused_before_services(self):
        for path in [self.live/'local_backend.py',self.root/'backend.env',self.root/'feishu.env',self.state/'people.json',self.state/'archive-policies/old.json',self.dropins/'safe.conf']:
            old=path.read_bytes();path.write_bytes(old+b'changed\n')
            with self.assertRaises(u.GateError):self.installer().install()
            path.write_bytes(old)
        self.assertEqual([],self.commands)

    def test_extra_release_files_tampered_code_and_symlinks_are_refused(self):
        extra=self.stage/'unlisted.py';extra.write_text('pass')
        with self.assertRaisesRegex(u.GateError,'unlisted'):self.installer().install()
        extra.unlink();target=self.stage/'feishu_accounts.py';target.write_text('VERSION = 3\n')
        with self.assertRaisesRegex(u.GateError,'checksum'):self.installer().install()
        target.unlink();target.symlink_to(self.live/'local_backend.py')
        with self.assertRaises(u.GateError):self.installer().install()
        self.assertEqual([],self.commands)

    def test_repeat_stage_is_refused_even_after_success(self):
        self.installer().install()
        # Even if someone restores the old sources, the release attempt marker remains.
        for name,sha in self.manifest['baseline'].items():
            path=self.live/name
            if sha is None:path.unlink()
            else:path.write_text('VERSION = 1\n')
        with self.assertRaisesRegex(u.GateError,'already_attempted'):self.installer().install()

    def test_pending_new_meeting_jobs_external_operations_and_delivery_are_detected(self):
        row={'session_id':'new','started_at':(self.now-dt.timedelta(minutes=5)).isoformat(),'last_sync_at':self.now.isoformat(),'utterances':[]}
        (self.state/'meetings/new.json').write_text(json.dumps(row))
        (self.state/'operations/op.json').write_text('{"status":"unknown"}')
        (self.state/'agent-jobs/job.json').write_text('{"status":"running"}')
        (self.state/'mobile-feishu/deliveries/a.json').write_text('{"operations":{"a":{"status":"partial"}}}')
        pending=u.pending_work(self.state,self.now)
        self.assertEqual((1,1,1,1),(pending['active_meetings'],pending['operations'],pending['jobs'],pending['deliveries']))
        with self.assertRaisesRegex(u.GateError,'pending_meeting'):self.installer().install()
        self.assertFalse(any(c[1]=='stop' for c in self.commands))

    def test_ended_and_idle_inferred_new_meetings_block_paid_work_restart(self):
        row={'session_id':'new','started_at':(self.now-dt.timedelta(hours=1)).isoformat(),'last_sync_at':(self.now-dt.timedelta(minutes=30)).isoformat(),'utterances':[{'end_ms':1000}]*5}
        (self.state/'meetings/new.json').write_text(json.dumps(row))
        self.assertEqual(1,u.pending_work(self.state,self.now)['minutes'])
        row['ended_at']=(self.now-dt.timedelta(minutes=10)).isoformat();(self.state/'meetings/new.json').write_text(json.dumps(row))
        self.assertEqual(1,u.pending_work(self.state,self.now)['minutes'])

    def test_failure_restores_only_five_sources_and_exact_env_dropins_then_restarts(self):
        before=u.source_snapshot(self.live);protected=u.protected_snapshot(self.args);self.failure='health'
        with self.assertRaisesRegex(u.GateError,'source_config_restored'):self.installer().install()
        self.assertEqual(before,u.source_snapshot(self.live));self.assertEqual(protected,u.protected_snapshot(self.args));self.assertEqual('active',self.status)
        self.assertTrue(any(c[1]=='daemon-reload' for c in self.commands))
        self.assertEqual('rolled_back',json.loads((self.root/'backups'/self.manifest['release_id']/'result.json').read_text())['status'])

    def test_rollback_never_deletes_new_oauth_principal_data(self):
        installer=self.installer();old_health=installer.health
        def changed_health(token):
            result=old_health(token)
            if u.source_snapshot(self.live)==self.manifest['files']:
                (self.state/'mobile-feishu/accounts.json').write_text('{"synthetic_principal":"preserve"}')
                result['strict_a_enabled']=True
            return result
        installer.health=changed_health
        with self.assertRaisesRegex(u.GateError,'source_config_restored'):installer.install()
        self.assertEqual('{"synthetic_principal":"preserve"}',(self.state/'mobile-feishu/accounts.json').read_text())

    def test_turning_off_existing_bot_cannot_bypass_paid_work_gate(self):
        installer=self.installer();installer.health=lambda token:dict(status='ok',feishu_bot=False)
        with self.assertRaisesRegex(u.GateError,'bot_must_remain_enabled'):installer.install()
        self.assertFalse(any(c[1]=='stop' for c in self.commands))

    def test_publish_error_after_replace_is_still_rolled_back(self):
        original=u.atomic_write;fired=[False]
        def fail_after(path,raw,*args,**kwargs):
            original(path,raw,*args,**kwargs)
            if Path(path)==self.live/'feishu_accounts.py' and not fired[0]:fired[0]=True;raise OSError('synthetic publish failure')
        with patch.object(u,'atomic_write',side_effect=fail_after),self.assertRaisesRegex(u.GateError,'source_config_restored'):self.installer().install()
        self.assertEqual(self.manifest['baseline'],u.source_snapshot(self.live));self.assertEqual('active',self.status)

    def test_concurrent_configuration_edit_is_not_overwritten_by_rollback(self):
        original=u.atomic_write;fired=[False]
        def edit_and_fail(path,raw,*args,**kwargs):
            original(path,raw,*args,**kwargs)
            if Path(path)==self.live/'minutes_delivery.py' and not fired[0]:
                fired[0]=True;(self.dropins/'safe.conf').write_text('operator concurrent configuration\n');raise OSError()
        with patch.object(u,'atomic_write',side_effect=edit_and_fail),self.assertRaisesRegex(u.GateError,'requires_attention'):self.installer().install()
        self.assertEqual('operator concurrent configuration\n',(self.dropins/'safe.conf').read_text());self.assertEqual('inactive',self.status)

    def test_health_keeps_all_existing_flags_and_requires_typed_capabilities(self):
        before={'status':'ok','strict_a_enabled':False,'archive_policy_version':1,'jev_stats':{'count':3}}
        after={**before,**u.CAPABILITIES,'jev_stats':{'count':0}}
        self.assertTrue(u.health_matches(before,after,upgraded=True))
        for altered in [{**after,'strict_a_enabled':True},{**after,'feishu_mobile_version':True},{**after,'minutes_delivery_confirmation_required':1},{**after,'unexpected_flag':True}]:
            self.assertFalse(u.health_matches(before,altered,upgraded=True))

    def test_fake_test_runner_has_real_network_namespace_and_oops_drop(self):
        instance=self.installer();del instance.tests
        called=[]
        def fake_run(command,**kwargs):
            called.append((command,kwargs));return SimpleNamespace(returncode=0,stdout=b'ok',stderr=b'')
        with patch.object(u.subprocess,'run',side_effect=fake_run):instance.fake_tests()
        command,kwargs=called[0];self.assertEqual(['unshare','--net','--'],command[:3]);self.assertEqual('oops',command[-1])
        self.assertNotIn('OOPS_API_TOKEN',kwargs['env']);self.assertIn('os.setuid',command[command.index('-c')+1]);self.assertIn('cryptography.fernet',u.TEST_RUNNER)

    def test_fake_failure_and_non_oops_service_block_before_stop(self):
        installer=self.installer()
        installer.tests=lambda: (_ for _ in ()).throw(u.GateError('isolated_fake_regressions_or_crypto_failed'))
        with self.assertRaisesRegex(u.GateError,'crypto_failed'):installer.install()
        self.assertFalse(any(c[1]=='stop' for c in self.commands))
        installer=self.installer();original=installer.command
        installer.command=lambda *parts: 'root' if parts[1]=='show' and parts[4]=='User' else original(*parts)
        with self.assertRaisesRegex(u.GateError,'run_as_oops'):installer.install()
        self.assertFalse(any(c[1]=='stop' for c in self.commands))

    def test_stage_build_pins_current_source_and_refuses_reusing_directory(self):
        baseline=self.root/'baseline.json';baseline.write_text(json.dumps(u.baseline(self.args)))
        checks=self.root/'checks.json';checks.write_text(json.dumps({key:True for key in u.CHECKS}))
        stage=self.root/'fresh-stage'
        result=u.build(stage,baseline,checks)
        self.assertEqual('stage_built',result['status'])
        manifest=json.loads((stage/'manifest.json').read_text())
        root=Path(u.__file__).resolve().parents[1]
        self.assertEqual({name:u.file_hash(root/'scripts'/name) for name in u.FILES},manifest['files'])
        self.assertEqual(set(u.FILES)|set(u.TESTS)|{u.INSTALLER,'manifest.json'},{p.name for p in stage.iterdir()})
        with self.assertRaises(FileExistsError):u.build(stage,baseline,checks)

    def test_default_lock_uses_real_run_lock_and_still_rejects_var_lock_symlink(self):
        args=u.arguments(['synthetic-stage'])
        self.assertEqual('/run/lock/oops-feishu-mobile-upgrade.lock',args.lock_file)
        actual=self.root/args.lock_file.lstrip('/')
        actual.parent.mkdir(parents=True)
        (self.root/'var').mkdir();(self.root/'var/lock').symlink_to(actual.parent,target_is_directory=True)
        with u.deployment_lock(actual):self.assertTrue(actual.is_file())
        with self.assertRaisesRegex(u.GateError,'symlink_requires_review'):
            with u.deployment_lock(self.root/'var/lock/oops-feishu-mobile-upgrade.lock'):pass

    def test_unread_recording_offload_links_do_not_expand_queue_scan(self):
        recordings=self.state/'recordings';recordings.mkdir()
        other=self.root/'offloaded.wav';other.write_bytes(b'synthetic audio never read')
        (recordings/'original.wav').symlink_to(other)
        self.assertFalse(any(u.pending_work(self.state,self.now).values()))
        # Actual queue links still refuse deployment, even when a target is readable.
        target=self.root/'outside-meeting.json';target.write_text('{}')
        (self.state/'meetings/linked.json').symlink_to(target)
        with self.assertRaisesRegex(u.GateError,'symlink_requires_review'):u.pending_work(self.state,self.now)

    def test_guard_does_not_accept_external_or_redirect_health(self):
        self.args.health_url='https://example.org/healthz'
        with self.assertRaisesRegex(u.GateError,'literal_loopback'):self.installer().read_health('synthetic')


if __name__=='__main__':unittest.main()
