package com.oops.app.backend

import com.oops.app.buffer.Utterance
import org.json.JSONObject

/** Explicit reads can open confirmed short evidence, never reconstruct the expired transcript. */
object RetainedTaskEvidence {
    fun select(history: JSONObject, session: String, ids: List<String>): List<Utterance>? = runCatching {
        require(history.getString("session_id") == session && ids.size in 1..3 && ids.distinct().size == ids.size)
        val rows = history.getJSONArray("retained_evidence")
        val byId = (0 until rows.length()).map { rows.getJSONObject(it) }.associateBy { it.getString("id") }
        ids.map { id ->
            val row = byId[id] ?: error("未独立保留")
            // `expired` describes the full transcript's TTL; the separately confirmed excerpt remains usable.
            require(row.opt("confirmed") == true && row.optString("source_status") in setOf("available", "expired"))
            val text = row.getString("text")
            val start = row.getLong("start_ms"); val end = row.getLong("end_ms")
            require(text.isNotBlank() && text.codePointCount(0, text.length) <= 280 && start >= 0 && end > start)
            fun JSONObject.nullable(key: String) = if (isNull(key)) null else optString(key).takeIf { it.isNotBlank() }
            Utterance(id, start, end, text, row.optJSONObject("review")?.nullable("speaker") ?: row.nullable("speaker"))
        }
    }.getOrNull()
}
