package com.oops.app.audio

import com.oops.app.core.Pcm
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * The 录音豆 as an [AudioSource]: Opus packets from a [BeanLink] are decoded off the SDK's callback thread,
 * mixed to mono and handed on as the usual 100 ms 16 kHz frames. Lost packets become [AudioSource.Listener.onGap]
 * so the timeline keeps step with the room; a press of the mark button is the same recall mark as a double tap.
 */
class BeanAudioSource(
    private val link: BeanLink,
    private val newDecoder: () -> OpusDecoder,
    override val kind: String,
    private val nowMs: () -> Long = { System.nanoTime() / 1_000_000 },
) : AudioSource {
    private sealed interface Event {
        class Packet(val opus: ByteArray, val sequence: Int, val isMark: Boolean) : Event
        class Connected(val connected: Boolean) : Event
    }

    private val queue = LinkedBlockingQueue<Event>(QUEUE_PACKETS)
    @Volatile private var running = false
    private var worker: Thread? = null

    override fun start(listener: AudioSource.Listener) {
        running = true
        queue.clear()
        listener.onReady(false)
        listener.onStatus("正在连接${link.label}")
        worker = thread(name = "oops-bean") { loop(listener) }
        link.start(object : BeanLink.Sink {
            override fun onPacket(opus: ByteArray, sequence: Int, isMark: Boolean) {
                // Never block the SDK's Bluetooth thread; a full queue means decoding fell behind, counted as a gap.
                if (running) queue.offer(Event.Packet(opus, sequence, isMark))
            }

            override fun onConnected(connected: Boolean) {
                if (running) queue.offer(Event.Connected(connected))
            }

            override fun onStatus(detail: String?) {
                if (running) listener.onStatus(detail)
            }

            override fun onError(error: Throwable) {
                if (running) listener.onError(error)
            }
        })
    }

    override fun stop() {
        running = false
        runCatching { link.stop() }
        worker?.interrupt()
        worker?.join(1_000)
        worker = null
    }

    private fun loop(listener: AudioSource.Listener) {
        val decoder = try {
            newDecoder()
        } catch (e: Throwable) {
            listener.onError(e)
            return
        }
        val sequence = PacketSequence()
        val marks = MarkEdge()
        val frames = FrameBatcher(Pcm.FRAME_BYTES)
        var ready = false
        try {
            while (running) {
                when (val event = queue.poll(200, TimeUnit.MILLISECONDS) ?: continue) {
                    is Event.Connected -> {
                        if (!event.connected) {
                            ready = false
                            sequence.reset()
                            frames.clear()
                            listener.onReady(false)
                        }
                    }
                    is Event.Packet -> {
                        val missing = sequence.missingBefore(event.sequence)
                        if (missing > 0) {
                            frames.clear()
                            listener.onGap(missing.toLong() * BeanFrames.PACKET_MS)
                        }
                        if (!ready) {
                            ready = true
                            listener.onStatus(null)
                            listener.onReady(true)
                        }
                        if (marks.press(event.isMark, nowMs())) listener.onMark(AudioSource.Mark.DOUBLE_TAP)
                        val pcm = decoder.decode(event.opus)
                        if (pcm.isNotEmpty()) frames.add(BeanFrames.toBytes(pcm)).forEach(listener::onAudio)
                    }
                }
            }
        } catch (_: InterruptedException) {
            // stopped
        } catch (e: Throwable) {
            if (running) listener.onError(e)
        } finally {
            runCatching { decoder.close() }
        }
    }

    private companion object {
        const val QUEUE_PACKETS = 500 // 10 s of audio
    }
}
