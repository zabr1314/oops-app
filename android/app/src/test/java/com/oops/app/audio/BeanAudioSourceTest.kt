package com.oops.app.audio

import com.oops.app.core.Pcm
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit.SECONDS
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.sin

class BeanFramesTest {
    @Test
    fun `downmix averages the two capsules`() {
        assertArrayEquals(shortArrayOf(150, -1, 32767), BeanFrames.downmix(shortArrayOf(100, 200, -2, 0, 32767, 32767)))
    }

    @Test
    fun `sequence gaps count lost packets but not resets`() {
        val s = PacketSequence(maxGap = 100)
        assertEquals(0, s.missingBefore(7))
        assertEquals(0, s.missingBefore(8))
        assertEquals(3, s.missingBefore(12))
        assertEquals(0, s.missingBefore(2)) // counter restarted
        assertEquals(0, s.missingBefore(500)) // too far to be loss
        s.reset()
        assertEquals(0, s.missingBefore(900))
    }

    @Test
    fun `a held mark button is one mark, and presses are spaced`() {
        val m = MarkEdge(minGapMs = 2_000)
        assertEquals(listOf(true, false, false, false, false, true),
            listOf(m.press(true, 0), m.press(true, 20), m.press(false, 40), m.press(true, 1_000), m.press(false, 1_020), m.press(true, 3_000)))
    }

    @Test
    fun `batcher hands out whole frames and keeps the rest`() {
        val b = FrameBatcher(4)
        assertTrue(b.add(byteArrayOf(1, 2, 3)).isEmpty())
        val out = b.add(byteArrayOf(4, 5, 6, 7, 8, 9))
        assertEquals(listOf(listOf<Byte>(1, 2, 3, 4), listOf<Byte>(5, 6, 7, 8)), out.map { it.toList() })
        b.clear()
        assertTrue(b.add(byteArrayOf(10, 11, 12)).isEmpty())
    }

    @Test
    fun `decimation keeps speech-band tones and removes what would alias`() {
        fun tone(hz: Double, n: Int) = ShortArray(n) { (10_000 * sin(2 * PI * hz * it / 48_000)).toInt().toShort() }
        fun level(x: ShortArray) = x.drop(100).map { abs(it.toDouble()) }.average()
        val d = Decimate3()
        val pass = (0 until 10).flatMap { d.process(tone(1_000.0, 960)).asList() }.toShortArray()
        assertEquals(3_200, pass.size)
        assertTrue(level(pass) > 5_500) // a 10 000 sine averages ~6 366
        val stop = Decimate3().process(tone(12_000.0, 9_600))
        assertTrue(level(stop) < 300)
    }
}

class BeanAudioSourceTest {
    /** Decodes a "packet" by repeating its first byte as 320 samples (20 ms at 16 kHz). */
    private class FakeDecoder : OpusDecoder {
        var closed = false
        override fun decode(packet: ByteArray) = ShortArray(320) { packet[0].toShort() }
        override fun close() { closed = true }
    }

    private class FakeLink : BeanLink {
        override val label = "测试豆"
        var sink: BeanLink.Sink? = null
        var stopped = false
        override fun start(sink: BeanLink.Sink) { this.sink = sink }
        override fun stop() { stopped = true }
    }

    private fun listener(errors: LinkedBlockingQueue<Throwable> = LinkedBlockingQueue()) = object : AudioSource.Listener {
        override fun onAudio(pcm: ByteArray) {}
        override fun onError(error: Throwable) { errors.offer(error) }
    }

    @Test fun `decoder failure cannot start the real SDK or its file writer`() {
        val link = FakeLink()
        val source = BeanAudioSource(link, { error("no codec") }, "bean")
        org.junit.Assert.assertThrows(IllegalStateException::class.java) { source.start(listener()) }
        assertNull(link.sink)
    }

    @Test fun `synchronous SDK startup failure stops the link and releases decoder`() {
        var stopped = false
        val decoder = FakeDecoder()
        val link = object : BeanLink {
            override val label = "失败豆"
            override fun start(sink: BeanLink.Sink) { error("sdk start failed") }
            override fun stop() { stopped = true }
        }
        val source = BeanAudioSource(link, { decoder }, "bean")
        org.junit.Assert.assertThrows(IllegalStateException::class.java) { source.start(listener()) }
        assertTrue(stopped)
        assertTrue(decoder.closed)
    }

    @Test fun `async SDK error closes the producer and stopped callbacks cannot affect a new run`() {
        val link = FakeLink()
        val errors = LinkedBlockingQueue<Throwable>()
        val source = BeanAudioSource(link, { FakeDecoder() }, "bean_sim")
        source.start(listener(errors))
        val old = link.sink!!
        old.onError(IllegalStateException("disconnected"))
        assertEquals("disconnected", errors.poll(2, SECONDS)!!.message)
        assertTrue(link.stopped)
        source.stop()
        source.start(listener(errors))
        old.onError(IllegalStateException("late previous session"))
        assertNull(errors.poll())
        source.stop()
    }

    @Test fun `cleanup failure is propagated rather than reported as stopped successfully`() {
        val decoder = FakeDecoder()
        val link = object : BeanLink {
            override val label = "失败豆"
            override fun start(sink: BeanLink.Sink) {}
            override fun stop() { error("scratch cleanup failed") }
        }
        val source = BeanAudioSource(link, { decoder }, "bean")
        source.start(listener())
        org.junit.Assert.assertThrows(IllegalStateException::class.java) { source.stop() }
        assertTrue(decoder.closed)
    }

    @Test
    fun `packets become 100 ms frames, lost packets a gap, the mark button a recall mark`() {
        val link = FakeLink()
        val decoder = FakeDecoder()
        val frames = LinkedBlockingQueue<ByteArray>()
        val gaps = LinkedBlockingQueue<Long>()
        val marks = AtomicInteger()
        val readiness = CopyOnWriteArrayList<Boolean>()
        val statuses = CopyOnWriteArrayList<String?>()
        var now = 0L
        val source = BeanAudioSource(link, { decoder }, "bean_sim", nowMs = { now })
        source.start(object : AudioSource.Listener {
            override fun onAudio(pcm: ByteArray) { frames.add(pcm) }
            override fun onGap(missingMs: Long) { gaps.add(missingMs) }
            override fun onMark(mark: AudioSource.Mark) { marks.incrementAndGet() }
            override fun onReady(ready: Boolean) { readiness.add(ready) }
            override fun onStatus(detail: String?) { statuses.add(detail) }
            override fun onError(error: Throwable) = throw error
        })
        val sink = link.sink!!
        for (n in 0 until 5) sink.onPacket(byteArrayOf(n.toByte()), sequence = 100 + n, isMark = n == 2)
        val first = frames.poll(2, SECONDS)!!
        assertEquals(Pcm.FRAME_BYTES, first.size)
        assertEquals(4, first[2 * 320 * 4].toInt()) // fifth packet starts at sample 1280
        assertEquals(1, marks.get())

        sink.onPacket(byteArrayOf(9), sequence = 108, isMark = false) // 105–107 lost
        assertEquals(60L, gaps.poll(2, SECONDS))
        sink.onConnected(false)
        Thread.sleep(300)
        assertEquals(listOf(false, true, false), readiness.toList())
        assertEquals("正在连接测试豆", statuses.first())
        assertTrue(null in statuses)

        source.stop()
        assertTrue(link.stopped)
        assertTrue(decoder.closed)
        assertNull(frames.poll()) // the lone packet after the gap never filled a frame
        assertFalse(readiness.last())
    }
}
