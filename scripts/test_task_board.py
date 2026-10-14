#!/usr/bin/env python3
"""The running task list keeps only what the meeting supports: sources, known ids, known people."""
import unittest

import task_board as tb
from test_item_quality import CLOUD, VERSION


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

    def test_real_examples_and_generic_principles_never_become_open_tasks(self):
        context = [dict(id='u15', text=CLOUD)]
        model = Fake({'tasks': [dict(id='new', what=what, sources=['u15'], status='open')
                                for what in ('如果那边有cloud就立马买', '有问题马上说，不要被问题卡壳')]})
        self.assertEqual([], tb.update(model, [], [dict(what='候选', source='u15')], context))

    def test_numeric_ambiguity_is_saved_only_as_a_review_candidate(self):
        model = Fake({'tasks': [dict(id='new', what='将 OOPS 代码叠出一百版', sources=['u000032'], status='open')]})
        board = tb.update(model, [], [dict(what='叠代码', source='u000032')], VERSION)
        self.assertEqual('needs_review', board[0]['status'])
        self.assertEqual('quantity_ambiguity', board[0]['quality']['reason'])


class BoardsTest(unittest.TestCase):
    def test_legacy_quality_read_is_derived_preserves_file_and_closed_history(self):
        import tempfile
        import json
        from pathlib import Path
        rows = [dict(id='u15', text=CLOUD)] + VERSION
        old = [dict(id='t1', what='有问题马上说，不要被问题卡壳', status='open', sources=['u15']),
               dict(id='t2', what='将 OOPS 代码叠出一百版', status='open', sources=['u000032']),
               dict(id='t3', what='如果那边有cloud就立马买', status='done', sources=['u15']),
               dict(id='t4', what='有问题马上说', status='dropped', sources=['u15'])]
        with tempfile.TemporaryDirectory() as folder:
            boards = tb.Boards(folder, None, source_rows=lambda sid: rows)
            path = Path(boards.path('sess-0001'))
            path.write_text(json.dumps(dict(tasks=old, source_hashes=boards._hashes('sess-0001'))))
            original = path.read_bytes()
            view = boards.view('sess-0001')
            self.assertEqual(old[2:], view['tasks'])
            self.assertEqual(['t1', 't2'], [t['id'] for t in view['review_queue']])
            self.assertEqual(['rejected', 'needs_review'], [t['quality']['status'] for t in view['review_queue']])
            self.assertEqual(original, path.read_bytes())

    def test_unknown_legacy_evidence_is_a_question_without_rewriting(self):
        import tempfile
        import json
        from pathlib import Path
        with tempfile.TemporaryDirectory() as folder:
            boards = tb.Boards(folder, None)
            path = Path(boards.path('sess-0001'))
            path.write_text(json.dumps(dict(tasks=BOARD)))
            original = path.read_bytes()
            view = boards.view('sess-0001')
            self.assertEqual([], view['tasks'])
            self.assertEqual('evidence_missing', view['review_queue'][0]['quality']['reason'])
            self.assertEqual(original, path.read_bytes())

    def test_review_candidates_survive_later_model_batches_without_entering_tasks(self):
        import tempfile
        model = Fake({'tasks': [dict(id='new', what='将 OOPS 代码叠出一百版', sources=['u000032'], status='open')]})
        with tempfile.TemporaryDirectory() as folder:
            boards = tb.Boards(folder, model, source_rows=lambda sid: VERSION)
            boards.queues['sess-0001'] = [([dict(what='叠代码', source='u000032')], VERSION)]
            boards.running.add('sess-0001')
            boards._work('sess-0001')
            self.assertEqual([], boards.view('sess-0001')['tasks'])
            self.assertEqual(1, len(boards.view('sess-0001')['review_queue']))
            model.answer = {'tasks': []}
            boards.queues['sess-0001'] = [([dict(what='更新 UI', source='u000033')], VERSION)]
            boards.running.add('sess-0001')
            boards._work('sess-0001')
            self.assertEqual([], boards.view('sess-0001')['tasks'])
            self.assertEqual(1, len(boards.view('sess-0001')['review_queue']))

    def test_new_conversation_during_generation_does_not_cancel_supported_tasks(self):
        import tempfile
        rows = list(CONTEXT)
        class MoreConversation:
            def complete_json(self, *args, **kwargs):
                rows.append(dict(id='u9', text='接着讨论下一项', speaker=None))
                return {'tasks':[dict(id='new',what='列 P0',priority='P0',sources=['u8'])]}, 'fake'
        with tempfile.TemporaryDirectory() as folder:
            boards = tb.Boards(folder, MoreConversation(), source_rows=lambda sid: rows)
            boards.queues['sess-0001'] = [([dict(what='列 P0',source='u8')],CONTEXT)]
            boards.running.add('sess-0001')
            boards._work('sess-0001')
            self.assertEqual(['列 P0'], [t['what'] for t in boards.view('sess-0001')['tasks']])

    def test_temporary_daily_context_is_never_sent_to_board_model_or_saved(self):
        import tempfile
        from pathlib import Path
        class Never:
            def complete_json(self, *args, **kwargs):
                raise AssertionError('daily board generation must not run')
        with tempfile.TemporaryDirectory() as folder:
            boards = tb.Boards(folder, Never(), source_rows=lambda sid: None)
            boards.submit('daily-0001', [dict(what='列 P0', source='u8')], CONTEXT)
            self.assertEqual([], boards.view('daily-0001')['tasks'])
            self.assertEqual([], list(Path(folder).iterdir()))

    def test_expiry_or_correction_during_generation_cannot_save_a_late_board(self):
        import tempfile
        from pathlib import Path
        for expired in (False, True):
            rows = list(CONTEXT)
            class Changed:
                def complete_json(self, *args, **kwargs):
                    rows.clear()
                    if not expired: rows.extend([dict(CONTEXT[0]), dict(CONTEXT[1], text='先不用做了')])
                    return {'tasks':[dict(id='new',what='列 P0',priority='P0',sources=['u8'])]}, 'fake'
            with tempfile.TemporaryDirectory() as folder:
                boards = tb.Boards(folder, Changed(), source_rows=lambda sid: rows or None)
                boards.queues['sess-0001'] = [([dict(what='列 P0', source='u8')], CONTEXT)]
                boards.running.add('sess-0001')
                boards._work('sess-0001')
                self.assertEqual([], list(Path(folder).iterdir()))

    def test_saved_board_withdraws_changed_sources_and_is_deleted_after_expiry(self):
        import tempfile
        import json
        from pathlib import Path
        rows = list(CONTEXT)
        with tempfile.TemporaryDirectory() as folder:
            boards = tb.Boards(folder, None, source_rows=lambda sid: rows or None)
            path = Path(boards.path('sess-0001'))
            path.write_text(json.dumps(dict(tasks=[dict(what='列 P0', sources=['u8'])],source_hashes=boards._hashes('sess-0001'))))
            self.assertEqual(1, len(boards.view('sess-0001')['tasks']))
            rows[1] = dict(rows[1], review={'verdict':'rejected'})
            self.assertEqual([], boards.view('sess-0001')['tasks'])
            rows.clear(); boards.cleanup()
            self.assertFalse(path.exists())

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
