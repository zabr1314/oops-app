package com.oops.app.store

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.time.Instant

/**
 * Meetings the app never stopped (killed, reinstalled or swiped away mid-meeting) leave a meta file without
 * `audio_ended_at`, and the server never learns they ended, so no minutes go out. On the next start their end is
 * estimated from what reached the disk, written into the meta (`recovered`, which the recording upload then
 * carries), and sent once as an end-only meeting sync. `<id>.ended` marks a sent end; it is pruned with the session.
 */
object SessionRecovery {
    /** (session id, estimated end) for every unfinished session whose end has not been sent yet. */
    fun scan(dir: File, active: String?, accepts: (String, JSONObject) -> Boolean = { _, _ -> true }): List<Pair<String, String>> {
        RecordingExpiry.prune(dir, active)
        val result = mutableListOf<Pair<String, String>>()
        val metas = dir.listFiles { f -> f.name.endsWith(".json") && f.name.count { it == '.' } == 1 }.orEmpty()
        for (metaFile in metas.sortedBy { it.lastModified() }) {
            val id = metaFile.name.removeSuffix(".json")
            if (id == active || File(dir, "$id.ended").exists() || File(dir, "$id.expired").exists()) continue
            val meta = runCatching { JSONObject(metaFile.readText()) }.getOrNull() ?: continue
            if (!accepts(id, meta) || RecordingExpiry.expired(meta, "transcript")) continue
            if (!meta.has("audio_ended_at")) {
                val end = estimateEnd(dir, id) ?: continue
                meta.put("audio_ended_at", end).put("recovered", true).put("bytes", File(dir, "$id.pcm").length())
                metaFile.writeText(meta.toString(2))
            }
            // New formal archives may be killed after audio stops but before
            // EOS/ack and the final sync. Never infer a successful transcription.
            if (RecordingPolicy.fromMeta(meta)?.archives == true) {
                meta.put("recovered", true)
                if (!meta.has("asr_closure")) meta.put("asr_closure", "incomplete")
                    .put("asr_error_code", "process_interrupted").put("asr_error", "应用中断，转写结束未确认")
                metaFile.writeText(meta.toString(2))
            }
            if (meta.optBoolean("recovered")) result += id to meta.getString("audio_ended_at")
        }
        return result
    }

    /** Original finals only: no inferred speaker, tag, owner, agenda or model call. */
    fun replayBodies(dir: File, id: String, endedAt: String, meta: JSONObject): List<JSONObject> {
        require(!RecordingExpiry.expired(meta, "transcript")) { "完整文字已到期，不能恢复" }
        val file = File(dir, "$id.finals.jsonl")
        require(file.isFile) { "没有可恢复的原话文件，保留录音等待核对" }
        val rows = linkedMapOf<String, JSONObject>()
        file.bufferedReader().useLines { lines -> lines.filter { it.isNotBlank() }.forEach { line ->
            val raw = JSONObject(line)
            val uid = raw.getString("id"); val text = raw.getString("text")
            val start = raw.getDouble("start_ms"); val end = raw.getDouble("end_ms")
            require(uid.matches(Regex("[A-Za-z0-9_-]{1,100}")) && text.isNotBlank() && text.length <= 2000 &&
                start.isFinite() && end.isFinite() && start >= 0 && end > start) { "恢复原话不完整，请核对本机文件" }
            rows[uid] = JSONObject().put("id", uid).put("text", text).put("start_ms", start).put("end_ms", end)
            require(rows.size <= 20_000) { "恢复原话超过会议容量" }
        } }
        require(rows.isNotEmpty()) { "没有可恢复的原话，不能以空结束回执代替" }
        val chunks = rows.values.toList().sortedBy { it.getDouble("start_ms") }.chunked(250)
        return chunks.mapIndexed { index, chunk -> endBody(id, endedAt, meta).apply {
            put("utterances", JSONArray(chunk))
            if (index != chunks.lastIndex) remove("ended_at")
        } }
    }

    /** Only the end: no start (the server already has it), no sentences and no agenda, which the server keeps. */
    fun endBody(id: String, endedAt: String, meta: JSONObject? = null): JSONObject {
        val body = JSONObject().put("session_id", id).put("ended_at", endedAt)
            .put("recovered", true).put("utterances", JSONArray()).put("notices", JSONArray())
        if (meta != null) RecordingPolicy.fromMeta(meta)?.contract(meta.getString("archive_started_at"))?.let { contract ->
            contract.keys().forEach { key -> body.put(key, contract.get(key)) }
            body.put("started_at", meta.getString("archive_started_at")).put("time_zone", meta.optString("time_zone", "UTC"))
        }
        if (meta != null && meta.optString("asr_closure") in setOf("acknowledged", "incomplete", "cancelled")) {
            for (key in listOf("asr_closure", "asr_error_code", "asr_error")) {
                if (meta.has(key)) body.put(key, meta.get(key))
            }
        }
        return body
    }

    fun markSent(dir: File, id: String) {
        File(dir, "$id.ended").writeText(Instant.now().toString())
    }

    /** The last wall-clock time written by the ASR or timing log, else when the audio file last grew. */
    internal fun estimateEnd(dir: File, id: String): String? {
        val logged = listOf("asr.jsonl", "timing.jsonl").mapNotNull { lastAt(File(dir, "$id.$it")) }.maxOrNull()
        val ms = logged ?: File(dir, "$id.pcm").takeIf { it.isFile }?.lastModified()?.takeIf { it > 0 } ?: return null
        return Instant.ofEpochMilli(ms).toString()
    }

    private fun lastAt(file: File, tailBytes: Int = 64 * 1024): Long? {
        if (!file.isFile || file.length() == 0L) return null
        val text = RandomAccessFile(file, "r").use { raf ->
            val start = maxOf(0L, raf.length() - tailBytes)
            raf.seek(start)
            ByteArray((raf.length() - start).toInt()).also { raf.readFully(it) }.toString(Charsets.UTF_8)
        }
        return text.lineSequence().toList().asReversed().firstNotNullOfOrNull { line ->
            runCatching { JSONObject(line).optLong("at").takeIf { it > 0 } }.getOrNull()
        }
    }
}
