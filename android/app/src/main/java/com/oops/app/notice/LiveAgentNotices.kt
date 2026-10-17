package com.oops.app.notice

import com.oops.app.buffer.Utterance
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.time.Instant

/** Validates a read-only worker projection against the phone's current original sentences. */
object LiveAgentNotices {
    data class Snapshot(val attempt: Long, val previous: Boolean, val notices: List<Notice>,
                        val evidence: Map<String, String>)

    private fun textHash(text: String) = MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it.toInt() and 0xff) }

    fun binding(value: Utterance): String = "${value.startMs}:${value.endMs}:${textHash(value.text)}:" +
        JSONArray().put(value.speaker ?: JSONObject.NULL).put(value.manualSpeaker ?: JSONObject.NULL).toString()

    fun read(payload: JSONObject, session: String, available: List<Utterance>, nowMs: Long): Snapshot? {
        require(payload.getInt("version") == 1 && payload.getString("session_id") == session)
        if (payload.optString("status") !in setOf("ready", "pending", "ended") ||
            !payload.optBoolean("checkpoint_available") || !payload.optBoolean("notice_evaluated")) return null
        require(payload.getString("model") == "gpt-6.1-sol" && payload.getString("notice_protocol") == "sol-observer-v1")
        require(Instant.parse(payload.getString("transcript_expires_at")).isAfter(Instant.now()))
        val attempt = payload.getLong("attempt_id")
        require(attempt > 0 && payload.getString("snapshot_fingerprint").matches(Regex("[0-9a-f]{64}")))
        val items = payload.getJSONArray("notices")
        require(items.length() <= 30)
        val pool = available.associateBy { it.id }
        val evidence = mutableMapOf<String, String>()
        fun ids(value: JSONArray): List<String> {
            require(value.length() in 1..3)
            return (0 until value.length()).map { value.getString(it) }.also { require(it.distinct().size == it.size) }
        }
        fun side(value: JSONArray, expected: List<String>): List<Utterance> {
            require(value.length() == expected.size)
            return (0 until value.length()).map { i ->
                val row = value.getJSONObject(i)
                require(row.getString("id") == expected[i])
                val original = requireNotNull(pool[expected[i]]) { "提醒原话尚未同步或已变化" }
                require(row.getString("text") == original.text && row.getLong("start_ms") == original.startMs &&
                    row.getLong("end_ms") == original.endMs)
                val speaker = if (row.isNull("speaker")) null else row.getString("speaker")
                require(speaker == (original.manualSpeaker ?: original.speaker))
                require(row.getString("binding").matches(Regex("[0-9a-f]{64}")))
                val hash = binding(original)
                require(textHash(original.text) == row.getString("text_hash"))
                evidence[original.id] = hash
                original
            }
        }
        val seen = mutableSetOf<String>()
        val notices = (0 until items.length()).map { i ->
            val item = items.getJSONObject(i)
            val id = item.getString("id")
            require(id.matches(Regex("[A-Za-z0-9_-]{1,100}")) && seen.add(id))
            require(item.getString("kind") == "conflict" && item.getString("status") == "open")
            val earlierIds = ids(item.getJSONArray("earlier_ids")); val currentIds = ids(item.getJSONArray("current_ids"))
            require(earlierIds.none { it in currentIds })
            val earlier = side(item.getJSONArray("earlier"), earlierIds)
            val current = side(item.getJSONArray("current"), currentIds)
            require(earlier.all { left -> current.all { right -> left.startMs < right.startMs ||
                left.startMs == right.startMs && left.id < right.id } })
            val text = item.getString("text"); val question = item.optString("question")
            require(text.isNotBlank() && text.length <= 160 && question.length <= 96)
            fun quotes(rows: List<Utterance>) = rows.joinToString("\n") { "${it.startMs / 60000}分钟：「${it.text}」" }
            Notice(id = "agent-$id", kind = "conflict", title = "Oops 发现可能冲突 · 待核对",
                detail = text + "\n先前依据：\n" + quotes(earlier) + "\n当前依据：\n" + quotes(current) +
                    if (question.isBlank()) "" else "\n$question",
                atMs = nowMs, evidenceIds = earlierIds + currentIds)
        }
        return Snapshot(attempt, payload.optBoolean("is_previous"), notices, evidence)
    }
}
