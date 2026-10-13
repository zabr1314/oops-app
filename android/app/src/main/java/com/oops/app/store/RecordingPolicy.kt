package com.oops.app.store

import org.json.JSONObject
import java.io.File
import java.time.Instant

/** Per-capture consent, never inferred from a previous meeting or debug setting. */
data class RecordingPolicy(val mode: String = "daily", val audioDays: Int = 30, val transcriptDays: Int = 30) {
    val archives: Boolean get() = mode == "meeting"
    init { require(mode in setOf("daily", "meeting") && audioDays in DAYS && transcriptDays in DAYS) }
    fun contract(startedAt: String): JSONObject = JSONObject().put("recording_mode", mode)
        .put("cloud_save_confirmed", archives).put("audio_retention_days", audioDays)
        .put("transcript_retention_days", transcriptDays).put("archive_started_at", startedAt)
    companion object {
        val DAYS = setOf(7, 30, 90)
        fun fromBridge(value: JSONObject): RecordingPolicy {
            val mode = value.optString("recordingMode", "daily")
            require(mode != "meeting" || value.optBoolean("cloudSaveConfirmed", false)) { "正式会议须明确选择云端保存" }
            return RecordingPolicy(mode, value.optInt("audioRetentionDays", 30), value.optInt("transcriptRetentionDays", 30))
        }
        fun fromMeta(meta: JSONObject): RecordingPolicy? {
            if (!meta.has("recording_mode")) return null // existing archives keep their legacy policy
            require(meta.optString("recording_mode") == "meeting" && meta.optBoolean("cloud_save_confirmed")) { "未获准的记录不能归档" }
            Instant.parse(meta.getString("archive_started_at"))
            return RecordingPolicy("meeting", meta.getInt("audio_retention_days"), meta.getInt("transcript_retention_days"))
        }
    }
}

/** Enforces new per-asset deadlines even for failed uploads and crash-recovery copies. */
object RecordingExpiry {
    private val textSuffixes = listOf("finals.jsonl", "asr.jsonl", "timing.jsonl")
    fun expired(meta: JSONObject, asset: String, nowMs: Long = System.currentTimeMillis()): Boolean {
        val policy = RecordingPolicy.fromMeta(meta) ?: return false
        if (meta.optBoolean(asset + "_expired")) return true
        val days = if (asset == "audio") policy.audioDays else policy.transcriptDays
        return nowMs >= Instant.parse(meta.getString("archive_started_at")).toEpochMilli() + days * 86_400_000L
    }
    fun removeAsset(dir: File, id: String, asset: String) {
        require(asset in setOf("audio", "transcript"))
        val path = File(dir, "$id.json")
        val meta = runCatching { JSONObject(path.readText()) }.getOrNull() ?: return
        (if (asset == "audio") listOf("pcm") else textSuffixes).forEach { File(dir, "$id.$it").delete() }
        meta.put(asset + "_expired", true)
        path.writeText(meta.toString(2))
        File(dir, "$id.uploaded").delete() // remaining unexpired assets may still need upload
        if (meta.optBoolean("audio_expired") && meta.optBoolean("transcript_expired")) {
            File(dir, "$id.ended").delete()
            File(dir, "$id.expired").writeText("expired") // terminal; never recovered or uploaded again
        }
    }
    fun prune(dir: File, active: String? = null, nowMs: Long = System.currentTimeMillis()): List<String> {
        val changed = mutableListOf<String>()
        for (path in dir.listFiles { f -> f.name.endsWith(".json") && f.name.count { it == '.' } == 1 }.orEmpty()) {
            val id = path.name.removeSuffix(".json")
            if (File(dir, "$id.expired").exists()) continue
            val meta = runCatching { JSONObject(path.readText()) }.getOrNull() ?: continue
            if (!meta.has("recording_mode")) continue // no retroactive new default for historical archives
            for (asset in listOf("audio", "transcript")) {
                if (runCatching { expired(meta, asset, nowMs) }.getOrDefault(false) && !meta.optBoolean(asset + "_expired")) {
                    removeAsset(dir, id, asset); meta.put(asset + "_expired", true); changed += "$id:$asset"
                }
            }
        }
        return changed
    }
}
