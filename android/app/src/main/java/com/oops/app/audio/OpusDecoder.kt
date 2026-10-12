package com.oops.app.audio

import android.media.MediaCodec
import android.media.MediaFormat
import java.nio.ByteBuffer
import java.nio.ByteOrder

/** Raw Opus packets → 16 kHz mono 16-bit samples. Not thread-safe: one decoder per stream. */
interface OpusDecoder {
    /** Samples ready so far; a decoder may hold back a packet or two, so the count varies per call. */
    fun decode(packet: ByteArray): ShortArray

    fun close()
}

/**
 * Android's platform Opus decoder (no native library to ship). It always outputs 48 kHz, so stereo is
 * averaged to mono and then [Decimate3] brings it to 16 kHz; a decoder that reports 16 kHz is passed through.
 */
class MediaCodecOpusDecoder(private val channels: Int = 2, inputRate: Int = 16_000) : OpusDecoder {
    private val codec: MediaCodec = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_AUDIO_OPUS)
    private val info = MediaCodec.BufferInfo()
    private var outputRate = 48_000
    private var outputChannels = channels
    private val decimate = Decimate3()
    private var presentationUs = 0L

    init {
        val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_OPUS, 48_000, channels)
        format.setByteBuffer("csd-0", opusHead(channels, inputRate))
        format.setByteBuffer("csd-1", nanos(0)) // codec delay: the bean stream carries no pre-skip
        format.setByteBuffer("csd-2", nanos(80_000_000)) // seek pre-roll, the value the Opus spec recommends
        codec.configure(format, null, null, 0)
        codec.start()
    }

    override fun decode(packet: ByteArray): ShortArray {
        val index = codec.dequeueInputBuffer(INPUT_TIMEOUT_US)
        if (index >= 0) {
            val input = codec.getInputBuffer(index)!!
            input.clear()
            input.put(packet)
            codec.queueInputBuffer(index, 0, packet.size, presentationUs, 0)
            presentationUs += BeanFrames.PACKET_MS * 1_000L
        } else {
            throw IllegalStateException("Opus 解码器输入队列已满")
        }
        val out = ArrayList<ShortArray>(2)
        while (true) {
            val o = codec.dequeueOutputBuffer(info, 0)
            when {
                o == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> codec.outputFormat.let {
                    outputRate = it.getInteger(MediaFormat.KEY_SAMPLE_RATE)
                    outputChannels = it.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
                    require(outputRate == 48_000 || outputRate == 16_000) { "Opus 解码输出 $outputRate Hz，暂不支持" }
                }
                o >= 0 -> {
                    val buffer = codec.getOutputBuffer(o)!!.order(ByteOrder.LITTLE_ENDIAN)
                    buffer.position(info.offset).limit(info.offset + info.size)
                    val samples = ShortArray(info.size / 2).also { buffer.asShortBuffer().get(it) }
                    codec.releaseOutputBuffer(o, false)
                    val mono = if (outputChannels == 2) BeanFrames.downmix(samples) else samples
                    out.add(if (outputRate == 48_000) decimate.process(mono) else mono)
                }
                else -> break
            }
        }
        return if (out.size == 1) out[0] else out.flatMap { it.asList() }.toShortArray()
    }

    override fun close() {
        runCatching { codec.stop() }
        codec.release()
    }

    private companion object {
        const val INPUT_TIMEOUT_US = 50_000L

        fun opusHead(channels: Int, inputRate: Int): ByteBuffer = ByteBuffer.allocate(19).order(ByteOrder.LITTLE_ENDIAN).apply {
            put("OpusHead".toByteArray())
            put(1) // version
            put(channels.toByte())
            putShort(0) // pre-skip
            putInt(inputRate)
            putShort(0) // output gain
            put(0) // channel mapping family 0: mono or stereo
            flip()
        }

        fun nanos(value: Long): ByteBuffer = ByteBuffer.allocate(8).order(ByteOrder.nativeOrder()).putLong(value).apply { flip() }
    }
}
