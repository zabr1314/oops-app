package com.oops.app.backend

import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class PersonalContextApiTest {
    private fun profile(revision: Int = 1) = JSONObject().put("kind", "profile").put("id", "current")
        .put("revision", revision).put("status", "current").put("confirmed", true)
        .put("value", JSONObject().put("name", "本人").put("role", "产品负责人").put("context", "首版")
            .put("scenarios", JSONArray().put("会议")))

    @Test fun personalContextUsesNativeIdentityAndSendsOnlyTheExplicitVersionedMutation() = runTest {
        val seen = mutableListOf<Triple<String, String?, JSONObject>>()
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { exchange ->
            val bytes = exchange.requestBody.readBytes()
            val body = if (bytes.isEmpty()) JSONObject() else JSONObject(bytes.toString(Charsets.UTF_8))
            seen.add(Triple(exchange.requestMethod + " " + exchange.requestURI.path,
                exchange.requestHeaders.getFirst("X-Oops-User-Token"), body))
            val reply = JSONObject().put("context_revision", 1).put("identity_revision", 2)
            if (exchange.requestMethod == "GET") reply.put("profile", profile()).put("preferences", JSONObject.NULL).put("memories", JSONArray())
            else reply.put("item", profile()).put("operation_revision", 1).put("replayed", false)
            val output = reply.toString().toByteArray()
            exchange.sendResponseHeaders(200, output.size.toLong()); exchange.responseBody.use { it.write(output) }
        }
        server.start()
        try {
            val opaque = "opaque-personal-context-native-only-abcdefghijklmnopqrstuvwxyz"
            val api = HttpOopsApi(OkHttpClient(), "http://127.0.0.1:${server.address.port}", "service-token",
                personalToken = { opaque })
            api.feishuCall("personal.context.read", JSONObject().put("requestId", "read-1"))
            api.feishuCall("personal.context.profile", JSONObject().put("requestId", "write-1")
                .put("op_id", "original-context-op").put("expected_revision", 0).put("confirmed", true)
                .put("value", profile().getJSONObject("value")).put("principal", "must-not-be-trusted")
                .put("account", "must-not-be-trusted").put("sessionId", "not-a-meeting"))
            assertEquals(listOf("GET /v1/personal/context", "POST /v1/personal/context/profile"), seen.map { it.first })
            assertTrue(seen.all { it.second == opaque })
            assertEquals(setOf("op_id", "expected_revision", "confirmed", "value"), seen.last().third.keys().asSequence().toSet())
            assertEquals("original-context-op", seen.last().third.getString("op_id"))
            assertEquals("会议", seen.last().third.getJSONObject("value").getJSONArray("scenarios").getString(0))
            assertFalse(seen.last().third.toString().contains(opaque))
        } finally { server.stop(0) }
    }

    @Test fun mismatchedMutationObjectOrOperationRevisionCannotBePresentedAsSaved() {
        val request = JSONObject().put("memory_id", "memory-a").put("expected_revision", 4)
        for (bad in listOf(
            JSONObject().put("context_revision", 9).put("identity_revision", 2).put("operation_revision", 5).put("item", profile()),
            JSONObject().put("context_revision", 9).put("identity_revision", 2).put("operation_revision", 6)
                .put("item", profile(5).put("kind", "memory").put("id", "memory-a"))
        )) assertTrue(runCatching { HttpOopsApi.validatePersonalReply("personal.context.memory", request, bad) }.isFailure)
    }

    @Test fun sourceInvalidationMustNotReturnAnyStaleBodyAndAccountVersionIsRequired() {
        val stale = profile(2).put("status", "needs_review").put("confirmed", false)
        val invalid = JSONObject().put("context_revision", 2).put("identity_revision", 2)
            .put("profile", stale).put("preferences", JSONObject.NULL).put("memories", JSONArray())
        assertTrue(runCatching { HttpOopsApi.validatePersonalReply("personal.context.read", JSONObject(), invalid) }.isFailure)
        invalid.getJSONObject("profile").put("value", JSONObject.NULL)
        assertEquals("needs_review", HttpOopsApi.validatePersonalReply("personal.context.read", JSONObject(), invalid)
            .getJSONObject("profile").getString("status"))
        invalid.remove("identity_revision")
        assertTrue(runCatching { HttpOopsApi.validatePersonalReply("personal.context.read", JSONObject(), invalid) }.isFailure)
    }

    @Test fun personMemoryRequiresAStableIdentifierAndManualSourceInsteadOfANameOnlyOrUnverifiedQuote() {
        val value = JSONObject().put("title", "沟通偏好").put("body", "本人记录：提前发议程")
            .put("category", "person").put("person_id", "person-a").put("person_name", "同名")
            .put("person_kind", "preference").put("scenarios", JSONArray().put("会议"))
        val memory = JSONObject().put("kind", "memory").put("id", "memory-a").put("revision", 1)
            .put("status", "current").put("confirmed", true).put("value", value)
            .put("source", JSONObject().put("kind", "manual"))
        val reply = JSONObject().put("context_revision", 1).put("identity_revision", 2)
            .put("profile", JSONObject.NULL).put("preferences", JSONObject.NULL).put("memories", JSONArray().put(memory))
        assertEquals("person-a", HttpOopsApi.validatePersonalReply("personal.context.read", JSONObject(), reply)
            .getJSONArray("memories").getJSONObject(0).getJSONObject("value").getString("person_id"))
        memory.getJSONObject("source").put("kind", "meeting")
        assertTrue(runCatching { HttpOopsApi.validatePersonalReply("personal.context.read", JSONObject(), reply) }.isFailure)
        memory.getJSONObject("source").put("kind", "manual");value.remove("person_id")
        assertTrue(runCatching { HttpOopsApi.validatePersonalReply("personal.context.read", JSONObject(), reply) }.isFailure)
        value.put("person_id", "person-a").put("category", "fact")
        assertTrue(runCatching { HttpOopsApi.validatePersonalReply("personal.context.read", JSONObject(), reply) }.isFailure)
    }

    @Test fun aSnapshotCannotRelabelAnotherPersonsContextAsTheExplicitlySelectedPerson() {
        val request = JSONObject().put("person_id", "person-a").put("scenario", "会议")
        val reply = JSONObject().put("context_revision", 1).put("identity_revision", 2)
            .put("person_id", "person-b").put("scenario", "会议")
        assertTrue(runCatching { HttpOopsApi.validatePersonalReply("personal.context.snapshot", request, reply) }.isFailure)
        reply.put("person_id", "person-a")
        assertEquals("person-a", HttpOopsApi.validatePersonalReply("personal.context.snapshot", request, reply).getString("person_id"))
        assertTrue(runCatching { HttpOopsApi.validatePersonalReply("personal.context.snapshot", JSONObject().put("scenario", "会议"), reply) }.isFailure)
    }
}
