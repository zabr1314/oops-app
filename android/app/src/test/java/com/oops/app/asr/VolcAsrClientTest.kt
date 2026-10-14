package com.oops.app.asr

import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.junit.Assert.*
import org.junit.Test
import java.nio.ByteBuffer
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/** Exercises the socket lifecycle without an HTTP client, network, or ASR credentials. */
class VolcAsrClientTest {
    @Test fun lateFinalsAreDeliveredBeforeAcknowledgedClosure() {
        val fixture = Fixture()
        fixture.client.connect()
        fixture.factory.open()
        fixture.client.sendAudio(byteArrayOf(1, 2))
        fixture.client.finish()

        assertTrue(fixture.client.isFinishing)
        assertFalse(fixture.client.awaitTermination(0))
        fixture.factory.respond(finalJson("第一句。", 0, 100), last = false)
        assertEquals(listOf("第一句。"), fixture.listener.finals.map { it.text })
        assertTrue(fixture.listener.closures.isEmpty())

        fixture.factory.respond(finalJson("结束时的尾句。", 100, 200), last = true)
        assertTrue(fixture.client.awaitTermination(1_000))
        assertEquals(listOf("第一句。", "结束时的尾句。"), fixture.listener.finals.map { it.text })
        assertEquals(listOf("open", "final:第一句。", "final:结束时的尾句。", "closed"), fixture.listener.events)
        assertAcknowledged(fixture)

        // Transport callbacks following the application acknowledgement cannot report a second close.
        fixture.factory.remoteClose()
        assertEquals(1, fixture.listener.closures.size)
    }

    @Test fun emptyPayloadLastResponseAcknowledgesFinish() {
        val fixture = Fixture()
        fixture.client.connect()
        fixture.factory.open()
        fixture.client.finish()

        fixture.factory.respond("", last = true)

        assertTrue(fixture.client.awaitTermination(1_000))
        assertTrue(fixture.listener.finals.isEmpty())
        assertAcknowledged(fixture)
    }

    @Test fun terminalFinalRemainsFinishingUntilListenerHasFinished() {
        val fixture = Fixture()
        val enteredFinal = CountDownLatch(1)
        val releaseFinal = CountDownLatch(1)
        val callbackFailure = AtomicReference<Throwable?>()
        fixture.listener.finalHook = {
            enteredFinal.countDown()
            assertTrue("test must release the final callback", releaseFinal.await(5, TimeUnit.SECONDS))
        }
        fixture.client.connect()
        fixture.factory.open()
        fixture.client.finish()

        val receiver = Thread({
            try {
                fixture.factory.respond(finalJson("仍在交付的尾句。", 0, 100), last = true)
            } catch (failure: Throwable) {
                callbackFailure.set(failure)
            }
        }, "fake-asr-final").apply { isDaemon = true; start() }
        try {
            assertTrue("terminal response should enter onFinal", enteredFinal.await(2, TimeUnit.SECONDS))
            assertTrue(fixture.client.isFinishing)
            assertFalse(fixture.client.awaitTermination(0))
            assertTrue(fixture.listener.closures.isEmpty())
        } finally {
            releaseFinal.countDown()
            receiver.join(2_000)
        }

        assertFalse("fake receiver must finish", receiver.isAlive)
        callbackFailure.get()?.let { throw it }
        assertTrue(fixture.client.awaitTermination(1_000))
        assertFalse(fixture.client.isFinishing)
        assertEquals(listOf("仍在交付的尾句。"), fixture.listener.finals.map { it.text })
        assertAcknowledged(fixture)
    }

    @Test fun providerErrorWhileFinishingIsNotSuccessfulCompletion() {
        val fixture = Fixture()
        fixture.client.connect()
        fixture.factory.open()
        fixture.client.finish()

        fixture.factory.providerError(45000081, "waiting for audio timed out")

        assertFailed(fixture)
        assertTrue(fixture.listener.closures.single().first!!.contains("45000081"))
    }

    @Test fun transportCloseWithoutLastResponseIsNotSuccessfulCompletion() {
        val fixture = Fixture()
        fixture.client.connect()
        fixture.factory.open()
        fixture.client.finish()

        fixture.factory.remoteClose()

        assertFailed(fixture)
    }

    @Test fun missingLastResponseTimesOutAndReleasesWaiter() {
        val fixture = Fixture(finishTimeoutMs = 50)
        fixture.client.connect()
        fixture.factory.open()
        fixture.client.finish()

        assertFailed(fixture)
    }

    @Test fun duplicateFinishSendsExactlyOneEndPacketAndNoLaterAudio() {
        val fixture = Fixture()
        fixture.client.connect()
        fixture.client.sendAudio(byteArrayOf(1, 2))
        fixture.client.finish()
        fixture.client.finish()
        fixture.client.sendAudio(byteArrayOf(3, 4))
        fixture.factory.open()

        val frames = fixture.factory.socket.sentBinary
        assertEquals(1, frames.count { isAudio(it) && isLast(it) })
        assertEquals(2, frames.count(::isAudio))
        assertTrue(isLast(frames.last()))
        fixture.factory.respond("", last = true)
        assertAcknowledged(fixture)
    }

