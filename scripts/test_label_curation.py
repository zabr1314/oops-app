"""Temporary data only: cleanup, human precedence, owner gate and reversible originals."""
import copy
import hashlib
import json
from pathlib import Path
import unittest

import content_curation as cc
import label_items as li
import label_curation as lc
from test_label_items import Fixture, Fake, RAW, ROWS, BLIND, tl


class CurationIntegration(Fixture):
    def setUp(self):
        super().setUp()
        original_blind = li.blind_ids
        li.blind_ids = lambda *_: list(BLIND)
        self.addCleanup(setattr, li, 'blind_ids', original_blind)
        self.generate(Fake(RAW))
        doc, _, _ = li.items_state(self.data, '0235')
        self.originals = doc['items']
        items = lc.canonical(self.originals)
        order = {r['id']: i for i, r in enumerate(ROWS)}
        plan = dict(schema=1, meeting_id='0235', source_hash=cc.source_hash(ROWS), origin_items_hash=cc.origin_items_hash(items),
            sentences=[dict(id=r['id'], mode='context', reason='保留来源') for r in ROWS], summary=[],
            item_ops=[dict(action='merge', item_ids=[i['id'] for i in items], kind='task', title='整理接口方案并核对输出',
                           reason='同一交付的步骤', evidence_ids=sorted({u for i in items for u in i['evidence_ids']}, key=order.__getitem__))])
        self.path = Path(self.folder) / 'curation/0235.json'
        self.path.parent.mkdir()
        self.path.write_text(json.dumps(plan, ensure_ascii=False))

    def test_read_preserves_originals_and_answers_and_never_confirms_owner(self):
        source = Path(li.items_path(self.folder, '0235'))
        before = source.read_bytes()
        out = self.payload()
        active = [i for i in out['items'] if not i['curation']['suppressed']]
        self.assertEqual(1, len(active))
        self.assertEqual(2, out['counts']['curated'])
        self.assertEqual(1, out['counts']['todo'])
        self.assertIsNone(active[0]['review'])
        self.assertFalse(active[0]['claimed'])
        self.assertTrue(all(c.get('speaker') is None for c in active[0]['claimants']))
        self.assertEqual(before, source.read_bytes())
        self.assertFalse((Path(self.folder) / 'item-reviews').exists())
        with self.assertRaises(ValueError):
            self.act(action='confirm', item=active[0]['id'], fingerprint=active[0]['fingerprint'])

    def test_current_human_answer_protects_whole_merge_for_that_person(self):
        original = self.originals[0]
        self.act(action='confirm', item=original['id'], fingerprint=original['fingerprint'], owner=tl.PEOPLE[0])
        mine = self.payload()
        self.assertEqual([i['id'] for i in self.originals], [i['id'] for i in mine['items']])
        self.assertEqual(tl.PEOPLE[0], mine['items'][0]['review']['owner'])
        other = self.payload(tl.PEOPLE[1])
        self.assertEqual(1, other['counts']['todo'])
        self.assertTrue(any(i['source'] == 'curated' for i in other['items']))

    def test_merged_candidate_can_be_confirmed_only_with_human_owner(self):
        merged = next(i for i in self.payload()['items'] if i['source'] == 'curated')
        done = self.act(action='confirm', item=merged['id'], fingerprint=merged['fingerprint'], owner=tl.PEOPLE[1])
        current = next(i for i in done['items'] if i['id'] == merged['id'])
        self.assertEqual(tl.PEOPLE[1], current['review']['owner'])
        self.assertEqual(1, done['counts']['confirmed'])

    def test_restore_is_personal_and_undoable_without_business_confirmation(self):
        original = next(i for i in self.payload()['items'] if i['id'] == self.originals[0]['id'])
        restored = self.act(action='reopen', item=original['id'], fingerprint=original['fingerprint'])
        self.assertEqual(2, restored['counts']['todo'])
        self.assertTrue(all(i['review'] is None for i in restored['items']))
        self.assertEqual(1, self.payload(tl.PEOPLE[1])['counts']['todo'])
        undo = self.act(action='undo')
        self.assertEqual(1, undo['counts']['todo'])

    def test_manual_merge_preserves_its_unreviewed_destination(self):
        first, second = self.originals
        plan = json.loads(self.path.read_text())
        plan['item_ops'] = [dict(action='keep', item_id=first['id'], reason='保留'),
                            dict(action='suppress', item_id=second['id'], reason='整理收起')]
        self.path.write_text(json.dumps(plan))
        out = self.act(action='merge', item=first['id'], fingerprint=first['fingerprint'], into=second['id'])
        self.assertEqual(1, out['counts']['todo'])
        target = next(i for i in out['items'] if i['id'] == second['id'])
        self.assertFalse(target['curation']['suppressed'])
        self.assertIsNone(target['review'])
        # Keeping the manual merge target does not assign an owner or copy this
        # person's answer into another person's view.
        self.assertEqual(0, out['counts']['confirmed'])
        self.assertEqual(1, self.payload(tl.PEOPLE[1])['counts']['todo'])
        undone = self.act(action='undo')
        self.assertTrue(next(i for i in undone['items'] if i['id'] == second['id'])['curation']['suppressed'])

    def test_manual_merge_chain_is_protected_but_stale_edges_are_not(self):
        originals = copy.deepcopy(self.originals)
        third = copy.deepcopy(originals[1])
        third['title'] = '核对第三项输出'
        third['fingerprint'] = li.item_fingerprint(third, {r['id']: r for r in ROWS})
        third['id'] = 'ai-' + third['fingerprint'][:12]
        originals.append(third)
        a, b, c = originals
        plan = json.loads(self.path.read_text())
        plan['origin_items_hash'] = cc.origin_items_hash(lc.canonical(originals))
        plan['item_ops'] = [dict(action='keep', item_id=i['id'], reason='保留') for i in (a, b)] + [
            dict(action='suppress', item_id=c['id'], reason='整理收起')]
        self.path.write_text(json.dumps(plan))
        reviews = {a['id']: dict(status='merged', into=b['id'], fingerprint=a['fingerprint']),
                   b['id']: dict(status='merged', into=c['id'], fingerprint=b['fingerprint'])}
        state = dict(state=dict(reviews=reviews))
        out, meta = lc.project_items(self.data, '0235', tl.PEOPLE[0], dict(items=originals), state, BLIND)
        self.assertEqual('ready', meta['status'])
        self.assertTrue(all(not i['curation']['suppressed'] for i in out))
        reviews[b['id']]['fingerprint'] = 'stale-source-fingerprint'
        out, _ = lc.project_items(self.data, '0235', tl.PEOPLE[0], dict(items=originals), state, BLIND)
        self.assertTrue(next(i for i in out if i['id'] == c['id'])['curation']['suppressed'])
        self.assertEqual('stale-source-fingerprint', reviews[b['id']]['fingerprint'])

    def test_restore_original_cannot_hide_confirmed_curated_result(self):
        merged = next(i for i in self.payload()['items'] if i['source'] == 'curated')
        original = self.originals[0]
        self.act(action='confirm', item=merged['id'], fingerprint=merged['fingerprint'], owner=tl.PEOPLE[1])
        review_path = Path(li._reviews_path(self.data, '0235', tl.PEOPLE[0]))
        before = review_path.read_bytes()
        with self.assertRaisesRegex(ValueError, '先在该事项撤回确认'):
            self.act(action='reopen', item=original['id'], fingerprint=original['fingerprint'])
        self.assertEqual(before, review_path.read_bytes())
        current = next(i for i in self.payload()['items'] if i['id'] == merged['id'])
        self.assertEqual('confirmed', current['review']['status'])
        self.assertEqual(tl.PEOPLE[1], current['review']['owner'])
        # An explicit withdrawal is required before the original merge group
        # can be restored, so restoring cannot silently remove a human answer.
        self.act(action='reopen', item=merged['id'], fingerprint=merged['fingerprint'])
        out = self.act(action='reopen', item=original['id'], fingerprint=original['fingerprint'])
        self.assertEqual(2, out['counts']['todo'])
        self.assertEqual(0, out['counts']['confirmed'])
        self.assertTrue(all(i['review'] is None for i in out['items']))

    def test_stale_or_blind_summary_cannot_silently_replace_current_items(self):
        plan = json.loads(self.path.read_text())
        plan['source_hash'] = 'f' * 64
        self.path.write_text(json.dumps(plan))
        out = self.payload()
        self.assertEqual('needs_review', out['curation']['status'])
        self.assertEqual([i['id'] for i in self.originals], [i['id'] for i in out['items']])
        plan['source_hash'] = cc.source_hash(ROWS)
        plan['summary'] = [dict(text='不能借整理泄露盲测', evidence_ids=['u4-1'])]
        self.path.write_text(json.dumps(plan))
        out = self.payload()
        self.assertEqual('needs_review', out['curation']['status'])
        self.assertEqual(['reserved_source'], out['curation']['errors'])


if __name__ == '__main__': unittest.main()
