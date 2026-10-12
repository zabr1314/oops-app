#!/usr/bin/env python3
"""The running task list keeps only what the meeting supports: sources, known ids, known people."""
import unittest

import task_board as tb


class Fake:
    def __init__(self, answer):
        self.answer = answer

    def complete_json(self, system, user, timeout=40):
        return self.answer, "fake"


CONTEXT = [dict(id="u7", text="那就先把 App 跑通", speaker="林春源"), dict(id="u8", text="我来列 P0", speaker="洪玉麟")]
BOARD = [dict(id="t1", what="订酒店", owner="", priority="P3", status="open", sources=["u2"], reason="")]


class UpdateTest(unittest.TestCase):
    def test_new_merged_and_reranked_tasks_keep_their_sources(self):
        model = Fake({"tasks": [
            {"id": "t1", "what": "订酒店", "owner": "", "priority": "P3", "status": "dropped", "sources": [], "reason": "主办方已安排"},
            {"id": "new", "what": "列出 P0 功能点", "owner": "洪玉麟", "priority": "P0", "status": "open", "sources": ["u8"]},
            {"id": "new", "what": "编造的任务", "priority": "P0", "sources": ["u99"]},  # no real source: ignored
            {"id": "new", "what": "派给外人", "owner": "张三", "priority": "P9", "sources": ["u7"]}]})
        board = tb.update(model, BOARD, [dict(what="列 P0", owner="", source="u8")], CONTEXT)
        by = {t["what"]: t for t in board}
        self.assertEqual("dropped", by["订酒店"]["status"])
        self.assertEqual(("t2", "P0", "洪玉麟", ["u8"]), (by["列出 P0 功能点"]["id"], by["列出 P0 功能点"]["priority"],
                                                       by["列出 P0 功能点"]["owner"], by["列出 P0 功能点"]["sources"]))
        self.assertNotIn("编造的任务", by)
        self.assertEqual(("", "P2"), (by["派给外人"]["owner"], by["派给外人"]["priority"]))  # unknown person and priority

    def test_a_task_the_model_forgets_is_kept(self):
        board = tb.update(Fake({"tasks": []}), BOARD, [], CONTEXT)
        self.assertEqual(["t1"], [t["id"] for t in board])
        self.assertFalse(board[0]["changed"])


class BoardsTest(unittest.TestCase):
    def test_drafts_are_folded_in_on_a_background_thread_and_saved(self):
        import tempfile
        import time
        model = Fake({"tasks": [{"id": "new", "what": "列出 P0 功能点", "owner": "洪玉麟", "priority": "P0", "status": "open",
                                 "sources": ["u8"]}]})
        with tempfile.TemporaryDirectory() as folder:
            boards = tb.Boards(folder, model, log=lambda _: None)
            boards.submit("sess-0001", [dict(what="列 P0", owner="", source="u8")], CONTEXT)
            deadline = time.monotonic() + 3
            while boards.view("sess-0001")["pending"] and time.monotonic() < deadline:
                time.sleep(0.02)
            view = boards.view("sess-0001")
            self.assertEqual(["列出 P0 功能点"], [t["what"] for t in view["tasks"]])
            self.assertFalse(view["pending"])
            self.assertEqual(view["tasks"], tb.Boards(folder, None).view("sess-0001")["tasks"])  # survives a restart
            with self.assertRaises(ValueError):
                boards.view("../etc")


if __name__ == "__main__":
    unittest.main()
