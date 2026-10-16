package com.oops.app.engine

import org.junit.Assert.fail
import org.junit.Test

class CaptureSettingsGuardTest {
    private fun blocked(action: () -> Unit) { try { action(); fail("settings must remain untouched") } catch (_: IllegalStateException) {} }

    @Test fun `endpoint credential or mock changes are refused during capture pause and ASR closure`() {
        for (state in listOf(Triple(true, false, false), Triple(true, true, false), Triple(false, false, true))) {
            blocked { CaptureSettingsGuard.verify(state.first, state.second, state.third, serviceChanged = true, sourceChanged = false) }
        }
    }

    @Test fun `paused source cannot silently change but existing active input switching remains allowed`() {
        blocked { CaptureSettingsGuard.verify(true, true, false, serviceChanged = false, sourceChanged = true) }
        CaptureSettingsGuard.verify(true, false, false, serviceChanged = false, sourceChanged = true)
        CaptureSettingsGuard.verify(true, true, false, serviceChanged = false, sourceChanged = false)
    }

    @Test fun `explicitly ended and fully closed recording allows a new service configuration`() {
        CaptureSettingsGuard.verify(false, false, false, serviceChanged = true, sourceChanged = true)
    }
}
