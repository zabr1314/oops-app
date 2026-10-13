package com.oops.app.store

import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.nio.file.FileVisitResult
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.SimpleFileVisitor
import java.nio.file.attribute.BasicFileAttributes
import java.time.Instant
import java.util.UUID

/** The SDK's redundant recording is scratch, never an additional meeting archive. */
data class BeanCaptureContract(val policy: RecordingPolicy, val sessionId: String, val startedAt: String) {
    val audioExpiresAtMs: Long
    init {
        requireDailySafe(policy)
        require(sessionId.matches(Regex("[A-Za-z0-9_-]{8,80}"))) { "录音豆记录编号无效" }
        audioExpiresAtMs = Math.addExact(Instant.parse(startedAt).toEpochMilli(), policy.audioDays * 86_400_000L)
    }

    companion object {
        fun requireDailySafe(policy: RecordingPolicy) {
            check(policy.archives) {
                "录音豆 SDK 暂不能保证日常五分钟临时保存，请在音源中选择手机麦克风；正式会议需明确选择云端保存"
            }
        }
    }
}

/**
 * Owns only bean-sdk-scratch-v1, not the legacy filesDir/bean directory. A process-wide lease keeps
 * a closing SDK writer from overlapping a new session. Only an SDK disconnect acknowledgement (or
 * failure before SDK initialisation) may finish a lease; deletion failure keeps it blocked.
 * On process restart all writers are gone, so startup may remove this namespace's orphan scratch.
 */
class BeanScratchStore(
    private val root: File,
    private val remove: (File) -> Unit = ::removeTree,
) {
    private val key: String get() {
        check(!Files.isSymbolicLink(root.toPath())) {
            "录音豆临时目录不安全，已停止接入"
        }
        return root.canonicalPath
    }

    fun recover(): Int = synchronized(lock) {
        active[key]?.let {
            if (!it.canRetryCleanup) return@synchronized 0 // never unlink another live or closing writer
            it.finishStopped()
        }
        recoverLocked()
    }

    fun begin(contract: BeanCaptureContract, nowMs: Long = System.currentTimeMillis()): Lease = synchronized(lock) {
        active[key]?.takeIf { it.canRetryCleanup }?.finishStopped()
        check(active[key] == null) { "上一场录音豆传输尚未关闭或临时副本清理失败，请稍后重试" }
        check(nowMs < contract.audioExpiresAtMs) { "本场录音保留期已到，请开始新的会议" }
        recoverLocked()
        check(root.isDirectory || root.mkdirs()) { "无法建立录音豆临时目录" }
        val folder = File(root, "capture-${UUID.randomUUID()}")
        check(folder.mkdir()) { "无法建立本场录音豆临时目录" }
        try {
            File(folder, MARKER).writeText(JSONObject().put("kind", KIND).put("session_id", contract.sessionId)
                .put("archive_started_at", contract.startedAt).put("audio_expires_at_ms", contract.audioExpiresAtMs).toString())
        } catch (error: Throwable) {
            runCatching { remove(folder) }
            throw error
        }
        Lease(folder, contract, key).also { active[key] = it }
    }

    private fun recoverLocked(): Int {
        key // validate even when the namespace does not exist
        if (!root.exists()) return 0
        check(root.isDirectory) { "录音豆临时目录无效" }
        var count = 0
        for (folder in root.listFiles() ?: throw IOException("无法读取录音豆临时目录")) {
            val marker = File(folder, MARKER)
            check(folder.name.matches(Regex("capture-[a-f0-9-]{36}")) && !Files.isSymbolicLink(folder.toPath()) &&
                folder.isDirectory && !Files.isSymbolicLink(marker.toPath()) &&
                runCatching { JSONObject(marker.readText()).optString("kind") == KIND }.getOrDefault(false)) {
                "录音豆临时目录存在无法核对的副本，已停止接入"
            }
            remove(folder) // failure propagates: never claim this copy was cleared
            check(!folder.exists()) { "录音豆临时副本清理失败，已停止接入" }
            count++
        }
        return count
    }

    inner class Lease internal constructor(val folder: File, val contract: BeanCaptureContract, private val ownerKey: String) {
        private var stopping = false
        private var writerStopped = false
        internal val canRetryCleanup: Boolean get() = writerStopped
        val accepting: Boolean get() = synchronized(lock) { active[ownerKey] === this && !stopping }
        fun expired(nowMs: Long = System.currentTimeMillis()) = nowMs >= contract.audioExpiresAtMs
        fun markStopping() = synchronized(lock) { stopping = true }
        fun finishStopped() = synchronized(lock) {
            if (active[ownerKey] !== this) return@synchronized
            stopping = true
            writerStopped = true
            remove(folder)
            check(!folder.exists()) { "录音豆临时副本清理失败，已停止接入" }
            active.remove(ownerKey)
        }
    }

    companion object {
        const val DIRECTORY = "bean-sdk-scratch-v1"
        private const val MARKER = ".oops-scratch.json"
        private const val KIND = "oops-bean-scratch-v1"
        private val lock = Any()
        private val active = mutableMapOf<String, BeanScratchStore.Lease>()

        private fun removeTree(folder: File) {
            if (!folder.exists()) return
            Files.walkFileTree(folder.toPath(), object : SimpleFileVisitor<Path>() {
                override fun visitFile(file: Path, attrs: BasicFileAttributes): FileVisitResult {
                    Files.delete(file) // walkFileTree does not follow symbolic links
                    return FileVisitResult.CONTINUE
                }
                override fun postVisitDirectory(dir: Path, error: IOException?): FileVisitResult {
                    if (error != null) throw error
                    Files.delete(dir)
                    return FileVisitResult.CONTINUE
                }
            })
        }
    }
}
