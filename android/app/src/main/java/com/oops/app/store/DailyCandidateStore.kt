package com.oops.app.store

import com.oops.app.buffer.Utterance
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.time.Instant
import java.security.MessageDigest

/** Minimal private, unconfirmed excerpts. This is not a rolling full-transcript archive. */
class DailyCandidateStore(private val dir: File) {
    @Synchronized fun upsert(session: String, utterance: Utterance, highlight: JSONObject? = null,
                             sources: List<Utterance> = listOf(utterance)) {
        require(session.matches(Regex("[A-Za-z0-9_-]+")))
        if (highlight == null && utterance.tag !in setOf("commitment", "decision", "constraint", "idea")) return
        if (highlight != null) {
            require(highlight.getInt("version") == 1) { "重点结果版本不支持" }
            require(highlight.getString("status") in setOf("candidate", "defer", "suppressed")) { "重点状态无效" }
            if (highlight.getString("status") != "candidate") return
        }
        val decided = decisions(session)
        if (decided.items.any { it.first == utterance.id && (it.second == null || it.second == hash(utterance.text)) }) return
        check(!decided.sealed) { "本次日常候选处理回执已达上限，请开始新的日常聆听" }
        val now = Instant.now().toString()
        val item = JSONObject().put("id", utterance.id).put("session_id", session)
            .put("tag", utterance.tag ?: "uncertain").put("visibility", "private")
            .put("confirmed", false).put("status", "candidate").put("original_available", false)
            .put("updated_at", now).put("occurrences", 1)
        if (highlight == null) {
            // Compatibility with older services: this is an excerpt, never a model summary.
            val quote = prefix(utterance.text, 280)
            if (quote.isBlank()) return
            item.put("quote", quote).put("content_kind", "raw_excerpt").put("summary", JSONObject.NULL)
                .put("excerpt_truncated", quote != utterance.text).put("completeness", "not_evaluated")
                .put("evidence", JSONArray().put(evidence(utterance, quote)))
        } else {
            val text = highlight.getString("text").trim()
            require(text.isNotBlank() && size(text) <= 280) { "重点须为280字以内的完整表达" }
            require(highlight.getString("completeness") == "complete") { "重点表达尚未完整" }
            val quoted = highlight.getJSONArray("evidence")
            require(quoted.length() in 1..5) { "重点短依据数量无效" }
            val available = sources.associateBy { it.id }
            val seen = mutableSetOf<String>()
            var total = 0
            val checked = JSONArray()
            for (i in 0 until quoted.length()) {
                val part = quoted.getJSONObject(i)
                val id = part.getString("id")
                val source = available[id] ?: error("重点原话已移出当前临时范围")
                val quote = part.getString("quote")
                require(seen.add(id) && quote.isNotBlank() && source.text.contains(quote)) { "重点短依据不匹配" }
                require(part.getLong("start_ms") == source.startMs && part.getLong("end_ms") == source.endMs &&
                    part.getString("text_hash") == hash(source.text)) { "重点来源已变化，请重新核对" }
                total += size(quote)
                require(total <= 280) { "重点仅能保留280字以内的必要短依据" }
                checked.put(evidence(source, quote))
            }
            require(utterance.id in seen) { "重点未引用本次当前原话" }
            val fingerprint = highlight.getString("source_fingerprint")
            require(fingerprint.matches(Regex("[a-f0-9]{64}"))) { "重点来源标记无效" }
            item.put("summary", text).put("quote", (0 until checked.length()).joinToString("\n") { checked.getJSONObject(it).getString("quote") })
                .put("content_kind", "model_summary").put("evidence", checked).put("completeness", "complete")
                .put("source_fingerprint", fingerprint).put("reason", highlight.optString("reason").take(80))
                .put("analysis_engine", highlight.optString("engine", "unknown"))
        }
        val evidence = item.getJSONArray("evidence")
        item.put("start_ms", (0 until evidence.length()).minOf { evidence.getJSONObject(it).getLong("start_ms") })
            .put("end_ms", (0 until evidence.length()).maxOf { evidence.getJSONObject(it).getLong("end_ms") })
        if (!dir.isDirectory && !dir.mkdirs()) throw IOException("无法保存私人候选")
        val file = File(dir, "$session.json")
        val previous = if (file.exists()) JSONArray(file.readText()) else JSONArray()
        val existing = (0 until previous.length()).map { previous.getJSONObject(it).also { old ->
            require(old.getString("session_id") == session) { "私人候选来源不匹配" }
            old.getString("id"); old.getString("quote")
        } }
        val earlier = existing.firstOrNull { it.getString("id") == utterance.id }
        if (earlier?.optBoolean("confirmed") == true) return
        if (earlier != null && sourceKey(earlier) == sourceKey(item) &&
            (highlight == null || earlier.optString("source_fingerprint") == item.getString("source_fingerprint"))) return
        val items = existing.filter { it.optString("id") != utterance.id }
        highlight?.optJSONObject("semantic_duplicate_of")?.let { reference ->
            val id = reference.optString("id")
            val digest = reference.optString("text_hash")
            val source = sources.firstOrNull { it.id == id }
            if (source != null && id != utterance.id && digest == hash(source.text)) {
                val related = items.firstOrNull { old -> !old.optBoolean("confirmed") &&
                    old.optJSONArray("evidence")?.let { quotes -> (0 until quotes.length()).any { index ->
                        quotes.getJSONObject(index).let { it.optString("id") == id && it.optString("text_hash") == digest }
                    } } == true }
                if (related != null) item.put("related_candidate_id", related.getString("id"))
                    .put("group_id", related.optString("group_id").ifBlank { related.getString("id") })
                    .put("duplicate_hint", "semantic")
            }
        }
        // Equal wording is a grouping hint, not proof of the same subject, speaker or commitment.
        val same = items.firstOrNull { old -> old.optString("tag") == item.optString("tag") &&
            old.optString("content_kind") == item.optString("content_kind") &&
            candidateText(old) == candidateText(item) }
        if (same != null && !item.has("related_candidate_id")) item.put("related_candidate_id", same.getString("id"))
            .put("group_id", same.optString("group_id").ifBlank { same.getString("id") }).put("duplicate_hint", "same_wording")
        writeAtomic(file, JSONArray(items.takeLast(49) + item))
    }

