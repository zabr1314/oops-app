package com.oops.app.backend

import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest

/** Used for requests, late callbacks and snapshots alike. Appended speech never changes sourceRevision. */
object TaskBoardPolicy {
    data class Context(val sessionId: String, val serviceEpoch: Long, val backendUrl: String,
                       val sourceRevision: Long, val mode: String, val transcriptExpired: Boolean)
    fun accepts(request: Context, current: Context): Boolean = request == current &&
        current.sessionId.isNotBlank() && current.mode == "meeting"

    fun withoutSources(board: JSONObject, changed: Set<String>): JSONObject {
        val session = board.optString("session_id")
        val tasks = board.optJSONArray("tasks") ?: JSONArray()
        val remaining = JSONArray()
        for (index in 0 until tasks.length()) {
            val task = tasks.optJSONObject(index) ?: continue
            val ids = task.optJSONArray("sources") ?: continue
            val selected = (0 until ids.length()).mapNotNull { ids.opt(it) as? String }
            val dependencies = TaskSourceBinding.allSources(task.optJSONObject("source_binding")?.toString(), session, selected) ?: continue
            if (dependencies.none { it.id in changed }) remaining.put(JSONObject(task.toString()))
        }
        return JSONObject(board.toString()).put("tasks", remaining)
    }

    fun filter(board: JSONObject, current: Context, texts: Map<String, String> = emptyMap(), blockedSources: Set<String> = emptySet(),
               speakers: Map<String, String?> = emptyMap(), reviews: Map<String, Map<String, String>> = emptyMap()): JSONObject? {
        if (current.sessionId.isBlank() || current.mode != "meeting" || board.optString("session_id") != current.sessionId) return null
        val tasks = board.optJSONArray("tasks") ?: return null
        val accepted = JSONArray()
        for (index in 0 until tasks.length()) {
            val task = tasks.optJSONObject(index) ?: continue
            val idsJson = task.optJSONArray("sources") ?: continue
            val ids = (0 until idsJson.length()).mapNotNull { idsJson.opt(it) as? String }
            if (ids.size != idsJson.length() || task.optString("what").isBlank() ||
                ids.any { it in blockedSources } ||
                task.optString("priority") !in setOf("P0", "P1", "P2", "P3") ||
                task.optString("status") !in setOf("open", "done", "dropped")) continue
            val binding = task.optJSONObject("source_binding")?.toString()
            if (!TaskSourceBinding.valid(binding, current.sessionId, ids, retainedOnly = current.transcriptExpired)) continue
            val sources = TaskSourceBinding.allSources(binding, current.sessionId, ids)!!
            if (sources.any { it.id in blockedSources }) continue
            // Missing local text may still be in the formal archive; the server supplies its verified binding.
            if (sources.any { source -> texts[source.id]?.let { hash(it) != source.textHash } == true }) continue
            if (sources.any { source -> speakers.containsKey(source.id) && speakers[source.id] != source.speaker ||
                    reviews[source.id]?.let { it != source.review } == true }) continue
            accepted.put(JSONObject(task.toString()))
        }
        return JSONObject(board.toString()).put("tasks", accepted)
            .put("serviceEpoch", current.serviceEpoch).put("backendUrl", current.backendUrl)
            .put("sourceRevision", current.sourceRevision).put("recording_mode", current.mode)
    }

    private fun hash(text: String) = MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it.toInt() and 255) }
}
