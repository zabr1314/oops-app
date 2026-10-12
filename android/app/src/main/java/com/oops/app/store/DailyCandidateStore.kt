package com.oops.app.store

import com.oops.app.buffer.Utterance
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.time.Instant

/** Minimal private, unconfirmed excerpts. This is not a rolling full-transcript archive. */
class DailyCandidateStore(private val dir: File) {
    @Synchronized fun upsert(session: String, utterance: Utterance) {
        if (utterance.tag !in setOf("commitment", "decision", "constraint", "idea")) return
        require(session.matches(Regex("[A-Za-z0-9_-]+")))
        dir.mkdirs()
        val file = File(dir, "$session.json")
        val previous = runCatching { JSONArray(file.readText()) }.getOrDefault(JSONArray())
        val items = (0 until previous.length()).map { previous.getJSONObject(it) }.filter { it.optString("id") != utterance.id }.takeLast(49)
        val item = JSONObject().put("id", utterance.id).put("session_id", session).put("quote", utterance.text.take(280))
            .put("start_ms", utterance.startMs).put("end_ms", utterance.endMs).put("tag", utterance.tag)
            .put("visibility", "private").put("confirmed", false).put("status", "candidate")
            .put("original_available", false).put("updated_at", Instant.now().toString())
        file.writeText(JSONArray(items + item).toString())
    }
    @Synchronized fun list(): List<JSONObject> = dir.listFiles { f -> f.extension == "json" }.orEmpty()
        .flatMap { file -> runCatching { val a = JSONArray(file.readText()); (0 until a.length()).map { a.getJSONObject(it) } }.getOrDefault(emptyList()) }
        .sortedByDescending { it.optString("updated_at") }
    @Synchronized fun find(session: String, id: String): JSONObject? = list().firstOrNull { it.optString("session_id") == session && it.optString("id") == id }
    @Synchronized fun remove(session: String, id: String) {
        require(session.matches(Regex("[A-Za-z0-9_-]+")))
        val file = File(dir, "$session.json")
        val items = list().filter { it.optString("session_id") == session && it.optString("id") != id }
        if (items.isEmpty()) file.delete() else file.writeText(JSONArray(items).toString())
    }
}
