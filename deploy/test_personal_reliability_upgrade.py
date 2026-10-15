"""Temporary-files deployment gates; never call a service, provider, network or production path."""
import datetime as dt
from contextlib import closing, contextmanager
import importlib.util
import json
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('personal_reliability_upgrade',Path(__file__).with_name('personal-reliability-upgrade.py'))
u=importlib.util.module_from_spec(spec);spec.loader.exec_module(u)


class UpgradeTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name).resolve()
        self.stage=self.root/'stage';self.live=self.root/'live';self.state=self.root/'state';self.dropins=self.root/'dropins'
        for folder in [self.stage,self.live,self.state,self.dropins]:folder.mkdir()
        for folder in ['feishu','meetings','operations','agent-jobs','archive-policies','mobile-feishu/deliveries',
                       'mobile-feishu/calendars','mobile-feishu/assistant-deliveries','mobile-feishu/agent-deliveries',
                       'mobile-feishu/feishu-accounts']:(self.state/folder).mkdir(parents=True)
        self.now=dt.datetime.now(dt.timezone.utc)
        (self.state/'feishu/state.json').write_text(json.dumps({'since':(self.now-dt.timedelta(days=1)).isoformat(),'meetings':{}}))
        for name in ['people.json','voiceprints.json']:(self.state/name).write_text('{"synthetic":"keep"}')
        (self.state/'archive-policies/old.json').write_text('{"synthetic_policy":true}')
        for name in ['backend.env','jev.env','feishu.env','unit.service']:(self.root/name).write_text('synthetic-private-value-never-print\n')
        (self.dropins/'safe.conf').write_text('[Service]\nUser=oops\n')
        self.args=SimpleNamespace(target=[str(self.stage)],live_dir=str(self.live),state_dir=str(self.state),env_file=str(self.root/'backend.env'),jev_env_file=str(self.root/'jev.env'),feishu_env_file=str(self.root/'feishu.env'),unit_file=str(self.root/'unit.service'),dropin_dir=str(self.dropins),backup_root=str(self.root/'backups'),service='oops-backend',health_url='http://127.0.0.1:8787/healthz',python='/usr/bin/python3',apply=True)
        with self.owner_db() as db:
            db.execute(u.OWNER_DDL['owners']);db.execute(u.OWNER_DDL['receipts'])
            db.execute('INSERT INTO owners VALUES (?,?,?)', ('synthetic-meeting','synthetic-principal','synthetic-account'))
            db.execute('INSERT INTO receipts VALUES (?,?,?)', ('synthetic-receipt','synthetic-principal',123.0))
        (self.state/'mobile-feishu/feishu-accounts/accounts.json').write_text('{"encrypted":"synthetic-keep"}')
        for name in u.FILES:
            (self.stage/name).write_text('VERSION = 2\n')
            if name not in u.NEW:(self.live/name).write_text('VERSION = 1\n')
        for name in u.TESTS:(self.stage/name).write_text('pass\n')
        for name in u.TEST_HELPERS:(self.stage/name).write_text('TEST_ONLY = True\n')
        for name in ('asr_review.py','processing_trace.py','recordings.py'):(self.live/name).write_text('PRODUCTION_VERSION = 3\n')
        shutil.copyfile(u.__file__,self.stage/u.INSTALLER)
        self.manifest=dict(schema=2,captured_at=self.now.isoformat(),files={name:u.file_hash(self.stage/name) for name in u.FILES},
            baseline=u.source_snapshot(self.live),preserved=u.preserved_sources(self.live),protected=u.protected_snapshot(self.args),
            owner=u.owner_snapshot(self.args),tests={name:u.file_hash(self.stage/name) for name in u.TESTS},
            test_helpers={name:u.file_hash(self.stage/name) for name in u.TEST_HELPERS},checks={key:True for key in u.CHECKS},installer_sha256=u.file_hash(u.__file__))
        self.save_manifest();self.commands=[];self.status='active';self.test_runs=0;self.failure=None
        self.guard=patch.object(socket.socket,'connect',side_effect=AssertionError('network forbidden in deployment tests'));self.guard.start()

    def tearDown(self):self.guard.stop();self.temp.cleanup()

    @contextmanager
    def owner_db(self):
        db=sqlite3.connect(u.owner_path(self.args))
        try:
            with db:yield db
        finally:db.close()

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
        before=dict(status='ok',jev=True,strict_a_enabled=False,archive_policy_version=1,action_source_binding_version=1,feishu_bot=True,
                    feishu_mobile_version=1,minutes_delivery_confirmation_required=True)
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
        self.manifest['preserved']=u.preserved_sources(self.live);self.save_manifest()
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
        with self.owner_db() as db:
            db.execute('DROP TABLE read_grants');db.execute('DROP TABLE voice_owners')
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

    def test_failure_restores_only_nine_sources_and_keeps_env_dropins_then_restarts(self):
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
        self.assertEqual(set(u.FILES)|set(u.TESTS)|set(u.TEST_HELPERS)|{u.INSTALLER,'manifest.json'},{p.name for p in stage.iterdir()})
        self.assertEqual({name:u.file_hash(root/'scripts'/name) for name in u.TEST_HELPERS},manifest['test_helpers'])
        with self.assertRaises(FileExistsError):u.build(stage,baseline,checks)

    def test_default_lock_uses_real_run_lock_and_still_rejects_var_lock_symlink(self):
        args=u.arguments(['synthetic-stage'])
        self.assertEqual('/run/lock/oops-personal-reliability-upgrade.lock',args.lock_file)
        actual=self.root/args.lock_file.lstrip('/')
        actual.parent.mkdir(parents=True)
        (self.root/'var').mkdir();(self.root/'var/lock').symlink_to(actual.parent,target_is_directory=True)
        with u.deployment_lock(actual):self.assertTrue(actual.is_file())
        with self.assertRaisesRegex(u.GateError,'symlink_requires_review'):
            with u.deployment_lock(self.root/'var/lock/oops-personal-reliability-upgrade.lock'):pass

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

    def test_fresh_actual_production_baseline_is_required_and_schema1_is_refused(self):
        self.manifest['captured_at']=(self.now-dt.timedelta(seconds=u.BASELINE_MAX_AGE+10)).isoformat();self.save_manifest()
        with self.assertRaisesRegex(u.GateError,'fresh_production_baseline'):self.installer().install()
        self.manifest['captured_at']=(self.now+dt.timedelta(minutes=1)).isoformat();self.save_manifest()
        with self.assertRaisesRegex(u.GateError,'fresh_production_baseline'):self.installer().install()
        self.manifest['captured_at']=self.now.isoformat();self.manifest['schema']=1;self.save_manifest()
        with self.assertRaisesRegex(u.GateError,'manifest_file_set'):self.installer().install()
        self.assertEqual([],self.commands)

    def test_preserved_asr_trace_recording_hash_drift_refuses_before_stop(self):
        for name in ('asr_review.py','processing_trace.py','recordings.py'):
            path=self.live/name;old=path.read_bytes();path.write_bytes(old+b'# concurrent production change\n')
            with self.assertRaisesRegex(u.GateError,'preserved_dependency_drift'):self.installer().install()
            path.write_bytes(old)
        self.assertEqual([],self.commands)

    def test_encrypted_account_bytes_and_original_owner_rows_are_protected(self):
        account=self.state/'mobile-feishu/feishu-accounts/accounts.json';old=account.read_bytes();account.write_text('{"new":"binding"}')
        with self.assertRaisesRegex(u.GateError,'protected_configuration_drift'):self.installer().install()
        account.write_bytes(old)
        with self.owner_db() as db:db.execute('UPDATE owners SET account=?',('other-account',))
        with self.assertRaisesRegex(u.GateError,'owner_data_drift'):self.installer().install()
        self.assertEqual([],self.commands)

    def test_only_exact_additive_empty_acl_schema_and_no_implicit_grants(self):
        before=u.owner_snapshot(self.args);accounts=u.protected_snapshot(self.args)
        self.installer().install();after=u.owner_snapshot(self.args)
        self.assertTrue(u.owner_matches(before,after,migrated=True))
        self.assertEqual(set(u.OWNER_DDL),set(after))
        self.assertEqual(0,after['voice_owners']['rows']);self.assertEqual(0,after['read_grants']['rows'])
        self.assertEqual(before['owners'],after['owners']);self.assertEqual(before['receipts'],after['receipts'])
        self.assertEqual(accounts,u.protected_snapshot(self.args))
        backup=self.root/'backups'/self.manifest['release_id']/'meeting-owners.sqlite3'
        self.assertEqual(0o600,backup.stat().st_mode&0o777)
        with closing(sqlite3.connect(backup)) as db:
            self.assertEqual(1,db.execute('SELECT count(*) FROM owners').fetchone()[0])
            self.assertEqual(0,db.execute("SELECT count(*) FROM sqlite_master WHERE name='read_grants'").fetchone()[0])

    def test_unknown_schema_and_altered_acl_definition_refuse(self):
        with self.owner_db() as db:db.execute('CREATE TABLE unreviewed (secret TEXT)')
        with self.assertRaisesRegex(u.GateError,'owner_schema_requires_review'):self.installer().install()
        with self.owner_db() as db:
            db.execute('DROP TABLE unreviewed');db.execute('CREATE TABLE voice_owners (name TEXT PRIMARY KEY, principal TEXT)')
        with self.assertRaisesRegex(u.GateError,'owner_schema_requires_review'):self.installer().install()
        self.assertEqual([],self.commands)

    def test_preexisting_explicit_acl_rows_are_preserved_without_reclassification(self):
        with self.owner_db() as db:
            db.execute(u.OWNER_DDL['voice_owners']);db.execute(u.OWNER_DDL['read_grants'])
            db.execute('INSERT INTO read_grants VALUES (?,?,?,?,?)',('meeting','synthetic-meeting','person-x','explicit-admin',123.0))
        self.manifest['owner']=u.owner_snapshot(self.args);self.save_manifest();before=self.manifest['owner']
        self.installer().install()
        self.assertEqual(before,u.owner_snapshot(self.args))

    def test_start_failure_rolls_back_code_and_keeps_original_owner_rows_and_empty_acl(self):
        before=u.owner_snapshot(self.args);self.failure='health'
        with self.assertRaisesRegex(u.GateError,'source_config_restored'):self.installer().install()
        after=u.owner_snapshot(self.args)
        self.assertTrue(u.owner_matches(before,after,migrated=True))
        self.assertEqual(0,after['voice_owners']['rows']);self.assertEqual(0,after['read_grants']['rows'])
        self.assertEqual(self.manifest['baseline'],u.source_snapshot(self.live))

    def test_user_owner_edit_during_failed_start_is_never_overwritten(self):
        installer=self.installer();old_health=installer.health;edited=[False]
        def health(token):
            result=old_health(token)
            if u.source_snapshot(self.live)==self.manifest['files'] and not edited[0]:
                edited[0]=True
                with self.owner_db() as db:db.execute('UPDATE owners SET account=?',('concurrent-user-account',))
                result['strict_a_enabled']=True
            return result
        installer.health=health
        with self.assertRaisesRegex(u.GateError,'requires_attention'):installer.install()
        self.assertEqual(self.manifest['baseline'],u.source_snapshot(self.live))
        with self.owner_db() as db:self.assertEqual('concurrent-user-account',db.execute('SELECT account FROM owners').fetchone()[0])
        self.assertEqual('inactive',self.status)

    def test_new_journal_unknown_and_pending_steps_block_install_even_if_invalidated(self):
        cases=[('calendars',{'status':'created_unverified'},'calendars'),
               ('calendars',{'status':'invitation_unknown'},'calendars'),
               ('calendars',{'status':'invalidated','create_step':'pending'},'calendars'),
               ('assistant-deliveries',{'status':'unknown'},'agent_deliveries'),
               ('agent-deliveries',{'status':'failed','steps':{'file':{'status':'pending','read':False}}},'agent_deliveries')]
        for folder,op,key in cases:
            with self.subTest(folder=folder,status=op['status']):
                path=self.state/'mobile-feishu'/folder/'synthetic.json';path.write_text(json.dumps({'operations':{'original-op':op}}))
                self.assertEqual(1,u.pending_work(self.state,self.now)[key])
                with self.assertRaisesRegex(u.GateError,'pending_meeting'):self.installer().install()
                path.unlink()
        self.assertFalse(any(c[1]=='stop' for c in self.commands))

    def test_completed_journal_receipts_are_not_replayed_or_rewritten(self):
        path=self.state/'mobile-feishu/calendars/known.json';path.write_text('{"operations":{"known":{"status":"created","event_id":"synthetic-event"}}}')
        raw=path.read_bytes();self.installer().install()
        self.assertEqual(raw,path.read_bytes())

    def test_live_baseline_is_rechecked_after_fake_tests_before_any_stop(self):
        installer=self.installer()
        installer.tests=lambda: (self.live/'processing_trace.py').write_text('CONCURRENT_UPDATE=True\n')
        with self.assertRaisesRegex(u.GateError,'preserved_dependency_drift'):installer.install()
        self.assertFalse(any(c[1]=='stop' for c in self.commands))

    def test_health_requires_all_new_typed_flags_and_preserves_existing_asr_features(self):
        before={'status':'ok','asr_review':True,'content_curation_version':1,'strict_a_enabled':False}
        after={**before,**u.CAPABILITIES}
        self.assertTrue(u.health_matches(before,after,upgraded=True))
        for key,value in [('asr_review',False),('personal_object_permissions_version',True),('calendar_confirmation_required',1),
                          ('agent_delivery_confirmation_required',False),('minutes_topic_sources_version',None)]:
            with self.subTest(key=key):self.assertFalse(u.health_matches(before,{**after,key:value},upgraded=True))

    def test_test_helpers_are_checked_but_never_installed_to_live(self):
        self.assertEqual(9,len(u.FILES));self.assertEqual(8,len(u.TESTS));self.assertEqual(3,len(u.TEST_HELPERS))
        self.assertFalse(set(u.FILES)&set(u.TEST_HELPERS))
        self.installer().install()
        for name in u.TEST_HELPERS:self.assertFalse((self.live/name).exists())
        self.assertEqual(9,len(u.source_snapshot(self.live)))

    def test_existing_production_helper_is_preserved_instead_of_overwritten_by_test_copy(self):
        name=u.TEST_HELPERS[0];path=self.live/name;path.write_text('PRODUCTION_ORIGINAL=True\n')
        self.manifest['preserved']=u.preserved_sources(self.live);self.save_manifest()
        self.installer().install()
        self.assertEqual('PRODUCTION_ORIGINAL=True\n',path.read_text())

    def test_missing_tampered_or_unlisted_test_helpers_are_refused(self):
        helper=self.stage/u.TEST_HELPERS[0];original=helper.read_bytes()
        helper.write_text('CHANGED=True\n')
        with self.assertRaisesRegex(u.GateError,'staged_checksum'):self.installer().install()
        helper.unlink()
        with self.assertRaisesRegex(u.GateError,'unlisted_paths'):self.installer().install()
        helper.write_bytes(original)
        self.manifest['test_helpers']['unreviewed_converter.py']='a'*64;self.save_manifest()
        with self.assertRaisesRegex(u.GateError,'manifest_file_set'):self.installer().install()
        self.assertEqual([],self.commands)

    def test_helper_cannot_be_added_to_live_source_whitelist(self):
        name=u.TEST_HELPERS[0]
        self.manifest['files'][name]=self.manifest['test_helpers'][name]
        self.manifest['baseline'][name]=None;self.save_manifest()
        with self.assertRaisesRegex(u.GateError,'manifest_file_set'):self.installer().install()
        self.assertEqual([],self.commands)

    def test_real_test_helpers_import_from_stage_without_network_cli_or_model(self):
        baseline=self.root/'baseline.json';baseline.write_text(json.dumps(u.baseline(self.args)))
        checks=self.root/'checks.json';checks.write_text(json.dumps({key:True for key in u.CHECKS}))
        stage=self.root/'helper-import-stage';u.build(stage,baseline,checks)
        probe=r'''
import importlib, pathlib, socket, subprocess, sys, urllib.request
sys.path.insert(0,sys.argv[1])
def forbidden(*args,**kwargs):raise AssertionError('network_or_cli_forbidden')
socket.socket.connect=forbidden;socket.socket.connect_ex=forbidden;socket.getaddrinfo=forbidden
urllib.request.urlopen=forbidden;urllib.request.OpenerDirector.open=forbidden;subprocess.run=forbidden
for name in ('label_minutes_import','label_items','label_workflow'):
 module=importlib.import_module(name)
 assert pathlib.Path(module.__file__).parent==pathlib.Path(sys.argv[1])
assert callable(importlib.import_module('label_minutes_import').build_bundle)
print('three_test_only_helpers_imported_without_provider_calls')
'''
        result=subprocess.run([sys.executable,'-I','-B','-c',probe,str(stage)],capture_output=True,text=True,timeout=15)
        self.assertEqual(0,result.returncode,result.stderr)
        self.assertIn('three_test_only_helpers_imported',result.stdout)
        self.assertIn("'test_minutes_quality'",u.TEST_RUNNER)


if __name__=='__main__':unittest.main()
