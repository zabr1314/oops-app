import copy
import unittest
from meeting_curation import operation_hash, split_tasks, transcript_view


class CurationTest(unittest.TestCase):
    def test_noise_folded_but_current_human_verdict_and_full_source_stay(self):
        rows = [dict(id='a', text='嗯。'), dict(id='b', text='随便聊聊', tag='chitchat'),
                dict(id='c', text='已确认的有用原话', tag='chitchat', review=dict(verdict='confirmed')),
                dict(id='d', text='需要更多信息', tag='uncertain'),
                dict(id='e', text='嗯。', review=dict(verdict='confirmed'))]
        before = copy.deepcopy(rows)
        self.assertEqual(['a', 'b'], transcript_view(rows)['folded_ids'])
        self.assertEqual(before, rows)

    def test_only_explicit_unchanged_operation_is_archived_without_external_write(self):
        op = dict(op_id='test-op', request=dict(draft=dict(what='服务器验收测试')))
        items = [dict(op_id='test-op', what='测试', feishu=dict(state='open')),
                 dict(op_id='work-op', what='正式业务任务', feishu=dict(state='open'))]
        policy = dict(schema=1, entries={'test-op': dict(action='archive', request_hash=operation_hash(op), reason='验收测试')})
        before = copy.deepcopy((op, items, policy))
        active, archived = split_tasks(items, [op], policy)
        self.assertEqual(['work-op'], [x['op_id'] for x in active])
        self.assertEqual('open', archived[0]['feishu']['state'])
        self.assertEqual(before, (op, items, policy))
        op['request']['draft']['what'] = '正式任务变更'
        self.assertEqual(items, split_tasks(items, [op], policy)[0])
        self.assertEqual(items, split_tasks(items, [op], {})[0])


if __name__ == '__main__': unittest.main()
