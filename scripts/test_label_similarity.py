import unittest

from label_similarity import SimilarityIndex, normalize_text


def unit(uid, text, kind="fact", ids=None):
    return dict(id=uid, ids=ids or ["row:" + uid], text=text, kind=kind, fingerprint="source:" + uid)


class SimilarityTests(unittest.TestCase):
    def test_punctuation_and_fillers_are_normalized(self):
        a = "对啊，嗯，这台设备内置麦克风。"
        b = "这台设备内置麦克风！"
        self.assertEqual(normalize_text(a), normalize_text(b))
        index = SimilarityIndex([unit("a", a), unit("b", b)])
        self.assertEqual(index.matches("a", 80)[0]["score"], 100)

    def test_does_not_remove_content_prefix(self):
        self.assertEqual(normalize_text("对比结果比较稳定。"), "对比结果比较稳定")
        self.assertEqual(normalize_text("这个设备有麦克风。"), "这个设备有麦克风")

    def test_wording_similarity_has_a_transparent_score(self):
        index = SimilarityIndex([unit("a", "这台设备内置麦克风，可以语音唤醒。"),
                                 unit("b", "这台设备内置麦克风，也可以语音唤醒。")])
        member = index.matches("a", 80)[0]
        self.assertGreaterEqual(member["score"], 80)
        self.assertLess(member["score"], 100)
        self.assertEqual(member["method"], "text-char-v1")
        self.assertEqual(member["fingerprint"], "source:b")
        self.assertEqual(member["ids"], ["row:b"])

    def test_same_kind_is_not_sufficient(self):
        index = SimilarityIndex([unit("a", "这台设备内置麦克风。"), unit("b", "会议定在下周五下午。")])
        self.assertEqual(index.matches("a", 60), [])

    def test_different_kinds_are_never_matches(self):
        index = SimilarityIndex([unit("a", "这台设备内置麦克风。"),
                                 unit("b", "这台设备内置麦克风。", "info")])
        self.assertEqual(index.score("a", "b"), 0)

    def test_tasks_decisions_and_uncertain_are_excluded(self):
        units = [unit("a", "稍后处理一下设备问题。", "info")]
        units.extend(unit(kind, units[0]["text"], kind) for kind in ("task", "decision", "uncertain"))
        index = SimilarityIndex(units)
        self.assertEqual(set(index.units), {"a"})
        self.assertEqual(index.matches("task", 60), [])

    def test_blind_atomic_ids_and_unit_ids_cannot_reenter(self):
        text = "这台设备内置麦克风。"
        index = SimilarityIndex([unit("a", text), unit("b", text, ids=["x", "blind"]), unit("c", text)],
                                excluded_ids=["blind", "c"])
        self.assertEqual(index.matches("a", 60, allowed_ids=["b", "c"]), [])
        self.assertEqual(set(index.units), {"a"})

    def test_negative_statement_is_rejected(self):
        index = SimilarityIndex([unit("a", "这台设备内置麦克风，可以语音唤醒。"),
                                 unit("b", "这台设备没有内置麦克风，不可以语音唤醒。")])
        self.assertEqual(index.matches("a", 60), [])

    def test_swapped_negative_objects_are_rejected(self):
        index = SimilarityIndex([unit("a", "没有麦克风但有扬声器。"),
                                 unit("b", "有麦克风但没有扬声器。")])
        self.assertEqual(index.score("a", "b"), 0)

    def test_numbers_dates_and_quantities_must_match(self):
        for a, b in [("目前有 12 台设备正常连接。", "目前有 13 台设备正常连接。"),
                     ("明天上午测试这台设备。", "今天上午测试这台设备。"),
                     ("目前有三台设备正常连接。", "目前有两台设备正常连接。"),
                     ("价格大概是 10.5 元左右。", "价格大概是 10.6 元左右。")]:
            with self.subTest(a=a):
                self.assertEqual(SimilarityIndex([unit("a", a), unit("b", b)]).score("a", "b"), 0)

    def test_brands_and_explicit_known_chinese_names_must_match(self):
        for a, b, terms in [("目前 DJI 的设备连接正常。", "目前 Sony 的设备连接正常。", []),
                            ("洪玉麟之前说设备连接正常。", "林春源之前说设备连接正常。", ["洪玉麟", "林春源"])]:
            with self.subTest(a=a):
                self.assertEqual(SimilarityIndex([unit("a", a), unit("b", b)], protected_terms=terms).score("a", "b"), 0)

    def test_name_cue_and_vocative_guard(self):
        for a, b in [("负责人是张三，设备已连接。", "负责人是李四，设备已连接。"),
                     ("张三，设备已经连接成功。", "李四，设备已经连接成功。")]:
            with self.subTest(a=a):
                self.assertEqual(SimilarityIndex([unit("a", a), unit("b", b)]).score("a", "b"), 0)

    def test_short_expressions_only_match_exact_normalized_text(self):
        index = SimilarityIndex([unit("a", "可以", "noise"), unit("b", "可以。", "noise"), unit("c", "不可以", "noise")])
        self.assertEqual([member["id"] for member in index.matches("a", 60)], ["b"])

    def test_pure_acknowledgements_remain_available(self):
        index = SimilarityIndex([unit("a", "嗯嗯。", "noise"), unit("b", "嗯，嗯", "noise"),
                                 unit("c", "嗯。", "noise"), unit("d", "啊。", "noise")])
        self.assertEqual([member["id"] for member in index.matches("a", 80)], ["b", "c"])

    def test_filter_limit_and_stable_sort(self):
        text = "这台设备内置麦克风。"
        index = SimilarityIndex([unit("c", text), unit("a", text), unit("b", text)])
        self.assertEqual([member["id"] for member in index.matches("a")], ["b", "c"])
        self.assertEqual([member["id"] for member in index.matches("a", allowed_ids=["c"])], ["c"])
        self.assertEqual([member["id"] for member in index.matches("a", limit=1)], ["b"])
        self.assertEqual(index.matches("missing"), [])

    def test_anchor_matches_do_not_form_a_transitive_cluster(self):
        index = SimilarityIndex([unit("a", "这台设备内置麦克风，可以语音唤醒。"),
                                 unit("b", "这台设备内置麦克风，也可以语音唤醒。"),
                                 unit("c", "另一台设备也可以语音唤醒，还有蓝牙连接。")])
        # Direct scoring is the contract, even when a caller reuses the index
        # after reviewing another member. No stored union/find group exists.
        matches = index.matches("a", 60)
        self.assertEqual(matches, index.matches("a", 60))
        self.assertTrue(all(index.score("a", m["id"]) >= .6 for m in matches))

    def test_rejects_invalid_threshold_and_limit(self):
        index = SimilarityIndex([unit("a", "这台设备内置麦克风。")])
        for threshold in [True, 0, 50, 100, "80", .8]:
            with self.subTest(threshold=threshold):
                self.assertRaises(ValueError, index.matches, "a", threshold)
        for limit in [0, 101, True, 1.5]:
            with self.subTest(limit=limit):
                self.assertRaises(ValueError, index.matches, "a", limit=limit)

    def test_input_and_result_cannot_mutate_the_index(self):
        text = "这台设备内置麦克风。"
        items = [unit("a", text), unit("b", text)]
        index = SimilarityIndex(items)
        items[1]["ids"].append("late")
        found = index.matches("a")
        found[0]["ids"].append("tamper")
        self.assertEqual(index.matches("a")[0]["ids"], ["row:b"])

    def test_duplicate_unit_id_fails_closed(self):
        self.assertRaises(ValueError, SimilarityIndex, [unit("a", "这台设备内置麦克风。"), unit("a", "设备连接正常。")])


if __name__ == "__main__":
    unittest.main()
