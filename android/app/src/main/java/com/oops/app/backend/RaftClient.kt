package com.oops.app.backend

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import okio.BufferedSink
import org.json.JSONObject
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

/** Narrow Raft API transport. Provider/worker credentials never reach H5. */
class RaftClient(http: OkHttpClient, baseUrl: String, private val token: String, private val personalToken: String) {
    private val base = baseUrl.trim().trimEnd('/')
    private val client = http.newBuilder().callTimeout(20, TimeUnit.SECONDS)
        .retryOnConnectionFailure(false).followRedirects(false).followSslRedirects(false).build()
    private val readClient = client.newBuilder().connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS).callTimeout(20, TimeUnit.SECONDS).build()

    suspend fun call(operation: String, payload: JSONObject): JSONObject = withContext(Dispatchers.IO) {
        require(token.isNotBlank()) { "请先配置真实后端的服务访问凭据" }
        fun identity(key: String, pattern: String): String {
            val value = payload.optString(key)
            require(value.matches(Regex(pattern))) { "协作请求编号无效" }
            return value
        }
        fun query(): String = URLEncoder.encode(identity("request_id", "[A-Za-z0-9_.:-]{1,128}"), "UTF-8")
        fun sourceQuery(): String {
            require(personalToken.isNotBlank()) { "请先登录本人的飞书账号，再核对会议任务的协作来源" }
            val reference = payload.optJSONObject("source_ref") ?: payload
            val kind = reference.optString("kind")
            require(kind in setOf("meeting_item", "label_review")) { "该会议任务来源尚未接入协作" }
            fun sourceIdentity(key: String, pattern: String): String {
                val value = reference.optString(key)
                require(value.matches(Regex(pattern))) { "会议任务来源编号或指纹无效，请重新读取" }
                return value
            }
            val values = linkedMapOf("kind" to kind)
            val meetingKey = if (kind == "meeting_item") "session_id" else "source_meeting_id"
            values[meetingKey] = sourceIdentity(meetingKey, "[A-Za-z0-9_-]{1,100}")
            values["item_id"] = sourceIdentity("item_id", "[A-Za-z0-9_-]{1,100}")
            if (reference.has("fingerprint")) values["fingerprint"] = sourceIdentity("fingerprint", "[a-f0-9]{64}")
            if (payload.has("mode")) {
                require(payload.opt("mode") == "delegate") { "仅支持明确的候选交办读取模式" }
                values["mode"] = "delegate"
            }
            return values.entries.joinToString("&") { (key, value) -> "$key=" + URLEncoder.encode(value, "UTF-8") }
        }
        val path = when (operation) {
            "source.read" -> "/v1/raft/source?" + sourceQuery()
            "source.links" -> "/v1/raft/source/links?" + sourceQuery()
            "collaboration.read" -> "/v1/raft/collaboration"
            "collaboration.submit" -> "/v1/raft/collaboration/handoffs"
            "collaboration.find" -> "/v1/raft/collaboration/handoffs?request_id=" + query()
            "collaboration.continue" -> "/v1/raft/collaboration/continue"
            "collaboration.review" -> "/v1/raft/collaboration/reviews"
            "collaboration.cancel" -> "/v1/raft/collaboration/handoffs/" + identity("handoff_id", "[a-f0-9]{32}") + "/cancel"
            "task.create" -> "/v1/raft/tasks"
            "task.list" -> "/v1/raft/tasks" + if (payload.has("request_id")) "?request_id=" + query() else ""
            "task.get" -> "/v1/raft/tasks/" + identity("id", "raft-task:[a-f0-9]{32}")
            else -> throw IllegalArgumentException("未知的协作操作")
        }
        val write = operation in setOf("collaboration.submit", "collaboration.continue", "collaboration.review", "collaboration.cancel", "task.create")
        if (write) require(payload.opt("confirm") == true) { "请逐次核对正文、群成员并明确确认" }
        if (operation == "task.create" && payload.has("task_ref")) {
            require(personalToken.isNotBlank() && payload.opt("source_confirm") == true && payload.optJSONObject("source_contract") != null) {
                "请先用本人账号读取来源，并明确核对本次派工"
            }
        }
        val builder = Request.Builder().url(base + path)
        val url = builder.build().url
        require(url.username.isBlank() && url.password.isBlank() && (url.isHttps || url.host in setOf("127.0.0.1", "localhost", "::1"))) { "协作服务需要 HTTPS 或本机回环地址" }
        builder.header("Authorization", "Bearer $token")
        if (personalToken.isNotBlank()) builder.header("X-Oops-User-Token", personalToken)
        if (write) {
            val body = JSONObject(payload.toString()).apply { if (operation == "collaboration.cancel") remove("handoff_id") }.toString()
            require(body.toByteArray(Charsets.UTF_8).size <= 64000) { "协作正文过长" }
            val raw = body.toRequestBody("application/json; charset=utf-8".toMediaType())
            // Prevent OkHttp HTTP/auth follow-ups as well as connection retries.
            val once = object : RequestBody() {
                override fun contentType() = raw.contentType()
                override fun contentLength() = raw.contentLength()
                override fun isOneShot() = true
                override fun writeTo(sink: BufferedSink) = raw.writeTo(sink)
            }
            builder.post(once)
        } else builder.get()
        (if (write) client else readClient).newCall(builder.build()).execute().use { response ->
            val value = runCatching { JSONObject(response.body?.string().orEmpty()) }.getOrElse {
                throw HttpFailure(response.code, "协作服务回包不可核对")
            }
            if (!response.isSuccessful) {
                val detail = value.optJSONObject("error")
                throw HttpFailure(response.code, detail?.optString("message")?.takeIf { it.isNotBlank() } ?: "协作请求未完成", detail?.optString("code"))
            }
            value
        }
    }
}