    @Test fun cancelBeforeOpenReleasesWaiterAndNeverFlushesPendingFrames() {
        val fixture = Fixture()
        fixture.client.connect()
        fixture.client.sendAudio(byteArrayOf(1, 2))

        fixture.client.cancel()
        assertTrue(fixture.client.awaitTermination(0))
        fixture.factory.open()
        fixture.factory.respond(finalJson("取消后不应交付。", 0, 100), last = true)
        fixture.factory.remoteClose()

        assertTrue(fixture.factory.socket.sentBinary.isEmpty())
        assertEquals(0, fixture.listener.openCount.get())
        assertTrue(fixture.listener.finals.isEmpty())
        assertTrue(fixture.listener.closures.isEmpty())
        assertTrue(fixture.factory.socket.cancelCount.get() > 0)
    }

    @Test fun malformedBinaryResponseFailsInsteadOfWaitingIndefinitely() {
        val fixture = Fixture()
        fixture.client.connect()
        fixture.factory.open()
        fixture.client.finish()

        fixture.factory.binary(byteArrayOf(0x11))

        assertFailed(fixture)
    }

    @Test fun rejectedEndPacketIsReportedAsFailure() {
        val fixture = Fixture()
        fixture.client.connect()
        fixture.factory.open()
        fixture.factory.socket.acceptSends = false

        fixture.client.finish()

        assertFailed(fixture)
    }

    @Test fun rejectedAudioDoesNotBlockCallerOnInFlightFinal() {
        val fixture = Fixture()
        val enteredFinal = CountDownLatch(1)
        val releaseFinal = CountDownLatch(1)
        val sendReturned = CountDownLatch(1)
        val callbackFailure = AtomicReference<Throwable?>()
        fixture.listener.finalHook = {
            enteredFinal.countDown()
            assertTrue(releaseFinal.await(5, TimeUnit.SECONDS))
        }
        fixture.client.connect()
        fixture.factory.open()
        val receiver = Thread({
            try {
                fixture.factory.respond(finalJson("发送失败时仍在交付。", 0, 100), last = false)
            } catch (failure: Throwable) {
                callbackFailure.set(failure)
            }
        }, "fake-asr-receive").apply { isDaemon = true; start() }
        var sender: Thread? = null
        try {
            assertTrue(enteredFinal.await(2, TimeUnit.SECONDS))
            fixture.factory.socket.acceptSends = false
            sender = Thread({
                try {
                    fixture.client.sendAudio(byteArrayOf(1, 2))
                } catch (failure: Throwable) {
                    callbackFailure.set(failure)
                } finally {
                    sendReturned.countDown()
                }
            }, "fake-asr-send").apply { isDaemon = true; start() }
            assertTrue("audio caller must not wait for a listener callback", sendReturned.await(1, TimeUnit.SECONDS))
            assertFalse(fixture.client.awaitTermination(0))
            assertTrue(fixture.listener.closures.isEmpty())
        } finally {
            releaseFinal.countDown()
            sender?.join(2_000)
            receiver.join(2_000)
        }

        assertFalse(receiver.isAlive)
        assertTrue(sender?.isAlive == false)
        callbackFailure.get()?.let { throw it }
        assertFailed(fixture)
        assertEquals(listOf("发送失败时仍在交付。"), fixture.listener.finals.map { it.text })
        assertEquals("closed", fixture.listener.events.last())
    }

    @Test fun finishTimeoutWaitsForInFlightNonterminalFinalDelivery() {
        val fixture = Fixture(finishTimeoutMs = 50)
        val enteredFinal = CountDownLatch(1)
        val releaseFinal = CountDownLatch(1)
        val callbackFailure = AtomicReference<Throwable?>()
        fixture.listener.finalHook = {
            enteredFinal.countDown()
            assertTrue(releaseFinal.await(5, TimeUnit.SECONDS))
        }
        fixture.client.connect()
        fixture.factory.open()
        val receiver = Thread({
            try {
                fixture.factory.respond(finalJson("超时前已进入交付。", 0, 100), last = false)
            } catch (failure: Throwable) {
                callbackFailure.set(failure)
            }
        }, "fake-asr-timeout").apply { isDaemon = true; start() }
        try {
            assertTrue(enteredFinal.await(2, TimeUnit.SECONDS))
            fixture.client.finish()
            assertFalse("timeout must drain the final callback before releasing waiters", fixture.client.awaitTermination(200))
            assertTrue(fixture.client.isFinishing)
            assertTrue(fixture.listener.closures.isEmpty())
        } finally {
            releaseFinal.countDown()
            receiver.join(2_000)
        }

        assertFalse(receiver.isAlive)
        callbackFailure.get()?.let { throw it }
        assertFailed(fixture)
        assertFalse(fixture.client.isFinishing)
        assertEquals(listOf("超时前已进入交付。"), fixture.listener.finals.map { it.text })
        assertEquals(listOf("open", "final:超时前已进入交付。", "closed"), fixture.listener.events)
    }

