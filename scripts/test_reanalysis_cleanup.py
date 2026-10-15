#!/usr/bin/env python3
"""Reanalysis retention only purges its own copies, preserving numeric charges."""
import fcntl
import json
import os
from pathlib import Path
import tempfile
import unittest

from replay_history import cleanup_reanalyses, reanalysis_source_hash


class ReanalysisCleanupTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'
        (self.source / 'meetings').mkdir(parents=True)
        private = self.root / 'private'
        self.published, self.jobs, self.receipts = private / 'reanalyses', private / 'reanalysis-jobs', private / 'receipts'
        self.published.mkdir(parents=True)
        self.job = self.jobs / 'run-safe'
        self.job.mkdir(parents=True)
        self.row = dict(session_id='safe', started_at='2026-10-14T00:00:00Z', time_zone='UTC', reviews={},
            utterances=[dict(id='u1', text='PRIVATE-SOURCE-MARKER', speaker='甲', start_ms=0, end_ms=1000, tag='idea')])
        self.write_source()
        self.record = dict(version=1, run_id='run-safe', source_session_id='safe', source_hash=reanalysis_source_hash(self.row),
            source_snapshot=self.row, utterances=self.row['utterances'], raw_calls=[{'body': 'PRIVATE-RAW-CALL'}],
            budget=dict(approved_cny=.1, spent_cny=.006, reserved_cny=.02, request_count=2))
        self.run_path = self.published / 'run-safe.json'
        self.progress_path, self.budget_path = self.job / 'progress.json', self.job / 'budget.json'
        self.run_path.write_text(json.dumps(self.record))
        self.progress_path.write_text(json.dumps(self.record))
        self.budget_path.write_text(json.dumps(dict(config=dict(run_id='run-safe', source_session_id='safe', source_hash=self.record['source_hash']),
            cap_nanos=100000000, spent_nanos=6000000, reserved_nanos=20000000,
            requests=[dict(status='settled', text='PRIVATE-BUDGET-CONTEXT'), dict(status='unknown', text='PRIVATE-UNKNOWN')],
            arbitrary='PRIVATE-BUDGET-ROOT')))

    def tearDown(self):
        self.temp.cleanup()

    def write_source(self):
        (self.source / 'meetings/safe.json').write_text(json.dumps(self.row))

    def cleanup(self):
        return cleanup_reanalyses(str(self.source), str(self.published), str(self.jobs), str(self.receipts))

    def change_source(self):
        self.row['utterances'][0]['speaker'] = '乙'
        self.write_source()

    def test_current_source_keeps_all_rerun_bytes_and_does_not_create_receipts(self):
        paths = [self.run_path, self.progress_path, self.budget_path, self.source / 'meetings/safe.json']
        before = {str(path): path.read_bytes() for path in paths}
        result = self.cleanup()
        self.assertEqual(0, result['published_removed'])
        self.assertEqual(before, {str(path): path.read_bytes() for path in paths})
        self.assertFalse(self.receipts.exists())

    def test_changed_source_removes_raw_copies_but_preserves_all_exposure(self):
        self.change_source()
        source_before = (self.source / 'meetings/safe.json').read_bytes()
        result = self.cleanup()
        self.assertEqual((1, 1, 1), (result['published_removed'], result['jobs_anonymized'], result['receipts_kept']))
        self.assertFalse(self.run_path.exists())
        for path in [self.progress_path, self.budget_path, self.receipts / 'run-safe.json']:
            text = path.read_text()
            self.assertNotIn('PRIVATE-', text)
            receipt = json.loads(text)
            self.assertTrue(receipt['content_purged'])
            self.assertEqual('source_changed', receipt['cleanup_reason'])
            self.assertEqual(.006, receipt['budget']['spent_cny'])
            self.assertEqual(.02, receipt['budget']['reserved_cny'])
            self.assertEqual(1, receipt['budget']['unknown_requests'])
        self.assertEqual(source_before, (self.source / 'meetings/safe.json').read_bytes())

    def test_expiry_and_delete_reasons_are_enforced_without_touching_source(self):
        self.row['storage_policy'] = dict(transcript_expires_at='2000-01-01T00:00:00Z')
        self.write_source()
        self.cleanup()
        self.assertEqual('source_expired', json.loads((self.receipts / 'run-safe.json').read_text())['cleanup_reason'])
        self.run_path.write_text(json.dumps(self.record))
        (self.source / 'meetings/safe.json').unlink()
        self.cleanup()
        self.assertEqual('source_deleted', json.loads((self.receipts / 'run-safe.json').read_text())['cleanup_reason'])

    def test_running_paid_job_is_never_edited(self):
        self.change_source()
        fd = os.open(self.job / 'run.lock', os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            before = self.progress_path.read_bytes()
            result = self.cleanup()
            self.assertEqual(1, result['active_skipped'])
            self.assertEqual(before, self.progress_path.read_bytes())
            self.assertTrue(self.run_path.exists())
        finally:
            os.close(fd)
        self.assertEqual(1, self.cleanup()['published_removed'])

    def test_cleanup_is_idempotent_and_preserves_unrelated_files(self):
        (self.job / '.reanalysis-interrupted').write_text('PRIVATE-TEMP-SOURCE')
        (self.published / '.reanalysis-interrupted-publish').write_text(json.dumps(self.record))
        (self.job / 'notes.txt').write_text('preserve explicitly unrelated file')
        self.change_source()
        self.cleanup()
        self.assertFalse((self.job / '.reanalysis-interrupted').exists())
        self.assertFalse((self.published / '.reanalysis-interrupted-publish').exists())
        self.assertTrue((self.job / 'notes.txt').exists())
        before = self.progress_path.read_bytes()
        receipt_before = (self.receipts / 'run-safe.json').read_bytes()
        self.assertEqual(0, self.cleanup()['jobs_anonymized'])
        self.assertEqual(before, self.progress_path.read_bytes())
        self.assertEqual(receipt_before, (self.receipts / 'run-safe.json').read_bytes())

    def test_unrecognized_or_symlinked_records_are_not_guessed_disposable(self):
        self.run_path.write_text('{"unrecognized":true}')
        self.change_source()
        result = self.cleanup()
        self.assertGreater(result['invalid_skipped'], 0)
        self.assertTrue(self.run_path.exists())
        self.run_path.unlink()
        os.symlink(self.source / 'meetings/safe.json', self.run_path)
        self.cleanup()
        self.assertTrue(self.run_path.is_symlink())
        self.assertTrue((self.source / 'meetings/safe.json').exists())

    def test_source_or_nested_targets_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'overlaps_source'):
            cleanup_reanalyses(str(self.source), str(self.source / 'meetings'), str(self.jobs))
        with self.assertRaisesRegex(ValueError, 'targets_overlap'):
            cleanup_reanalyses(str(self.source), str(self.published), str(self.published / 'jobs'))

    def test_durable_ledger_reservation_wins_over_stale_progress_summary(self):
        self.record['budget'].update(spent_cny=0, reserved_cny=0, request_count=0, unknown_requests=0)
        self.run_path.write_text(json.dumps(self.record))
        self.progress_path.write_text(json.dumps(self.record))
        self.change_source()
        self.cleanup()
        budget = json.loads((self.receipts / 'run-safe.json').read_text())['budget']
        self.assertEqual(.006, budget['actual_cny'])
        self.assertEqual(.02, budget['reserved_cny'])
        self.assertEqual(.026, budget['exposure_cny'])
        self.assertEqual(2, budget['request_count'])
        self.assertEqual(1, budget['unknown_requests'])


if __name__ == '__main__':
    unittest.main()
