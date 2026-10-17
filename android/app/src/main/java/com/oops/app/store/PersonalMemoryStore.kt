package com.oops.app.store

import android.content.Context
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import java.security.MessageDigest
import com.oops.app.buffer.Utterance

/** Device-private personal notes and explicitly reviewed daily suggestions; never cloud/assistant sync. */
class PersonalMemoryStore(context: Context) {
    private val target = File(context.noBackupFilesDir, "personal_memories_v1.json")
    private val file = AtomicFile(target)

    private data class Item(
        val id: String,
        val title: String,
        val body: String,
        val kind: String,
        val createdAt: Long,
        val updatedAt: Long,
        val provenance: JSONObject? = null,
    ) {
        fun json() = JSONObject().put("id", id).put("title", title).put("body", body).put("kind", kind)
            .put("createdAt", createdAt).put("updatedAt", updatedAt)
            .apply { provenance?.let { saved -> saved.keys().forEach { key -> put(key, saved.get(key)) } } }
    }

    /** Shared across Activity instances so a renderer restart cannot race an unfinished write. */
    fun handle(action: String, payload: JSONObject): JSONObject = synchronized(LOCK) {
        val requestId = payload.opt("requestId") as? String
        val result = JSONObject()
            .put("requestId", requestId?.takeIf { it.length <= MAX_REQUEST_ID } ?: "")
            .put("action", action).put("version", 2).put("capabilities", capabilities())
        try {
            ensure(requestId != null && requestId.isNotBlank() && requestId.length <= MAX_REQUEST_ID,
                "个人记忆请求编号无效，请重新打开页面")
            when (action) {
                "list" -> result.put("items", JSONArray(readItems().sortedWith(ITEM_ORDER).map(Item::json)))
                "save" -> result.put("item", save(payload).json())
                "delete" -> result.put("item", delete(payload).json())
                else -> throw MemoryFailure("不支持的个人记忆操作")
            }
            result.put("ok", true)
        } catch (error: MemoryFailure) {
            result.put("ok", false).put("error", error.message)
        } catch (_: Exception) {
            // Do not log personal content, raw JSON, or filesystem exceptions through the bridge.
            result.put("ok", false).put("error", "个人记忆读取或保存失败，请重新读取核对；原数据未主动清除")
        }
        result
    }

    private fun save(payload: JSONObject): Item {
        val title = text(payload, "title", "请填写标题", MAX_TITLE)
        val body = text(payload, "body", "请填写记忆内容", MAX_BODY)
        val kind = payload.opt("kind") as? String
        ensure(kind in KINDS, "请选择身份、偏好、目标、经历或日常")
        val create = when (val value = payload.opt("create")) {
            null -> false
            is Boolean -> value
            else -> throw MemoryFailure("个人记忆保存方式无效")
        }
        val id = if (!payload.has("id")) {
            ensure(create, "请指定要修改的个人记忆")
            "personal-${UUID.randomUUID()}"
        } else validatedId(payload.opt("id"))
        val items = readItems().toMutableList()
        val index = items.indexOfFirst { it.id == id }
        if (create && index >= 0) {
            val existing = items[index]
            ensure(existing.title == title && existing.body == body && existing.kind == kind,
                "该记忆编号已有其他内容，请重新读取核对")
            return existing // A repeated, identical creation only acknowledges the persisted item.
        }
        ensure(create || index >= 0, "这条个人记忆已不存在，请重新读取")
        ensure(!create || items.size < MAX_ITEMS, "个人记忆已达 $MAX_ITEMS 条，请先整理现有内容")
        val previous = items.getOrNull(index)
        val now = System.currentTimeMillis().coerceAtLeast(1L)
        val updatedAt = if (previous == null) now else maxOf(now, Math.addExact(previous.updatedAt, 1L))
        val provenance = previous?.provenance?.let { JSONObject(it.toString()).put("confirmed_text", body) }
        val item = Item(id, title, body, kind!!, previous?.createdAt ?: now, updatedAt, provenance)
        if (index >= 0) items[index] = item else items.add(item)
        writeItems(items)
        return item
    }