    @Test fun rejectedQueuedRequestDoesNotReportOpenOrFlushRemainingFrames() {
        val fixture = Fixture()
        fixture.client.connect()
        fixture.client.sendAudio(byteArrayOf(1, 2))
        fixture.factory.socket.acceptSends = false

        fixture.factory.open()

        assertFailed(fixture)
        assertEquals(0, fixture.listener.openCount.get())
        assertEquals(1, fixture.factory.socket.sentBinary.size)
    }

    private class Fixture(finishTimeoutMs: Long = 30_000) {
        val factory = FakeFactory()
        val listener = RecordingListener()
        val client = VolcAsrClient(
            factory,
            VolcCredentials("test-only-key", "", "", "test-only-resource"),
            "{}",
            listener,
            finishTimeoutMs = finishTimeoutMs,
        )
    }

    private class RecordingListener : VolcAsrClient.Listener {
        val openCount = AtomicInteger()
        val finals = CopyOnWriteArrayList<RawUtterance>()
        val closures = CopyOnWriteArrayList<Pair<String?, Boolean>>()
        val events = CopyOnWriteArrayList<String>()
        @Volatile var finalHook: (RawUtterance) -> Unit = {}

        override fun onOpen() {
            openCount.incrementAndGet()
            events += "open"
        }

        override fun onPartial(text: String, startMs: Long, endMs: Long) = Unit

        override fun onFinal(utterance: RawUtterance) {
            finalHook(utterance)
            finals += utterance
            events += "final:${utterance.text}"
        }

        override fun onClosed(error: String?, fatal: Boolean) {
            closures += error to fatal
            events += "closed"
        }
    }

    private class FakeFactory : WebSocket.Factory {
        lateinit var listener: WebSocketListener
        lateinit var socket: FakeWebSocket

        override fun newWebSocket(request: Request, listener: WebSocketListener): WebSocket {
            this.listener = listener
            socket = FakeWebSocket(request)
            return socket
        }

        fun open() {
            val response = Response.Builder()
                .request(socket.request())
                .protocol(Protocol.HTTP_1_1)
                .code(101)
                .message("Switching Protocols")
                .build()
            listener.onOpen(socket, response)
        }

        fun respond(json: String, last: Boolean) {
            binary(VolcProtocol.encode(
                VolcProtocol.TYPE_FULL_SERVER_RESPONSE,
                if (last) VolcProtocol.FLAG_LAST_PACKET else VolcProtocol.FLAG_NONE,
                VolcProtocol.SERIALIZATION_JSON,
                VolcProtocol.COMPRESSION_NONE,
                json.toByteArray(Charsets.UTF_8),
            ))
        }

        fun providerError(code: Int, message: String) {
            val payload = message.toByteArray(Charsets.UTF_8)
            binary(byteArrayOf(0x11, 0xf0.toByte(), 0x10, 0) +
                ByteBuffer.allocate(8).putInt(code).putInt(payload.size).array() + payload)
        }

        fun binary(bytes: ByteArray) = listener.onMessage(socket, bytes.toByteString())

        fun remoteClose() = listener.onClosed(socket, 1000, "")
    }

    private class FakeWebSocket(private val originalRequest: Request) : WebSocket {
        val sentBinary = CopyOnWriteArrayList<ByteString>()
        val cancelCount = AtomicInteger()
        @Volatile var acceptSends = true

        override fun request(): Request = originalRequest
        override fun queueSize(): Long = 0
        override fun send(text: String): Boolean = acceptSends
        override fun send(bytes: ByteString): Boolean {
            sentBinary += bytes
            return acceptSends
        }
        override fun close(code: Int, reason: String?): Boolean = true
        override fun cancel() { cancelCount.incrementAndGet() }
    }

    private companion object {
        fun finalJson(text: String, startMs: Long, endMs: Long): String =
            """{"result":{"utterances":[{"text":"$text","start_time":$startMs,"end_time":$endMs,"definite":true}]}}"""

        fun isAudio(frame: ByteString): Boolean = ((frame[1].toInt() and 0xff) ushr 4) == VolcProtocol.TYPE_AUDIO_ONLY
        fun isLast(frame: ByteString): Boolean = (frame[1].toInt() and VolcProtocol.FLAG_LAST_PACKET) != 0

        fun assertAcknowledged(fixture: Fixture) {
            val closure = fixture.client.closure
            assertNotNull(closure)
            assertTrue(closure!!.acknowledged)
            assertNull(closure.error)
            assertEquals(1, fixture.listener.closures.size)
            assertNull(fixture.listener.closures.single().first)
        }

        fun assertFailed(fixture: Fixture) {
            assertTrue(fixture.client.awaitTermination(2_000))
            val closure = fixture.client.closure
            assertNotNull(closure)
            assertFalse(closure!!.acknowledged)
            assertNotNull(closure.error)
            assertEquals(1, fixture.listener.closures.size)
            assertNotNull(fixture.listener.closures.single().first)
        }
    }
}
