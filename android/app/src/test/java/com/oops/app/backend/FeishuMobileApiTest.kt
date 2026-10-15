package com.oops.app.backend

import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class FeishuMobileApiTest {
    @Test fun openingHistoryBeforeFeishuSettingsCreatesOneIdentityForReadsAndRecordingUploads() = runTest {
        val seen = mutableListOf<Pair<String, String?>>()
        val opaque = "opaque-history-first-phone-identity-abcdefghijklmnopqrstuvwxyz"
        var saved = ""
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { exchange ->
            seen.add(exchange.requestURI.path to exchange.requestHeaders.getFirst("X-Oops-User-Token"))
            exchange.requestBody.readBytes()
            val body = when (exchange.requestURI.path) {
                "/v1/feishu/session" -> JSONObject().put("session_token", opaque)
                else -> JSONObject().put("items", org.json.JSONArray()).put("received", 2)
            }.toString().toByteArray()
            exchange.sendResponseHeaders(200, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        server.start()
        try {
            val api = HttpOopsApi(OkHttpClient(), "http://127.0.0.1:${server.address.port}", "service-key",
                personalToken = { saved }, savePersonalToken = { saved = it }, enablePersonalIdentity = true)
            api.historyList()
            api.historyOpen("meeting-first")
            api.recordingManifest("meeting-first", JSONObject())
            api.recordingChunk("meeting-first", "audio.pcm", 0, byteArrayOf(0, 0), "test-sha")
            api.recordingComplete("meeting-first")
            assertEquals("/v1/feishu/session", seen.first().first)
            assertEquals(1, seen.count { it.first == "/v1/feishu/session" })
            assertNull(seen.first().second)
            assertTrue(seen.drop(1).all { it.second == opaque })
        } finally { server.stop(0) }
    }

    @Test fun failedIdentityCreationNeverFallsBackToReadingWithOnlyTheSharedServiceCredential() = runTest {
        val paths = mutableListOf<String>()
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { exchange ->
            paths.add(exchange.requestURI.path)
            val body = """{"error":{"code":"ACCOUNTS_STORAGE_UNAVAILABLE","message":"个人连接暂不可用"}}""".toByteArray()
            exchange.sendResponseHeaders(503, body.size.toLong())
            exchange.responseBody.use { it.write(body) }
        }
        server.start()
        try {
            val api = HttpOopsApi(OkHttpClient(), "http://127.0.0.1:${server.address.port}", "service-key",
                enablePersonalIdentity = true)
            val error = runCatching { api.historyList() }.exceptionOrNull() as HttpFailure
            assertEquals("ACCOUNTS_STORAGE_UNAVAILABLE", error.errorCode)
            assertEquals(listOf("/v1/feishu/session"), paths)
        } finally { server.stop(0) }
    }

    @Test fun personalSessionIsBootstrappedOnceKeptNativeAndAddedToReviewedDelivery() = runTest {
        val seen = mutableListOf<Triple<String, String?, String>>()
        val opaque = "opaque-phone-identity-abcdefghijklmnopqrstuvwxyz"
        var saved = ""
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { exchange ->
            assertEquals("Bearer service-key", exchange.requestHeaders.getFirst("Authorization"))
            seen.add(Triple(exchange.requestURI.path, exchange.requestHeaders.getFirst("X-Oops-User-Token"),
                exchange.requestBody.readBytes().toString(Charsets.UTF_8)))
            val response = when (exchange.requestURI.path) {
                "/v1/feishu/session" -> JSONObject().put("session_token", opaque)
                "/v1/feishu/status" -> JSONObject().put("status", "bound").put("account", JSONObject().put("name", "本人"))
                else -> JSONObject().put("status", "sent").put("session_id", "meeting-1")
                    .put("revision", 2).put("op_id", "review-op-123")
            }.toString().toByteArray()
            exchange.sendResponseHeaders(200, response.size.toLong())
            exchange.responseBody.use { it.write(response) }
        }
        server.start()
        try {
            val api = HttpOopsApi(OkHttpClient(), "http://127.0.0.1:${server.address.port}", "service-key",
                personalToken = { saved }, savePersonalToken = { saved = it })
            val status = api.feishuCall("feishu.status", JSONObject())
            assertEquals("bound", status.getString("status"))
            assertFalse(status.toString().contains(opaque))
            api.feishuCall("minutes.delivery.confirm", JSONObject().put("sessionId", "meeting-1")
                .put("opId", "review-op-123").put("revision", 2).put("confirmed", true))
            assertEquals(1, seen.count { it.first == "/v1/feishu/session" })
            assertEquals(opaque, saved)
            assertNull(seen.first().second)
            assertTrue(seen.drop(1).all { it.second == opaque })
            val confirm = JSONObject(seen.last().third)
            assertEquals("review-op-123", confirm.getString("op_id"))
            assertTrue(confirm.getBoolean("confirmed"))
            assertTrue(runCatching { api.feishuCall("minutes.delivery.open", JSONObject().put("sessionId", "../other")) }.isFailure)
        } finally { server.stop(0) }
    }

    @Test fun expiredPersonalAuthorizationKeepsItsOwnErrorAndNeverFallsBackToSharedIdentity() = runTest {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        var count = 0
        server.createContext("/") { exchange ->
            count++
            assertNotNull(exchange.requestHeaders.getFirst("X-Oops-User-Token"))
            val response = """{"error":{"code":"FEISHU_AUTH_EXPIRED","message":"请重新连接本人的飞书账号"}}""".toByteArray()
            exchange.sendResponseHeaders(401, response.size.toLong())
            exchange.responseBody.use { it.write(response) }
        }
        server.start()
        try {
            val api = HttpOopsApi(OkHttpClient(), "http://127.0.0.1:${server.address.port}", "service-key",
                personalToken = { "opaque-already-stored-phone-identity" })
            val error = runCatching { api.feishuCall("feishu.status", JSONObject()) }.exceptionOrNull() as HttpFailure
            assertEquals("FEISHU_AUTH_EXPIRED", error.errorCode)
            assertEquals(1, count)
        } finally { server.stop(0) }
    }

    private fun operation(session: String, revision: Int = 2, job: String? = null, followup: String? = null): JSONObject =
        JSONObject().put("session_id", session).put("revision", revision).put("op_id", "original-operation")
            .put("status", "unknown").also {
                if (job != null) it.put("job_id", job).put("source_session_id", "meeting-1")
                if (followup != null) it.put("followup_id", followup)
            }

    private fun agentDraft(job: String): JSONObject = JSONObject().put("session_id", job).put("job_id", job)
        .put("source_session_id", "meeting-1").put("revision", 2).put("result_revision", 1)
        .put("title", "original").put("content", "original body")

    @Test fun mismatchingProviderObjectsAreRejectedBeforeRequestMetadataCanLabelThem() {
        val job = "a".repeat(32)
        val request = JSONObject().put("sessionId", "meeting-1").put("jobId", job).put("revision", 2)
        val valid = JSONObject().put("session_id", job).put("job_id", job).put("source_session_id", "meeting-1")
            .put("draft", agentDraft(job)).put("delivery", operation(job, job = job))
        assertEquals(job, HttpOopsApi.validatePersonalReply("assistant.delivery.open", request, valid).getString("session_id"))
        for (change in listOf<(JSONObject) -> Unit>(
            { it.put("session_id", "wrong-job") },
            { it.put("job_id", "b".repeat(32)) },
            { it.put("source_session_id", "meeting-2") },
            { it.getJSONObject("draft").put("job_id", "b".repeat(32)) },
            { it.getJSONObject("draft").put("session_id", "meeting-1") },
            { it.getJSONObject("draft").put("source_session_id", "meeting-2") },
            { it.getJSONObject("delivery").put("session_id", "wrong-job") },
            { it.getJSONObject("delivery").put("source_session_id", "meeting-2") }
        )) {
            val bad = JSONObject(valid.toString()).also(change)
            assertTrue(runCatching { HttpOopsApi.validatePersonalReply("assistant.delivery.open", request, bad) }.isFailure)
        }
        // Validation does not decorate or overwrite the original provider JSON.
        assertFalse(valid.has("requestId"))
        assertEquals(job, valid.getString("session_id"))
    }

    @Test fun calendarAndMinutesRepliesCheckNestedSessionFollowupAndAcknowledgedRevision() {
        val request = JSONObject().put("sessionId", "meeting-1").put("followupId", "fu-one").put("revision", 2)
        val calendar = JSONObject().put("session_id", "meeting-1").put("followup_id", "fu-one")
            .put("calendar", operation("meeting-1", followup = "fu-one"))
        assertNotNull(HttpOopsApi.validatePersonalReply("calendar.confirm", request, calendar))
        val wrongDraft = JSONObject(calendar.toString()).put("draft", JSONObject().put("session_id", "meeting-1")
            .put("followup_id", "fu-one").put("revision", 3))
        assertTrue(runCatching { HttpOopsApi.validatePersonalReply("calendar.confirm", request, wrongDraft) }.isFailure)
        for (change in listOf<(JSONObject) -> Unit>(
            { it.put("session_id", "meeting-2") },
            { it.put("followup_id", "fu-two") },
            { it.getJSONObject("calendar").put("session_id", "meeting-2") },
            { it.getJSONObject("calendar").put("followup_id", "fu-two") },
            { it.getJSONObject("calendar").put("revision", 3) }
        )) assertTrue(runCatching { HttpOopsApi.validatePersonalReply("calendar.confirm", request, JSONObject(calendar.toString()).also(change)) }.isFailure)
        val minutes = JSONObject().put("session_id", "meeting-1")
            .put("draft", JSONObject().put("session_id", "meeting-1").put("revision", 3))
            .put("delivery", operation("meeting-1", 1)) // an old historical receipt is legitimate on save
        assertNotNull(HttpOopsApi.validatePersonalReply("minutes.delivery.save", request, minutes))
        minutes.getJSONObject("draft").put("revision", 4)
        assertTrue(runCatching { HttpOopsApi.validatePersonalReply("minutes.delivery.save", request, minutes) }.isFailure)
        minutes.getJSONObject("draft").put("revision", 3).put("session_id", "meeting-2")
        assertTrue(runCatching { HttpOopsApi.validatePersonalReply("minutes.delivery.open", request, minutes) }.isFailure)
    }

    @Test fun historicalInvalidatedAndUnknownReceiptsCanSurviveANullDraftWithoutFreshSideEffects() {
        val request = JSONObject().put("sessionId", "meeting-1").put("followupId", "manual").put("opId", "original-operation")
        val calendar = JSONObject().put("session_id", "meeting-1").put("followup_id", "manual")
            .put("draft", JSONObject.NULL).put("calendar", operation("meeting-1", followup = "manual").put("source_status", "source_changed"))
        assertNotNull(HttpOopsApi.validatePersonalReply("calendar.status", request, calendar))
        val job = "a".repeat(32)
        val result = JSONObject().put("session_id", job).put("job_id", job).put("draft", JSONObject.NULL)
            .put("delivery", operation(job, job = job).put("status", "invalidated"))
        assertNotNull(HttpOopsApi.validatePersonalReply("assistant.delivery.status", JSONObject(request.toString()).put("jobId", job), result))
        result.getJSONObject("delivery").put("op_id", "unrelated-operation")
        assertTrue(runCatching { HttpOopsApi.validatePersonalReply("assistant.delivery.status", JSONObject(request.toString()).put("jobId", job), result) }.isFailure)
        result.put("delivery", JSONObject.NULL)
        assertTrue(runCatching { HttpOopsApi.validatePersonalReply("assistant.delivery.status", JSONObject(request.toString()).put("jobId", job), result) }.isFailure)
    }

    @Test fun assistantListingFiltersRequestedMeetingAndChecksEveryRowsSourceAndReceipt() {
        val first = "a".repeat(32); val second = "b".repeat(32)
        val rows = org.json.JSONArray().put(JSONObject().put("job_id", first).put("session_id", "meeting-1")
            .put("delivery", operation(first, job = first)))
            .put(JSONObject().put("job_id", second).put("session_id", "meeting-2"))
        val request = JSONObject().put("sessionId", "meeting-1")
        val checked = HttpOopsApi.validatePersonalReply("assistant.jobs", request, JSONObject().put("items", rows))
        assertEquals(1, checked.getJSONArray("items").length())
        assertEquals(first, checked.getJSONArray("items").getJSONObject(0).getString("job_id"))
        assertEquals(2, rows.length())
        rows.getJSONObject(1).put("source_session_id", "meeting-1")
        assertTrue(runCatching { HttpOopsApi.validatePersonalReply("assistant.jobs", request, JSONObject().put("items", rows)) }.isFailure)
        rows.getJSONObject(1).remove("source_session_id")
        rows.getJSONObject(0).getJSONObject("delivery").put("job_id", second)
        assertTrue(runCatching { HttpOopsApi.validatePersonalReply("assistant.jobs", request, JSONObject().put("items", rows)) }.isFailure)
    }

    @Test fun personalCalendarAndAssistantHttpRoutesPreserveQueryBodyAndRejectMisroutedHttpReply() = runTest {
        val seen = mutableListOf<Pair<String, JSONObject>>()
        var mismatch = false
        val job = "a".repeat(32)
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { exchange ->
            assertEquals("opaque-current-person", exchange.requestHeaders.getFirst("X-Oops-User-Token"))
            val bytes = exchange.requestBody.readBytes().toString(Charsets.UTF_8)
            val body = if (bytes.isBlank()) JSONObject() else JSONObject(bytes)
            seen.add(exchange.requestURI.toString() to body)
            val result = when {
                exchange.requestURI.path == "/v1/assistant/jobs" -> JSONObject().put("items", org.json.JSONArray())
                exchange.requestURI.path.contains("/assistant/") -> JSONObject().put("session_id", job).put("job_id", job)
                    .put("source_session_id", if (mismatch) "meeting-other" else "meeting-1")
                    .put("draft", agentDraft(job).put("revision", if (exchange.requestURI.path.endsWith("/save")) 3 else 2))
                exchange.requestURI.path.endsWith("/confirm") || exchange.requestURI.path.endsWith("/status") -> JSONObject().put("session_id", "meeting-1").put("followup_id", "fu-one")
                    .put("calendar", operation("meeting-1", followup = "fu-one"))
                else -> JSONObject().put("session_id", "meeting-1").put("followup_id", "fu-one")
                    .put("draft", JSONObject().put("session_id", "meeting-1").put("followup_id", "fu-one")
                        .put("revision", if (exchange.requestURI.path.endsWith("/save")) 3 else 2))
            }.toString().toByteArray()
            exchange.sendResponseHeaders(200, result.size.toLong()); exchange.responseBody.use { it.write(result) }
        }
        server.start()
        try {
            val api = HttpOopsApi(OkHttpClient(), "http://127.0.0.1:${server.address.port}", "service-key", personalToken = { "opaque-current-person" })
            val request = JSONObject().put("sessionId", "meeting-1").put("jobId", job).put("followupId", "fu-one")
                .put("revision", 2).put("opId", "original-operation").put("confirmed", true)
            api.feishuCall("calendar.open", request)
            assertEquals("/v1/meetings/meeting-1/calendar?followup_id=fu-one", seen.last().first)
            api.feishuCall("calendar.save", request)
            assertEquals("/v1/meetings/meeting-1/calendar/save?followup_id=fu-one", seen.last().first)
            api.feishuCall("calendar.confirm", request)
            assertEquals("fu-one", seen.last().second.getString("followup_id"))
            assertEquals("original-operation", seen.last().second.getString("op_id"))
            api.feishuCall("calendar.status", request)
            assertEquals("/v1/meetings/meeting-1/calendar/status?followup_id=fu-one", seen.last().first)
            api.feishuCall("assistant.jobs", request)
            assertEquals("/v1/assistant/jobs?session_id=meeting-1", seen.last().first)
            val save = JSONObject(request.toString()).put("attachments", org.json.JSONArray().put("原稿.pptx")).put("attachment_copies_confirmed", true)
            api.feishuCall("assistant.delivery.save", save)
            assertEquals("/v1/assistant/jobs/$job/delivery/save", seen.last().first)
            assertTrue(seen.last().second.getBoolean("attachment_copies_confirmed"))
            assertEquals("原稿.pptx", seen.last().second.getJSONArray("attachments").getString(0))
            mismatch = true
            assertTrue(runCatching { api.feishuCall("assistant.delivery.open", request) }.isFailure)
        } finally { server.stop(0) }
    }
}