    private fun delete(payload: JSONObject): Item {
        val id = validatedId(payload.opt("id"))
        val items = readItems()
        val existing = items.firstOrNull { it.id == id }
            ?: throw MemoryFailure("这条个人记忆已不存在，请重新读取")
        writeItems(items.filterNot { it.id == id })
        return existing
    }

    private fun readDocument(): JSONObject {
        if (!target.exists() && !File(target.path + ".bak").exists() && !File(target.path + ".new").exists()) {
            return JSONObject().put("schema", 1).put("items", JSONArray()).put("candidates", JSONArray()).put("settled", JSONArray())
        }
        try {
            val document = JSONObject(readBytes().toString(Charsets.UTF_8))
            ensure(document.opt("schema") == 1, STORAGE_ERROR)
            ensure(!document.has("candidates") || document.optJSONArray("candidates") != null, STORAGE_ERROR)
            ensure(!document.has("settled") || document.optJSONArray("settled") != null, STORAGE_ERROR)
            if (!document.has("candidates")) document.put("candidates", JSONArray())
            if (!document.has("settled")) document.put("settled", JSONArray())
            val candidates = document.getJSONArray("candidates")
            val settled = document.getJSONArray("settled")
            ensure(candidates.length() <= MAX_CANDIDATES && settled.length() <= MAX_SETTLED, STORAGE_ERROR)
            val candidateIds = HashSet<String>()
            for (i in 0 until candidates.length()) {
                val row = candidates.getJSONObject(i)
                validateCandidate(row)
                ensure(candidateIds.add(row.getString("id")), STORAGE_ERROR)
            }
            val settledIds = HashSet<String>()
            for (i in 0 until settled.length()) {
                val row = settled.getJSONObject(i)
                ensure(candidateId(row.opt("id")) && settledIds.add(row.getString("id")) &&
                    row.optString("action") in setOf("confirm", "discard", "withdrawn") &&
                    row.optLong("version") > 0 && HASH.matches(row.optString("source_fingerprint")), STORAGE_ERROR)
                if (row.optString("action") == "confirm") {
                    validatedId(row.opt("memory_id"))
                    ensure(HASH.matches(row.optString("confirmation_hash")), STORAGE_ERROR)
                }
            }
            ensure(candidateIds.intersect(settledIds).isEmpty(), STORAGE_ERROR)
            parseItems(document)
            return document
        } catch (_: Exception) {
            throw MemoryFailure(STORAGE_ERROR)
        }
    }

    private fun readItems(): List<Item> = parseItems(readDocument())

    private fun parseItems(document: JSONObject): List<Item> {
        try {
            val rows = document.optJSONArray("items") ?: throw MemoryFailure(STORAGE_ERROR)
            ensure(rows.length() <= MAX_ITEMS, STORAGE_ERROR)
            val seen = HashSet<String>()
            return (0 until rows.length()).map { index ->
                val row = rows.getJSONObject(index)
                val id = validatedId(row.opt("id"))
                val title = text(row, "title", STORAGE_ERROR, MAX_TITLE)
                val body = text(row, "body", STORAGE_ERROR, MAX_BODY)
                val kind = row.opt("kind") as? String
                val createdAt = timestamp(row, "createdAt")
                val updatedAt = timestamp(row, "updatedAt")
                ensure(seen.add(id) && kind in KINDS && createdAt <= updatedAt, STORAGE_ERROR)
                // Storage is validated in full before any edit; malformed rows are never skipped or reset.
                ensure(row.opt("title") == title && row.opt("body") == body, STORAGE_ERROR)
                val provenance = if (row.has("source")) {
                    ensure(row.optString("source") == "daily_personal_confirmed" && row.opt("confirmed") == true &&
                        row.opt("subject_confirmed") == true && row.optString("confirmed_text") == body &&
                        row.optString("source_status") in setOf("current", "changed") &&
                        HASH.matches(row.optString("source_fingerprint")) && row.opt("original_available") == false &&
                        SESSION.matches(row.optString("session_id")) && candidateId(row.opt("candidate_id")) &&
                        row.optLong("candidate_version") > 0 && row.optJSONArray("evidence") != null, STORAGE_ERROR)
                    text(row, "summary", STORAGE_ERROR, 280)
                    validateEvidence(row.getJSONArray("evidence"), row.getString("utterance_id"))
                    JSONObject().also { saved -> SOURCE_FIELDS.forEach { key -> if (row.has(key)) saved.put(key, row.get(key)) } }
                } else null
                Item(id, title, body, kind!!, createdAt, updatedAt, provenance)
            }
        } catch (_: Exception) {
            throw MemoryFailure(STORAGE_ERROR)
        }
    }

