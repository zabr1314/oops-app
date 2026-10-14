package com.oops.app.backend

import java.io.IOException
import org.json.JSONObject

/** Only emitted for a structured 409 that explicitly guarantees no external write took place. */
class ActionSourceRejected(val code: String, message: String) : IOException(message) {
    companion object {
        fun fromHttp(status: Int, body: String): ActionSourceRejected? = runCatching {
            val json = JSONObject(body)
            val error = json.getJSONObject("error")
            val code = error.getString("code")
            val noWrite = error.opt("no_external_write") == true || error.optJSONObject("extra")?.opt("no_external_write") == true ||
                json.optJSONObject("extra")?.opt("no_external_write") == true
            if (status == 409 && noWrite && (code == "SOURCE_BINDING_REQUIRED" || code == "SOURCE_CHANGED" || code.startsWith("ACTION_SOURCE_")))
                ActionSourceRejected(code, error.optString("message", "来源已变化").take(160)) else null
        }.getOrNull()
    }
}
