package com.oops.app.audio

import android.os.SystemClock
import java.io.DataInputStream
import java.io.EOFException
import java.io.InputStream
import kotlin.concurrent.thread

/**
 * A 录音豆 without hardware: replays a stream in the bean's realtime format (consecutive [packetBytes]-byte
 * Opus packets, made with `scripts/bean_opus.py encode`) at 20 ms per packet, numbering packets like the
 * device. When the stream ends it reports a disconnect, as the device does when recording stops.
 * Test audio only; it never counts as a device run.
 */
class ReplayBeanLink(
    override val label: String,
    private val open: () -> InputStream,
    private val packetBytes: Int = 160,
    /** Packet indexes that carry the mark flag, to exercise the mark button. */
    private val markedPackets: Set<Int> = emptySet(),
) : BeanLink {
    @Volatile private var running = false
    private var worker: Thread? = null

    override fun start(sink: BeanLink.Sink) {
        running = true
        worker = thread(name = "oops-bean-replay") {
            try {
                DataInputStream(open().buffered()).use { input ->
                    sink.onConnected(true)
                    val startedAt = SystemClock.elapsedRealtime()
                    var n = 0
                    while (running) {
                        val packet = ByteArray(packetBytes)
                        try {
                            input.readFully(packet)
                        } catch (_: EOFException) {
                            break
                        }
                        sink.onPacket(packet, n, n in markedPackets)
                        n++
                        val wait = startedAt + n * BeanFrames.PACKET_MS - SystemClock.elapsedRealtime()
                        if (wait > 0) Thread.sleep(wait)
                    }
                }
                if (running) {
                    sink.onConnected(false)
                    sink.onStatus("模拟录音豆已播完")
                }
            } catch (_: InterruptedException) {
                // stopped
            } catch (e: Throwable) {
                if (running) sink.onError(e)
            }
        }
    }

    override fun stop() {
        running = false
        worker?.interrupt()
        worker?.join(500)
        worker = null
    }
}