    private fun candidateText(item: JSONObject) = if (item.isNull("summary")) item.optString("quote") else item.getString("summary")
    private data class EvidenceKey(val id: String, val textHash: String, val startMs: Long, val endMs: Long)
    private fun sourceKey(item: JSONObject): List<EvidenceKey> = item.optJSONArray("evidence")?.let { rows ->
        (0 until rows.length()).map { rows.getJSONObject(it).let { row ->
            EvidenceKey(row.getString("id"), row.optString("text_hash"), row.getLong("start_ms"), row.getLong("end_ms"))
        } }.sortedBy { it.id }
    }.orEmpty()
    private fun decisionFile(session: String) = File(File(dir, ".decisions"), "$session.json")
    private data class DecisionState(val items: List<Pair<String, String?>>, val sealed: Boolean = false)
    /** Only IDs and full-source hashes. A missing hash on a legacy candidate blocks that ID conservatively. */
    private fun decisions(session: String): DecisionState {
        val file = decisionFile(session)
        if (!file.exists()) return DecisionState(emptyList())
        val value = JSONObject(file.readText())
        require(value.getInt("version") == 1) { "私人候选处理回执版本无效" }
        val rows = value.getJSONArray("items")
        val items = (0 until rows.length()).map { rows.getJSONObject(it).let { row ->
            row.getString("id").also { require(it.isNotBlank()) } to
                (if (row.isNull("text_hash")) null else row.getString("text_hash").also { require(it.matches(Regex("[a-f0-9]{64}"))) })
        } }
        return DecisionState(items, value.optBoolean("sealed"))
    }
    private fun recordDecision(session: String, id: String, candidate: JSONObject?) {
        val digest = candidate?.optJSONArray("evidence")?.let { rows ->
            (0 until rows.length()).map { rows.getJSONObject(it) }.firstOrNull { it.optString("id") == id }
                ?.optString("text_hash")?.takeIf { it.matches(Regex("[a-f0-9]{64}")) }
        }
        val old = decisions(session)
        if (old.sealed || old.items.any { it.first == id && (it.second == null || it.second == digest) }) return
        // Do not evict an old decision and make its delayed response eligible again.
        // At capacity, seal automatic additions for this session; explicit save/discard can still finish.
        val sealed = old.items.size >= 4096
        val rows = (if (sealed) old.items else old.items + (id to digest)).map { (sourceId, sourceHash) ->
            JSONObject().put("id", sourceId).put("text_hash", sourceHash ?: JSONObject.NULL)
        }
        writeAtomic(decisionFile(session), JSONObject().put("version", 1).put("sealed", sealed).put("items", JSONArray(rows)).toString())
    }
    private fun evidence(source: Utterance, quote: String) = JSONObject().put("id", source.id).put("quote", quote)
        .put("start_ms", source.startMs).put("end_ms", source.endMs).put("text_hash", hash(source.text))
    private fun hash(text: String) = MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it.toInt() and 255) }
    private fun size(text: String) = text.codePointCount(0, text.length)
    private fun prefix(text: String, limit: Int) = text.substring(0, text.offsetByCodePoints(0, minOf(size(text), limit)))
    private fun writeAtomic(file: File, values: JSONArray) = writeAtomic(file, values.toString())
    private fun writeAtomic(file: File, text: String) {
        val parent = requireNotNull(file.parentFile)
        if (!parent.isDirectory && !parent.mkdirs()) throw IOException("无法保存私人候选处理回执")
        val temporary = File.createTempFile(".candidate-", ".tmp", parent)
        try {
            FileOutputStream(temporary).use { output ->
                output.write(text.toByteArray(Charsets.UTF_8)); output.fd.sync()
            }
            Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } finally { temporary.delete() }
    }
    @Synchronized fun list(): List<JSONObject> = listStrict()
    /** Result screens must distinguish unreadable content from an empty store. No legacy file is rewritten. */
    @Synchronized fun listStrict(): List<JSONObject> {
        if (!dir.exists()) return emptyList()
        if (!dir.isDirectory) throw IOException("私人候选目录不可读")
        return (dir.listFiles { f -> f.extension == "json" } ?: throw IOException("私人候选不可读"))
            .flatMap { file ->
                val values = JSONArray(file.readText())
                (0 until values.length()).map { values.getJSONObject(it).also { item ->
                    require(item.getString("session_id") == file.nameWithoutExtension) { "私人候选来源不匹配" }
                    item.getString("id"); item.getString("quote")
                } }
            }.sortedByDescending { it.optString("updated_at") }
    }
    @Synchronized fun find(session: String, id: String): JSONObject? = listStrict().firstOrNull { it.optString("session_id") == session && it.optString("id") == id }
    @Synchronized fun remove(session: String, id: String) = removeStrict(session, id)

    /** Only explicit user actions call this path; a failed write keeps the original candidate bytes. */
    @Synchronized fun removeStrict(session: String, id: String) {
        require(session.matches(Regex("[A-Za-z0-9_-]+")))
        val original = listStrict().filter { it.optString("session_id") == session }
        // Record intent first. If either write/delete fails the caller reports failure and the old row stays reviewable.
        recordDecision(session, id, original.firstOrNull { it.optString("id") == id })
        val items = original.filter { it.optString("id") != id }
        if (items.size == original.size) return
        val file = File(dir, "$session.json")
        if (items.isEmpty()) {
            if (!file.delete()) throw IOException("候选未能移除")
        } else writeAtomic(file, JSONArray(items))
    }
}
