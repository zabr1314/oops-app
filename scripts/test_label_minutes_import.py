#!/usr/bin/env python3
"""Stored summary import is deterministic, source-bound and never billable."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import label_items
from label_minutes_import import build_bundle, PROMPT_VERSION
from label_workflow import row_fingerprint


ALICE, BOB = '林春源', '洪玉麟'
ROSTER = {ALICE: 'person-alice', BOB: 'person-bob'}
FINGERPRINT = 'a' * 64
ROWS = [dict(id='u1', text='我来整理接口说明。', start_ms=0, end_ms=3000,
             speaker=BOB, review=dict(speaker=ALICE, by=BOB, at='2026-10-13T03:01:00Z')),
        dict(id='u2', text='周五前发出来。', start_ms=3500, end_ms=5000, speaker=ALICE),
        dict(id='u3', text='先把 App 跑通。', start_ms=7000, end_ms=9000),
        dict(id='u4', text='硬件是否一起做还没定。', start_ms=10000, end_ms=12000)]
ROW = dict(session_id='session-new-001', started_at='2026-10-13T11:00:00+08:00',
           ended_at='2026-10-13T11:01:00+08:00', updated_at='2026-10-13T03:02:00Z',
           time_zone='Asia/Shanghai', display_title='接口安排', transcript_status='available', utterances=ROWS,
           storage_policy=dict(version=1, recording_mode='meeting', cloud_save_confirmed=True,
               audio_retention_days=7, transcript_retention_days=30, archive_started_at='2026-10-13T03:00:00+00:00',
               audio_expires_at='2026-10-20T03:00:00+00:00', transcript_expires_at='2026-11-12T03:00:00+00:00'))
ANALYSIS = dict(version=5, theme='接口安排', substantive=True,
    actions=[dict(task='整理并发送接口说明', ids=['u1', 'u2'], owner=ALICE, due='周五前', priority='main')],
    decisions=[dict(text='先把 App 跑通', ids=['u3'])],
    undecided=[dict(topic='硬件是否一起做？', views='暂未确定', ids=['u4'])],
    open_questions=[dict(question='接口限额是多少？', id='u2')])


class MinutesImportTest(unittest.TestCase):
    def bundle(self, row=None, analysis=None, roster=None):
        return build_bundle(copy.deepcopy(ROW if row is None else row), copy.deepcopy(ANALYSIS if analysis is None else analysis),
                            FINGERPRINT, 'm-new001', ROSTER if roster is None else roster)

    def test_all_four_summary_lists_become_source_bound_items_without_confirmed_owners(self):
        out = self.bundle()
        meeting, document = out['meeting'], out['items']
        self.assertEqual(['task', 'decision', 'open', 'open'], [i['kind'] for i in document['items']])
        self.assertEqual([['u1', 'u2']], document['items'][0]['evidence'])
        self.assertEqual(ALICE, document['items'][0]['owner_hint'])
        self.assertTrue(all('owner' not in item and 'review' not in item and not item['claimed'] for item in document['items']))
        by_id = {r['id']: r for r in meeting['utterances']}
        for item in document['items']:
            self.assertEqual(label_items.item_fingerprint(item, by_id), item['fingerprint'])
            self.assertEqual('ai-' + item['fingerprint'][:12], item['id'])
        self.assertEqual(label_items.source_hash(meeting['utterances']), document['source_hash'])
        self.assertEqual((PROMPT_VERSION, 'ready', 'stored-minutes', 0, []),
            tuple(document[k] for k in ('prompt_version', 'status', 'model', 'charged_upper_cny', 'attempts')))

    def test_meeting_preserves_contract_origin_timestamps_and_ready_metadata(self):
        meeting = self.bundle()['meeting']
        self.assertEqual(ROW['storage_policy'], meeting['storage_policy'])
        self.assertEqual((ROW['started_at'], ROW['ended_at']), (meeting['started_at'], meeting['ended_at']))
        self.assertEqual('session-new-001', meeting['source_session'])
        self.assertEqual('existing_summary', meeting['source_kind'])
        self.assertTrue(meeting['imported'])
        self.assertTrue(meeting['audio_available'])
        self.assertEqual(list(ROSTER), meeting['shared_roster'])
        self.assertEqual(dict(stage='ready', revision=meeting['source_revision'], updated_at='2026-10-13T03:01:00+00:00',
                              reason_code=None, retryable=False), meeting['processing'])
        self.assertEqual(ROW['utterances'][0]['text'], meeting['utterances'][0]['text'])
        self.assertEqual('u1', meeting['origin_id_map']['u1'])
        self.assertEqual(FINGERPRINT, meeting['source_minutes_fingerprint'])

    def test_only_fresh_manual_speaker_in_destination_roster_is_confirmed(self):
        rows = copy.deepcopy(ROW)
        rows['utterances'][1]['review'] = dict(speaker=ALICE, source_changed_at='2026-10-13T03:05:00Z')
        rows['utterances'][2]['review'] = dict(speaker='其他团队的人', by=BOB)
        imported = self.bundle(row=rows)['meeting']['utterances']
        first = imported[0]
        self.assertEqual(ALICE, first['confirmed_speaker'])
        self.assertEqual('person-alice', first['confirmed_person_id'])
        self.assertEqual(BOB, first['speaker_hint'])
        self.assertEqual(dict(mode='backend_manual', fingerprint=row_fingerprint(first), by=BOB,
            at='2026-10-13T03:01:00Z', source_session_id=ROW['session_id'], source_utterance_id='u1',
            text_sha256=hashlib.sha256(first['text'].encode()).hexdigest()), first['speaker_source'])
        self.assertTrue(all('confirmed_speaker' not in r for r in imported[1:]))
        self.assertTrue(all('voice' not in r and 'role' not in r and 'speaker' not in r for r in imported))

    def test_explicit_different_person_id_cannot_reuse_a_same_display_name(self):
        row = copy.deepcopy(ROW)
        row['utterances'][0]['review']['speaker_person_id'] = 'another-team-alice'
        self.assertNotIn('confirmed_speaker', self.bundle(row=row)['meeting']['utterances'][0])
        row['utterances'][0]['review']['speaker_person_id'] = ROSTER[ALICE]
        self.assertEqual(ALICE, self.bundle(row=row)['meeting']['utterances'][0]['confirmed_speaker'])
        with self.assertRaises(ValueError):
            self.bundle(roster=[ALICE, ALICE])

    def test_source_reviews_map_is_supported_without_promoting_raw_machine_speaker(self):
        row = copy.deepcopy(ROW)
        row['reviews'] = {'u1': row['utterances'][0].pop('review')}
        out = self.bundle(row=row)
        self.assertEqual(ALICE, out['meeting']['utterances'][0]['confirmed_speaker'])
        self.assertNotIn('confirmed_speaker', out['meeting']['utterances'][1])

    def test_unsafe_clip_ids_have_stable_aliases_and_explicit_origin_mapping(self):
        row, analysis = copy.deepcopy(ROW), copy.deepcopy(ANALYSIS)
        unsafe = '一句话:原句/编号#' + 'x' * 55
        row['utterances'][0]['id'] = unsafe
        analysis['actions'][0]['ids'][0] = unsafe
        out = self.bundle(row=row, analysis=analysis)
        first = out['meeting']['utterances'][0]
        self.assertRegex(first['id'], r'^[A-Za-z0-9_-]{1,40}$')
        self.assertNotEqual(unsafe, first['id'])
        self.assertEqual(unsafe, first['origin_id'])
        self.assertEqual(unsafe, out['meeting']['origin_id_map'][first['id']])
        self.assertEqual(unsafe, first['speaker_source']['source_utterance_id'])
        self.assertEqual(first['id'], out['items']['items'][0]['evidence'][0][0])
        self.assertEqual(out, self.bundle(row=row, analysis=analysis))

    def test_alias_collision_with_a_real_safe_id_does_not_overwrite_evidence(self):
        row = copy.deepcopy(ROW)
        unsafe = 'source:unsafe'
        collision = 'u-' + hashlib.sha256(unsafe.encode()).hexdigest()[:32]
        row['utterances'][0]['id'] = unsafe
        row['utterances'][1]['id'] = collision
        analysis = dict(actions=[dict(task='处理明确事项', ids=[unsafe, collision])])
        imported = self.bundle(row=row, analysis=analysis)['meeting']['utterances']
        self.assertEqual(collision, imported[1]['id'])
        self.assertNotEqual(collision, imported[0]['id'])
        self.assertEqual(4, len({r['id'] for r in imported}))

    def test_missing_evidence_and_empty_titles_are_dropped_without_partial_support(self):
        analysis = dict(actions=[dict(task='无出处事项', ids=[]), dict(task='部分依据已经丢失', ids=['u1', 'missing'])],
                        decisions=[dict(text='', ids=['u1'])], undecided=[dict(topic='确实还没定', ids=['u4'])])
        out = self.bundle(analysis=analysis)['items']
        self.assertEqual(3, out['dropped'])
        self.assertEqual(['确实还没定'], [item['title'] for item in out['items']])

    def test_evidence_splits_at_gaps_and_at_180_seconds_without_adding_uncited_rows(self):
        row = copy.deepcopy(ROW)
        row['utterances'] = [dict(id='a', text='第一句', start_ms=0, end_ms=100000),
            dict(id='b', text='第二句', start_ms=100001, end_ms=200000),
            dict(id='context', text='未引用的上下文', start_ms=200001, end_ms=201000),
            dict(id='c', text='第三句', start_ms=220000, end_ms=250000)]
        analysis = dict(actions=[dict(task='整理三处原话支持的行动', ids=['c', 'a', 'b'])])
        out = self.bundle(row=row, analysis=analysis)
        self.assertEqual([['a'], ['b'], ['c']], out['items']['items'][0]['evidence'])
        self.assertNotIn('context', [uid for span in out['items']['items'][0]['evidence'] for uid in span])
        row['utterances'][0]['end_ms'] = 180001
        self.assertEqual([], self.bundle(row=row, analysis=analysis)['items']['items'])

    def test_import_is_deterministic_does_not_mutate_inputs_and_does_no_io(self):
        row, analysis = copy.deepcopy(ROW), copy.deepcopy(ANALYSIS)
        before = copy.deepcopy((row, analysis, ROSTER))
        with patch('builtins.open', side_effect=AssertionError('conversion must do no file I/O')), \
             patch('urllib.request.urlopen', side_effect=AssertionError('conversion must do no network I/O')):
            first = build_bundle(row, analysis, FINGERPRINT, 'm-new001', ROSTER)
            second = build_bundle(row, analysis, FINGERPRINT, 'm-new001', ROSTER)
        self.assertEqual(first, second)
        self.assertEqual(before, (row, analysis, ROSTER))

    def test_identity_hint_changes_do_not_change_item_fingerprints_or_selected_owner(self):
        first = self.bundle()
        row = copy.deepcopy(ROW)
        row['utterances'][0]['review']['speaker'] = BOB
        row['utterances'][0]['speaker'] = ALICE
        second = self.bundle(row=row)
        self.assertEqual([i['fingerprint'] for i in first['items']['items']], [i['fingerprint'] for i in second['items']['items']])
        self.assertEqual(first['items']['source_hash'], second['items']['source_hash'])
        self.assertTrue(all('owner' not in i for i in second['items']['items']))
        self.assertEqual(first['meeting']['source_revision'], second['meeting']['source_revision'])
        row['updated_at'] = '2027-01-01T00:00:00Z'
        third = self.bundle(row=row)
        self.assertEqual(second, third)

    def test_original_text_or_saved_summary_change_changes_source_revision(self):
        first = self.bundle()
        row = copy.deepcopy(ROW)
        row['utterances'][0]['text'] += '原文更新。'
        changed = self.bundle(row=row)
        self.assertNotEqual(first['meeting']['source_revision'], changed['meeting']['source_revision'])
        self.assertNotEqual(first['items']['items'][0]['fingerprint'], changed['items']['items'][0]['fingerprint'])
        analysis = copy.deepcopy(ANALYSIS)
        analysis['actions'][0]['task'] += '并测试'
        changed = self.bundle(analysis=analysis)
        self.assertNotEqual(first['meeting']['source_revision'], changed['meeting']['source_revision'])

    def test_standard_item_loader_accepts_bundle_with_allowed_import_version(self):
        out = self.bundle()
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / 'items.json'
            target.write_text(json.dumps(out['items']), encoding='utf-8')
            with patch.object(label_items, 'READ_PROMPT_VERSIONS', (*label_items.READ_PROMPT_VERSIONS, PROMPT_VERSION)):
                loaded = label_items.load_items(str(target), out['meeting']['utterances'], 'm-new001', [])
            self.assertEqual(out['items'], loaded)

    def test_explicit_daily_expired_deleted_and_invalid_sources_are_rejected(self):
        for field, value in [('transcript_status', 'expired'), ('deleted', True), ('analysis_invalidated', True), ('recording_mode', 'daily')]:
            with self.subTest(field=field):
                row = copy.deepcopy(ROW)
                row[field] = value
                with self.assertRaises(ValueError):
                    self.bundle(row=row)
        row = copy.deepcopy(ROW)
        row['storage_policy']['cloud_save_confirmed'] = False
        with self.assertRaises(ValueError):
            self.bundle(row=row)
        row = copy.deepcopy(ROW)
        row['utterances'][1]['id'] = 'u1'
        with self.assertRaises(ValueError):
            self.bundle(row=row)
        with self.assertRaises(ValueError):
            build_bundle(ROW, ANALYSIS, 'old', '../escape', ROSTER)


if __name__ == '__main__':
    unittest.main()
