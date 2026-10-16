package com.oops.app.backend

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import org.json.JSONArray
import java.io.IOException

/** The real backend (洪玉麟's service), see docs/api.md. */
class HttpOopsApi(private val http: OkHttpClient, baseUrl: String, private val token: String = "", private val sessionMode: (String) -> String? = { null },
    private val personalToken: () -> String = { "" }, private val savePersonalToken: (String) -> Unit = {},
    private val enablePersonalIdentity: Boolean = false) : OopsApi,
    com.oops.app.store.RecordingTransport {
    override val name = "http"
    private val base = baseUrl.trim().trimEnd('/')
    @Volatile private var archivePolicySupported = false
    @Volatile private var personalSupported = false
    private fun requirePolicySupportBlocking() {
        if (archivePolicySupported) return
        val health = blocking(request("/healthz").get().build())
        require(health.optInt("archive_policy_version") >= 1) { "当前服务尚不支持日常临时处理和分别保存期限，请更新服务后重试" }
        personalSupported = health.optInt("feishu_mobile_version") >= 1
        archivePolicySupported = true
    }
    suspend fun requireArchivePolicy() = withContext(Dispatchers.IO) {
        requirePolicySupportBlocking()
        requirePersonalIdentityBlocking()
    }

    private fun request(path: String): Request.Builder {
        val builder = Request.Builder().url(base + path)
        if (token.isNotBlank()) {
            val url = builder.build().url
            require(url.isHttps || url.host in setOf("127.0.0.1", "localhost", "::1")) { "服务访问凭据需要 HTTPS" }
            builder.header("Authorization", "Bearer $token")
        }
        personalToken().takeIf { it.isNotBlank() }?.let {
            val url = builder.build().url
            require(url.isHttps || url.host in setOf("127.0.0.1", "localhost", "::1")) { "个人连接需要 HTTPS" }
            builder.header("X-Oops-User-Token", it)
        }
        return builder
    }

    private fun ensurePersonalSession() = synchronized(identityLock) {
        if (personalToken().isBlank()) {
            val result = blocking(request("/v1/feishu/session").post("{}".toRequestBody(JSON)).build())
            val session = result.optString("session_token")
            require(session.length >= 32) { "服务未返回有效个人连接身份" }
            savePersonalToken(session)
            require(personalToken() == session) { "个人连接身份未能安全保存" }
        }
    }

    /** Called off the UI thread, before building the request and its headers. */
    private fun requirePersonalIdentityBlocking() {
        if (enablePersonalIdentity || personalSupported) ensurePersonalSession()
    }

    override suspend fun feishuCall(action: String, request: JSONObject): JSONObject = withContext(Dispatchers.IO) {
        ensurePersonalSession()
        val id = request.optString("sessionId")
        if (action.startsWith("minutes.delivery.") || action.startsWith("calendar."))
            require(id.matches(Regex("[A-Za-z0-9_-]{1,100}")))
        val job = request.optString("jobId")
        if (action.startsWith("assistant.delivery.")) {
            require(job.matches(Regex("[a-f0-9]{32}")))
            require(id.matches(Regex("[A-Za-z0-9_-]{1,100}")))
        }
        if (action == "assistant.jobs" && id.isNotBlank()) require(id.matches(Regex("[A-Za-z0-9_-]{1,100}")))
        val followup = request.optString("followupId", "manual")
        if (action.startsWith("calendar.")) require(followup.matches(Regex("[A-Za-z0-9_-]{1,100}")))
        val body = if (action.startsWith("personal.context.")) JSONObject().apply {
            val fields = if (action == "personal.context.snapshot") setOf("memory_ids", "scenario")
                else if (action == "personal.context.delete") setOf("op_id", "expected_revision", "memory_id")
                else setOf("op_id", "expected_revision", "confirmed", "value", "memory_id", "source")
            for (key in fields) if (request.has(key)) put(key, request.get(key))
        } else JSONObject(request.toString())
        if (body.has("opId")) body.put("op_id", body.getString("opId"))
        if (body.has("followupId")) body.put("followup_id", followup)
        val path = when (action) {
            "feishu.status" -> "/v1/feishu/status"
            "feishu.connect" -> "/v1/feishu/connect"
            "feishu.disconnect" -> "/v1/feishu/disconnect"
            "feishu.recipients" -> "/v1/feishu/recipients?q=" + java.net.URLEncoder.encode(request.optString("query"), "UTF-8")
            "personal.context.read" -> "/v1/personal/context"
            "personal.context.profile" -> "/v1/personal/context/profile"
            "personal.context.preferences" -> "/v1/personal/context/preferences"
            "personal.context.memory" -> "/v1/personal/context/memories"
            "personal.context.delete" -> "/v1/personal/context/memories/delete"
            "personal.context.snapshot" -> "/v1/personal/context/snapshot"
            "minutes.delivery.open" -> "/v1/meetings/$id/delivery"
            "minutes.delivery.save" -> "/v1/meetings/$id/delivery/save"
            "minutes.delivery.confirm" -> "/v1/meetings/$id/delivery/confirm"
            "minutes.delivery.status" -> "/v1/meetings/$id/delivery/status"
            "assistant.jobs" -> "/v1/assistant/jobs" + if (id.isNotBlank()) "?session_id=" + java.net.URLEncoder.encode(id, "UTF-8") else ""
            "assistant.delivery.open" -> "/v1/assistant/jobs/$job/delivery"
            "assistant.delivery.save" -> "/v1/assistant/jobs/$job/delivery/save"
            "assistant.delivery.confirm" -> "/v1/assistant/jobs/$job/delivery/confirm"
            "assistant.delivery.status" -> "/v1/assistant/jobs/$job/delivery/status"
            "calendar.open" -> "/v1/meetings/$id/calendar?followup_id=$followup"
            "calendar.save" -> "/v1/meetings/$id/calendar/save?followup_id=$followup"
            "calendar.confirm" -> "/v1/meetings/$id/calendar/confirm?followup_id=$followup"
            "calendar.status" -> "/v1/meetings/$id/calendar/status?followup_id=$followup"
            else -> throw IllegalArgumentException("未知的飞书操作")
        }
        val result = if (action in setOf("feishu.status", "feishu.recipients", "minutes.delivery.open", "minutes.delivery.status",
                "assistant.jobs", "assistant.delivery.open", "assistant.delivery.status", "calendar.open", "calendar.status", "personal.context.read"))
            blocking(this@HttpOopsApi.request(path).get().build())
        else blocking(this@HttpOopsApi.request(path).post(body.toString().toRequestBody(JSON)).build())
        validatePersonalReply(action, request, result)
    }

    override suspend fun notice(request: JSONObject): JSONObject? =
        optional("/v1/notices", request)?.let { NoticeJson.validate(it, request) }
    override suspend fun syncMeeting(request: JSONObject): JSONObject? {
        if (request.has("recording_mode")) withContext(Dispatchers.IO) {
            requirePolicySupportBlocking()
            if (personalSupported) ensurePersonalSession()
        }
        val result = optional("/v1/meetings/sync", request)
        if (result != null) {
            require(result.optString("session_id") == request.getString("session_id")) { "服务返回的会话编号不一致" }
            require(result.optString("transcript_status") != "expired") { "服务完整文字已到期，不能确认恢复" }
        }
        if (request.has("recording_mode") && result != null) {
            val accepted = result.optJSONObject("storage_policy") ?: throw IOException("服务未确认本次保存期限")
            for (key in listOf("recording_mode", "cloud_save_confirmed", "audio_retention_days", "transcript_retention_days"))
                require(accepted.opt(key) == request.opt(key)) { "服务确认的保存方式与本次选择不一致" }
            require(java.time.Duration.between(java.time.Instant.parse(accepted.getString("archive_started_at")), java.time.Instant.parse(request.getString("archive_started_at"))).abs() <= java.time.Duration.ofNanos(1_000)) { "服务确认的保存起点与本次选择不一致" }
        }
        return result
    }
    override suspend fun historyList() = optionalGet("/v1/meetings?limit=30")
    override suspend fun historyOpen(id: String): JSONObject? {
        require(id.matches(Regex("[A-Za-z0-9_-]{1,100}")))
        return optionalGet("/v1/meetings/$id")
    }
    override suspend fun historyMinutes(id: String): JSONObject? {
        require(id.matches(Regex("[A-Za-z0-9_-]{1,100}")))
        return optionalGet("/v1/meetings/$id/minutes")
    }
    override suspend fun meetingBoard(id: String): JSONObject? {
        require(id.matches(Regex("[A-Za-z0-9_-]{1,100}")))
        return optionalGet("/v1/meetings/$id/board")
    }
    override suspend fun retainMeeting(request: JSONObject) = optional("/v1/meetings/retain", request)
    override suspend fun historyDelete(id: String) = optional("/v1/meetings/delete", JSONObject().put("session_id", id).put("confirm", true))
    override suspend fun historySearch(query: String) = optional("/v1/meetings/search", JSONObject().put("query", query))
    override suspend fun reviewMeeting(request: JSONObject) = optional("/v1/meetings/review", request)
    override suspend fun reviewMeetingItem(request: JSONObject) = optional("/v1/meetings/items", request)
    override suspend fun projects() = optionalGet("/v1/projects")
    override suspend fun project(name: String): JSONObject? {
        require(name.isNotBlank() && name.length <= 30)
        return optionalGet("/v1/projects/" + java.net.URLEncoder.encode(name, "UTF-8").replace("+", "%20"))
    }
    override suspend fun setMeetingProject(sessionId: String, project: String) =
        optional("/v1/meetings/project", JSONObject().put("session_id", sessionId).put("project", project))
    override suspend fun renameMeeting(sessionId: String, title: String) =
        optional("/v1/meetings/rename", JSONObject().put("session_id", sessionId).put("title", title))
    override suspend fun tasks(assignee: String?, status: String): JSONObject? {
        if (enablePersonalIdentity) withContext(Dispatchers.IO) { ensurePersonalSession() }
        require(status in setOf("open", "done", "all"))
        val query = "status=$status" + (assignee?.let { "&assignee=" + java.net.URLEncoder.encode(it, "UTF-8") } ?: "")
        return optionalGet("/v1/tasks?$query")
    }
    override suspend fun recordingClip(sessionId: String, startMs: Long, endMs: Long): ByteArray? = withContext(Dispatchers.IO) {
        require(startMs in 0 until endMs)
        requirePersonalIdentityBlocking()
        http.newCall(request(recordingPath(sessionId) + "/clip?start_ms=$startMs&end_ms=$endMs").get().build()).execute().use { response ->
            when {
                response.code == 404 || response.code == 501 -> null
                response.code == 409 -> throw HttpFailure(409, "录音还没上传到这一段")
                response.code == 410 -> throw com.oops.app.store.RecordingAssetExpired("audio")
                !response.isSuccessful -> throw HttpFailure(response.code, "原声接口返回 HTTP ${response.code}")
                else -> com.oops.app.core.Wav.openPcm(response.body.byteStream()).use { it.readBytes() }
            }
        }
    }
    private suspend fun optionalGet(path: String): JSONObject? = withContext(Dispatchers.IO) {
        requirePersonalIdentityBlocking()
        http.newCall(request(path).get().build()).execute().use { response ->
            if (response.code == 404 || response.code == 501) null
            else if (!response.isSuccessful) throw HttpFailure(response.code, "会议接口返回 HTTP ${response.code}")
            else JSONObject(response.body.string())
        }
    }

    override suspend fun recall(request: RecallRequest) =
        ApiJson.recallResponse(post("/v1/recall", ApiJson.recallRequest(request)))

    override suspend fun draftAction(request: DraftRequest): DraftResponse {
        if (enablePersonalIdentity) withContext(Dispatchers.IO) { ensurePersonalSession() }
        return ApiJson.draftResponse(post("/v1/actions/draft", ApiJson.draftRequest(request)))
    }

    override suspend fun confirmAction(request: ConfirmRequest): ActionResult {
        if (enablePersonalIdentity) withContext(Dispatchers.IO) { ensurePersonalSession() }
        return ApiJson.actionResult(post("/v1/actions/confirm", ApiJson.confirmRequest(request)))
    }

    /** Optional endpoint: a backend without voiceprints answers 404/501 and we simply skip. */
    override suspend fun identifySpeaker(request: SpeakerRequest): SpeakerResult? =
        optional("/v1/speaker", ApiJson.speakerRequest(request))?.let(ApiJson::speakerResult)

    override suspend fun speakerSplit(sessionId: String, utteranceId: String): SplitFetch? =
        optional("/v1/speaker/split", ApiJson.splitRequest(sessionId, utteranceId))?.let(ApiJson::splitResult)

    override suspend fun tagUtterance(request: TagRequest): TagResult? =
        optional("/v1/utterances", ApiJson.tagRequest(request))?.let(ApiJson::tagResult)

    override suspend fun previewSpeakers(request: SpeakerRequest): com.oops.app.buffer.SpeakerPreview? =
        optional("/v1/speaker-preview", ApiJson.speakerRequest(request))?.let(ApiJson::speakerPreview)

    suspend fun voiceprints(): JSONObject = withContext(Dispatchers.IO) {
        requirePersonalIdentityBlocking()
        call(request("/v1/voiceprints").get().build())
    }
    suspend fun enrollVoiceprint(body: JSONObject): JSONObject = post("/v1/voiceprints/enroll", body)
    suspend fun testVoiceprint(body: JSONObject): JSONObject = post("/v1/voiceprints/test", body)
    suspend fun deleteVoiceprint(body: JSONObject): JSONObject = post("/v1/voiceprints/delete", body)

    private suspend fun optional(path: String, json: JSONObject): JSONObject? = withContext(Dispatchers.IO) {
        requirePersonalIdentityBlocking()
        http.newCall(request(path).post(scoped(json).toString().toRequestBody(JSON)).build()).execute().use { response ->
            if (response.code == 404 || response.code == 501) null
            else if (!response.isSuccessful) throw HttpFailure(response.code, "分析接口返回 HTTP ${response.code}")
            else JSONObject(response.body.string())
        }
    }

    override suspend fun getAction(opId: String) = withContext(Dispatchers.IO) {
        requirePersonalIdentityBlocking()
        ApiJson.actionResult(call(request("/v1/actions/$opId").get().build()))
    }

    // ---- raw meeting assets (blocking; call off the main thread) ----

    private fun recordingPath(id: String): String {
        require(id.matches(Regex("[A-Za-z0-9-]{8,80}")))
        return "/v1/recordings/$id"
    }

    private fun blocking(request: Request): JSONObject = http.newCall(request).execute().use { response ->
        val text = response.body.string()
        val error = runCatching { JSONObject(text).optJSONObject("error") }.getOrNull()
        if (response.code == 409 && error?.has("received") == true) throw com.oops.app.store.ResumeAt(error.getLong("received"))
        if (response.code == 410) {
            val asset = error?.optString("asset")?.takeIf { it in setOf("audio", "transcript") }
                ?: error?.optJSONObject("extra")?.optString("asset")?.takeIf { it in setOf("audio", "transcript") }
                ?: runCatching { JSONObject(text).optJSONObject("extra")?.optString("asset") }.getOrNull()?.takeIf { it in setOf("audio", "transcript") }
            throw com.oops.app.store.RecordingAssetExpired(asset)
        }
        if (!response.isSuccessful) throw HttpFailure(response.code, "请求未完成（HTTP ${response.code}）：${error?.optString("message") ?: ""}",
            error?.optString("code")?.takeIf { it.matches(Regex("[A-Z_]{1,60}")) })
        JSONObject(text)
    }

    override fun recordingManifest(sessionId: String, body: JSONObject): JSONObject {
        requirePersonalIdentityBlocking()
        return blocking(request(recordingPath(sessionId) + "/manifest").post(scoped(body).toString().toRequestBody(JSON)).build())
    }

    override fun recordingChunk(sessionId: String, name: String, offset: Long, bytes: ByteArray, sha256: String): Long {
        require(name in setOf("audio.pcm", "finals.jsonl", "asr.jsonl", "timing.jsonl", "meta.json"))
        requirePersonalIdentityBlocking()
        return blocking(request(recordingPath(sessionId) + "/$name?offset=$offset").header("X-Content-SHA256", sha256)
            .put(bytes.toRequestBody(OCTET)).build()).getLong("received")
    }

    override fun recordingComplete(sessionId: String): JSONObject {
        requirePersonalIdentityBlocking()
        return blocking(request(recordingPath(sessionId) + "/complete").post("{}".toRequestBody(JSON)).build())
    }

    private fun scoped(body: JSONObject): JSONObject {
        sessionMode(body.optString("session_id"))?.let { body.put("recording_mode", it) }
        if (body.has("recording_mode")) requirePolicySupportBlocking()
        return body
    }

    private suspend fun post(path: String, body: JSONObject): JSONObject = withContext(Dispatchers.IO) {
        requirePersonalIdentityBlocking()
        call(request(path).post(scoped(body).toString().toRequestBody(JSON)).build())
    }

    private suspend fun call(request: Request): JSONObject = withContext(Dispatchers.IO) {
        http.newCall(request).execute().use { response ->
            val text = response.body.string()
            if (!response.isSuccessful) {
                val error = runCatching { JSONObject(text).optJSONObject("error") }.getOrNull()
                val detail = error?.optString("message")?.take(160)?.takeIf { it.isNotBlank() }
                    ?: "服务暂时不可用"
                ActionSourceRejected.fromHttp(response.code, text)?.let { throw it }
                val code = error?.optString("code")?.takeIf { it.matches(Regex("[A-Z_]{1,50}")) }
                if ((response.code == 401 || response.code == 403) && (code == null || code == "UNAUTHORIZED")) {
                    throw IOException("后端授权失效（HTTP ${response.code}），请检查服务授权")
                }
                throw HttpFailure(response.code, "后端返回 ${response.code}：$detail", code)
            }
            JSONObject(text)
        }
    }

    companion object {
        private val identityLock = Any()
        private val JSON = "application/json; charset=utf-8".toMediaType()
        private val OCTET = "application/octet-stream".toMediaType()

        /** Validate provider identities before native request metadata can label a reply.
         * Agent's journal session_id is its job ID; source_session_id is the meeting.
         * Historical operations may have another review revision than a current draft.
         */
        internal fun validatePersonalReply(action: String, request: JSONObject, raw: JSONObject): JSONObject {
            val result = JSONObject(raw.toString())
            fun field(row: JSONObject, key: String, expected: String, required: Boolean = false) {
                if (!row.has(key) || row.isNull(key)) {
                    require(!required) { "服务回包缺少核对对象编号，请查询原操作" }
                    return
                }
                require(row.opt(key) is String && row.getString(key) == expected) { "服务回包对象不一致，请查询原操作" }
            }
            fun objectOrNull(row: JSONObject, key: String): JSONObject? {
                if (!row.has(key) || row.isNull(key)) return null
                require(row.opt(key) is JSONObject) { "服务回包格式无法核对" }
                return row.getJSONObject(key)
            }
            fun revision(row: JSONObject): Long {
                val value = row.opt("revision")
                require((value is Int || value is Long) && (value as Number).toLong() > 0) { "服务回包缺少有效核对版本" }
                return (value as Number).toLong()
            }
            if (action.startsWith("personal.context.")) {
                fun nonnegative(key: String) {
                    val value = result.opt(key)
                    require((value is Int || value is Long) && (value as Number).toLong() >= 0) { "个人上下文回包缺少有效版本" }
                }
                nonnegative("context_revision"); nonnegative("identity_revision")
                fun item(row: JSONObject, kind: String, id: String) {
                    field(row, "kind", kind, true); field(row, "id", id, true); revision(row)
                    require(row.optString("status") in setOf("current", "deleted", "needs_review", "source_unavailable")) { "个人上下文状态无效" }
                    if (row.optString("status") == "current") {
                        require(row.optBoolean("confirmed") && row.opt("value") is JSONObject) { "个人上下文尚未确认" }
                    } else require(row.isNull("value")) { "失效个人上下文不得返回旧正文" }
                }
                if (action == "personal.context.read") {
                    objectOrNull(result, "profile")?.let { item(it, "profile", "current") }
                    objectOrNull(result, "preferences")?.let { item(it, "preferences", "current") }
                    val memories = result.optJSONArray("memories") ?: throw IllegalArgumentException("服务未返回个人记忆清单")
                    require(memories.length() <= 200) { "个人记忆清单过大" }
                    for (index in 0 until memories.length()) {
                        val row = memories.optJSONObject(index) ?: throw IllegalArgumentException("个人记忆格式无效")
                        require(row.optString("id").matches(Regex("[A-Za-z0-9_-]{1,100}"))) { "个人记忆编号无效" }
                        item(row, "memory", row.getString("id"))
                    }
                } else if (action != "personal.context.snapshot") {
                    val kind = when (action) { "personal.context.profile" -> "profile"; "personal.context.preferences" -> "preferences"; else -> "memory" }
                    val row = result.optJSONObject("item") ?: throw IllegalArgumentException("个人修改未返回当前版本")
                    item(row, kind, if (kind == "memory") request.getString("memory_id") else "current")
                    require(result.optLong("operation_revision", -1) == request.getLong("expected_revision") + 1) { "个人修改回包版本不一致，请核对原操作" }
                }
                return result
            }
            fun operation(row: JSONObject, expectedSession: String, job: String? = null,
                          source: String? = null, followup: String? = null) {
                field(row, "session_id", expectedSession, true)
                field(row, "sessionId", expectedSession)
                if (job != null) { field(row, "job_id", job, true); field(row, "jobId", job) }
                if (source != null) field(row, "source_session_id", source)
                if (followup != null) { field(row, "followup_id", followup, true); field(row, "followupId", followup) }
                require(row.opt("op_id") is String && row.getString("op_id").matches(Regex("[A-Za-z0-9_-]{8,100}"))) { "服务未返回有效原操作编号" }
                revision(row)
            }
            val sid = request.optString("sessionId")
            if (action == "assistant.jobs") {
                if (sid.isNotBlank()) field(result, "session_id", sid)
                fun checkedRows(key: String): JSONArray? {
                    if (!result.has(key)) return null
                    require(result.opt(key) is JSONArray) { "成果清单格式无法核对" }
                    val rows = result.getJSONArray(key)
                    val filtered = JSONArray()
                    for (index in 0 until rows.length()) {
                        val row = rows.optJSONObject(index) ?: throw IllegalArgumentException("成果清单包含无效对象")
                        val job = row.optString("job_id", row.optString("id"))
                        val source = row.optString("source_session_id", row.optString("session_id"))
                        require(job.matches(Regex("[a-f0-9]{32}")) && source.matches(Regex("[A-Za-z0-9_-]{1,100}"))) { "成果清单缺少有效来源编号" }
                        field(row, "job_id", job); field(row, "id", job); field(row, "jobId", job)
                        field(row, "session_id", source); field(row, "source_session_id", source); field(row, "sessionId", source)
                        objectOrNull(row, "delivery")?.let { operation(it, job, job, source) }
                        if (sid.isBlank() || source == sid) filtered.put(row)
                    }
                    return filtered
                }
                val items = checkedRows("items")
                val jobs = checkedRows("jobs")
                require(items != null || jobs != null) { "服务未返回成果清单" }
                if (items != null) result.put("items", items)
                if (jobs != null) result.put("jobs", jobs)
                return result
            }
            val agent = action.startsWith("assistant.delivery.")
            val calendar = action.startsWith("calendar.")
            if (!agent && !calendar && !action.startsWith("minutes.delivery.")) return result
            val job = request.optString("jobId")
            val expectedSession = if (agent) job else sid
            val followup = request.optString("followupId", "manual")
            field(result, "session_id", expectedSession, true)
            field(result, "sessionId", expectedSession)
            if (agent) { field(result, "job_id", job, true); field(result, "jobId", job); field(result, "source_session_id", sid) }
            if (calendar) { field(result, "followup_id", followup, true); field(result, "followupId", followup) }
            val draft = objectOrNull(result, "draft")
            val op = objectOrNull(result, if (calendar) "calendar" else "delivery")
                ?: if (result.has("op_id")) result else null
            if (draft != null) {
                field(draft, "session_id", expectedSession, true); field(draft, "sessionId", expectedSession)
                if (agent) { field(draft, "job_id", job, true); field(draft, "jobId", job); field(draft, "source_session_id", sid, true) }
                if (calendar) { field(draft, "followup_id", followup, true); field(draft, "followupId", followup) }
                revision(draft)
            }
            if (op != null) operation(op, expectedSession, if (agent) job else null, if (agent) sid else null, if (calendar) followup else null)
            if (agent && (draft != null || op?.optString("status") !in setOf("sent", "unknown", "invalidated", null))) {
                field(result, "source_session_id", sid, true)
            }
            if (action.endsWith(".save")) {
                val requested = revision(request)
                require(draft != null && revision(draft) == requested + 1) { "保存回包版本不一致，请重新读取草稿" }
            }
            if (action.endsWith(".confirm")) {
                require(op != null && revision(op) == revision(request)) { "确认回包版本不一致，请查询原操作" }
                require(draft == null || revision(draft) == revision(request)) { "确认回包含其他版本草稿，请重新读取原操作" }
            }
            if (agent && draft != null && op != null && revision(draft) == revision(op) &&
                draft.has("result_revision") && op.has("result_revision")) {
                require(draft.opt("result_revision") == op.opt("result_revision")) { "成果文件版本回包不一致，请查询原操作" }
            }
            if (action.endsWith(".status") && request.has("opId")) {
                require(op != null) { "服务未返回原操作回执，不能按未提交处理" }
                field(op, "op_id", request.getString("opId"), true)
            }
            return result
        }
    }
}
