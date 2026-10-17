package com.oops.app.backend

import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.time.Instant

/** Private display snapshots. Never an authorization, a write receipt, or a second daily transcript. */
internal class HttpReadCache(private val directory: File?) {
    data class Entry(val body: String, val etag: String, val checkedAt: Long, val sourceUntil: Long,
                     val keepUntil: Long) {
        // Include the retained UTF-16 strings, not only their sometimes smaller UTF-8 wire form.
        val memoryBytes: Long = body.length.toLong() * 2 + etag.length.toLong() * 2 + 256
        val displayUntil: Long get() = minOf(sourceUntil, checkedAt + DISPLAY_MS)
        fun json(state: String, final: Boolean): JSONObject = JSONObject(body).put("read_cache", JSONObject()
            .put("state", state).put("final", final).put("checked_at_ms", checkedAt)
            .put("expires_at_ms", displayUntil))
    }

    private val memory = java.util.LinkedHashMap<String, Entry>(16, 0.75f, true)
    private var memoryBytes = 0L
    private var lastPrunedAt = 0L

    @Synchronized fun get(key: String, preview: Boolean = false): Entry? {
        val now = System.currentTimeMillis()
        if (lastPrunedAt == 0L || now < lastPrunedAt || now - lastPrunedAt >= DISPLAY_MS) {
            directory?.let { runCatching { prune(it, now) } }
        }
        val entry = memory[key] ?: runCatching {
            val target = directory?.let { File(it, "$key.json") } ?: return@runCatching null
            if (!target.isFile || target.length() > MAX_ENTRY_BYTES) return@runCatching null
            val row = JSONObject(AtomicFile(target).openRead().use { it.readBytes().toString(Charsets.UTF_8) })
            if (row.optInt("version") != VERSION) return@runCatching null
            val loaded = Entry(row.getString("body"), row.getString("etag"), row.getLong("checkedAt"),
                row.getLong("sourceUntil"), row.getLong("keepUntil"))
            // Recheck the source set even on disk; old or malformed snapshots cannot grant a lease.
            val lease = sourceLease(JSONObject(loaded.body))
            loaded.takeIf { lease.persistent && it.etag.isNotBlank() && lease.deadline == it.sourceUntil && it.checkedAt > 0 &&
                it.keepUntil == minOf(it.sourceUntil, it.checkedAt + KEEP_MS) }
        }.getOrNull()?.also { putMemory(key, it) } ?: run { remove(key); return null }
        if (now < entry.checkedAt || now >= entry.keepUntil || now >= entry.sourceUntil) {
            remove(key); return null
        }
        return entry.takeIf { !preview || now < it.displayUntil }
    }

    @Synchronized fun save(key: String, body: String, etag: String): Entry? {
        val now = System.currentTimeMillis()
        if (body.toByteArray(Charsets.UTF_8).size > MAX_ENTRY_BYTES || etag.isBlank()) {
            remove(key); return null
        }
        val parsed = runCatching { JSONObject(body) }.getOrNull() ?: run { remove(key); return null }
        // Unknown legacy source contracts are kept only for the brief display lease.
        val lease = runCatching { sourceLease(parsed) }.getOrElse { SourceLease(0L, false) }
        // A mixed response still observes every known deadline, even though it may not go to disk.
        val sourceUntil = minOf(lease.deadline ?: Long.MAX_VALUE,
            if (lease.persistent) Long.MAX_VALUE else now + DISPLAY_MS)
        if (sourceUntil <= now) { remove(key); return null }
        val entry = Entry(body, etag, now, sourceUntil, minOf(sourceUntil, now + KEEP_MS))
        putMemory(key, entry)
        if (!lease.persistent) {
            // Legacy results without a source contract are memory-only, never disk archives.
            directory?.let { runCatching { AtomicFile(File(it, "$key.json")).delete() } }
            return entry
        }
        runCatching {
            val dir = directory ?: return@runCatching
            dir.mkdirs()
            val target = AtomicFile(File(dir, "$key.json"))
            val bytes = JSONObject().put("version", VERSION).put("body", body).put("etag", etag)
                .put("checkedAt", now).put("sourceUntil", sourceUntil).put("keepUntil", entry.keepUntil)
                .toString().toByteArray(Charsets.UTF_8)
            if (bytes.size > MAX_ENTRY_BYTES) { target.delete(); return@runCatching }
            val output = target.startWrite()
            try { output.write(bytes); target.finishWrite(output) }
            catch (error: Exception) { target.failWrite(output); throw error }
            // Expiry as filesystem metadata lets cleanup avoid reading every cached response body.
            if (!target.baseFile.setLastModified(entry.keepUntil)) target.delete()
            prune(dir, now)
        }
        return entry
    }

    @Synchronized fun remove(key: String) {
        removeMemory(key)
        directory?.let { runCatching { AtomicFile(File(it, "$key.json")).delete() } }
    }

