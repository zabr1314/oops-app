package com.oops.app.store

import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.time.Instant

class BeanScratchStoreTest {
    private val start = "2026-10-13T00:00:00Z"
    private val now = Instant.parse(start).toEpochMilli()
    private fun contract(days: Int = 7, id: String = "meeting-0001") =
        BeanCaptureContract(RecordingPolicy("meeting", days, 30), id, start)

    private inline fun temporary(test: (File) -> Unit) {
        val root = Files.createTempDirectory("oops-bean-scratch-test").toFile()
        try { test(root) } finally { root.deleteRecursively() }
    }

    @Test fun `daily is refused before a scratch folder or SDK is created`() = temporary { files ->
        assertThrows(IllegalStateException::class.java) {
            BeanCaptureContract(RecordingPolicy(), "daily-0001", start)
        }
        assertTrue(files.listFiles()!!.isEmpty())
    }

    @Test fun `meeting lease freezes original audio deadline independently of transcript`() = temporary { files ->
        val store = BeanScratchStore(File(files, BeanScratchStore.DIRECTORY))
        for (days in listOf(7, 30, 90)) {
            val lease = store.begin(contract(days), now)
            assertFalse(lease.expired(now + days * 86_400_000L - 1))
            assertTrue(lease.expired(now + days * 86_400_000L))
            assertTrue(lease.folder.isDirectory)
            lease.markStopping(); lease.finishStopped()
        }
        assertThrows(IllegalStateException::class.java) { store.begin(contract(), now + 7 * 86_400_000L) }
    }

    @Test fun `live and closing writer block every instance until actual stop acknowledgement`() = temporary { files ->
        val root = File(files, BeanScratchStore.DIRECTORY)
        val first = BeanScratchStore(root).begin(contract(), now)
        val opus = File(first.folder, "SDK.opus").apply { writeBytes(byteArrayOf(1, 2)) }
        assertEquals(0, BeanScratchStore(root).recover())
        assertThrows(IllegalStateException::class.java) { BeanScratchStore(root).begin(contract(id = "meeting-0002"), now) }
        first.markStopping()
        assertFalse(first.accepting)
        assertEquals(0, BeanScratchStore(root).recover())
        assertTrue(opus.exists()) // never unlink an unacknowledged writer
        first.finishStopped()
        assertFalse(opus.exists())
        val second = BeanScratchStore(root).begin(contract(id = "meeting-0002"), now)
        assertNotEquals(first.folder, second.folder)
        first.finishStopped() // a late duplicate acknowledgement cannot remove the new session
        assertTrue(second.accepting)
        second.markStopping(); second.finishStopped()
    }

    @Test fun `cleanup failure stays blocked and can retry only after writer is acknowledged stopped`() = temporary { files ->
        var fail = true
        val root = File(files, BeanScratchStore.DIRECTORY)
        val store = BeanScratchStore(root) { folder ->
            if (fail) throw IOException("disk unavailable")
            check(folder.deleteRecursively())
        }
        val lease = store.begin(contract(), now)
        File(lease.folder, "SDK.opus").writeText("audio")
        lease.markStopping()
        assertThrows(IOException::class.java) { lease.finishStopped() }
        assertFalse(lease.accepting)
        assertThrows(IOException::class.java) { store.begin(contract(id = "meeting-0002"), now) }
        assertTrue(lease.folder.exists())
        fail = false
        store.recover()
        assertFalse(lease.folder.exists())
        val second = store.begin(contract(id = "meeting-0002"), now)
        second.markStopping(); second.finishStopped()
    }

    @Test fun `startup removes owned crash leftovers but preserves old bean archive`() = temporary { files ->
        val old = File(files, "bean/old.opus").apply { parentFile!!.mkdirs(); writeText("historic") }
        val scratch = File(files, "${BeanScratchStore.DIRECTORY}/capture-00000000-0000-0000-0000-000000000001").apply { mkdirs() }
        File(scratch, ".oops-scratch.json").writeText("{\"kind\":\"oops-bean-scratch-v1\"}")
        File(scratch, "SDK.opus").writeText("orphan")
        assertEquals(1, BeanScratchStore(scratch.parentFile!!).recover())
        assertFalse(scratch.exists())
        assertEquals("historic", old.readText())
    }

    @Test fun `unknown or unmarked scratch is not silently removed and blocks new capture`() = temporary { files ->
        val root = File(files, BeanScratchStore.DIRECTORY).apply { mkdirs() }
        val unknown = File(root, "unknown.opus").apply { writeText("unknown") }
        val store = BeanScratchStore(root)
        assertThrows(IllegalStateException::class.java) { store.recover() }
        assertThrows(IllegalStateException::class.java) { store.begin(contract(), now) }
        assertEquals("unknown", unknown.readText())
    }

    @Test fun `cleanup does not follow SDK file symlinks or accept a linked namespace`() = temporary { files ->
        val outside = File(files, "legacy.opus").apply { writeText("preserve") }
        val root = File(files, BeanScratchStore.DIRECTORY)
        val lease = BeanScratchStore(root).begin(contract(), now)
        Files.createSymbolicLink(File(lease.folder, "linked.opus").toPath(), outside.toPath())
        lease.markStopping(); lease.finishStopped()
        assertEquals("preserve", outside.readText())
        val linked = File(files, "redirect")
        Files.createSymbolicLink(linked.toPath(), files.toPath())
        assertThrows(IllegalStateException::class.java) { BeanScratchStore(linked).recover() }
    }

    @Test fun `invalid capture identity or start time never allocates storage`() = temporary { files ->
        assertThrows(IllegalArgumentException::class.java) { contract(id = "../escape") }
        assertThrows(java.time.format.DateTimeParseException::class.java) {
            BeanCaptureContract(RecordingPolicy("meeting"), "meeting-0001", "invalid")
        }
        assertTrue(files.listFiles()!!.isEmpty())
    }
}
