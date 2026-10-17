package com.oops.app.audio

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class BeanAuthTest {
    private fun auth(user: String = "u", expires: Long = System.currentTimeMillis() / 1000 + 3600) =
        BeanAuth("u", "d", "token", JSONObject().put("user_id", user).put("device_id", "d")
            .put("license_expire_time", expires).toString(), "signature", false)

    @Test fun `only a complete matching unexpired licence can start`() {
        auth().requireUsable()
        for (invalid in listOf(auth(user = "other"), auth(expires = 1), auth().copy(token = ""), auth().copy(licenseJson = "invalid"))) {
            try { invalid.requireUsable(); fail("invalid device auth accepted") } catch (_: IllegalStateException) {}
        }
    }
}
