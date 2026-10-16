package com.oops.app.backend

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okio.BufferedSink
import org.json.JSONObject
import java.io.IOException

/** The real backend (洪玉麟's service), see docs/api.md. */
class HttpOopsApi(private val http: OkHttpClient, baseUrl: String, private val token: String = "", private val sessionMode: (String) -> String? = { null },
    private val personalToken: () -> String = { "" }, private val savePersonalToken: (String) -> Unit = {},
    private val enablePersonalIdentity: Boolean = false) : OopsApi,
    com.oops.app.store.RecordingTransport {
    override val name = "http"
    private val base = baseUrl.trim().trimEnd('/')
    // Task reads have their own bounded budget; do not relax ASR/model or write deadlines.
    private val taskHttp by lazy {
        http.newBuilder().callTimeout(20, java.util.concurrent.TimeUnit.SECONDS)
            .readTimeout(15, java.util.concurrent.TimeUnit.SECONDS)
            .retryOnConnectionFailure(false).followRedirects(false).followSslRedirects(false).build()
    }
    @Volatile private var archivePolicySupported = false
    @Volatile private var personalSupported = false
    private fun requirePolicySupportBlocking() {
        if (archivePolicySupported) return
        val health = blocking(request("/healthz").get().build())
        require(health.optInt("archive_policy_version") >= 1) { "当前服务尚不支持日常临时处理和分别保存期限，请更新服务后重试" }
        personalSupported = health.optInt("feishu_mobile_version") >= 1
        archivePolicySupported = true
    }
    suspend fun requireArchivePolicy() = withContext(Dispatchers.IO) { requirePolicySupportBlocking() }

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

    private fun execute(request: Request): okhttp3.Response = http.newCall(request).execute()

    private fun ensurePersonalSession() = synchronized(identityLock) {
        if (personalToken().isBlank()) {
            val result = blocking(request("/v1/feishu/session").post("{}".toRequestBody(JSON)).build())
            val session = result.optString("session_token")
            require(session.length >= 32) { "服务未返回有效个人连接身份" }
            savePersonalToken(session)
            require(personalToken() == session) { "个人连接身份未能安全保存" }
        }
    }

    override suspend fun feishuCall(action: String, request: JSONObject): JSONObject = withContext(Dispatchers.IO) {
        ensurePersonalSession()
        val id = request.optString("sessionId")
        if (action.startsWith("minutes.delivery.")) require(id.matches(Regex("[A-Za-z0-9_-]{1,100}")))
        val body = JSONObject(request.toString())
        if (body.has("opId")) body.put("op_id", body.getString("opId"))
        val path = when (action) {
            "feishu.status" -> "/v1/feishu/status"
            "feishu.connect" -> "/v1/feishu/connect"
            "feishu.disconnect" -> "/v1/feishu/disconnect"
            "feishu.recipients" -> "/v1/feishu/recipients?q=" + java.net.URLEncoder.encode(request.optString("query"), "UTF-8")
            "minutes.delivery.open" -> "/v1/meetings/$id/delivery"
            "minutes.delivery.save" -> "/v1/meetings/$id/delivery/save"
            "minutes.delivery.confirm" -> "/v1/meetings/$id/delivery/confirm"
            "minutes.delivery.status" -> "/v1/meetings/$id/delivery/status"
            else -> throw IllegalArgumentException("未知的飞书操作")
        }
        if (action in setOf("feishu.status", "feishu.recipients", "minutes.delivery.open", "minutes.delivery.status"))
            blocking(this@HttpOopsApi.request(path).get().build())
        else blocking(this@HttpOopsApi.request(path).post(body.toString().toRequestBody(JSON)).build())
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
        if (enablePersonalIdentity) withContext(Dispatchers.IO) { ensurePersonalSession() }
        return optionalGet("/v1/projects/" + java.net.URLEncoder.encode(name, "UTF-8").replace("+", "%20"))
    }
    override suspend fun setMeetingProject(sessionId: String, project: String) =
        optional("/v1/meetings/project", JSONObject().put("session_id", sessionId).put("project", project))
    override suspend fun renameMeeting(sessionId: String, title: String) =
        optional("/v1/meetings/rename", JSONObject().put("session_id", sessionId).put("title", title))
    override suspend fun tasks(assignee: String?, status: String, mine: Boolean): JSONObject? {
        if (enablePersonalIdentity) withContext(Dispatchers.IO) { ensurePersonalSession() }
        require(status in setOf("open", "done", "all"))
        val query = "status=$status" + if (enablePersonalIdentity && (mine || assignee != null)) "&mine=1"
            else assignee?.let { "&assignee=" + java.net.URLEncoder.encode(it, "UTF-8") }.orEmpty()
        return taskGet("/v1/tasks?$query&include_candidates=0")
    }
    override suspend fun taskCandidates(): JSONObject? {
        if (enablePersonalIdentity) withContext(Dispatchers.IO) { ensurePersonalSession() }
        return taskGet("/v1/task-candidates")
    }
    private suspend fun taskGet(path: String): JSONObject? = withContext(Dispatchers.IO) {
        taskHttp.newCall(request(path).get().build()).execute().use { response ->
            if (response.code == 404 || response.code == 501) null
            else if (!response.isSuccessful) throw failure(response.code, response.body.string())
            else JSONObject(response.body.string())
        }
    }
    override suspend fun taskReview(request: JSONObject, save: Boolean): JSONObject? = withContext(Dispatchers.IO) {
        ensurePersonalSession()
        val mid = request.getString("source_meeting_id")
        val uid = request.getString("item_id")
        require(mid.matches(Regex("[0-9]{4}")) && uid.matches(Regex("ai-[0-9a-f]{12}"))) { "核对事项编号无效" }
        val path = if (save) "/v1/task-candidates/review" else "/v1/task-candidates/$mid/$uid"
        val builder = this@HttpOopsApi.request(path)
        if (save) {
            val body = request.toString().toRequestBody(JSON)
            builder.post(object : RequestBody() {
                override fun contentType() = body.contentType()
                override fun contentLength() = body.contentLength()
                override fun writeTo(sink: BufferedSink) = body.writeTo(sink)
                override fun isOneShot() = true
            })
        } else builder.get()
        taskHttp.newCall(builder.build()).execute().use { response ->
            if (response.code == 404 || response.code == 501) null
            else if (!response.isSuccessful) throw failure(response.code, response.body.string())
            else JSONObject(response.body.string())
        }
    }
    override suspend fun recordingClip(sessionId: String, startMs: Long, endMs: Long): ByteArray? = withContext(Dispatchers.IO) {
        require(startMs in 0 until endMs)
        execute(request(recordingPath(sessionId) + "/clip?start_ms=$startMs&end_ms=$endMs").get().build()).use { response ->
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
        execute(request(path).get().build()).use { response ->
            if (response.code == 404 || response.code == 501) null
            else if (!response.isSuccessful) throw failure(response.code, response.body.string())
            else JSONObject(response.body.string())
        }
    }

    override suspend fun recall(request: RecallRequest) =
        ApiJson.recallResponse(post("/v1/recall", ApiJson.recallRequest(request)))

    override suspend fun draftAction(request: DraftRequest): DraftResponse {
        if (enablePersonalIdentity) withContext(Dispatchers.IO) { ensurePersonalSession() }
        return ApiJson.draftResponse(post("/v1/actions/draft", ApiJson.draftRequest(request)))
    }

    override suspend fun draftFromItem(sessionId: String, itemId: String, fingerprint: String): JSONObject? {
        require(sessionId.matches(Regex("[A-Za-z0-9_-]{1,100}"))) { "来源会话编号无效" }
        require(itemId.isNotBlank() && itemId.length <= 200 && fingerprint.isNotBlank() && fingerprint.length <= 200) { "事项来源无效" }
        withContext(Dispatchers.IO) { ensurePersonalSession() }
        val body = JSONObject().put("session_id", sessionId).put("item_id", itemId).put("fingerprint", fingerprint)
        return optional("/v1/actions/from-item", body)?.also { result ->
            require(result.getString("session_id") == sessionId && result.getString("item_id") == itemId &&
                result.getString("item_fingerprint") == fingerprint) { "服务返回的事项来源不一致" }
        }
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

    suspend fun voiceprints(): JSONObject = call(request("/v1/voiceprints").get().build())
    suspend fun enrollVoiceprint(body: JSONObject): JSONObject = post("/v1/voiceprints/enroll", body)
    suspend fun testVoiceprint(body: JSONObject): JSONObject = post("/v1/voiceprints/test", body)
    suspend fun deleteVoiceprint(body: JSONObject): JSONObject = post("/v1/voiceprints/delete", body)

    private suspend fun optional(path: String, json: JSONObject): JSONObject? = withContext(Dispatchers.IO) {
        execute(request(path).post(scoped(json).toString().toRequestBody(JSON)).build()).use { response ->
            if (response.code == 404 || response.code == 501) null
            else if (!response.isSuccessful) throw failure(response.code, response.body.string())
            else JSONObject(response.body.string())
        }
    }

    override suspend fun getAction(opId: String) =
        ApiJson.actionResult(call(request("/v1/actions/$opId").get().build()))

    // ---- raw meeting assets (blocking; call off the main thread) ----

    private fun recordingPath(id: String): String {
        require(id.matches(Regex("[A-Za-z0-9-]{8,80}")))
        return "/v1/recordings/$id"
    }

    private fun blocking(request: Request): JSONObject = execute(request).use { response ->
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

    override fun recordingManifest(sessionId: String, body: JSONObject) =
        blocking(request(recordingPath(sessionId) + "/manifest").post(scoped(body).toString().toRequestBody(JSON)).build())

    override fun recordingChunk(sessionId: String, name: String, offset: Long, bytes: ByteArray, sha256: String): Long {
        require(name in setOf("audio.pcm", "finals.jsonl", "asr.jsonl", "timing.jsonl", "meta.json"))
        return blocking(request(recordingPath(sessionId) + "/$name?offset=$offset").header("X-Content-SHA256", sha256)
            .put(bytes.toRequestBody(OCTET)).build()).getLong("received")
    }

    override fun recordingComplete(sessionId: String) =
        blocking(request(recordingPath(sessionId) + "/complete").post("{}".toRequestBody(JSON)).build())

    private fun scoped(body: JSONObject): JSONObject {
        sessionMode(body.optString("session_id"))?.let { body.put("recording_mode", it) }
        if (body.has("recording_mode")) requirePolicySupportBlocking()
        return body
    }

    private suspend fun post(path: String, body: JSONObject): JSONObject = withContext(Dispatchers.IO) {
        call(request(path).post(scoped(body).toString().toRequestBody(JSON)).build())
    }

    private suspend fun call(request: Request): JSONObject = withContext(Dispatchers.IO) {
        execute(request).use { response ->
            val text = response.body.string()
            if (!response.isSuccessful) throw failure(response.code, text)
            JSONObject(text)
        }
    }

    private fun failure(status: Int, text: String): IOException {
        ActionSourceRejected.fromHttp(status, text)?.let { return it }
        val json = runCatching { JSONObject(text) }.getOrNull()
        val error = json?.optJSONObject("error")
        val detail = error?.optString("message")?.take(160)?.takeIf { it.isNotBlank() } ?: "服务暂时不可用"
        val code = error?.optString("code")?.takeIf { it.matches(Regex("[A-Z_]{1,60}")) }
        val noWrite = error?.opt("no_external_write") == true || error?.optJSONObject("extra")?.opt("no_external_write") == true ||
            json?.optJSONObject("extra")?.opt("no_external_write") == true
        val message = if ((status == 401 || status == 403) && (code == null || code == "UNAUTHORIZED"))
            "后端授权失效（HTTP $status），请检查服务授权" else "后端返回 $status：$detail"
        return HttpFailure(status, message, code, noWrite)
    }

    private companion object {
        val identityLock = Any()
        val JSON = "application/json; charset=utf-8".toMediaType()
        val OCTET = "application/octet-stream".toMediaType()
    }
}
