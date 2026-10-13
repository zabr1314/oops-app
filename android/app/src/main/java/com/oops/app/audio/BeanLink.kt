package com.oops.app.audio

/**
 * The 录音豆 as a stream of Opus packets, apart from how they arrive: the Soundcore SDK on a real
 * device ([SoundcoreBeanLink], built only when the SDK is present), or [ReplayBeanLink] replaying a
 * recorded stream so the whole chain runs without hardware.
 *
 * Packets follow the SDK's realtime format: raw Opus (no Ogg header), 16 kHz stereo, 20 ms each.
 */
interface BeanLink {
    /** Shown in the capture status, e.g. "录音豆 D3200" or "录音豆模拟（内置对话）". */
    val label: String

    fun start(sink: Sink)

    fun stop()

    interface Sink {
        /** One 20 ms Opus packet. [sequence] is the device's packet counter; [isMark] the mark button. */
        fun onPacket(opus: ByteArray, sequence: Int, isMark: Boolean)

        /** False while the device is disconnected or not recording; packets mark it ready again. */
        fun onConnected(connected: Boolean) {}

        /** A step the user must take, e.g. "请先按录音豆的录音键"; null clears it. */
        fun onStatus(detail: String?) {}

        fun onError(error: Throwable)
    }
}
