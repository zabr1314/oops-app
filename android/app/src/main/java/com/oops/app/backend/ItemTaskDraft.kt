package com.oops.app.backend

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** Adapts a reviewed historical item without borrowing the active recording's identity or evidence. */
object ItemTaskDraft {
    fun fromResponse(raw: JSONObject, expectedSession: String, itemId: String, fingerprint: String): ActionDraft {
        require(raw.getString("session_id") == expectedSession && raw.getString("item_id") == itemId &&
            raw.getString("item_fingerprint") == fingerprint) { "事项来源已变化，请重新打开" }
        val evidence = raw.getJSONObject("evidence")
        val binding = evidence.getJSONObject("source_binding")
        require(sameJson(binding, raw.getJSONObject("source_binding"))) { "事项依据回执不一致" }
        require(TaskSourceBinding.sessionId(binding.toString()) == expectedSession && binding.optString("scope") != "daily") { "事项会话来源无效" }
        require(binding.getString("item_id") == itemId && binding.getString("item_fingerprint") == fingerprint &&
            binding.getString("item_review_fingerprint").matches(Regex("[0-9a-f]{64}")) &&
            binding.getString("proof").matches(Regex("[0-9a-f]{64}"))) { "缺少当前事项的来源核对" }
        val idsJson = evidence.getJSONArray("utterance_ids")
        val ids = (0 until idsJson.length()).map(idsJson::getString)
        val quote = evidence.getString("quote")
        val bindingText = binding.toString()
        require(TaskSourceBinding.valid(bindingText, expectedSession, ids, quote)) { "事项原话依据无效" }
        val sources = TaskSourceBinding.sources(bindingText, expectedSession, ids)!!
        val rows = raw.getJSONArray("utterances")
        require(rows.length() == ids.size)
        val lines = (0 until rows.length()).map { index -> rows.getJSONObject(index).also { line ->
            val source = sources[index]
            require(line.getString("id") == source.id && line.getString("text") == source.quote &&
                line.nullable("speaker") == source.speaker) { "事项原话回执不一致" }
            require(line.getLong("start_ms") >= 0 && line.getLong("end_ms") > line.getLong("start_ms"))
        } }
        val start = evidence.getLong("clip_start_ms"); val end = evidence.getLong("clip_end_ms")
        require(start == lines.minOf { it.getLong("start_ms") } && end == lines.maxOf { it.getLong("end_ms") }) { "事项引用时间不一致" }
        val response = ApiJson.draftResponse(raw)
        require(response.sourceError == null && response.what.isNotBlank() && response.what == binding.getString("item_title")) { "事项内容已变化" }
        val who = raw.nullable("owner") ?: raw.nullable("who")
        val owner = binding.getString("item_owner")
        require(if (owner == "大家") who == null else !who.isNullOrBlank() && who == owner) { "事项负责人回执不一致" }
        require(response.whenRaw.orEmpty() == binding.getString("item_due")) { "事项日期回执不一致" }
        return ActionDraft("d" + UUID.randomUUID(), "item:$expectedSession:$itemId", who.orEmpty(), response.what,
            response.whenIso, response.whenRaw, response.constraint, response.assigneeCandidates,
            Evidence(ids, quote, start, end, bindingText), ownerSource = if (who == null) "none" else "manual",
            tier = "C", reason = response.reason, reviewStatus = "unreviewed", ownerSelectionSource = "user",
            sourceReceipt = response.sourceReceipt)
    }

    private fun JSONObject.nullable(key: String): String? = if (isNull(key)) null else getString(key).takeIf { it.isNotBlank() }

    private fun sameJson(a: Any?, b: Any?): Boolean = when {
        a is JSONObject && b is JSONObject -> a.keys().asSequence().toSet() == b.keys().asSequence().toSet() &&
            a.keys().asSequence().all { sameJson(a.get(it), b.get(it)) }
        a is JSONArray && b is JSONArray -> a.length() == b.length() && (0 until a.length()).all { sameJson(a.get(it), b.get(it)) }
        else -> a == b
    }
}
