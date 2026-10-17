package com.oops.app.store

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.time.Instant

/** End receipts contain metadata only. Existing excerpts remain in their original stores. */
class DailyListeningResultStore(private val dir: File) {
    @Synchronized fun record(receipt: JSONObject): JSONObject {
        val value = metadata(receipt)
        if (!dir.isDirectory && !dir.mkdirs()) throw IOException("无法保存日常结束回执")
        val target = File(dir, value.getString("session_id") + ".json")
        val temporary = File.createTempFile(".ended-", ".tmp", dir)
        try {
            FileOutputStream(temporary).use { output ->
                output.write(value.toString().toByteArray(Charsets.UTF_8))
                output.fd.sync()
            }
            Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } finally { temporary.delete() }
        return JSONObject(value.toString())
    }

    @Synchronized fun list(): List<JSONObject> {
        if (!dir.exists()) return emptyList()
        if (!dir.isDirectory) throw IOException("日常结束回执目录不可读")
        return (dir.listFiles { f -> f.extension == "json" } ?: throw IOException("日常结束回执不可读"))
            .map { file -> metadata(JSONObject(file.readText())).also {
                require(file.nameWithoutExtension == it.getString("session_id")) { "日常结束回执不匹配" }
            } }.sortedByDescending { Instant.parse(it.getString("ended_at")) }
    }

    companion object {
        private fun metadata(input: JSONObject): JSONObject {
            val session = input.getString("session_id")
            require(session.matches(Regex("[A-Za-z0-9_-]{1,100}")))
            val ended = input.getString("ended_at")
            Instant.parse(ended)
            val reason = input.getString("reason")
            require(reason in setOf("stopped", "meeting_switch"))
            val cleanup = input.getJSONObject("cleanup")
            val sourceStopped = cleanup.getBoolean("source_stopped")
            require(cleanup.getBoolean("temporary_audio_cleared") && cleanup.getBoolean("temporary_transcript_cleared"))
            val out = JSONObject().put("version", 1).put("session_id", session).put("ended_at", ended).put("reason", reason)
                .put("cleanup", JSONObject().put("status", if (sourceStopped) "cleared" else "source_cleanup_failed")
                    .put("temporary_audio_cleared", true).put("temporary_transcript_cleared", true).put("source_stopped", sourceStopped))
                .put("pending_analysis_at_stop", input.getInt("pending_analysis_at_stop").also { require(it >= 0) })
            for (name in listOf("candidate_count_at_end", "saved_count_at_end")) {
                val count = if (input.isNull(name)) null else input.getInt(name).also { require(it >= 0) }
                out.put(name, count ?: JSONObject.NULL)
            }
            return out // explicit allowlist: no text, audio, candidates or saved content can enter this file
        }
    }
}

