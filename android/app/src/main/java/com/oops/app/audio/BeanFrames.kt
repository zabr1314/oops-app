package com.oops.app.audio

import java.io.ByteArrayOutputStream
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin

/** Pure pieces of turning the bean's packets into the 16 kHz mono 100 ms frames every [AudioSource] delivers. */
object BeanFrames {
    const val PACKET_MS = 20

    /** Interleaved stereo 16-bit samples → mono, averaging the two capsules. */
    fun downmix(stereo: ShortArray): ShortArray =
        ShortArray(stereo.size / 2) { ((stereo[2 * it].toInt() + stereo[2 * it + 1]) / 2).toShort() }

    /** Little-endian 16-bit PCM bytes. */
    fun toBytes(samples: ShortArray): ByteArray {
        val out = ByteArray(samples.size * 2)
        for (i in samples.indices) {
            out[2 * i] = samples[i].toInt().toByte()
            out[2 * i + 1] = (samples[i].toInt() shr 8).toByte()
        }
        return out
    }
}

/**
 * The device's packet counter → how many 20 ms packets went missing. A jump backwards or over [maxGap]
 * packets is a counter reset (a new recording or a wrap), not lost audio.
 */
class PacketSequence(private val maxGap: Int = 3_000) {
    private var last: Int? = null

    fun missingBefore(sequence: Int): Int {
        val previous = last
        last = sequence
        if (previous == null) return 0
        val step = sequence - previous
        return if (step in 2..maxGap + 1) step - 1 else 0
    }

    fun reset() {
        last = null
    }
}

/** The mark button holds `isMark` over several packets; one press is one mark, at most once per [minGapMs]. */
class MarkEdge(private val minGapMs: Long = 2_000) {
    private var held = false
    private var lastMarkAt = Long.MIN_VALUE / 2

    fun press(isMark: Boolean, nowMs: Long): Boolean {
        val rising = isMark && !held
        held = isMark
        if (!rising || nowMs - lastMarkAt < minGapMs) return false
        lastMarkAt = nowMs
        return true
    }
}

/** Collects PCM bytes and hands out whole frames of [frameBytes]. */
class FrameBatcher(private val frameBytes: Int) {
    private val pending = ByteArrayOutputStream()

    fun add(pcm: ByteArray): List<ByteArray> {
        pending.write(pcm)
        if (pending.size() < frameBytes) return emptyList()
        val all = pending.toByteArray()
        val whole = all.size / frameBytes
        pending.reset()
        pending.write(all, whole * frameBytes, all.size - whole * frameBytes)
        return List(whole) { all.copyOfRange(it * frameBytes, (it + 1) * frameBytes) }
    }

    /** Drops the unfinished frame, e.g. before a gap so the timeline stays aligned. */
    fun clear() = pending.reset()
}

/**
 * 48 kHz → 16 kHz with a windowed-sinc low-pass (cut-off 7 kHz), for decoders that always output 48 kHz
 * (Android's Opus decoder does). Keeps its filter history across calls.
 */
class Decimate3(taps: Int = 47) {
    private val kernel: DoubleArray
    private val history: ShortArray
    private var phase = 0

    init {
        require(taps % 2 == 1)
        val cutoff = 7_000.0 / 48_000.0
        val mid = taps / 2
        val raw = DoubleArray(taps) { i ->
            val n = (i - mid).toDouble()
            val sinc = if (n == 0.0) 2 * cutoff else sin(2 * PI * cutoff * n) / (PI * n)
            sinc * (0.54 - 0.46 * cos(2 * PI * i / (taps - 1))) // Hamming window
        }
        val sum = raw.sum()
        kernel = DoubleArray(taps) { raw[it] / sum }
        history = ShortArray(taps - 1)
    }

    fun process(input: ShortArray): ShortArray {
        val buffer = ShortArray(history.size + input.size)
        history.copyInto(buffer)
        input.copyInto(buffer, history.size)
        val out = ArrayList<Short>(input.size / 3 + 1)
        var i = phase
        while (i < input.size) {
            var acc = 0.0
            for (k in kernel.indices) acc += kernel[k] * buffer[i + k]
            out.add(acc.roundToInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt()).toShort())
            i += 3
        }
        phase = i - input.size
        buffer.copyInto(history, 0, buffer.size - history.size, buffer.size)
        return out.toShortArray()
    }
}
