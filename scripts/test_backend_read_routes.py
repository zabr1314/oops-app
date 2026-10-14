#!/usr/bin/env python3
"""Local authenticated read-route regression tests; no model or Feishu calls."""

import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from types import SimpleNamespace

import task_board
from local_backend import Backend, Handler, Operations
from meeting_features import Meetings


class MinutesCache:
    """A stored response, deliberately separate from meeting detail."""

    def __init__(self):
        self.response = {"status": "pending", "reason": "writing"}
        self.reads = []

    def minutes_view(self, row):
        self.reads.append(row["session_id"])
        return dict(self.response)


class ReadRoutesTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.meetings = Meetings(self.directory.name)
        self.meetings.sync({
            "session_id": "meeting-safe",
            "started_at": "2026-10-12T09:00:00+08:00",
            "time_zone": "Asia/Shanghai",
            "utterances": [{"id": "u1", "text": "先核对这条会议决定。",
                            "start_ms": 0, "end_ms": 1000, "tag": "decision"}],
        })
        self.minutes = MinutesCache()
        self.boards = task_board.Boards(self.directory.name + "/boards", None)
        self.backend = Backend.__new__(Backend)
        self.backend.meetings, self.backend.feishu, self.backend.boards = self.meetings, self.minutes, self.boards
        self.backend.ops = Operations(self.directory.name + '/operations')

        class Protected(Handler):
            api_token = "test-read-route-only"
            enroll_secret = ""

        Protected.backend = self.backend
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Protected)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.directory.cleanup()

    def get(self, path, authenticated=True):
        headers = {"Authorization": "Bearer test-read-route-only"} if authenticated else {}
        request = urllib.request.Request(
            "http://127.0.0.1:" + str(self.server.server_port) + path, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=3) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            with error:
                return error.code, json.load(error)

    def test_detail_and_query_read_the_same_stable_meeting_id(self):
        status, expected = self.get("/v1/meetings/meeting-safe")
        self.assertEqual(status, 200)
        for suffix in ("?refresh=1", "?source=web&retry=2", "?", "?id=other"):
            with self.subTest(suffix=suffix):
                status, detail = self.get("/v1/meetings/meeting-safe" + suffix)
                self.assertEqual(status, 200)
                self.assertEqual(detail, expected)
        self.assertEqual(self.minutes.reads, [])

    def test_nested_and_trailing_paths_are_not_interpreted_as_detail(self):
        for path in ("/v1/meetings/unexpected/meeting-safe",
                     "/v1/meetings/meeting-safe/",
                     "/v1/meetings/meeting-safe/minutes/meeting-safe",
                     "/v1/meetings/meeting-safe/minutes/",
                     "/v1/meetings//meeting-safe"):
            with self.subTest(path=path):
                status, result = self.get(path)
                self.assertEqual(status, 404)
                self.assertEqual(result["error"]["code"], "NOT_FOUND")
        self.assertEqual(self.minutes.reads, [])

    def test_missing_and_invalid_detail_ids_keep_existing_errors(self):
        for path, expected in (("/v1/meetings/missing?refresh=1", 404),
                               ("/v1/meetings/bad.id?refresh=1", 400)):
            with self.subTest(path=path):
                status, result = self.get(path)
                self.assertEqual(status, expected)
                self.assertIn("error", result)

    def test_board_route_reads_the_running_task_list(self):
        status, empty = self.get("/v1/meetings/meeting-safe/board")
        self.assertEqual((status, empty["tasks"], empty["pending"]), (200, [], False))
        with open(self.boards.path("meeting-safe"), "w", encoding="utf-8") as f:
            json.dump({"tasks": [{"id": "t1", "what": "列出 P0 功能点", "priority": "P0", "status": "open", "sources": ["u1"]}],
                       "updated_at": "2026-10-12T12:00:00+00:00"}, f, ensure_ascii=False)
        status, board = self.get("/v1/meetings/meeting-safe/board?refresh=1")
        self.assertEqual((status, board["session_id"], board["tasks"]), (200, "meeting-safe", []))
        self.assertEqual(board['review_queue'][0]['quality']['reason'], 'evidence_missing')
        self.assertEqual(board['review_queue'][0]['priority'], 'P0')
        self.assertEqual('u1', board['review_queue'][0]['source_binding']['sources'][0]['id'])
        self.assertEqual(self.get("/v1/meetings/meeting-safe/board", authenticated=False)[0], 401)
        self.assertEqual(self.get("/v1/meetings/bad.id/board")[0], 400)
        self.assertEqual(self.minutes.reads, [])

    def test_minutes_queries_preserve_current_cached_status_and_never_return_detail(self):
        cases = (
            {"status": "ready", "minutes": {"version": 1, "overview": "已存的纪要"},
             "sources": {}, "doc_url": None},
            {"status": "pending", "reason": "in_progress"},
            {"status": "pending", "reason": "writing"},
            {"status": "unavailable", "reason": "source_changed",
             "message": "来源已变化", "historical_doc_url": "https://example.invalid/history"},
            {"status": "unavailable", "reason": "before_bot"},
            {"status": "unavailable", "reason": "no_end"},
            {"status": "unavailable", "reason": "failed"},
        )
        for cached in cases:
            with self.subTest(cached=cached):
                self.minutes.response = cached
                for suffix in ("", "?refresh=1"):
                    status, result = self.get("/v1/meetings/meeting-safe/minutes" + suffix)
                    self.assertEqual(status, 200)
                    self.assertEqual(result, {"session_id": "meeting-safe", **cached})
                    self.assertNotIn("utterances", result)
                    if cached.get("reason") == "source_changed":
                        self.assertNotIn("minutes", result)
                        self.assertNotIn("doc_url", result)
        self.assertEqual(len(self.minutes.reads), len(cases) * 2)

    def test_minutes_without_bot_is_unavailable_and_missing_meeting_is_404(self):
        self.backend.feishu = None
        status, result = self.get("/v1/meetings/meeting-safe/minutes?refresh=1")
        self.assertEqual((status, result), (200, {
            "session_id": "meeting-safe", "status": "unavailable", "reason": "bot_off"}))
        status, result = self.get("/v1/meetings/missing/minutes?refresh=1")
        self.assertEqual(status, 404)
        self.assertEqual(result["error"]["code"], "NOT_FOUND")
        status, result = self.get("/v1/meetings/bad.id/minutes?refresh=1")
        self.assertEqual(status, 400)
        self.assertEqual(result["error"]["code"], "BAD_REQUEST")

    def test_detail_and_minutes_still_require_full_service_auth(self):
        for path in ("/v1/meetings/meeting-safe?refresh=1",
                     "/v1/meetings/meeting-safe/minutes?refresh=1"):
            with self.subTest(path=path):
                status, result = self.get(path, authenticated=False)
                self.assertEqual(status, 401)
                self.assertEqual(result["error"]["code"], "UNAUTHORIZED")
        self.assertEqual(self.minutes.reads, [])


if __name__ == "__main__":
    unittest.main()