/** Read-only projections use current disk excerpts; a receipt is never a second copy of content. */
class DailyListeningResults(
    private val receipts: DailyListeningResultStore,
    private val candidateRows: () -> List<JSONObject>,
    private val savedRows: () -> List<JSONObject>,
) {
    /** Freeze under the engine's pipeline -> result-store lock, at the actual clear boundary. */
    fun snapshot(session: String, endedAt: String, sourceStopped: Boolean, pending: Int, reason: String): JSONObject {
        val initial = read(session)
        return JSONObject().put("session_id", session).put("ended_at", endedAt).put("reason", reason)
            .put("candidate_count_at_end", initial.opt("candidate_count") ?: JSONObject.NULL)
            .put("saved_count_at_end", initial.opt("saved_count") ?: JSONObject.NULL)
            .put("pending_analysis_at_stop", pending)
            .put("cleanup", JSONObject().put("status", if (sourceStopped) "cleared" else "source_cleanup_failed")
                .put("temporary_audio_cleared", true).put("temporary_transcript_cleared", true).put("source_stopped", sourceStopped))
    }

    /** IO persists only the already-frozen metadata; current excerpts/counts remain a separate projection. */
    fun finish(snapshot: JSONObject): JSONObject {
        val frozen = JSONObject(snapshot.toString())
        val saved = runCatching { receipts.record(frozen) }
        return read(frozen.getString("session_id"), fallbackReceipt = saved.getOrDefault(frozen), receiptFailure = saved.isFailure)
    }

    fun read(sessionId: String? = null, requestId: String = "", fallbackReceipt: JSONObject? = null,
             receiptFailure: Boolean = false): JSONObject {
        val requested = sessionId?.takeIf { it.isNotBlank() }
        require(requested == null || requested.matches(Regex("[A-Za-z0-9_-]{1,100}")))
        val errors = JSONArray()
        fun error(scope: String, message: String) { errors.put(JSONObject().put("scope", scope).put("code", "DAILY_RESULT_READ_FAILED").put("message", message)) }
        val receiptRead = runCatching { receipts.list() }
        if (receiptRead.isFailure) error("receipt", "结束回执读取失败，结束时间和清理状态暂无法核对")
        if (receiptFailure) errors.put(JSONObject().put("scope", "receipt").put("code", "DAILY_RESULT_SAVE_FAILED")
            .put("message", "本次结束回执未能保存；重点仍按原来的方式保留，请检查存储空间"))
        val candidateRead = runCatching(candidateRows)
        if (candidateRead.isFailure) error("candidates", "私人候选读取失败，请重试；当前条数未知")
        val savedRead = runCatching(savedRows)
        if (savedRead.isFailure) error("saved", "已保存片段读取失败，请重试；当前条数未知")
        val records = receiptRead.getOrDefault(emptyList()).let { existing ->
            if (fallbackReceipt == null) existing else listOf(JSONObject(fallbackReceipt.toString())) + existing.filter {
                it.optString("session_id") != fallbackReceipt.optString("session_id") }
        }
        val candidates = candidateRead.getOrDefault(emptyList())
        val allSaved = savedRead.getOrDefault(emptyList())
        val dailyIds = (records.map { it.getString("session_id") } + candidates.map { it.getString("session_id") } +
            allSaved.filter { it.optString("recording_mode") == "daily" || it.optString("id").startsWith("daily-") }
                .map { it.optString("session_id") }).filter { it.isNotBlank() }.toSet()
        val saved = allSaved.filter { it.optString("session_id") in dailyIds }
        val recordMap = records.associateBy { it.getString("session_id") }
        val contentTimes = (candidates.map { it.getString("session_id") to validTime(it.optString("updated_at")) } +
            saved.map { it.getString("session_id") to validTime(it.optString("saved_at")) })
            .groupBy({ it.first }, { it.second }).mapValues { (_, times) -> times.filterNotNull().maxOrNull() }
        val sessions = dailyIds.map { sid ->
            val receipt = recordMap[sid]
            JSONObject().put("session_id", sid).put("ended_at", receipt?.optString("ended_at") ?: JSONObject.NULL)
                .put("updated_at", contentTimes[sid]?.toString() ?: JSONObject.NULL)
                .put("candidate_count", if (candidateRead.isSuccess) candidates.count { it.optString("session_id") == sid } else JSONObject.NULL)
                .put("saved_count", if (savedRead.isSuccess) saved.count { it.optString("session_id") == sid } else JSONObject.NULL)
        }.sortedWith(compareByDescending<JSONObject> {
            validTime(it.optString("ended_at")) ?: validTime(it.optString("updated_at")) ?: Instant.MIN
        }.thenBy { it.getString("session_id") })
        val latestReceipt = records.maxByOrNull { Instant.parse(it.getString("ended_at")) }
        val latest = latestReceipt?.getString("session_id") ?: sessions.firstOrNull()?.getString("session_id")
        val selected = requested ?: latest
        val receipt = selected?.let { recordMap[it] }
        val selectedCandidates = candidates.filter { it.optString("session_id") == selected }
        val selectedSaved = saved.filter { it.optString("session_id") == selected }
        val receiptState = when {
            receiptFailure || receiptRead.isFailure -> "failed"
            receipt == null -> "missing"
            else -> "saved"
        }
        return JSONObject().put("version", 1).put("requestId", requestId)
            .put("requested_session_id", requested ?: JSONObject.NULL).put("session_id", selected ?: JSONObject.NULL)
            .put("ended_at", receipt?.optString("ended_at") ?: JSONObject.NULL).put("receipt", receipt ?: JSONObject.NULL)
            .put("cleanup", receipt?.optJSONObject("cleanup") ?: JSONObject.NULL).put("time_unknown", receipt == null)
            .put("candidate_count", if (candidateRead.isSuccess) selectedCandidates.size else JSONObject.NULL)
            .put("saved_count", if (savedRead.isSuccess) selectedSaved.size else JSONObject.NULL)
            .put("candidates", JSONArray(selectedCandidates)).put("saved_items", JSONArray(selectedSaved))
            .put("sessions", JSONArray(sessions)).put("latest_session_id", latest ?: JSONObject.NULL)
            .put("total_candidate_count", if (candidateRead.isSuccess) candidates.size else JSONObject.NULL)
            .put("storage", JSONObject().put("receipt", receiptState).put("candidates", if (candidateRead.isSuccess) "ok" else "failed")
                .put("saved", if (savedRead.isSuccess) "ok" else "failed"))
            .put("errors", errors).put("auto_open", false)
    }

    companion object {
        fun validTime(value: String): Instant? = runCatching { Instant.parse(value) }.getOrNull()
        fun mayAutoOpen(showResult: Boolean, stoppedEpoch: Long, currentEpoch: Long, sessionId: String,
                        capturing: Boolean) = showResult && stoppedEpoch == currentEpoch && sessionId.isBlank() && !capturing
    }
}
