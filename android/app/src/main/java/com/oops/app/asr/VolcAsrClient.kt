package com.oops.app.asr

import com.oops.app.asr.VolcProtocol.ServerMessage
import com.oops.app.core.Pcm
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * One streaming-ASR connection. A conversation uses a single connection and keeps sending
 * audio through pauses (otherwise the server times out with 45000081 and speaker ids reset).
 * All reported times are relative to the first audio sent on this connection.
 */
class VolcAsrClient(
    private val http: WebSocket.Factory,
    private val credentials: VolcCredentials,
    private val requestJson: String,
    private val listener: Listener,
    private val finishTimeoutMs: Long = FINISH_TIMEOUT_MS,
) {
    interface Listener {
        fun onOpen()
        fun onPartial(text: String, startMs: Long, endMs: Long)
        fun onFinal(utterance: RawUtterance)

        /** Every raw server response payload, before parsing (kept as a raw asset). */
        fun onRaw(payload: String) {}

        /** Exactly once unless cancelled. Null error requires a provider terminal response, not just a socket close. */
        fun onClosed(error: String?, fatal: Boolean)
    }

    private val lock = Any()
    // Listener callbacks may enter the engine's pipeline lock. Keep them out of
    // `lock`, while serializing terminal notification behind in-flight finals.
    private val deliveryLock = Any()
    private var socket: WebSocket? = null
    private var opened = false
    private var finishing = false
    private var connecting = false
    private var finishDeadline: ScheduledFuture<*>? = null
    private val pending = ArrayDeque<ByteString>()
    private var pendingAudioBytes = 0

    /** Audio dropped while still connecting shifts the server clock; added back to every timestamp. */
    @Volatile private var droppedMs = 0L
    private val seenFinals = LinkedHashSet<Triple<Long, Long, String>>()
    private val closed = AtomicBoolean(false)
    private val sendFailureObserved = AtomicBoolean(false)
    private val sendFailureReported = AtomicBoolean(false)
    private val terminated = CountDownLatch(1)
    data class Closure(val acknowledged: Boolean, val error: String?, val errorCode: String? = null)
    @Volatile var closure: Closure? = null
        private set
    val isFinishing: Boolean get() = synchronized(lock) { finishing && terminated.count > 0 }

    init { require(finishTimeoutMs > 0) }

    /** Waiting never reconnects or resends paid audio. */
    fun awaitTermination(timeoutMs: Long = FINISH_TIMEOUT_MS + 1_000): Boolean =
        terminated.await(timeoutMs, TimeUnit.MILLISECONDS)

    fun connect() {
        synchronized(lock) {
            if (connecting || closed.get()) return
            connecting = true
            pending.addFirst(VolcProtocol.fullClientRequest(requestJson).toByteString())
        }
        val request = Request.Builder().url(ENDPOINT).apply {
            header("X-Api-Resource-Id", credentials.resourceId)
            header("X-Api-Connect-Id", UUID.randomUUID().toString())
            if (credentials.apiKey.isNotBlank()) {
                header("X-Api-Key", credentials.apiKey)
            } else {
                header("X-Api-App-Key", credentials.appId)
                header("X-Api-Access-Key", credentials.accessToken)
            }
        }.build()
        val created = http.newWebSocket(request, socketListener)
        synchronized(lock) { if (closed.get()) created.cancel() else socket = created }
    }

    fun sendAudio(pcm: ByteArray) {
        val sent = synchronized(lock) {
            if (finishing || closed.get() || sendFailureObserved.get()) return
            enqueueLocked(VolcProtocol.audio(pcm, last = false).toByteString(), isAudio = true)
        }
        if (!sent) failedSend()
    }

    /** One explicit empty EOS. Only a provider last response confirms that remaining finals flushed. */
    fun finish() {
        val sent = synchronized(lock) {
            if (finishing || closed.get() || sendFailureObserved.get()) return
            finishing = true
            finishDeadline = FINISH_TIMER.schedule({
                CLOSURE_WORKER.execute {
                    report("ASR 结束确认超时，已收到的转写已保留，完整性未确认", fatal = false, errorCode = "finish_timeout")
                    socket?.cancel()
                }
            }, finishTimeoutMs, TimeUnit.MILLISECONDS)
            enqueueLocked(VolcProtocol.audio(ByteArray(0), last = true).toByteString(), isAudio = false)
        }
        if (!sent) failedSend()
    }

    /** Drops the connection without reporting back. */
    fun cancel() {
        if (closed.compareAndSet(false, true)) {
            finishDeadline?.cancel(false)
            synchronized(lock) { pending.clear(); pendingAudioBytes = 0 }
            closure = Closure(false, "ASR 已取消", "cancelled")
            socket?.cancel()
            terminated.countDown()
        }
    }

    private fun enqueueLocked(frame: ByteString, isAudio: Boolean): Boolean {
        if (opened) {
            val accepted = socket?.send(frame) == true
            if (!accepted) sendFailureObserved.set(true)
            return accepted
        }
        if (isAudio && pendingAudioBytes + frame.size > MAX_PENDING_AUDIO_BYTES && pending.size > 1) {
            // Still connecting after ~10 s: drop the oldest audio, keep the request frame at the head.
            val dropped = pending.removeAt(1)
            pendingAudioBytes -= dropped.size
            droppedMs += Pcm.samplesToMs(((dropped.size - AUDIO_FRAME_OVERHEAD) / 2).toLong())
        }
        pending.addLast(frame)
        if (isAudio) pendingAudioBytes += frame.size
        return true
    }

    private fun redact(error: String?): String? {
        var safe = error
        for (secret in listOf(credentials.apiKey, credentials.accessToken).filter { it.isNotBlank() }) {
            safe = safe?.replace(secret, "[redacted]")
        }
        return safe
    }

    private fun report(error: String?, fatal: Boolean, acknowledged: Boolean = false,
                       errorCode: String? = null, beforeClosed: () -> Unit = {}) {
        synchronized(deliveryLock) { if (closed.compareAndSet(false, true)) {
            finishDeadline?.cancel(false)
            synchronized(lock) { pending.clear(); pendingAudioBytes = 0 }
            val failedSend = sendFailureObserved.get()
            val safeError = redact(if (acknowledged && failedSend) "ASR音频发送失败，结束回执不能证明转写完整" else error)
            closure = Closure(acknowledged && !failedSend, safeError, if (acknowledged && failedSend) "send_failed" else errorCode)
            try { beforeClosed() } finally {
                try { listener.onClosed(safeError, fatal) } finally { terminated.countDown() }
            }
        } }
    }

    private fun failedSend() {
        // sendAudio/finish can be called while the engine owns its pipeline lock.
        // Never wait here for a callback which may be entering that same lock.
        sendFailureObserved.set(true)
        if (!sendFailureReported.compareAndSet(false, true)) return
        CLOSURE_WORKER.execute {
            report("ASR 音频或结束包发送失败，完整性未确认", fatal = false, errorCode = "send_failed")
            socket?.cancel()
        }
    }

    private val socketListener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            val sent = synchronized(lock) {
                if (closed.get()) { webSocket.cancel(); return }
                socket = webSocket
                opened = true
                var accepted = true
                while (pending.isNotEmpty() && accepted) accepted = webSocket.send(pending.removeFirst())
                if (!accepted) sendFailureObserved.set(true)
                pendingAudioBytes = 0
                accepted
            }
            if (!sent) { failedSend(); return }
            listener.onOpen()
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            if (closed.get()) return
            val message = try { VolcProtocol.decode(bytes.toByteArray()) } catch (_: Exception) {
                report("ASR 响应协议无效，完整性未确认", fatal = false, errorCode = "protocol_error")
                webSocket.cancel()
                return
            }
            when (message) {
                is ServerMessage.Error -> {
                    report("ASR 错误 ${message.code}: ${message.message}", fatal = false, errorCode = message.code.toString())
                    webSocket.cancel()
                }
                is ServerMessage.Response -> {
                    val update = try { VolcResult.parse(message.payload) } catch (_: Exception) {
                        report("ASR 响应内容无效，完整性未确认", fatal = false, errorCode = "payload_error")
                        webSocket.cancel()
                        return
                    }
                    val deliver: () -> Unit = {
                        runCatching { listener.onRaw(message.payload) }
                        update.finals.forEach { u ->
                            // Exact duplicates are suppressed without dropping distinct late/out-of-order finals.
                            val key = Triple(u.startMs, u.endMs, u.text.toByteArray().toByteString().sha256().hex())
                            if (seenFinals.add(key)) {
                                while (seenFinals.size > 256) seenFinals.remove(seenFinals.first())
                                listener.onFinal(u.shift(droppedMs))
                            }
                        }
                        update.partial?.let { listener.onPartial(it.text, it.startMs + droppedMs, it.endMs + droppedMs) }
                    }
                    if (message.isLast) {
                        // Claim termination before delivering the tail, so the deadline cannot race a valid last reply.
                        val requested = synchronized(lock) { finishing }
                        report(if (requested) null else "ASR提前结束，完整性未确认", fatal = false,
                            acknowledged = requested, errorCode = if (requested) null else "premature_server_end", beforeClosed = deliver)
                        webSocket.close(1000, null)
                    } else synchronized(deliveryLock) { if (!closed.get()) deliver() }
                }
            }
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            report("ASR 连接关闭但未收到结束确认（$code $reason），完整性未确认", fatal = false, errorCode = "closed_without_ack")
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            val httpError = response?.let { r -> "HTTP ${r.code} " + runCatching { r.body.string() }.getOrDefault("") }
            val detail = listOfNotNull(httpError, t.message).joinToString(" ").ifBlank { t.javaClass.simpleName }
            report(detail, fatal = response?.code?.let { it in FATAL_HTTP_CODES } == true, errorCode = "transport_error")
        }
    }

    companion object {
        const val ENDPOINT = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async"
        private const val AUDIO_FRAME_OVERHEAD = 8
        private const val MAX_PENDING_AUDIO_BYTES = 10 * Pcm.SAMPLE_RATE * Pcm.BYTES_PER_SAMPLE
        const val FINISH_TIMEOUT_MS = 30_000L
        private val FINISH_TIMER = Executors.newSingleThreadScheduledExecutor { r ->
            Thread(r, "oops-asr-finish").apply { isDaemon = true }
        }
        private val CLOSURE_WORKER = Executors.newCachedThreadPool { r ->
            Thread(r, "oops-asr-close").apply { isDaemon = true }
        }
        private val FATAL_HTTP_CODES = setOf(400, 401, 403)
    }
}
