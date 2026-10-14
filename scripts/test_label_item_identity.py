"""Identity-to-item integration on temporary meetings, without model/service calls."""
import json
import os
import unittest
import uuid

import label_item_identity as identity
import label_items as li
import team_label as tl
from test_label_items import Fixture, Fake, RAW, BLIND


class ClaimLanguage(unittest.TestCase):
    def test_explicit_first_person_actions(self):
        for text in ("我去问一下对接人。", "那我来负责这个。", "我再问一下那个姐姐回我。",
                     "那我周五前把新方案发你。", "我明天提交申请。", "我申请。"):
            with self.subTest(text=text):
                self.assertTrue(identity.is_claim(text))

    def test_negation_questions_quotes_hypotheticals_and_completed_actions_are_not_claims(self):
        for text in ("我不负责。", "我不会提交。", "我已经申请了。", "我发了申请。", "我申请过。",
                     "我来问一下吗？", "我负责这个？", "如果我来做就好了。", "比如我来申请。",
                     "他说我来负责。", "他说‘我来负责’。", "他说“我来负责”。", "我觉得应该申请。",
                     "我们要开发这个功能。", "你去问一下。", "我刚才去问了。",
                     "不是我负责，是古月负责。", "不用我做。", "你帮我发一下。", "我做不了。", "我做不到。",
                     "他说：我来做。", "我申请已经通过了。", "我负责的模块已经完成。", "我可以做，但这次我不做。"):
            with self.subTest(text=text):
                self.assertFalse(identity.is_claim(text))


