package com.oops.app.backend

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class RetainedTaskEvidenceTest {
    private fun history() = JSONObject().put("session_id", "meeting-1").put("transcript_status", "expired")
        .put("utterances", JSONArray().put(JSONObject().put("id", "full").put("text", "不应读全文")))
        .put("retained_evidence", JSONArray().put(JSONObject().put("id", "u1").put("text", "周五前发方案")
            .put("start_ms", 1000).put("end_ms", 2000).put("speaker", "洪玉麟").put("confirmed", true).put("source_status", "available")))
    @Test fun opensOnlyExplicitlySelectedCurrentConfirmedShortEvidence() {
        val rows = RetainedTaskEvidence.select(history(), "meeting-1", listOf("u1"))!!
        assertEquals(1, rows.size)
        assertEquals("周五前发方案", rows.single().text)
        assertEquals("洪玉麟", rows.single().speaker)
        assertNull(RetainedTaskEvidence.select(history(), "meeting-1", listOf("full")))
        assertNull(RetainedTaskEvidence.select(history(), "other-meeting", listOf("u1")))
        assertNull(RetainedTaskEvidence.select(history(), "meeting-1", listOf("u1", "u1")))
    }
    @Test fun changedUnconfirmedUnknownAndOverlongCopiesCannotBeReopened() {
        for ((key, value) in listOf("source_status" to "changed", "source_status" to "unknown", "confirmed" to false, "text" to "字".repeat(281))) {
            val copy = history().apply { getJSONArray("retained_evidence").getJSONObject(0).put(key, value) }
            assertNull(RetainedTaskEvidence.select(copy, "meeting-1", listOf("u1")))
        }
    }
    @Test fun currentManualSpeakerWinsWithoutRestoringOriginalText() {
        val copy = history().apply { getJSONArray("retained_evidence").getJSONObject(0).put("review", JSONObject().put("speaker", "江古月")) }
        val row = RetainedTaskEvidence.select(copy, "meeting-1", listOf("u1"))!!.single()
        assertEquals("江古月", row.speaker)
        assertTrue(row.words.isEmpty() && row.segments.isEmpty())
    }
    @Test fun cleanupExpiredFullTranscriptStillAllowsItsIndependentlyConfirmedExcerpt() {
        val cleaned = history().apply {
            put("utterances", JSONArray())
            getJSONArray("retained_evidence").getJSONObject(0).put("source_status", "expired")
        }
        val row = RetainedTaskEvidence.select(cleaned, "meeting-1", listOf("u1"))!!.single()
        assertEquals("周五前发方案", row.text)
        assertTrue(cleaned.getJSONArray("utterances").length() == 0)
        cleaned.getJSONArray("retained_evidence").getJSONObject(0).put("confirmed", false)
        assertNull(RetainedTaskEvidence.select(cleaned, "meeting-1", listOf("u1")))
    }
}