    @Synchronized fun clear() {
        memory.clear()
        memoryBytes = 0L
        lastPrunedAt = 0L
        runCatching { directory?.listFiles()?.forEach { file -> if (file.isFile) file.delete() } }
    }

    private fun putMemory(key: String, entry: Entry) {
        removeMemory(key)
        memory[key] = entry
        memoryBytes += entry.memoryBytes
        while (memory.size > MAX_ENTRIES || memoryBytes > MAX_TOTAL_BYTES) removeMemory(memory.keys.first())
    }

    private fun removeMemory(key: String) {
        memory.remove(key)?.let { memoryBytes -= it.memoryBytes }
    }

    private fun prune(dir: File, now: Long) {
        val files = dir.listFiles()?.filter { it.name.endsWith(".json") } ?: return
        val due = lastPrunedAt == 0L || now < lastPrunedAt || now - lastPrunedAt >= DISPLAY_MS
        if (!due && files.size <= MAX_ENTRIES && files.sumOf { it.length() } <= MAX_TOTAL_BYTES) return
        var bytes = 0L
        var count = 0
        files.sortedByDescending { it.lastModified() }.forEach { file ->
            val length = file.length()
            if (file.lastModified() <= now || count >= MAX_ENTRIES || bytes + length > MAX_TOTAL_BYTES) {
                removeMemory(file.name.removeSuffix(".json")); AtomicFile(file).delete()
            } else { bytes += length; count++ }
        }
        lastPrunedAt = now
    }

    private data class SourceLease(val deadline: Long?, val persistent: Boolean)

    /** Unknown sources are memory-only, bounded by any known source's earlier deadline. */
    private fun sourceLease(value: Any?): SourceLease {
        val sources = mutableSetOf<String>()
        val deadlines = mutableMapOf<String, Long>()
        var invalid = false
        var unknown = false
        var minimum: Long? = null
        fun visit(node: Any?) {
            when (node) {
                is JSONObject -> {
                    val ids = SOURCE_KEYS.filter { node.has(it) }.mapNotNull { key ->
                        val id = node.opt(key)
                        if (id is String && id.isNotBlank()) id else { unknown = true; null }
                    }.toMutableList()
                    if (node.has("source_meeting")) {
                        val source = node.optJSONObject("source_meeting")
                        val id = source?.opt("id")
                        if (id is String && id.isNotBlank()) ids += id else unknown = true
                    }
                    sources.addAll(ids)
                    if (node.has("storage_policy")) {
                        val policy = node.opt("storage_policy")
                        if (policy == null || policy === JSONObject.NULL) {
                            // Existing legacy rows explicitly serialize their absent contract as null.
                            unknown = true
                        } else {
                            val deadline = policyDeadline(policy)
                            if (deadline == null) invalid = true
                            else {
                                minimum = minOf(minimum ?: deadline, deadline)
                                if (ids.isEmpty()) unknown = true
                                else ids.forEach { id -> deadlines[id] = minOf(deadlines[id] ?: deadline, deadline) }
                            }
                        }
                    }
                    node.keys().forEach { key -> if (key != "storage_policy") visit(node.opt(key)) }
                }
                is JSONArray -> (0 until node.length()).forEach { visit(node.opt(it)) }
            }
        }
        visit(value)
        if (invalid) return SourceLease(0L, false)
        // One known meeting must not lend its retention policy to other rows in a mixed list.
        val persistent = !unknown && sources.isNotEmpty() && sources.all { it in deadlines }
        return SourceLease(minimum, persistent)
    }

    private fun policyDeadline(value: Any?): Long? = runCatching {
        val policy = value as? JSONObject ?: return@runCatching null
        if (policy.opt("version") != 1 || policy.opt("recording_mode") != "meeting" ||
            policy.opt("cloud_save_confirmed") != true) return@runCatching null
        val began = Instant.parse(policy.getString("archive_started_at")).toEpochMilli()
        for (asset in listOf("audio", "transcript")) {
            val days = policy.opt("${asset}_retention_days")
            if (days !in setOf(7, 30, 90)) return@runCatching null
            val expires = Instant.parse(policy.getString("${asset}_expires_at")).toEpochMilli()
            if (expires != began + (days as Int) * 86_400_000L) return@runCatching null
        }
        Instant.parse(policy.getString("transcript_expires_at")).toEpochMilli()
    }.getOrNull()

    companion object {
        private val SOURCE_KEYS = listOf("session_id", "source_session_id", "meeting_id", "source_meeting_id")
        private const val VERSION = 2
        // Different API instances may briefly coexist while a service is rebuilt.
        val LOCK = Any()
        const val DISPLAY_MS = 60_000L
        private const val KEEP_MS = 86_400_000L
        private const val MAX_ENTRY_BYTES = 8 * 1024 * 1024
        private const val MAX_TOTAL_BYTES = 32 * 1024 * 1024L
        private const val MAX_ENTRIES = 96
        fun key(vararg parts: String): String = MessageDigest.getInstance("SHA-256")
            .digest(parts.joinToString("") { "${it.length}:$it" }.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
    }
}