    private fun writeItems(items: List<Item>) {
        val document = readDocument().put("items", JSONArray(items.sortedWith(ITEM_ORDER).map(Item::json)))
        writeDocument(document)
    }

    private fun writeDocument(document: JSONObject) {
        val bytes = document.toString().toByteArray(Charsets.UTF_8)
        ensure(bytes.size <= MAX_FILE_BYTES, "个人记忆内容总量已达上限，请先整理现有内容")
        var output: FileOutputStream? = null
        try {
            ensure(target.parentFile?.isDirectory == true || target.parentFile?.mkdirs() == true,
                "个人记忆目录不可用，请稍后重新读取")
            val pending = file.startWrite()
            output = pending
            pending.write(bytes)
            pending.fd.sync() // AtomicFile.finishWrite alone does not report a failed fsync.
            file.finishWrite(pending)
            output = null
            // AtomicFile's finishWrite returns Unit even if its rename fails; require a committed read-back.
            ensure(readBytes().contentEquals(bytes), "个人记忆保存结果未确认，请重新读取核对")
        } catch (_: Exception) {
            output?.let { runCatching { file.failWrite(it) } }
            throw MemoryFailure("个人记忆保存结果未确认，请重新读取核对；请勿重复提交")
        }
    }

    private fun readBytes(): ByteArray = file.openRead().use { input ->
        val bytes = ByteArrayOutputStream()
        val buffer = ByteArray(8192)
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            ensure(bytes.size().toLong() + count <= MAX_FILE_BYTES, STORAGE_ERROR)
            bytes.write(buffer, 0, count)
        }
        bytes.toByteArray()
    }

    private fun text(data: JSONObject, field: String, message: String, max: Int): String {
        val value = (data.opt(field) as? String)?.trim() ?: throw MemoryFailure(message)
        ensure(value.isNotEmpty() && value.length <= max, if (value.length > max) "标题最多 $MAX_TITLE 字，内容最多 $MAX_BODY 字" else message)
        return value
    }

    private fun validatedId(value: Any?): String {
        ensure(value is String && ID_PATTERN.matches(value), "个人记忆编号无效，请重新读取")
        return value as String
    }

    private fun timestamp(data: JSONObject, field: String): Long {
        val value = data.opt(field)
        ensure(value is Long || value is Int, STORAGE_ERROR)
        return (value as Number).toLong().also { ensure(it > 0, STORAGE_ERROR) }
    }

    private fun ensure(valid: Boolean, message: String) {
        if (!valid) throw MemoryFailure(message)
    }

    private class MemoryFailure(message: String) : IllegalStateException(message)

    /** No transcript is accepted here: only a same-call model summary and bounded, verified excerpts. */
    fun offer(session: String, utterance: Utterance, analysis: JSONObject, sources: List<Utterance>): Boolean = synchronized(LOCK) {
        ensure(SESSION.matches(session), "个人候选来源无效")
        ensure(analysis.optInt("version") == 1 && analysis.optString("status") in setOf("candidate", "defer", "suppressed"),
            "个人候选结果版本无效")
        val id = "personal-candidate-" + hash(session + ":" + utterance.id)
        val document = readDocument()
        val settled = objects(document.getJSONArray("settled"))
        if (settled.any { it.getString("id") == id }) return@synchronized false
        val all = objects(document.getJSONArray("candidates"))
        val previous = all.firstOrNull { it.getString("id") == id }
        if (analysis.getString("status") != "candidate") {
            if (previous == null) return@synchronized false
            settle(document, previous, "withdrawn")
            document.put("candidates", JSONArray(all.filterNot { it.getString("id") == id }))
            writeDocument(document)
            return@synchronized true
        }
        val kind = analysis.opt("kind") as? String
        ensure(kind in KINDS && analysis.optString("completeness") == "complete", "个人候选分类或表达不完整")
        val title = text(analysis, "title", "个人候选标题无效", MAX_TITLE)
        val summary = text(analysis, "text", "个人候选正文无效", 280)
        val evidence = analysis.optJSONArray("evidence") ?: throw MemoryFailure("个人候选缺少短依据")
        ensure(evidence.length() in 1..5, "个人候选短依据数量无效")
        val available = sources.associateBy { it.id }
        val current = available[utterance.id] ?: throw MemoryFailure("个人候选当前原话不可用")
        val currentSpeaker = current.manualSpeaker ?: current.speaker
        val seen = HashSet<String>()
        val checked = JSONArray()
        var total = 0
        for (i in 0 until evidence.length()) {
            val part = evidence.getJSONObject(i)
            val source = available[part.optString("id")] ?: throw MemoryFailure("个人候选原话已移出临时范围")
            val quote = part.opt("quote") as? String ?: throw MemoryFailure("个人候选短依据无效")
            if (source.id != utterance.id) ensure(currentSpeaker != null && currentSpeaker !in setOf("other", "multi", "unclear") &&
                (source.manualSpeaker ?: source.speaker) == currentSpeaker, "个人候选含不同或未核对的声音来源")
            ensure(seen.add(source.id) && quote.isNotBlank() && source.text.contains(quote) &&
                part.getLong("start_ms") == source.startMs && part.getLong("end_ms") == source.endMs &&
                part.optString("text_hash") == hash(source.text), "个人候选来源已变化")
            total += quote.codePointCount(0, quote.length)
            ensure(total <= 280, "个人候选仅保留280字以内的必要短依据")
            checked.put(JSONObject().put("id", source.id).put("quote", quote).put("start_ms", source.startMs)
                .put("end_ms", source.endMs).put("text_hash", hash(source.text))
                .put("speaker", source.manualSpeaker ?: source.speaker ?: JSONObject.NULL))
        }
        ensure(utterance.id in seen && HASH.matches(analysis.optString("source_fingerprint")), "个人候选来源标记无效")
        ensure(all.size < MAX_CANDIDATES || previous != null, "个人候选已达上限，请先核对现有内容")
        ensure(settled.size < MAX_SETTLED, "个人候选处理记录已达上限，已停止自动新增")
        val now = System.currentTimeMillis().coerceAtLeast(1L)
        val updatedAt = previous?.getLong("updatedAt")?.let { maxOf(now, Math.addExact(it, 1L)) } ?: now
        val candidate = JSONObject().put("id", id).put("session_id", session).put("utterance_id", utterance.id)
            .put("version", previous?.getLong("version")?.let { Math.addExact(it, 1L) } ?: 1L)
            .put("source_fingerprint", analysis.getString("source_fingerprint")).put("kind", kind)
            .put("title", title).put("summary", summary).put("text", summary).put("evidence", checked)
            .put("subject", "需本人核对").put("subject_confirmed", false).put("status", "candidate")
            .put("original_available", false).put("createdAt", previous?.getLong("createdAt") ?: now).put("updatedAt", updatedAt)
        document.put("candidates", JSONArray(all.filterNot { it.getString("id") == id } + candidate))
        writeDocument(document)
        true
    }

    /** A later identity correction changes the excerpt version, never confirms a personal fact. */
    fun speakerChanged(session: String, utteranceId: String, speaker: String?, force: Boolean = false): Boolean = synchronized(LOCK) {
        val document = readDocument()
        var changed = false
        val now = System.currentTimeMillis().coerceAtLeast(1L)
        for (candidate in objects(document.getJSONArray("candidates"))) {
            if (candidate.optString("session_id") != session) continue
            var rowChanged = false
            for (part in objects(candidate.getJSONArray("evidence"))) {
                if (part.optString("id") == utteranceId && (force || (part.opt("speaker") as? String) != speaker)) {
                    part.put("speaker", speaker ?: JSONObject.NULL); rowChanged = true
                }
            }
            if (rowChanged) {
                candidate.put("version", Math.addExact(candidate.getLong("version"), 1L))
                    .put("updatedAt", maxOf(now, Math.addExact(candidate.getLong("updatedAt"), 1L)))
                changed = true
            }
        }
        for (item in objects(document.getJSONArray("items"))) {
            if (item.optString("source") != "daily_personal_confirmed" || item.optString("session_id") != session) continue
            if (objects(item.getJSONArray("evidence")).any { it.optString("id") == utteranceId &&
                    (force || (it.opt("speaker") as? String) != speaker) }) {
                item.put("source_status", "changed").put("updatedAt", maxOf(now, Math.addExact(item.getLong("updatedAt"), 1L)))
                changed = true
            }
        }
        if (changed) writeDocument(document)
        changed
    }

    fun candidates(action: String, payload: JSONObject): JSONObject = synchronized(LOCK) {
        val requestId = payload.opt("requestId") as? String
        val result = JSONObject().put("requestId", requestId?.takeIf { it.length <= MAX_REQUEST_ID } ?: "")
            .put("action", action).put("version", 2).put("capabilities", capabilities())
        var mutationWriteStarted = false
        try {
            ensure(requestId != null && requestId.isNotBlank() && requestId.length <= MAX_REQUEST_ID, "个人候选请求编号无效")
            val document = readDocument()
            val rows = objects(document.getJSONArray("candidates"))
            if (action != "list") {
                ensure(action in setOf("confirm", "discard"), "个人候选操作无效")
                val id = payload.optString("id")
                ensure(candidateId(id), "个人候选编号无效")
                val version = payload.getLong("version")
                val fingerprint = payload.optString("source_fingerprint")
                ensure(version > 0 && HASH.matches(fingerprint), "请重新读取本次个人候选")
                val previousDecision = objects(document.getJSONArray("settled")).firstOrNull { it.optString("id") == id }
                val candidate = rows.firstOrNull { it.optString("id") == id }
                val confirmation = if (action == "confirm") {
                    ensure(payload.opt("subject_confirmed") == true && payload.opt("content_confirmed") == true,
                        "请明确核对本人归属、分类及内容后再保存")
                    val kind = payload.opt("kind") as? String
                    ensure(kind in KINDS, "请选择个人记忆分类")
                    val title = text(payload, "title", "请填写个人记忆标题", MAX_TITLE)
                    val body = text(payload, "text", "请填写核对后的个人记忆", 280)
                    JSONObject().put("kind", kind).put("title", title).put("body", body)
                } else null
                val confirmationHash = confirmation?.let { confirmationDigest(id, version, fingerprint,
                    it.getString("kind"), it.getString("title"), it.getString("body")) }
                if (previousDecision != null) {
                    ensure(previousDecision.optString("action") == action && previousDecision.optLong("version") == version &&
                        previousDecision.optString("source_fingerprint") == fingerprint, "个人候选已经处理，请重新读取")
                    if (action == "confirm") {
                        ensure(previousDecision.optString("confirmation_hash") == confirmationHash, "已保存的核对内容不同，请查看个人记忆")
                        val saved = parseItems(document).firstOrNull { it.id == previousDecision.optString("memory_id") }
                            ?: throw MemoryFailure("原个人记忆已移除，不会重新创建")
                        result.put("memory", saved.json())
                    }
                } else {
                    ensure(candidate != null && candidate.getLong("version") == version &&
                        candidate.getString("source_fingerprint") == fingerprint, "候选或短依据版本已变化，请重新读取")
                    if (action == "confirm") {
                        val checked = requireNotNull(candidate)
                        val content = requireNotNull(confirmation)
                        val items = parseItems(document)
                        ensure(items.size < MAX_ITEMS, "个人记忆已达上限，请先整理")
                        val memoryId = "personal-" + UUID.nameUUIDFromBytes(("daily-personal:" + id).toByteArray(Charsets.UTF_8))
                        ensure(items.none { it.id == memoryId }, "个人记忆编号已有内容，请重新读取核对")
                        val now = System.currentTimeMillis().coerceAtLeast(1L)
                        val saved = Item(memoryId, content.getString("title"), content.getString("body"), content.getString("kind"), now, now,
                            JSONObject().put("source", "daily_personal_confirmed").put("confirmed", true).put("subject_confirmed", true)
                                .put("summary", checked.getString("summary")).put("confirmed_text", content.getString("body"))
                                .put("evidence", JSONArray(checked.getJSONArray("evidence").toString()))
                                .put("source_fingerprint", fingerprint).put("source_status", "current").put("original_available", false)
                                .put("candidate_id", id).put("candidate_version", version).put("session_id", checked.getString("session_id"))
                                .put("utterance_id", checked.getString("utterance_id")).put("confirmedAt", now))
                        document.put("items", JSONArray((items + saved).sortedWith(ITEM_ORDER).map(Item::json)))
                        settle(document, checked, action).put("memory_id", memoryId).put("confirmation_hash", confirmationHash)
                        result.put("memory", saved.json())
                    } else settle(document, requireNotNull(candidate), action)
                    document.put("candidates", JSONArray(rows.filterNot { it.getString("id") == id }))
                    mutationWriteStarted = true
                    writeDocument(document) // memory + candidate removal + tombstone commit together
                }
            }
            if (action == "list" && payload.has("check")) {
                val check = payload.optJSONObject("check") ?: throw MemoryFailure("个人候选核对请求无效")
                resolve(document, check, result)
            }
            result.put("items", JSONArray(objects(document.getJSONArray("candidates")).sortedByDescending { it.getLong("updatedAt") }))
                .put("ok", true)
        } catch (error: MemoryFailure) {
            result.remove("memory")
            result.put("ok", false).put("error", error.message)
            if (action != "list") result.put("write_status", if (mutationWriteStarted) "unknown" else "not_applied")
        } catch (_: Exception) {
            result.remove("memory")
            result.put("ok", false).put("error", "个人候选读取或保存未确认，请重新读取核对；不会自动重复提交")
            if (action != "list") result.put("write_status", if (mutationWriteStarted) "unknown" else "not_applied")
        }
        result
    }

    private fun settle(document: JSONObject, candidate: JSONObject, action: String): JSONObject {
        val rows = document.getJSONArray("settled")
        ensure(rows.length() < MAX_SETTLED, "个人候选处理记录已达上限，未改变本次内容")
        return JSONObject().put("id", candidate.getString("id")).put("action", action)
            .put("version", candidate.getLong("version")).put("source_fingerprint", candidate.getString("source_fingerprint"))
            .also { rows.put(it) }
    }

    /** One atomic snapshot proves an exact prior operation; list absence proves nothing. */
    private fun resolve(document: JSONObject, check: JSONObject, result: JSONObject) {
        val action = check.optString("action")
        val id = check.optString("id")
        val version = check.getLong("version")
        val fingerprint = check.optString("source_fingerprint")
        ensure(action in setOf("confirm", "discard") && candidateId(id) && version > 0 && HASH.matches(fingerprint),
            "个人候选核对请求无效")
        val contentHash = if (action == "confirm") {
            val kind = check.opt("kind") as? String
            ensure(kind in KINDS, "个人记忆核对分类无效")
            confirmationDigest(id, version, fingerprint, kind!!,
                text(check, "title", "个人记忆核对标题无效", MAX_TITLE), text(check, "text", "个人记忆核对内容无效", 280))
        } else null
        val receipt = objects(document.getJSONArray("settled")).firstOrNull {
            it.optString("id") == id && it.optString("action") == action && it.optLong("version") == version &&
                it.optString("source_fingerprint") == fingerprint && (action != "confirm" || it.optString("confirmation_hash") == contentHash)
        }
        val resolution = JSONObject().put("id", id).put("version", version).put("source_fingerprint", fingerprint)
            .put("action", action).put("status", if (receipt == null) "unresolved" else if (action == "confirm") "confirmed" else "discarded")
        if (receipt != null && action == "confirm") {
            val memoryId = receipt.getString("memory_id")
            val saved = parseItems(document).firstOrNull { item ->
                val origin = item.provenance
                item.id == memoryId && origin != null && origin.optString("candidate_id") == id &&
                    origin.optLong("candidate_version") == version && origin.optString("source_fingerprint") == fingerprint
            }
            resolution.put("memory_id", memoryId).put("memory_missing", saved == null)
            if (saved != null) result.put("memory", saved.json())
        }
        result.put("resolution", resolution)
    }

    private fun confirmationDigest(id: String, version: Long, fingerprint: String, kind: String, title: String, body: String) =
        hash(listOf(id, version.toString(), fingerprint, kind, title, body).joinToString("") { part -> "${part.length}:$part" })

    private fun validateCandidate(row: JSONObject) {
        ensure(candidateId(row.opt("id")) && SESSION.matches(row.optString("session_id")) &&
            row.optString("utterance_id").isNotBlank() && row.optLong("version") > 0 &&
            HASH.matches(row.optString("source_fingerprint")) && (row.opt("kind") as? String) in KINDS &&
            row.optString("status") == "candidate" && !row.optBoolean("subject_confirmed") &&
            row.optString("subject") == "需本人核对" && row.opt("original_available") == false, STORAGE_ERROR)
        text(row, "title", STORAGE_ERROR, MAX_TITLE); text(row, "summary", STORAGE_ERROR, 280)
        ensure(row.optString("text") == row.getString("summary") && timestamp(row, "createdAt") <= timestamp(row, "updatedAt"), STORAGE_ERROR)
        validateEvidence(row.getJSONArray("evidence"), row.getString("utterance_id"))
    }

    private fun validateEvidence(evidence: JSONArray, currentId: String) {
        ensure(evidence.length() in 1..5, STORAGE_ERROR)
        var total = 0
        val ids = HashSet<String>()
        for (part in objects(evidence)) {
            val quote = part.opt("quote") as? String ?: throw MemoryFailure(STORAGE_ERROR)
            total += quote.codePointCount(0, quote.length)
            ensure(ids.add(part.getString("id")) && quote.isNotBlank() && total <= 280 &&
                HASH.matches(part.optString("text_hash")) && part.getLong("start_ms") >= 0 &&
                part.getLong("end_ms") >= part.getLong("start_ms") &&
                (part.isNull("speaker") || part.opt("speaker") is String), STORAGE_ERROR)
        }
        ensure(currentId in ids, STORAGE_ERROR)
    }

    private fun objects(rows: JSONArray): List<JSONObject> = (0 until rows.length()).map(rows::getJSONObject)
    private fun candidateId(value: Any?) = value is String && value.startsWith("personal-candidate-") && HASH.matches(value.removePrefix("personal-candidate-"))
    private fun hash(value: String) = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it.toInt() and 255) }
    private fun capabilities() = JSONObject().put("manual", true).put("typed_candidates", true).put("cloud_sync", false)

    companion object {
        private val LOCK = Any()
        private val KINDS = setOf("身份", "偏好", "目标", "经历", "日常")
        private val ID_PATTERN = Regex("(?:personal-)?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
        private val ITEM_ORDER = compareByDescending<Item> { it.updatedAt }.thenByDescending { it.createdAt }.thenBy { it.id }
        private const val MAX_REQUEST_ID = 160
        private const val MAX_TITLE = 100
        private const val MAX_BODY = 5000
        private const val MAX_ITEMS = 1000
        private const val MAX_CANDIDATES = 200
        private const val MAX_SETTLED = 4096
        private const val MAX_FILE_BYTES = 32 * 1024 * 1024
        private val HASH = Regex("[a-f0-9]{64}")
        private val SESSION = Regex("[A-Za-z0-9_-]{1,100}")
        private val SOURCE_FIELDS = listOf("source", "confirmed", "subject_confirmed", "summary", "confirmed_text", "evidence",
            "source_fingerprint", "source_status", "original_available", "candidate_id", "candidate_version", "session_id", "utterance_id", "confirmedAt")
        private const val STORAGE_ERROR = "个人记忆文件暂不可读，已停止修改以保留原数据，请勿重复提交"
    }
}
