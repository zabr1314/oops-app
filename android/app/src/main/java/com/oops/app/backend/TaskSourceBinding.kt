package com.oops.app.backend

import org.json.JSONObject

/** A server snapshot is required for source-based writes; it is not reconstructed from a quote. */
object TaskSourceBinding {
    data class Source(val id: String, val kind: String, val textHash: String, val revision: String, val quote: String,
                      val speaker: String?, val review: Map<String, String>)
    fun sources(value: String?, session: String, ids: List<String>): List<Source>? = runCatching {
        require(!value.isNullOrBlank() && session.isNotBlank())
        val json = JSONObject(value)
        require(json.opt("version") == 1 && json.getString("session_id") == session)
        val rows = json.getJSONArray("sources")
        require(rows.length() in 1..20)
        val sources = (0 until rows.length()).map { index ->
            val row = rows.getJSONObject(index)
            require(row.has("speaker") && (row.isNull("speaker") || row.opt("speaker") is String))
            val review = row.getJSONObject("review")
            require(review.keys().asSequence().all { it in setOf("speaker", "owner", "verdict") && review.opt(it) is String })
            Source(row.getString("id"), row.getString("kind"), row.getString("text_hash"),
                row.getString("source_revision"), row.getString("quote"), if (row.isNull("speaker")) null else row.getString("speaker"),
                review.keys().asSequence().associateWith { review.getString(it) }).also {
                require(it.id.isNotBlank() && it.kind in setOf("transcript", "saved_excerpt"))
                require(it.textHash.matches(Regex("[0-9a-f]{64}")) && it.revision.isNotBlank())
                require(it.quote.isNotBlank() && it.quote.codePointCount(0, it.quote.length) <= 280)
            }
        }
        require(sources.map { it.id } == ids && ids.distinct().size == ids.size)
        sources
    }.getOrNull()

    fun allSources(value: String?, session: String, ids: List<String>): List<Source>? = runCatching {
        val selected = sources(value, session, ids) ?: error("来源无效")
        val json = JSONObject(value!!)
        require(!json.has("context_sources") || json.optJSONArray("context_sources") != null)
        val context = json.optJSONArray("context_sources") ?: return@runCatching selected
        val contextIds = (0 until context.length()).map { context.getJSONObject(it).getString("id") }
        if (contextIds.isEmpty()) return@runCatching selected
        require(contextIds.none { it in ids })
        val dependencyJson = JSONObject(json.toString()).put("sources", context)
        val dependencies = sources(dependencyJson.toString(), session, contextIds) ?: error("上下文来源无效")
        selected + dependencies
    }.getOrNull()

    fun valid(value: String?, session: String, ids: List<String>, quote: String? = null,
              retainedOnly: Boolean = false): Boolean {
        val sources = sources(value, session, ids) ?: return false
        val all = allSources(value, session, ids) ?: return false
        return (!retainedOnly || all.all { it.kind == "saved_excerpt" }) &&
            (quote == null || quote == sources.joinToString(" ") { it.quote })
    }
}
