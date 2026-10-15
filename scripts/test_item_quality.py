"""Source-quality regressions from 0239/0240 plus ordinary meeting commitments; no network."""
import unittest

from item_quality import assess_item


CLOUD = ('很快。嗯，啊，是是不是？对不对？然后就说有什么问题就马上说。嗯，我们就不要被一些问题给卡壳。'
         '嗯，啊，举个例子，就像那个 cloud 那个问题，嗯，是不是？如果缺了，如果他那边有，我们立马买。'
         '嗯，不要关心钱的问题，现在钱不是问题。嗯，你以为做事，钱不是问题。嗯，钱只是用来换资源的。')
VERSION = [dict(id='u000021', text='是你那边先上传。一版是不是？然后我这边 AI 审批。确认，然后再把你这个这一版迭代到我们最新的。'),
           dict(id='u000022', text='现在呃差不多做做出一百。嗯。做出一百以后，然后就是呃就是上上机号就好了。嗯。上机。'),
           dict(id='u000032', text='这个代码的问题嘛，把这两个就叠成一百就好了。嗯。'),
           dict(id='u000033', text='对吧？然后一版以后，就再再去再去再去再去，我们再去更新。啊，这更新是什么呢？更新 UI 和这个和设计。')]


class QualityTest(unittest.TestCase):
    def assess(self, title, text, **kwargs):
        return assess_item(title, [dict(id='u1', text=text)], **kwargs)

    def test_actual_cloud_example_is_not_a_purchase_commitment(self):
        for quote in (CLOUD, '我们立马买'):
            with self.subTest(quote=quote):
                result = assess_item('如果那边有cloud就立马买', [dict(id='u15', text=quote)],
                                     [dict(id='u15', text=CLOUD)])
                self.assertEqual(('rejected', 'example_or_hypothesis'), (result['status'], result['reason']))
                self.assertEqual(['u15'], result['ids'])

    def test_actual_communication_principle_is_not_open_work(self):
        result = self.assess('有问题马上说，不要被问题卡壳', CLOUD)
        self.assertEqual(('rejected', 'generic_principle'), (result['status'], result['reason']))

    def test_actual_version_homophone_stays_a_question_never_auto_corrected(self):
        for title in ('将 OOPS 代码叠出一百版，并更新 UI 与交互设计', '将两份代码合并为一版'):
            result = assess_item(title, VERSION[1:3], VERSION)
            self.assertEqual(('needs_review', 'quantity_ambiguity'), (result['status'], result['reason']))
            self.assertEqual(['u000022', 'u000032'], result['ids'])

    def test_invented_number_and_changed_unit_need_review(self):
        for title, source, reason in [('采购10台服务器', '采购服务器', 'unsupported_quantity'),
                                      ('提交100版报告', '提交一百份报告', 'quantity_unit_conflict')]:
            result = self.assess(title, source)
            self.assertEqual(('needs_review', reason), (result['status'], result['reason']))

    def test_real_multiple_quantities_and_chinese_arabic_equivalence_are_valid(self):
        result = self.assess('采购2台服务器，提交3份报价，预算2000元',
                             '我来采购两台服务器，明天提交三份报价，预算二千元。')
        self.assertEqual('accepted', result['status'])

    def test_p0_and_version_identifiers_are_not_invented_quantities(self):
        result = self.assess('列出 P0 功能点', '我来列 P0')
        self.assertEqual('accepted', result['status'])

    def test_actual_table_counter_paraphrase_is_not_a_unit_conflict(self):
        result = self.assess('让成员把各自所有想法写在一张表上',
                             '他们先把自己的所有的想法都全部写在一个表上。啊。我再用 AI 来筛选。')
        self.assertEqual('accepted', result['status'])

    def test_explicit_report_count_is_not_confused_with_nearby_code_version(self):
        result = self.assess('提交100份报告', '明天我来提交一百份报告。',
                             context=[dict(id='u0', text='这份代码一版就可以了。'),
                                      dict(id='u1', text='明天我来提交一百份报告。')])
        self.assertEqual('accepted', result['status'])

    def test_currency_chinese_and_arabic_count_the_same_amount(self):
        result = self.assess('采购服务器，预算100万元', '我来采购服务器，预算一百万元。')
        self.assertEqual('accepted', result['status'])

    def test_actual_week_paraphrase_does_not_quarantine_a_real_deadline(self):
        result = self.assess('搭建自媒体矩阵并在一周内完成',
                             '相当于这个这一块自媒体矩阵，我们要把这个这个月一个星期，我们就要把它完全给搭建好。')
        self.assertEqual('accepted', result['status'])

    def test_concrete_normal_task_and_conditional_real_promise_are_preserved(self):
        for title, text in [('提交客户报告', '明天我来提交客户报告。'),
                            ('修复登录接口', '如果测试失败，我会修复登录接口。'),
                            ('采购服务器', '如果服务器坏了，我们立马买服务器。')]:
            with self.subTest(text=text):
                self.assertEqual('accepted', self.assess(title, text)['status'])

    def test_uncommitted_condition_remains_reviewable(self):
        result = self.assess('采购服务器', '如果缺服务器就买服务器。')
        self.assertEqual(('needs_review', 'conditional_commitment_unconfirmed'),
                         (result['status'], result['reason']))

    def test_completed_negated_and_hypothetical_actions_are_rejected(self):
        for text, reason in [('报告已经发给客户了。', 'already_completed'),
                             ('不用发报告给客户。', 'negated_or_cancelled'),
                             ('假设客户要报告，我们马上发报告。', 'example_or_hypothesis')]:
            with self.subTest(text=text):
                result = self.assess('发送客户报告', text)
                self.assertEqual(('rejected', reason), (result['status'], result['reason']))

    def test_deadlines_and_past_noun_modifiers_are_not_completed_actions(self):
        for text in ('下班之前提交报告。', '把昨天整理的报告提交给客户。', '把已经写好的报告提交给客户。'):
            with self.subTest(text=text):
                self.assertEqual('accepted', self.assess('提交客户报告', text)['status'])
        for text in ('报告已经提交给客户。', '昨天提交报告。', '之前提交过报告。', '报告已提交。'):
            with self.subTest(text=text):
                self.assertEqual('rejected', self.assess('提交客户报告', text)['status'])

    def test_mixed_long_source_keeps_independent_actual_action(self):
        for text in ('不用买服务器，明天我来修复登录接口。',
                     '报告已经发给客户。明天我来修复登录接口。',
                     '举个例子，如果缺服务器就买。另外，明天我来修复登录接口。'):
            with self.subTest(text=text):
                self.assertEqual('accepted', self.assess('修复登录接口', text)['status'])

    def test_supporting_noun_quote_does_not_override_example_scope(self):
        result = assess_item('采购两台服务器',
                             [dict(id='u1', text='举个例子，我们买两台服务器。'),
                              dict(id='u0', text='两台服务器', support_only=True)])
        self.assertEqual('rejected', result['status'])

    def test_unrelated_context_does_not_supply_an_invented_quantity(self):
        result = self.assess('提交三份报告', '我来提交报告。', context=[dict(id='u0', text='这里有三份发票')])
        self.assertEqual('needs_review', result['status'])

    def test_missing_sources_remain_a_question(self):
        self.assertEqual('needs_review', assess_item('发报告', [])['status'])


if __name__ == '__main__':
    unittest.main()
