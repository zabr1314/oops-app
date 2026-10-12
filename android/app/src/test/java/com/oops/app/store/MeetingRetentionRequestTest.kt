package com.oops.app.store

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class MeetingRetentionRequestTest {
    private fun request()=JSONObject().put("sessionId","meeting-123").put("confirm",true)
        .put("evidence",JSONArray().put(JSONObject().put("id","u1").put("quote","预算10万").put("sourceText","预算10万，按第一版方案。")))
        .put("summaries",JSONArray().put(JSONObject().put("id","s1").put("text","确认首版预算").put("source_ids",JSONArray().put("u1"))))
    private fun rejects(f:()->Unit){try{f();fail("must reject")}catch(_:IllegalArgumentException){}}
    @Test fun `only explicitly selected short evidence goes out and hash binds the entire unchanged raw source`() {
        val body=MeetingRetentionRequest.fromBridge(request());val row=body.getJSONArray("evidence").getJSONObject(0)
        assertEquals("预算10万",row.getString("quote"));assertFalse(row.has("sourceText"));assertFalse(body.toString().contains("按第一版方案"))
        assertEquals(RecordingUploader.sha256("预算10万，按第一版方案。".toByteArray(Charsets.UTF_8)),row.getString("expected_text_hash"))
        val changed=request();changed.getJSONArray("evidence").getJSONObject(0).put("sourceText","预算10万，按第二版方案。")
        assertNotEquals(row.getString("expected_text_hash"),MeetingRetentionRequest.fromBridge(changed).getJSONArray("evidence").getJSONObject(0).getString("expected_text_hash"))
    }
    @Test fun `missing fresh confirmation or selected evidence is rejected`() {
        rejects{MeetingRetentionRequest.fromBridge(request().put("confirm",false))}
        rejects{MeetingRetentionRequest.fromBridge(request().put("evidence",JSONArray()))}
    }
    @Test fun `summary cannot reference an unselected source and edited quotes cannot fabricate evidence`() {
        val wrong=request();wrong.getJSONArray("summaries").getJSONObject(0).put("source_ids",JSONArray().put("other"))
        rejects{MeetingRetentionRequest.fromBridge(wrong)}
        val fabricated=request();fabricated.getJSONArray("evidence").getJSONObject(0).put("quote","已经决定预算翻倍")
        rejects{MeetingRetentionRequest.fromBridge(fabricated)}
    }
    @Test fun `summary is optional and long raw excerpts are refused`() {
        val only=request().put("summaries",JSONArray());assertEquals(0,MeetingRetentionRequest.fromBridge(only).getJSONArray("summaries").length())
        val long=request();long.getJSONArray("evidence").getJSONObject(0).put("quote","长".repeat(281)).put("sourceText","长".repeat(300))
        rejects{MeetingRetentionRequest.fromBridge(long)}
    }
}
