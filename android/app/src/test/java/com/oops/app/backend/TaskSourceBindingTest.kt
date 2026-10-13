package com.oops.app.backend

import com.oops.app.store.ActionOperationStore
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class TaskSourceBindingTest {
    @get:Rule val folder = TemporaryFolder()
    private fun binding() = JSONObject().put("version", 1).put("session_id", "meeting-1")
        .put("sources", JSONArray().put(JSONObject().put("id", "u1").put("kind", "transcript")
            .put("text_hash", "a".repeat(64)).put("source_revision", "revision-1").put("quote", "请发方案")
            .put("speaker", JSONObject.NULL).put("review", JSONObject())))
    private fun draft(value: String? = binding().toString()) = ActionDraft("d1", "c1", "洪玉麟", "发方案", null, null, null,
        listOf("洪玉麟"), Evidence(listOf("u1"), "请发方案", 0, 1000, value))

    @Test fun exactServerSourceIsRequiredAndQuoteCannotBeEdited() {
        assertTrue(TaskSourceBinding.valid(binding().toString(), "meeting-1", listOf("u1"), "请发方案"))
        assertFalse(TaskSourceBinding.valid(null, "meeting-1", listOf("u1")))
        assertFalse(TaskSourceBinding.valid(binding().toString(), "other-meeting", listOf("u1")))
        assertFalse(TaskSourceBinding.valid(binding().toString(), "meeting-1", listOf("u2")))
        assertFalse(TaskSourceBinding.valid(binding().toString(), "meeting-1", listOf("u1"), "另一个要求"))
    }
    @Test fun duplicateIdsMalformedHashAndUnknownKindFailClosed() {
        val duplicate = binding().apply { getJSONArray("sources").put(getJSONArray("sources").getJSONObject(0)) }
        assertFalse(TaskSourceBinding.valid(duplicate.toString(), "meeting-1", listOf("u1", "u1")))
        for ((key, value) in listOf("text_hash" to "wrong", "source_revision" to "", "kind" to "manual", "quote" to "字".repeat(281))) {
            val malformed = binding().apply { getJSONArray("sources").getJSONObject(0).put(key, value) }
            assertFalse(TaskSourceBinding.valid(malformed.toString(), "meeting-1", listOf("u1")))
        }
    }
    @Test fun longUnicodeExcerptUsesTheSameCodePointLimitAsBackend() {
        val value = binding().apply { getJSONArray("sources").getJSONObject(0).put("quote", "😀".repeat(280)) }
        assertTrue(TaskSourceBinding.valid(value.toString(), "meeting-1", listOf("u1")))
    }
    @Test fun transcriptExpiryNeedsSavedExcerptForNewBoardButFrozenConfirmationCanBeRevalidatedByServer() {
        assertFalse(TaskSourceBinding.valid(binding().toString(), "meeting-1", listOf("u1"), retainedOnly = true))
        val saved = binding().apply { getJSONArray("sources").getJSONObject(0).put("kind", "saved_excerpt") }
        assertTrue(TaskSourceBinding.valid(saved.toString(), "meeting-1", listOf("u1"), retainedOnly = true))
        assertTrue(TaskSourceBinding.valid(binding().toString(), "meeting-1", listOf("u1")))
    }
    @Test fun sourceBindingSurvivesStoreRestartAndRetryWithoutPayloadUpgrade() {
        val value = binding().put("proof", "server-signature").put("context_sources", JSONArray().put(
            binding().getJSONArray("sources").getJSONObject(0).put("id", "u-context")))
        val request = ConfirmRequest("op-1", "meeting-1", draft(value.toString()))
        val wire = ApiJson.confirmRequest(request).toString()
        val store = ActionOperationStore(folder.newFolder())
        store.save(ActionOperationStore.Operation(request, "https://service.example", false, ActionResult("op-1", "pending")))
        val restored = store.list().single().request
        assertEquals(value.toString(), restored.draft.evidence.sourceBinding)
        assertEquals(wire, ApiJson.confirmRequest(restored).toString())
        assertEquals(wire, ApiJson.confirmRequest(restored).toString())
    }
    @Test fun legacyCreatedOperationRemainsReadableWithoutInventedSourceGrant() {
        val request = ConfirmRequest("op-old", "meeting-1", draft(null))
        val wire = ApiJson.confirmRequest(request).toString()
        val store = ActionOperationStore(folder.newFolder())
        store.save(ActionOperationStore.Operation(request, "https://service.example", false, ActionResult("op-old", "created", "guid-old")))
        val restored = store.list().single()
        assertEquals("guid-old", restored.result.taskGuid)
        assertNull(restored.request.draft.evidence.sourceBinding)
        assertEquals(wire, ApiJson.confirmRequest(restored.request).toString())
        assertFalse(JSONObject(wire).getJSONObject("evidence").has("source_binding"))
    }
}
