package com.oops.app.backend

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

class ActionSourceWorkflowTest {
    private fun request() = ConfirmRequest("op-1", "meeting-1", ActionDraft("d1", "c1", "洪玉麟", "发方案", null, null, null,
        listOf("洪玉麟"), Evidence(listOf("u1"), "请发方案", 0, 1000)))
    private class Api(private val failure: Exception? = null, private val result: ActionResult = ActionResult("op-1", "pending")) : OopsApi {
        override val name = "test"
        var submits = 0
        var reads = 0
        override suspend fun recall(request: RecallRequest) = error("unused")
        override suspend fun draftAction(request: DraftRequest) = error("unused")
        override suspend fun confirmAction(request: ConfirmRequest): ActionResult { submits++; failure?.let { throw it }; return result }
        override suspend fun getAction(opId: String): ActionResult { reads++; return result }
    }
    @Test fun definiteNoWriteSourceConflictStopsOldRetryAndRequestsRedraft() = runBlocking {
        val api = Api(ActionSourceRejected("ACTION_SOURCE_CHANGED", "原话已改"))
        val result = ActionWorkflow.execute(api, request(), true, maxPolls = 0)
        assertEquals(ActionResult.FAILED, result.status)
        assertTrue(result.sourceInvalidated)
        assertFalse(ActionWorkflow.shouldSubmit(result))
        assertEquals(1, api.submits)
    }
    @Test fun genericHttp409OrLostResponseMustRemainUnknown() = runBlocking {
        for (failure in listOf(IOException("HTTP409"), IOException("response lost"))) {
            val result = ActionWorkflow.execute(Api(failure), request(), true, maxPolls = 0)
            assertEquals(ActionResult.PENDING, result.status)
            assertFalse(result.sourceInvalidated)
            assertFalse(ActionWorkflow.shouldSubmit(result))
        }
    }
    @Test fun earlierExternalAttemptWithBlockedSourceNeverBecomesDefiniteFailure() = runBlocking {
        val api = Api(result = ActionResult("op-1", "pending", sourceBlocked = true, message = "已停止写入，上次结果待核实"))
        val result = ActionWorkflow.execute(api, request(), true, maxPolls = 10)
        assertEquals(ActionResult.PENDING, result.status)
        assertTrue(result.sourceBlocked)
        assertFalse(result.sourceInvalidated)
        assertFalse(ActionWorkflow.shouldSubmit(result))
        assertEquals(0, api.reads)
        assertEquals("已停止写入，上次结果待核实", result.message)
    }
    @Test fun structuredHttpConflictNeedsLiteralNoWriteGuaranteeAndSourceCode() {
        fun body(code: String = "ACTION_SOURCE_CHANGED", flag: Any? = true) = org.json.JSONObject().put("error",
            org.json.JSONObject().put("code", code).put("no_external_write", flag ?: org.json.JSONObject.NULL)).toString()
        assertNotNull(ActionSourceRejected.fromHttp(409, body()))
        assertNotNull(ActionSourceRejected.fromHttp(409, body("SOURCE_BINDING_REQUIRED")))
        assertNull(ActionSourceRejected.fromHttp(409, body(flag = null)))
        assertNull(ActionSourceRejected.fromHttp(409, body(flag = "true")))
        assertNull(ActionSourceRejected.fromHttp(409, body("CONFLICT")))
        assertNull(ActionSourceRejected.fromHttp(503, body()))
        assertNull(ActionSourceRejected.fromHttp(409, "<html>gateway conflict</html>"))
    }
    @Test fun restoringPendingKeepsSourceBlockedReasonAndDoesNotClaimContinuedProcessing() {
        val original = ActionResult("op-1", "pending", sourceBlocked = true, message = "来源已变化，已停止再次写入；上次结果待核实", polling = true)
        val restored = ActionWorkflow.restoredPending(original)
        assertEquals(original.message, restored.message)
        assertTrue(restored.sourceBlocked)
        assertFalse(restored.sourceInvalidated || restored.polling)
        assertFalse(ActionWorkflow.shouldSubmit(restored))
        assertTrue(ActionWorkflow.restoredPending(original.copy(message = null)).message!!.contains("只能查询"))
    }
}
