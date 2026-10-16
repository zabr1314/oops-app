package com.oops.app.engine

import com.oops.app.buffer.AudioRingBuffer
import com.oops.app.core.Pcm
import com.oops.app.store.RecordingPolicy
import com.oops.app.store.SessionRecorder
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files

class CapturePauseGuardTest {
    private val policy = RecordingPolicy("meeting", 7, 90)
    private val guard = CapturePauseGuard("same-session", 4, "mic", policy, 1)
    private fun blocked(action: () -> Unit) { try { action(); fail("must refuse resume") } catch (_: IllegalStateException) {} }

    @Test fun `resume retains exact session service and per-asset save contract`() {
        guard.verifyResume("same-session", 4, policy, false)
        assertEquals(7, guard.policy.audioDays); assertEquals(90, guard.policy.transcriptDays)
        blocked { guard.verifyResume("new-session", 4, policy, false) }
        blocked { guard.verifyResume("same-session", 5, policy, false) }
        blocked { guard.verifyResume("same-session", 4, policy.copy(audioDays = 30), false) }
        blocked { guard.verifyResume("same-session", 4, policy.copy(transcriptDays = 30), false) }
        blocked { guard.verifyResume("same-session", 4, RecordingPolicy(), false) }
    }

    @Test fun `resume cannot overlap a pending ASR tail`() {
        blocked { guard.verifyResume("same-session", 4, policy, true) }
        guard.verifyResume("same-session", 4, policy, false)
    }

    @Test fun `replay and bean inputs do not advertise microphone pause semantics`() {
        assertTrue(CapturePauseGuard.supported("mic"))
        for (source in listOf("wav", "bean", "bean_sim", "remote", "unknown")) {
            assertFalse(CapturePauseGuard.supported(source))
            try { CapturePauseGuard("s", 0, source, RecordingPolicy(), 1); fail("unsupported source") } catch (_: IllegalArgumentException) {}
        }
    }

    @Test fun `pause holds existing PCM timeline and recorder open until explicit end`() {
        val dir = Files.createTempDirectory("pause-contract").toFile()
        val ring = AudioRingBuffer(Pcm.SAMPLE_RATE)
        val startedAt = java.time.Instant.now().toString()
        val meta = policy.contract(startedAt).put("started_at", startedAt)
        val recorder = SessionRecorder(dir, "same-session", meta)
        val before = ByteArray(Pcm.FRAME_BYTES) { 1 }; val after = ByteArray(Pcm.FRAME_BYTES) { 2 }
        ring.append(before); recorder.audio(before)
        val pausedAt = ring.endSample
        // Physical input is absent during pause: no silence, reset, end or replacement recorder.
        guard.verifyResume("same-session", 4, policy, false)
        assertEquals(pausedAt, ring.endSample)
        assertFalse(JSONObject(File(dir, "same-session.json").readText()).has("audio_ended_at"))
        assertFalse(File(dir, "same-session.ended").exists())
        ring.append(after); recorder.audio(after)
        assertEquals(pausedAt * 2, ring.endSample)
        assertEquals((before.size + after.size).toLong(), recorder.bytes)
        recorder.closeAudio()
        assertArrayEquals(before + after, File(dir, "same-session.pcm").readBytes())
        val ended = JSONObject(File(dir, "same-session.json").readText())
        assertEquals(7, ended.getInt("audio_retention_days")); assertEquals(90, ended.getInt("transcript_retention_days"))
    }
}
