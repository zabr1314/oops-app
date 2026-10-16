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
        class Control(val state: String) : Event
    }

    private val queue = LinkedBlockingQueue<Event>(QUEUE_PACKETS)
    @Volatile private var running = false
    @Volatile private var generation = 0L
    private var worker: Thread? = null
    override val supportsPause: Boolean get() = link.supportsPause
    override fun pause() { check(running); link.pause() }
    override fun resume() { check(running); link.resume() }

    override fun start(listener: AudioSource.Listener) {
        check(!running) { "录音豆音源已经运行" }
        // Do not start a file-producing SDK if this device cannot decode its packets.
        val decoder = newDecoder()
        val epoch = ++generation
        running = true
        queue.clear()
        listener.onReady(false)
        listener.onStatus("正在连接${link.label}")
        worker = thread(name = "oops-bean") { loop(listener, decoder, epoch) }
        try { link.start(object : BeanLink.Sink {
            override fun onPacket(opus: ByteArray, sequence: Int, isMark: Boolean) {
                // Never block the SDK's Bluetooth thread; a full queue means decoding fell behind, counted as a gap.
                if (running && generation == epoch) queue.offer(Event.Packet(opus, sequence, isMark))
            }

            override fun onConnected(connected: Boolean) {
                if (running && generation == epoch) queue.offer(Event.Connected(connected))
            }

            override fun onStatus(detail: String?) {
                if (running && generation == epoch) listener.onStatus(detail)
            }
            override fun onControlState(state: String) {
                if (running && generation == epoch && !queue.offer(Event.Control(state))) {
                    fail(listener, IllegalStateException("音频处理队列已满，无法确认暂停边界"), epoch)
                }
            }
            override fun onControlError(message: String) {
                if (running && generation == epoch) listener.onControlError(message)
            }

            override fun onError(error: Throwable) {
                if (running && generation == epoch) fail(listener, error, epoch)
            }
        }) } catch (error: Throwable) {
            runCatching { stop() }.onFailure { error.addSuppressed(it) }
            throw error
        }
    }

    override fun stop() {
        running = false
        generation++
        try { link.stop() } finally {
            worker?.interrupt()
            if (worker !== Thread.currentThread()) worker?.join(1_000)
            worker = null
            queue.clear()
        }
    }

    private fun fail(listener: AudioSource.Listener, error: Throwable, epoch: Long) {
        if (!running || generation != epoch) return
        running = false
        generation++
        queue.clear()
        if (worker !== Thread.currentThread()) worker?.interrupt()
        runCatching { link.stop() }.onFailure { error.addSuppressed(it) }
        listener.onError(error)
    }

    private fun loop(listener: AudioSource.Listener, decoder: OpusDecoder, epoch: Long) {
        val sequence = PacketSequence()
        val marks = MarkEdge()
        val frames = FrameBatcher(Pcm.FRAME_BYTES)
        var ready = false
        var control = "waiting"
        try {
            while (running && generation == epoch) {
                when (val event = queue.poll(200, TimeUnit.MILLISECONDS) ?: continue) {
                    is Event.Control -> {
                        control = event.state
                        if (control in listOf("paused", "stopped")) {
                            val tail = frames.drain()
                            if (tail.isNotEmpty()) listener.onAudio(tail)
                        }
                        if (control in listOf("draining", "paused", "stopped", "resuming", "disconnected")) {
                            ready = false
                            sequence.reset()
                            listener.onReady(false)
                        }
                        listener.onControlState(control)
                    }
                    is Event.Connected -> {
                        if (!event.connected) {
                            ready = false
                            sequence.reset()
                            frames.clear()
                            listener.onReady(false)
                        }
                    }
                    is Event.Packet -> {
                        if (control in listOf("paused", "stopped", "disconnected")) continue
                        val missing = sequence.missingBefore(event.sequence)
                        if (missing > 0) {
                            frames.clear()
                            listener.onGap(missing.toLong() * BeanFrames.PACKET_MS)
                        }
                        if (marks.press(event.isMark, nowMs())) listener.onMark(AudioSource.Mark.DOUBLE_TAP)
                        val pcm = decoder.decode(event.opus)
                        if (!running || generation != epoch) continue
                        if (pcm.isNotEmpty()) frames.add(BeanFrames.toBytes(pcm)).forEach { frame ->
                            if (!ready && control != "draining") {
                                link.confirmAudioReady()
                                ready = true
                                listener.onStatus(null)
                                if (control != "pausing") {
                                    control = "recording"
                                    listener.onControlState(control)
                                }
                                listener.onReady(true)
                            }
                            listener.onAudio(frame)
                        }
                    }
                }
            }
        } catch (_: InterruptedException) {
            // stopped
        } catch (e: Throwable) {
            fail(listener, e, epoch)
        } finally {
            runCatching { decoder.close() }
        }
    }

    private companion object {
        const val QUEUE_PACKETS = 500 // 10 s of audio
    }
}