class ItemIdentity(Fixture):
    def setUp(self):
        super().setUp()
        self._blind = li.blind_ids
        li.blind_ids = lambda folder, mid, rows: list(BLIND)
        self.addCleanup(setattr, li, "blind_ids", self._blind)
        with open(os.path.join(self.folder, 'meetings', '0235', 'voice.json'), 'w') as stream:
            json.dump({'rows': {'u3-1': {'name': tl.PEOPLE[0]}}}, stream)
        self.data = tl.Data(self.folder)
        self.model = Fake(RAW)
        self.generate(self.model)

    def group(self, speaker, action='confirm'):
        group = self.data.identity_payload(tl.PEOPLE[0])['groups'][0]
        return self.data.review_identity(tl.PEOPLE[0], dict(request_id=uuid.uuid4().hex,
            revision=self.data.identity_payload(tl.PEOPLE[0])['revision'], action=action,
            group=group['id'], fingerprint=group['fingerprint'], speaker=speaker))

    def test_shared_names_and_exact_claim_quote_reach_every_person_without_assigning_owner(self):
        self.group(tl.PEOPLE[1])
        for person in tl.PEOPLE:
            task = self.payload(person)['items'][0]
            self.assertEqual(task['speakers'], [tl.PEOPLE[1]])
            self.assertEqual(task['claimants'][0]['speaker'], tl.PEOPLE[1])
            self.assertEqual(task['claimants'][0]['ids'], ['u3-1'])
            self.assertEqual(task['claimant_status'], 'identified')
            self.assertTrue(task['claimants'][0]['speaker_source']['shared'])
            self.assertIsNone(task['review'])
            self.assertNotIn('owner', task)
        self.assertEqual(len(self.model.calls), 1)

    def test_identity_changes_update_clues_but_keep_previously_confirmed_owner_and_item_version(self):
        self.group(tl.PEOPLE[1])
        task = self.payload()['items'][0]
        self.act(action='confirm', item=task['id'], fingerprint=task['fingerprint'], owner=tl.PEOPLE[0])
        self.group(tl.PEOPLE[2])
        changed = self.payload()['items'][0]
        self.assertEqual(changed['id'], task['id'])
        self.assertEqual(changed['fingerprint'], task['fingerprint'])
        self.assertEqual(changed['claimants'][0]['speaker'], tl.PEOPLE[2])
        self.assertEqual(changed['review']['owner'], tl.PEOPLE[0])
        self.group(tl.PEOPLE[2], 'revoke')
        revoked = self.payload()['items'][0]
        self.assertIsNone(revoked['claimants'][0]['speaker'])
        self.assertEqual(revoked['claimant_status'], 'identity_pending')
        self.assertEqual(revoked['review']['owner'], tl.PEOPLE[0])

    def test_individual_sentence_correction_precedes_shared_group_without_affecting_others(self):
        self.group(tl.PEOPLE[1])
        person = tl.PEOPLE[0]
        doc = self.data.meeting_payload('0235', person)
        row = next(r for r in doc['rows'] if r['id'] == 'u3-1')
        self.data.review('0235', person, dict(request_id=uuid.uuid4().hex, revision=doc['revision'],
            action='set', scope='row', id=row['id'], fingerprint=row['fingerprint'],
            field='speaker', value=tl.PEOPLE[2]))
        self.assertEqual(self.payload(person)['items'][0]['claimants'][0]['speaker'], tl.PEOPLE[2])
        self.assertEqual(self.payload(tl.PEOPLE[3])['items'][0]['claimants'][0]['speaker'], tl.PEOPLE[1])
        _, meetings = li._meetings(self.folder)
        self.assertIn(tl.PEOPLE[1], li.build_request(*meetings['0235'])['user'])
        self.assertNotIn(tl.PEOPLE[2], li.build_request(*meetings['0235'])['user'])

    def test_existing_v1_items_remain_readable(self):
        path = li.items_path(self.folder, '0235')
        with open(path) as stream:
            doc = json.load(stream)
        doc['prompt_version'] = 'items-v1'
        li.atomic_write(path, doc)
        self.assertEqual(self.payload()['status'], 'ready')

    def test_human_added_item_cannot_keep_old_confirmation_after_same_id_source_edit(self):
        added = self.act(action='add', kind='task', title='问对接人', owner=tl.PEOPLE[0], ids=['u3-1'])
        human = next(it for it in added['items'] if it['source'] == 'human')
        path = os.path.join(self.folder, 'meetings', '0235', 'meeting.json')
        with open(path) as stream:
            meeting = json.load(stream)
        next(r for r in meeting['utterances'] if r['id'] == 'u3-1')['text'] = '我去问新的对接人。'
        with open(path, 'w') as stream:
            json.dump(meeting, stream)
        current = next(it for it in self.payload()['items'] if it['source'] == 'human')
        self.assertTrue(current['stale_review'])
        self.assertIsNone(current['review'])
        with self.assertRaises(tl.RevisionConflict):
            self.act(action='confirm', item=human['id'], fingerprint=human['fingerprint'], owner=tl.PEOPLE[0])
        confirmed = self.act(action='confirm', item=human['id'], fingerprint=current['fingerprint'], owner=tl.PEOPLE[0])
        self.assertEqual(confirmed['counts']['confirmed'], 1)

    def test_new_generation_uses_confirmed_names_and_new_quote_detects_identity_change(self):
        self.group(tl.PEOPLE[1])
        _, meetings = li._meetings(self.folder)
        request = li.build_request(*meetings['0235'])
        self.assertIn('已确认说话人：' + tl.PEOPLE[1], request['user'])
        self.assertNotIn('盲测', request['user'])
        quote = li.quote(meetings, 'fake-model', 2, 8, max_tokens=1000)
        self.group(tl.PEOPLE[2])
        _, changed = li._meetings(self.folder)
        model = Fake(RAW)
        with self.assertRaisesRegex(ValueError, 'quoted_source_changed'):
            li.generate(self.folder, changed, quote, 1, quote['quote_hash'], model)
        self.assertEqual(model.calls, [])

    def test_added_evidence_later_reserved_for_blind_test_is_never_exposed_or_confirmed(self):
        added = self.act(action='add', kind='task', title='问对接人', owner=tl.PEOPLE[0], ids=['u3-1'])
        human = next(it for it in added['items'] if it['source'] == 'human')
        li.blind_ids = lambda folder, mid, rows: list(BLIND) + ['u3-1']
        self.assertEqual(self.payload()['items'], [])
        with self.assertRaises(tl.RevisionConflict):
            self.act(action='confirm', item=human['id'], fingerprint=human['fingerprint'], owner=tl.PEOPLE[0])


if __name__ == '__main__':
    unittest.main()
