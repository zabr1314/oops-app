package com.oops.app.store

import org.json.JSONObject
import java.net.URI

/** Frozen destination identity only. Never persists access credentials. */
data class RecordingOrigin(val backendUrl: String, val mock: Boolean) {
    fun attach(meta: JSONObject): JSONObject = meta.put("backend_url", backendUrl).put("backend_mock", mock)
    fun matches(meta: JSONObject): Boolean = meta.has("backend_url") && meta.has("backend_mock") &&
        from(meta.optString("backend_url"), meta.optBoolean("backend_mock")) == this

    companion object {
        fun from(url: String, mock: Boolean): RecordingOrigin? = runCatching {
            if (url.isBlank() && mock) return@runCatching RecordingOrigin("", true)
            val uri = URI(url.trim())
            require(uri.scheme in setOf("http", "https") && uri.host != null && uri.userInfo == null && uri.query == null && uri.fragment == null)
            val scheme = uri.scheme.lowercase()
            val port = uri.port.takeUnless { it == 80 && scheme == "http" || it == 443 && scheme == "https" } ?: -1
            RecordingOrigin(URI(scheme, null, uri.host.lowercase(), port, uri.path.orEmpty().trimEnd('/'), null, null).toASCIIString(), mock)
        }.getOrNull()
    }
}
