"""Ordinary facts keep citations through generation, voting and cached reads."""
import copy
import unittest

import minutes_vote
from minutes_quality import project
from test_feishu_actions import EMPTY, FakeResolver
from test_minutes_review_invalidation import fixture, review


class TopicSourcesTest(unittest.TestCase):
    def source_minutes(self):
        answer = dict(EMPTY, substantive=True, theme='评审', topics=[
            dict(topic='版本范围', points=['先看第一版'], ids=['u4', 'missing', 'u4'])])
        return fixture(resolver=FakeResolver(dict(analysis=answer)))

    def test_topic_only_minutes_keep_real_ids_and_return_clickable_source_without_a_task(self):
        actions, meetings, calls, resolver = self.source_minutes()
        saved = actions.state.get('meetings', 's', 'analysis')
        self.assertEqual(['u4'], saved['topics'][0]['ids'])
        self.assertEqual([], saved['actions'])
        self.assertEqual([], saved['decisions'])
        asked = resolver.asked
        view = actions.minutes_view(meetings.load('s'))
        self.assertEqual('available', view['minutes']['topics'][0]['source_status'])
        self.assertEqual(['u4'], list(view['sources']))
        self.assertEqual('先看第一版', view['sources']['u4']['text'])
        self.assertEqual(asked, resolver.asked)
        self.assertEqual([], calls)

    def test_legacy_topic_is_explicitly_unrecorded_and_never_matches_current_text_to_invent_ids(self):
        actions, meetings, _, resolver = self.source_minutes()
        cached = actions.state.get('meetings', 's', 'analysis')
        cached['topics'][0].pop('ids')
        actions.state.put(cached, 'meetings', 's', 'analysis')
        before = copy.deepcopy(cached)
        asked = resolver.asked
        view = actions.minutes_view(meetings.load('s'))
        self.assertEqual('unrecorded', view['minutes']['topics'][0]['source_status'])
        self.assertEqual({}, view['sources'])
        self.assertEqual(before, actions.state.get('meetings', 's', 'analysis'))
        self.assertEqual(asked, resolver.asked)

    def test_source_revision_hides_old_topic_and_preserves_history_without_regeneration(self):
        actions, meetings, calls, resolver = self.source_minutes()
        before = copy.deepcopy(actions.state.get('meetings', 's', 'analysis'))
        asked = resolver.asked
        review(actions, 'u4', speaker='洪玉麟')
        view = actions.minutes_view(meetings.load('s'))
        self.assertEqual('source_changed', view['reason'])
        self.assertNotIn('minutes', view)
        self.assertNotIn('sources', view)
        self.assertEqual(before, actions.state.get('meetings', 's', 'analysis'))
        self.assertEqual(asked, resolver.asked)
        self.assertEqual([], calls)

    def test_incomplete_or_expired_topic_citations_cannot_be_presented_as_available(self):
        analysis = dict(EMPTY, topics=[dict(topic='预算', points=['五千'], ids=['u1', 'gone'])])
        row = dict(utterances=[dict(id='u1', text='预算五千')])
        self.assertEqual('unavailable', project(analysis, row)['topics'][0]['source_status'])
        analysis['topics'][0]['ids'] = ['u1']
        row['transcript_status'] = 'expired'
        self.assertEqual('unavailable', project(analysis, row)['topics'][0]['source_status'])

    def test_vote_keeps_the_selected_topic_and_its_own_citations_together(self):
        base = dict(EMPTY, substantive=True, topics=[dict(topic='版本范围', points=['先看第一版'], ids=['u4'])])
        runs = [copy.deepcopy(base) for _ in range(3)]
        runs[2]['topics'] = [dict(topic='另一个议题', points=['不同内容'], ids=['u2'])]
        result = minutes_vote.vote(runs)
        self.assertEqual(['u4'], result['topics'][0]['ids'])
        self.assertNotIn('u2', result['topics'][0]['ids'])


if __name__ == '__main__':
    unittest.main()
