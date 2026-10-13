package com.oops.app.backend

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.security.MessageDigest

class TaskBoardPolicyTest {
    private val current = TaskBoardPolicy.Context("meeting-1", 3, "https://service.example", 4, "meeting", false)
    private val text = "周五前把方案发给大家"
    private fun binding(kind: String = "transcript", id: String = "u1", session: String = current.sessionId) = JSONObject()
        .put("version", 1).put("session_id", session).put("sources", JSONArray().put(JSONObject()
            .put("id", id).put("kind", kind).put("text_hash", MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it.toInt() and 255) })
            .put("source_revision", "server-revision-1").put("quote", text).put("speaker", JSONObject.NULL).put("review", JSONObject())))
    private fun task(kind: String = "transcript", id: String = "u1") = JSONObject().put("id", "t-$id")
        .put("what", "发方案").put("priority", "P0").put("status", "open").put("sources", JSONArray().put(id))
        .put("source_binding", binding(kind, id))
    private fun board(vararg tasks: JSONObject) = JSONObject().put("session_id", current.sessionId)
        .put("tasks", JSONArray(tasks.toList())).put("updated_at", "same-time").put("pending", true)

    @Test fun lateCallbackCannotCrossServiceCredentialsOrSession() {
        assertTrue(TaskBoardPolicy.accepts(current, current))
        assertFalse(TaskBoardPolicy.accepts(current, current.copy(serviceEpoch = 4)))
        assertFalse(TaskBoardPolicy.accepts(current, current.copy(backendUrl = "https://other.example")))
        assertFalse(TaskBoardPolicy.accepts(current, current.copy(sessionId = "meeting-2")))
    }
    @Test fun sourceMutationExpiryAndDailyAllRevokeAnInflightRead() {
        assertFalse(TaskBoardPolicy.accepts(current, current.copy(sourceRevision = 5)))
        assertFalse(TaskBoardPolicy.accepts(current, current.copy(transcriptExpired = true)))
        assertFalse(TaskBoardPolicy.accepts(current.copy(mode = "daily"), current.copy(mode = "daily")))
        assertFalse(TaskBoardPolicy.accepts(current.copy(sessionId = ""), current.copy(sessionId = "")))
    }
    @Test fun formalMeetingCaptionPruningDoesNotWithdrawArchivedSources() {
        // The local five-minute transcript may no longer contain u1; the signed archive binding remains usable.
        val filtered = TaskBoardPolicy.filter(board(task()), current, emptyMap())!!
        assertEquals(1, filtered.getJSONArray("tasks").length())
        assertEquals(current.serviceEpoch, filtered.getLong("serviceEpoch"))
        assertEquals(current.sourceRevision, filtered.getLong("sourceRevision"))
        assertFalse(board(task()).has("serviceEpoch"))
    }
    @Test fun actualExpiryKeepsOnlyIndependentlyRetainedEvidence() {
        val filtered = TaskBoardPolicy.filter(board(task(), task("saved_excerpt", "u2")), current.copy(transcriptExpired = true))!!
        assertEquals(listOf("t-u2"), (0 until filtered.getJSONArray("tasks").length()).map { filtered.getJSONArray("tasks").getJSONObject(it).getString("id") })
    }
    @Test fun contextDependencyMustAlsoSurviveExpiryAndLocalCorrection() {
        val value = task("saved_excerpt").apply {
            getJSONObject("source_binding").put("context_sources", binding("transcript", "u-context").getJSONArray("sources"))
        }
        assertEquals(0, TaskBoardPolicy.filter(board(value), current.copy(transcriptExpired = true))!!.getJSONArray("tasks").length())
        assertEquals(0, TaskBoardPolicy.filter(board(value), current, blockedSources = setOf("u-context"))!!.getJSONArray("tasks").length())
        assertEquals(0, TaskBoardPolicy.filter(board(value), current, speakers = mapOf("u-context" to "洪玉麟"))!!.getJSONArray("tasks").length())
        value.getJSONObject("source_binding").getJSONArray("context_sources").getJSONObject(0).put("kind", "saved_excerpt")
        assertEquals(1, TaskBoardPolicy.filter(board(value), current.copy(transcriptExpired = true))!!.getJSONArray("tasks").length())
    }
    @Test fun newSpeakerOrOneChangedSourceKeepsUnrelatedExistingTasks() {
        val original = board(task(), task("transcript", "u2"))
        assertEquals(2, TaskBoardPolicy.withoutSources(original, setOf("new-speech")).getJSONArray("tasks").length())
        val remaining = TaskBoardPolicy.withoutSources(original, setOf("u1")).getJSONArray("tasks")
        assertEquals(1, remaining.length())
        assertEquals("t-u2", remaining.getJSONObject(0).getString("id"))
        assertEquals(2, original.getJSONArray("tasks").length())
    }
    @Test fun modifiedOrUnsavedLocalSourceCannotReenterThroughFreshBoard() {
        assertEquals(0, TaskBoardPolicy.filter(board(task()), current, mapOf("u1" to "下周再发"))!!.getJSONArray("tasks").length())
        assertEquals(0, TaskBoardPolicy.filter(board(task()), current, blockedSources = setOf("u1"))!!.getJSONArray("tasks").length())
        assertEquals(1, TaskBoardPolicy.filter(board(task()), current, mapOf("u1" to text))!!.getJSONArray("tasks").length())
    }
    @Test fun oldSpeakerOrReviewSnapshotCannotReturnBeforeSyncCatchesUp() {
        assertEquals(0, TaskBoardPolicy.filter(board(task()), current, speakers = mapOf("u1" to "洪玉麟"))!!.getJSONArray("tasks").length())
        assertEquals(0, TaskBoardPolicy.filter(board(task()), current, reviews = mapOf("u1" to mapOf("verdict" to "rejected")))!!.getJSONArray("tasks").length())
        assertEquals(1, TaskBoardPolicy.filter(board(task()), current, speakers = mapOf("u1" to null), reviews = mapOf("u1" to emptyMap()))!!.getJSONArray("tasks").length())
    }
    @Test fun inventedLegacyOrForeignSourcesAreNeverDisplayedAsCurrentTasks() {
        val missing = task().apply { remove("source_binding") }
        val foreign = task().put("source_binding", binding(session = "other-meeting"))
        val mismatch = task().put("sources", JSONArray().put("u2"))
        assertEquals(0, TaskBoardPolicy.filter(board(missing, foreign, mismatch), current)!!.getJSONArray("tasks").length())
        assertNull(TaskBoardPolicy.filter(board(task()).put("session_id", "other-meeting"), current))
        assertNull(TaskBoardPolicy.filter(board(task()), current.copy(mode = "daily")))
    }
    @Test fun emptyServerResultClearsOldTasksEvenWhenUpdatedAtDidNotChange() {
        val before = TaskBoardPolicy.filter(board(task()), current)!!
        val after = TaskBoardPolicy.filter(board(), current)!!
        assertEquals(before.getString("updated_at"), after.getString("updated_at"))
        assertNotEquals(before.toString(), after.toString())
        assertEquals(0, after.getJSONArray("tasks").length())
    }
}
