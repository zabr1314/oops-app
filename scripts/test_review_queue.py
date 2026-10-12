#!/usr/bin/env python3
"""Post-meeting review: with minutes, only the sentences they rest on; without, every tagged line as before."""
import tempfile
import unittest

from meeting_features import Meetings, review_queue

ROWS = [dict(id="u1", text="那你等我一下我马上回来", tag="commitment", speaker=None),
        dict(id="u2", text="周五前把方案发给春源", tag="commitment", speaker=None),
        dict(id="u3", text="那就先做声纹识别", tag="decision", speaker="洪玉麟"),
        dict(id="u4", text="今天天气真不错啊大家", tag="idea", speaker=None),
        dict(id="u5", text="这个板子先不买了", tag="idea", speaker=None)]


class ReviewQueueTest(unittest.TestCase):
    def test_without_minutes_every_tagged_line_and_unknown_speaker_is_checked(self):
        kinds = [(q["kind"], q["id"]) for q in review_queue(ROWS)]
        self.assertIn(("commitment", "u1"), kinds)
        self.assertIn(("speaker", "u4"), kinds)

    def test_with_minutes_only_their_sentences_are_checked(self):
        queue = review_queue(ROWS, {"tasks": {"u2"}, "decisions": {"u3", "u5"}})
        self.assertEqual([("commitment", "u2"), ("decision", "u3"), ("decision", "u5"), ("speaker", "u2"), ("speaker", "u5")],
                         [(q["kind"], q["id"]) for q in queue])  # u5 counts though tagged as an idea: the minutes cite it

    def test_reviewed_sentences_leave_and_minutes_without_items_leave_nothing(self):
        rows = [dict(u, review={"verdict": "confirmed", "speaker": "林春源"}) if u["id"] == "u2" else u for u in ROWS]
        self.assertEqual([], [q for q in review_queue(rows, {"tasks": {"u2"}, "decisions": set()})])
        self.assertEqual([], review_queue(ROWS, {"tasks": set(), "decisions": set()}))

    def test_meetings_ask_for_the_minutes_citations_when_loading(self):
        with tempfile.TemporaryDirectory() as folder:
            asked = []
            meetings = Meetings(folder, cited=lambda sid: asked.append(sid) or {"tasks": {"u2"}, "decisions": set()})
            meetings.sync({"session_id": "meeting-1", "started_at": "2026-10-12T09:00:00+08:00", "time_zone": "Asia/Shanghai",
                           "utterances": [dict(u, start_ms=i * 1000, end_ms=i * 1000 + 900) for i, u in enumerate(ROWS)]})
            row = meetings.load("meeting-1")
            self.assertEqual([("commitment", "u2"), ("speaker", "u2")], [(q["kind"], q["id"]) for q in row["review_queue"]])
            self.assertIn("meeting-1", asked)

    def test_the_minutes_topic_names_a_meeting_nobody_named(self):
        with tempfile.TemporaryDirectory() as folder:
            meetings = Meetings(folder, cited=lambda sid: {"tasks": set(), "decisions": set(), "theme": "录音豆 App 的 MVP 范围"})
            meetings.sync({"session_id": "meeting-2", "started_at": "2026-10-12T09:00:00+08:00", "time_zone": "Asia/Shanghai",
                           "utterances": [dict(u, start_ms=i * 1000, end_ms=i * 1000 + 900) for i, u in enumerate(ROWS)]})
            row = meetings.load("meeting-2")
            self.assertEqual(("录音豆 App 的 MVP 范围", "minutes"), (row["display_title"], row["title_source"]))
            meetings.rename({"session_id": "meeting-2", "title": "周会"})
            self.assertEqual(("周会", "manual"), (meetings.load("meeting-2")["display_title"], meetings.load("meeting-2")["title_source"]))


if __name__ == "__main__":
    unittest.main()
