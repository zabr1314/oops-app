"""Fake-filesystem deployment gates only; never runs systemctl, SSH or requests."""
import datetime as dt
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('quality_upgrade', Path(__file__).with_name('item-quality-upgrade.py'))
upgrade = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upgrade)


class UpgradeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.private = (self.root / 'state', self.root / 'label-data')
        self.bases = {'backend': self.root / 'backend-code', 'label': self.root / 'label-code'}
        self.stage = self.root / 'stage'
        for folder in (*self.private, *self.bases.values(), self.stage):
            folder.mkdir()
        for folder in ('meetings', 'feishu', 'agent-jobs', 'operations'):
            (self.private[0] / folder).mkdir()
        self.now = dt.datetime.now(dt.timezone.utc)
        (self.private[0] / 'feishu/state.json').write_text(json.dumps(dict(since=(self.now-dt.timedelta(days=1)).isoformat(), meetings={})))
        for mid in ('0235', '0236', '0238'):
            path = self.private[1] / 'meetings' / mid / 'meeting.json'
            path.parent.mkdir(parents=True)
            path.write_text('{"imported": false}')
        self.patches = [patch.object(upgrade, 'BASES', self.bases), patch.object(upgrade, 'PRIVATE', self.private),
                        patch.object(upgrade, 'CONFIG', ())]
        for p in self.patches:
            p.start()
        files = {}
        for scope, names in upgrade.FILES.items():
            (self.stage / scope).mkdir()
            for name in names:
                (self.bases[scope] / name).write_text('pass\n')
                (self.stage / scope / name).write_text('pass\n')
                files[scope + '/' + name] = upgrade.sha(self.stage / scope / name)
        self.manifest = dict(schema=1, files=files, baseline=upgrade.source_snapshot(),
                             label_catalog=upgrade.label_catalog(), checks={k: True for k in upgrade.CHECKS})
        self.save_manifest()

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.temp.cleanup()

    def save_manifest(self):
        (self.stage / 'manifest.json').write_text(json.dumps(self.manifest))

    def meeting(self, **extra):
        row = dict(session_id='session-0001', started_at=(self.now-dt.timedelta(hours=1)).isoformat(),
                   ended_at=(self.now-dt.timedelta(minutes=30)).isoformat(), utterances=[])
        row.update(extra)
        (self.private[0] / 'meetings/session-0001.json').write_text(json.dumps(row))

    def test_strict_validated_file_set_and_old_catalog(self):
        self.assertEqual(self.manifest, upgrade.validate(self.stage))

    def test_live_source_drift_blocks_release(self):
        (self.bases['backend'] / 'local_backend.py').write_text('changed = True\n')
        with self.assertRaisesRegex(RuntimeError, 'live_source_drift'):
            upgrade.validate(self.stage)

    def test_replaced_release_file_blocks_deployment(self):
        (self.stage / 'backend/item_quality.py').write_text('different = True\n')
        with self.assertRaisesRegex(RuntimeError, 'release_checksum_mismatch'):
            upgrade.validate(self.stage)

    def test_imported_catalog_requires_separate_revision_review(self):
        (self.private[1] / 'meetings/0235/meeting.json').write_text('{"imported": true}')
        with self.assertRaisesRegex(RuntimeError, 'imported_revision_requires_review'):
            upgrade.validate(self.stage)

    def test_incomplete_checks_cannot_reach_apply(self):
        self.manifest['checks']['android_h5'] = False
        self.save_manifest()
        with self.assertRaisesRegex(RuntimeError, 'incomplete_completed_checks'):
            upgrade.validate(self.stage)

    def test_old_unfinished_cached_minutes_do_not_trigger_bot(self):
        self.meeting(ended_at=(self.now-dt.timedelta(days=2)).isoformat())
        self.assertFalse(any(upgrade.pending_work().values()))

    def test_new_minutes_and_cached_send_are_detected_without_requesting_them(self):
        self.meeting()
        self.assertEqual(1, upgrade.pending_work()['generate'])
        state = dict(since=(self.now-dt.timedelta(days=1)).isoformat(),
                     meetings={'session-0001': {'analysis': {'version': 5}}})
        (self.private[0] / 'feishu/state.json').write_text(json.dumps(state))
        self.assertEqual(1, upgrade.pending_work()['send_cached'])

    def test_live_scan_job_and_operation_are_detected(self):
        self.meeting(ended_at=None, last_sync_at=self.now.isoformat())
        (self.private[0] / 'agent-jobs/a.json').write_text('{"status":"running"}')
        (self.private[0] / 'operations/a.json').write_text('{"status":"pending"}')
        pending = upgrade.pending_work()
        self.assertEqual((1, 1, 1), (pending['active_questions'], pending['jobs'], pending['operations']))

    def test_private_bytes_changes_are_detected_without_content_logging(self):
        before = upgrade.protected()
        (self.private[1] / 'answers.json').write_text('{"manual":"preserve"}')
        self.assertNotEqual(before, upgrade.protected())


if __name__ == '__main__':
    unittest.main()
