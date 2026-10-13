package com.oops.app.store

import org.json.JSONArray
import org.json.JSONObject

/** Only the person's selected short evidence and edited summary leave the bridge. */
object MeetingRetentionRequest {
    fun fromBridge(value: JSONObject): JSONObject {
        require(value.optBoolean("confirm")) { "请单独确认保留的摘要与短原话" }
        val session = value.getString("sessionId")
        require(session.matches(Regex("[A-Za-z0-9_-]{1,100}")))
        val evidence = value.getJSONArray("evidence")
        require(evidence.length() in 1..50) { "请先选择必要短原话" }
        val ids = mutableSetOf<String>()
        val selected = (0 until evidence.length()).map { i ->
            val row = evidence.getJSONObject(i)
            val id = row.getString("id")
            val quote = row.getString("quote").trim()
            val source = row.getString("sourceText")
            require(id.matches(Regex("[A-Za-z0-9_-]{1,100}")) && ids.add(id))
            require(quote.isNotBlank() && quote.length <= 280 && source.length <= 10_000 && quote in source) { "短原话须匹配本次核对的来源" }
            JSONObject().put("id", id).put("quote", quote)
                .put("expected_text_hash", RecordingUploader.sha256(source.toByteArray(Charsets.UTF_8)))
        }
        val summaries = value.optJSONArray("summaries") ?: JSONArray()
        require(summaries.length() <= 20)
        val summaryIds = mutableSetOf<String>()
        val edited = (0 until summaries.length()).map { i ->
            val row = summaries.getJSONObject(i); val id = row.getString("id"); val text = row.getString("text").trim()
            val sources = row.getJSONArray("source_ids")
            require(id.matches(Regex("[A-Za-z0-9_-]{1,100}")) && summaryIds.add(id) && text.isNotBlank() && text.length <= 2000)
            require(sources.length() in 1..10 && (0 until sources.length()).all { sources.getString(it) in ids }) { "摘要只能引用本次选定的短原话" }
            JSONObject().put("id", id).put("text", text).put("source_ids", sources)
        }
        return JSONObject().put("session_id", session).put("confirm", true).put("evidence", JSONArray(selected)).put("summaries", JSONArray(edited))
    }
}
