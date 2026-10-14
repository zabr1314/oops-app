"""Automatic bridge tests use temporary backend files and stored fake minutes only."""
import datetime as dt
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import label_auto_import as bridge

NOW = dt.datetime(2026, 10, 12, 20, tzinfo=dt.timezone.utc)
SID = '11111111-2222-3333-4444-555555555555'


class BridgeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.backend, self.data = self.root / 'backend', self.root / 'label'
        for folder in (self.backend / 'meetings', self.backend / 'recordings' / SID,
                       self.backend / 'feishu', self.data / 'meetings', self.data / 'identities'):
            folder.mkdir(parents=True)
        self.policy_file = self.data / 'auto-import-policy.json'
        self.policy = dict(schema=1, enabled=True, authorization='new_project_cloud_meetings_to_review_site',
            reuse_existing_minutes_only=True, backend_dir=str(self.backend), label_dir=str(self.data),
            enabled_after=bridge.stamp(NOW-dt.timedelta(hours=2)), baseline_sessions=[])
        self.write(self.policy_file, self.policy)
        self.write(self.data / 'identities/shared.json', {'approvals': {'a': {'speaker': '林春源'}}})
        self.archive = dict(version=1, recording_mode='meeting', cloud_save_confirmed=True,
            archive_started_at=bridge.stamp(NOW-dt.timedelta(hours=1)),
            audio_expires_at=bridge.stamp(NOW+dt.timedelta(days=30)),
            transcript_expires_at=bridge.stamp(NOW+dt.timedelta(days=30)))
        self.row = dict(session_id=SID, started_at=self.archive['archive_started_at'],
            ended_at=bridge.stamp(NOW-dt.timedelta(minutes=5)), time_zone='Asia/Shanghai', storage_policy=self.archive,
            utterances=[dict(id=f'u{i}', text='我来准备方案。' if i==1 else f'第{i}句讨论内容。',
                start_ms=i*1000, end_ms=i*1000+900, speaker=None, tag='commitment' if i==1 else 'idea')
                for i in range(1,6)], reviews={'u1': {'speaker': '林春源', 'by': '林春源', 'at': bridge.stamp(NOW)}})
        self.analysis = dict(actions=[dict(task='准备方案', ids=['u1'], owner='林春源', due='')],
            decisions=[dict(text='先做方案', ids=['u2'])], undecided=[], open_questions=[], theme='方案讨论')
        self.save_source()

    @staticmethod
    def write(path, value):
        path.write_text(json.dumps(value, ensure_ascii=False))

    def save_source(self, summary=True, complete=True):
        self.write(self.backend / 'meetings' / (SID+'.json'), self.row)
        raw = self.backend / 'recordings' / SID
        pcm = b'\0\0' * 16000 * 8
        (raw/'audio.pcm').write_bytes(pcm)
        files = {'audio.pcm': {'size': len(pcm), 'sha256': hashlib.sha256(pcm).hexdigest()}}
        self.write(raw/'manifest.json', {'storage_policy': self.archive, 'files': files})
        if complete:
            self.write(raw/'complete.json', {'session_id': SID, 'files': files})
        elif (raw/'complete.json').exists():
            (raw/'complete.json').unlink()
        row = json.loads(json.dumps(self.row))
        for u in row['utterances']:
            if u['id'] in row['reviews']: u['review'] = row['reviews'][u['id']]
        cache = dict(analysis=self.analysis, analysis_fingerprint=bridge.minutes_fingerprint(row)) if summary else {}
        self.write(self.backend/'feishu/state.json', {'meetings': {SID: cache}})

    def tick(self, now=NOW):
        with patch('urllib.request.urlopen', side_effect=AssertionError('bridge must not call external API')):
            return bridge.reconcile(self.backend, self.data, self.policy_file, now)

    def imported(self):
        folders = list((self.data/'meetings').iterdir())
        self.assertEqual(len(folders),1)
        return folders[0], bridge.read(folders[0]/'meeting.json')

    def test_end_to_end_idempotent_and_read_only_source(self):
        before={str(p.relative_to(self.backend)):bridge.file_hash(p) for p in self.backend.rglob('*') if p.is_file()}
        result=self.tick()
        folder, meeting=self.imported()
        items=bridge.read(folder/meeting['items_file'])
        self.assertEqual(result['model_calls'],0)
        self.assertEqual(result['ready'],1)
        self.assertEqual(meeting['processing']['stage'],'ready')
        self.assertEqual(len(items['items']),2)
        self.assertTrue((folder/meeting['audio_file']).exists())
        self.assertFalse(any('owner' in item for item in items['items']))
        source_after={str(p.relative_to(self.backend)):bridge.file_hash(p) for p in self.backend.rglob('*') if p.is_file()}
        self.assertEqual(before,source_after)
        committed=bridge.file_hash(folder/'meeting.json')
        self.tick(NOW+dt.timedelta(seconds=30))
        self.assertEqual(bridge.file_hash(folder/'meeting.json'),committed)

    def test_wait_for_upload_then_stored_summary_without_generating(self):
        self.save_source(summary=False,complete=False)
        self.tick()
        self.assertEqual(self.imported()[1]['processing']['stage'],'waiting_transcript')
        self.save_source(summary=False)
        self.tick()
        self.assertEqual(self.imported()[1]['processing']['stage'],'waiting_summary')
        self.save_source()
        self.tick()
        self.assertEqual(self.imported()[1]['processing']['stage'],'ready')

    def test_old_running_daily_private_and_unconsented_meetings_never_import(self):
        variants=[{'ended_at':None}, {'private':True}, {'review_export_scope':'private'},
                  {'started_at':bridge.stamp(NOW-dt.timedelta(days=1))},
                  {'storage_policy':{**self.archive,'recording_mode':'daily'}},
                  {'storage_policy':{**self.archive,'cloud_save_confirmed':False}}]
        for changes in variants:
            with self.subTest(changes=changes):
                original=self.row
                self.row={**original,**changes}
                self.save_source()
                self.tick()
                self.assertEqual(list((self.data/'meetings').iterdir()),[])
                self.row=original

    def test_expiry_deletion_and_source_revision_withdraw_old_assets(self):
        self.tick()
        folder,_=self.imported()
        self.row['utterances'][0]['text']='原话改了'
        self.write(self.backend/'meetings'/(SID+'.json'),self.row)
        self.tick()
        self.assertEqual(self.imported()[1]['processing']['stage'],'stale')
        self.assertEqual(list(folder.glob('audio-*.wav')),[])
        self.save_source()
        self.tick()
        self.assertEqual(self.imported()[1]['processing']['stage'],'ready')
        self.tick(NOW+dt.timedelta(days=31))
        self.assertEqual(self.imported()[1]['processing']['stage'],'expired')
        self.assertEqual(self.imported()[1]['utterances'],[])
        self.assertEqual(list(folder.glob('items-*.json')),[])
        (self.backend/'meetings'/(SID+'.json')).unlink()
        self.tick()
        self.assertEqual(self.imported()[1]['processing']['reason_code'],'source_withdrawn')

    def test_audio_expiry_keeps_live_transcript_without_audio(self):
        self.archive['audio_expires_at']=bridge.stamp(NOW-dt.timedelta(seconds=1))
        self.save_source()
        self.tick()
        folder,meeting=self.imported()
        self.assertEqual(meeting['processing']['stage'],'ready')
        self.assertFalse(meeting['audio_available'])
        self.assertEqual(list(folder.glob('audio-*.wav')),[])

    def test_corrupt_audio_fails_closed_and_recovers_same_meeting(self):
        (self.backend/'recordings'/SID/'audio.pcm').write_bytes(b'x'*256000)
        self.tick()
        folder,meeting=self.imported()
        self.assertEqual(meeting['processing']['stage'],'failed')
        self.assertEqual(meeting['utterances'],[])
        self.save_source()
        self.tick()
        self.assertEqual(self.imported()[0],folder)
        self.assertEqual(self.imported()[1]['processing']['stage'],'ready')

    def test_bridge_needs_its_own_explicit_destination_authorization(self):
        self.policy.pop('authorization')
        self.write(self.policy_file,self.policy)
        with self.assertRaisesRegex(ValueError,'not_authorized'):
            self.tick()
        self.assertEqual(list((self.data/'meetings').iterdir()),[])

    def test_resumed_meeting_withdraws_previously_imported_ready_result(self):
        self.tick()
        self.row.pop('ended_at')
        self.write(self.backend/'meetings'/(SID+'.json'),self.row)
        self.tick()
        folder,meeting=self.imported()
        self.assertEqual(meeting['processing']['reason_code'],'meeting_resumed')
        self.assertEqual(meeting['utterances'],[])
        self.assertEqual(list(folder.glob('audio-*.wav')),[])

    def test_late_source_change_during_audio_validation_cannot_publish_old_evidence(self):
        original=bridge.file_hash
        def change_then_hash(path):
            self.row['utterances'][0]['text']='源头在导入中改变'
            self.write(self.backend/'meetings'/(SID+'.json'),self.row)
            return original(path)
        with patch.object(bridge,'file_hash',side_effect=change_then_hash):
            self.tick()
        folder,meeting=self.imported()
        self.assertEqual(meeting['processing']['stage'],'stale')
        self.assertEqual(meeting['utterances'],[])
        self.assertEqual(list(folder.glob('items-*.json')),[])

    def test_fingerprint_matches_existing_backend_contract(self):
        from feishu_actions import FeishuActions
        row=json.loads(json.dumps(self.row))
        for u in row['utterances']:
            if u['id'] in row['reviews']:u['review']=row['reviews'][u['id']]
        self.assertEqual(bridge.minutes_fingerprint(row),FeishuActions.minutes_fingerprint(row))

    def test_live_http_guard_blocks_source_withdrawal_without_waiting_for_timer(self):
        self.tick()
        folder,meeting=self.imported()
        fp=meeting['source_minutes_fingerprint']
        self.assertIsNone(bridge.live_guard(self.backend,self.data,SID,fp))
        self.row['private']=True
        self.write(self.backend/'meetings'/(SID+'.json'),self.row)
        self.assertEqual(bridge.live_guard(self.backend,self.data,SID,fp)['stage'],'stale')

    def test_missing_policy_and_corrupt_source_withdraw_previously_ready_assets(self):
        self.tick()
        folder,_=self.imported()
        (self.backend/'meetings'/(SID+'.json')).write_text('{broken')
        self.tick()
        self.assertEqual(self.imported()[1]['processing']['stage'],'failed')
        self.assertEqual(list(folder.glob('audio-*.wav')),[])
        self.save_source()
        self.tick()
        self.policy_file.unlink()
        with self.assertRaises(ValueError):self.tick()
        self.assertEqual(self.imported()[1]['processing']['stage'],'waiting_policy')
        self.assertEqual(self.imported()[1]['utterances'],[])
        self.assertEqual(list(folder.glob('items-*.json')),[])

    def test_live_guard_rejects_replaced_summary_and_recording_before_timer(self):
        self.tick()
        _,meeting=self.imported()
        def guard():
            return bridge.live_guard(self.backend,self.data,SID,meeting['source_minutes_fingerprint'],
                expected_revision=meeting['source_revision'],expected_audio_sha256=meeting['source_audio_sha256'])
        self.assertIsNone(guard())
        self.analysis['actions'][0]['task']='替换后的方案事项'
        self.save_source()
        self.assertEqual(guard()['reason_code'],'summary_source_changed')
        self.analysis['actions'][0]['task']='准备方案'
        self.save_source()
        raw=self.backend/'recordings'/SID
        pcm=b'x'*256000
        (raw/'audio.pcm').write_bytes(pcm)
        for name in ('complete.json','manifest.json'):
            value=bridge.read(raw/name)
            value['files']['audio.pcm']['sha256']=hashlib.sha256(pcm).hexdigest()
            self.write(raw/name,value)
        self.assertEqual(guard()['reason_code'],'recording_source_changed')

    def test_malformed_source_shape_cannot_block_the_worker_or_keep_old_evidence(self):
        for shape in ([],['invalid'],{'unexpected':'object'}):
            with self.subTest(shape=shape):
                self.save_source();self.tick()
                self.write(self.backend/'meetings'/(SID+'.json'),shape)
                self.assertEqual(self.tick()['failed'],1)
                folder,meeting=self.imported()
                self.assertEqual(meeting['processing']['stage'],'failed')
                self.assertEqual(meeting['utterances'],[])

    def test_completed_audio_modified_in_place_is_rechecked(self):
        self.tick()
        (self.backend/'recordings'/SID/'audio.pcm').write_bytes(b'x'*256000)
        self.tick()
        self.assertEqual(self.imported()[1]['processing']['stage'],'failed')


if __name__=='__main__':
    unittest.main()
