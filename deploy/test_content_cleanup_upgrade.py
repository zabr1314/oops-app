"""Offline deployment gates: temporary files only, no systemctl or requests."""
import datetime as dt
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('cleanup_upgrade', Path(__file__).with_name('content-cleanup-upgrade.py'))
upgrade = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upgrade)


class UpgradeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.private = (self.root / 'state', self.root / 'label-data')
        self.bases = {'backend': self.root / 'backend-code', 'label': self.root / 'label-code'}
        self.stage = self.root / 'stage'
        for folder in (*self.private, *self.bases.values(), self.stage):
            folder.mkdir()
        for folder in ('meetings', 'feishu', 'agent-jobs', 'operations'):
            (self.private[0] / folder).mkdir()
        self.now = dt.datetime.now(dt.timezone.utc)
        (self.private[0] / 'feishu/state.json').write_text(json.dumps(dict(since=(self.now-dt.timedelta(days=1)).isoformat(), meetings={})))
        for mid in upgrade.MIDS:
            path = self.private[1] / 'meetings' / mid / 'meeting.json'
            path.parent.mkdir(parents=True)
            path.write_text('{"imported": false}')
        self.patches = [patch.object(upgrade, 'BASES', self.bases), patch.object(upgrade, 'PRIVATE', self.private),
                        patch.object(upgrade, 'CONFIG', ()), patch.object(upgrade, 'validate_sidecars', return_value={})]
        for p in self.patches:
            p.start()
        files = {}
        for scope, names in upgrade.FILES.items():
            (self.stage / scope).mkdir()
            for name in names:
                text = '<!doctype html><title>UI</title>\n' if name.endswith('.html') else 'pass\n'
                (self.bases[scope] / name).write_text(text)
                (self.stage / scope / name).write_text(text)
                files[scope + '/' + name] = upgrade.sha(self.stage / scope / name)
        data_files = {}
        for relative in upgrade.DATA_FILES:
            path = self.stage / 'data' / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('{}')
            data_files[relative] = upgrade.sha(path)
        self.manifest = dict(schema=1, files=files, baseline=upgrade.source_snapshot(),
                             label_catalog=upgrade.label_catalog(), checks={k: True for k in upgrade.CHECKS},
                             data_files=data_files, new_data_baseline=upgrade.data_snapshot(),
                             label_inputs=upgrade.label_inputs_snapshot(), plan_counts={}, installer_sha256=upgrade.sha(upgrade.__file__))
        self.save_manifest()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.temp.cleanup()

    def save_manifest(self):
        (self.stage / 'manifest.json').write_text(json.dumps(self.manifest))

    def test_html_is_checksum_verified_without_python_compilation(self):
        self.assertEqual(upgrade.validate(self.stage), self.manifest)

    def test_unknown_release_code_or_data_is_rejected(self):
        self.manifest['data_files']['label/answers.json'] = 'a' * 64
        self.save_manifest()
        with self.assertRaisesRegex(RuntimeError, 'unexpected_release_data_set'):
            upgrade.validate(self.stage)

    def test_live_source_and_proposal_drift_both_block_release(self):
        path = self.bases['backend'] / 'local_backend.py'
        path.write_text('changed = True\n')
        with self.assertRaisesRegex(RuntimeError, 'live_source_drift'):
            upgrade.validate(self.stage)
        path.write_text('pass\n')
        (self.private[1] / 'meetings/0236/items.json').write_text('{}')
        with self.assertRaisesRegex(RuntimeError, 'live_label_input_drift'):
            upgrade.validate(self.stage)

    def test_new_sidecars_must_still_be_absent(self):
        path = self.private[0] / 'task-visibility.json'
        path.write_text('{"human":"do not replace"}')
        with self.assertRaisesRegex(RuntimeError, 'live_new_sidecar_drift'):
            upgrade.validate(self.stage)

    def test_code_data_and_installer_checksums_are_required(self):
        self.manifest['installer_sha256'] = 'a' * 64
        self.save_manifest()
        with self.assertRaisesRegex(RuntimeError, 'installer_checksum_mismatch'):
            upgrade.validate(self.stage)
        self.manifest['installer_sha256'] = upgrade.sha(upgrade.__file__)
        self.save_manifest()
        (self.stage / 'data/backend/task-visibility.json').write_text('{"changed":true}')
        with self.assertRaisesRegex(RuntimeError, 'release_data_checksum_mismatch'):
            upgrade.validate(self.stage)

    def test_all_completed_checks_required(self):
        self.manifest['checks']['private_pending_review'] = False
        self.save_manifest()
        with self.assertRaisesRegex(RuntimeError, 'incomplete_completed_checks'):
            upgrade.validate(self.stage)

    def test_protected_invariants_allow_exactly_four_added_json_and_no_other_mutation(self):
        answer = self.private[1] / 'answers.json'
        answer.write_text('{"owner":"confirmed human"}')
        before = upgrade.protected()
        for relative in upgrade.DATA_FILES:
            path = upgrade.data_target(relative)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes((self.stage / 'data' / relative).read_bytes())
        self.assertTrue(upgrade.private_matches(before, self.manifest['data_files']))
        answer.write_text('{"owner":"changed"}')
        self.assertFalse(upgrade.private_matches(before, self.manifest['data_files']))

    def test_new_data_symlink_and_private_directory_symlink_block(self):
        (self.private[1] / 'curation').symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, 'data_symlink'):
            upgrade.data_snapshot()
        with self.assertRaisesRegex(RuntimeError, 'protected_symlink'):
            upgrade.protected()

    def test_pending_paid_and_external_work_detected_purely_from_json(self):
        row = dict(session_id='session-0001', started_at=(self.now-dt.timedelta(hours=1)).isoformat(),
                   ended_at=(self.now-dt.timedelta(minutes=30)).isoformat(), utterances=[])
        (self.private[0] / 'meetings/session-0001.json').write_text(json.dumps(row))
        (self.private[0] / 'agent-jobs/a.json').write_text('{"status":"running"}')
        (self.private[0] / 'operations/a.json').write_text('{"status":"pending"}')
        journal = self.private[1] / 'similarity_requests/member/request.json'
        journal.parent.mkdir(parents=True)
        journal.write_text('{"status":"prepared"}')
        pending = upgrade.pending_work()
        self.assertEqual((pending['generate'], pending['jobs'], pending['operations']), (1, 1, 1))
        self.assertEqual(pending['label_transactions'], 1)
        state = dict(since=(self.now-dt.timedelta(days=1)).isoformat(), meetings={'session-0001': {'analysis': {'version': 5}}})
        (self.private[0] / 'feishu/state.json').write_text(json.dumps(state))
        self.assertEqual(upgrade.pending_work()['send_cached'], 1)

    def test_preflight_never_stops_services_or_calls_network(self):
        with patch.object(upgrade.os, 'geteuid', return_value=0), patch.object(upgrade, 'active', return_value=True), \
                patch.object(upgrade.subprocess, 'run', side_effect=AssertionError('no service mutation')), \
                patch.object(upgrade.urllib.request, 'urlopen', side_effect=AssertionError('no network')):
            manifest, pending = upgrade.preflight(self.stage)
        self.assertEqual(manifest, self.manifest)
        self.assertFalse(any(pending.values()))

    def test_pending_work_blocks_preflight(self):
        with patch.object(upgrade.os, 'geteuid', return_value=0), patch.object(upgrade, 'active', return_value=True), \
                patch.object(upgrade, 'pending_work', return_value={'jobs': 1}):
            with self.assertRaisesRegex(RuntimeError, 'pending_external_or_paid_work'):
                upgrade.preflight(self.stage)

    def test_atomic_install_never_overwrites_existing_temp_or_new_target(self):
        source = self.root / 'source.json'; source.write_text('{"new":true}')
        target = self.root / 'published.json'; target.write_text('{"human":"keep"}')
        attrs = dict(uid=upgrade.os.geteuid(), gid=upgrade.os.getegid(), mode=0o600)
        temporary = target.with_name('.content-cleanup-stage-' + target.name)
        temporary.write_text('already here')
        with self.assertRaises(FileExistsError):
            upgrade.atomic_install(source, target, attrs)
        self.assertEqual(temporary.read_text(), 'already here')
        self.assertEqual(target.read_text(), '{"human":"keep"}')
        temporary.unlink()
        with self.assertRaises(FileExistsError):
            upgrade.atomic_install(source, target, attrs, new=True)
        self.assertEqual(target.read_text(), '{"human":"keep"}')
        self.assertFalse(temporary.exists())
        target.unlink()
        upgrade.atomic_install(source, target, attrs, new=True)
        self.assertEqual(target.read_text(), source.read_text())
        self.assertFalse(temporary.exists())


class PlanValidationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.stage, self.fixture = self.root / 'stage', self.root / 'fixture'
        (self.stage / 'label').mkdir(parents=True)
        source = Path(__file__).resolve().parents[1] / 'scripts/content_curation.py'
        (self.stage / 'label/content_curation.py').write_bytes(source.read_bytes())
        self.curation = upgrade._load_module('_curation_test', source)
        for mid in upgrade.MIDS:
            rows = [dict(id='u1', text='先提交接口。', start_ms=0, end_ms=1000),
                    dict(id='u2', text='独立留样原话。', start_ms=1000, end_ms=2000)]
            items = [dict(id='i1', kind='task', title='提交接口', evidence=[['u1']])]
            canonical = [dict(items[0], evidence_ids=['u1'])]
            plan = dict(schema=1, meeting_id=mid, source_hash=self.curation.source_hash(rows),
                        origin_items_hash=self.curation.origin_items_hash(canonical),
                        item_ops=[dict(action='keep', item_id='i1', reason='明确行动')],
                        sentences=[dict(id='u1', mode='focus', reason='明确行动'), dict(id='u2', mode='context', reason='保留独立样本')],
                        summary=[dict(text='先提交接口。', evidence_ids=['u1'])])
            path = self.fixture / 'meetings' / mid
            path.mkdir(parents=True)
            (path / 'meeting.json').write_text(json.dumps(dict(utterances=rows)))
            (path / 'items.json').write_text(json.dumps(dict(items=items, blind_ids=['u2'])))
            target = self.stage / 'data/label/curation' / (mid + '.json')
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(plan))
        target = self.stage / 'data/backend/task-visibility.json'
        target.parent.mkdir(parents=True)
        self.policy = dict(schema=1, entries={upgrade.TEST_OPERATION_ID: dict(action='archive',
                            request_hash=upgrade.TEST_OPERATION_REQUEST_HASH, reason='保留原记录，仅收起服务器验收测试')})
        target.write_text(json.dumps(self.policy))

    def tearDown(self):
        self.temp.cleanup()

    def test_local_plan_and_visibility_schema_validation_is_offline(self):
        with patch.object(upgrade.urllib.request, 'urlopen', side_effect=AssertionError('no network')):
            counts = upgrade.validate_sidecars(self.stage, live=False, fixture=self.fixture)
        self.assertEqual(set(counts), set(upgrade.MIDS))

    def test_reserved_summary_is_blocked_even_with_valid_general_plan(self):
        path = self.stage / 'data/label/curation/0235.json'
        plan = json.loads(path.read_text())
        plan['summary'][0]['evidence_ids'] = ['u2']
        path.write_text(json.dumps(plan))
        with self.assertRaisesRegex(RuntimeError, 'curation_reveals_reserved_source'):
            upgrade.validate_sidecars(self.stage, live=False, fixture=self.fixture)

    def test_source_changed_plan_is_blocked(self):
        path = self.fixture / 'meetings/0235/meeting.json'
        doc = json.loads(path.read_text()); doc['utterances'][0]['text'] = '改了'
        path.write_text(json.dumps(doc))
        with self.assertRaisesRegex(RuntimeError, 'curation_plan_invalid:0235:source_changed'):
            upgrade.validate_sidecars(self.stage, live=False, fixture=self.fixture)

    def test_only_fixed_test_operation_is_permitted(self):
        policy = json.loads(json.dumps(self.policy))
        entry = policy['entries'].pop(upgrade.TEST_OPERATION_ID)
        policy['entries']['some-other-op'] = entry
        with self.assertRaisesRegex(RuntimeError, 'visibility_operation_not_approved_test'):
            upgrade.validate_visibility(policy, live=False)

    def test_live_visibility_requires_exact_canonical_and_settled_original(self):
        backend = self.root / 'backend-state'; (backend / 'operations').mkdir(parents=True)
        request = dict(draft=dict(what=upgrade.TEST_OPERATION_TITLE))
        canonical = json.dumps(request, ensure_ascii=False)
        digest = upgrade.hashlib.sha256(canonical.encode()).hexdigest()
        policy = json.loads(json.dumps(self.policy))
        policy['entries'][upgrade.TEST_OPERATION_ID]['request_hash'] = digest
        op = dict(op_id=upgrade.TEST_OPERATION_ID, request=request, request_canonical=canonical,
                  status='created', feishu_task=dict(guid='existing'))
        path = backend / 'operations' / (upgrade.TEST_OPERATION_ID + '.json')
        path.write_text(json.dumps(op))
        with patch.object(upgrade, 'PRIVATE', (backend, self.fixture)), patch.object(upgrade, 'TEST_OPERATION_REQUEST_HASH', digest):
            upgrade.validate_visibility(policy)
            op['request'] = dict(draft=dict(what='正常业务任务'))
            path.write_text(json.dumps(op))
            with self.assertRaisesRegex(RuntimeError, 'visibility_canonical_request_mismatch'):
                upgrade.validate_visibility(policy)
            op['request'] = request; op['status'] = 'pending'
            path.write_text(json.dumps(op))
            with self.assertRaisesRegex(RuntimeError, 'visibility_operation_not_settled'):
                upgrade.validate_visibility(policy)


if __name__ == '__main__':
    unittest.main()
