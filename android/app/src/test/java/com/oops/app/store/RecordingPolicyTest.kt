package com.oops.app.store

import com.oops.app.buffer.SessionIndex
import com.oops.app.buffer.Utterance
import com.oops.app.backend.MeetingSync
import com.oops.app.backend.toCandidate
import com.oops.app.notice.Notice
import com.oops.app.notice.NoticeTracker
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.time.Instant

class RecordingPolicyTest {
    private val start = "2026-01-01T00:00:00Z"
    private fun meta(audio: Int = 7, text: Int = 90) = RecordingPolicy("meeting", audio, text).contract(start).put("started_at", start)
    private fun rejects(action: () -> Unit) { try { action(); fail("must reject") } catch (_: IllegalArgumentException) {} }

    @Test fun `daily default never grants archive and meeting requires fresh explicit consent`() {
        assertFalse(RecordingPolicy.fromBridge(JSONObject()).archives)
        rejects { RecordingPolicy.fromBridge(JSONObject().put("recordingMode", "meeting")) }
        rejects { RecordingPolicy.fromBridge(JSONObject().put("recordingMode", "meeting").put("cloudSaveConfirmed", true).put("audioRetentionDays", 14)) }
        val p = RecordingPolicy.fromBridge(JSONObject().put("recordingMode", "meeting").put("cloudSaveConfirmed", true).put("audioRetentionDays", 7).put("transcriptRetentionDays", 90))
        assertEquals(7, p.audioDays); assertEquals(90, p.transcriptDays)
        assertEquals(30, RecordingPolicy.fromBridge(JSONObject().put("recordingMode", "meeting").put("cloudSaveConfirmed", true)).audioDays)
    }
    @Test fun `new daily meta cannot create recorder files but old archives remain legacy`() {
        val dir = Files.createTempDirectory("daily-reject").toFile()
        rejects { SessionRecorder(dir, "daily", JSONObject().put("recording_mode", "daily")) }
        assertTrue(dir.listFiles()!!.isEmpty())
        assertNull(RecordingPolicy.fromMeta(JSONObject().put("started_at", start)))
    }
    @Test fun `each asset expires from original start including unfinished unuploaded and recovery files`() {
        val dir = Files.createTempDirectory("policy-expiry").toFile()
        File(dir,"s.json").writeText(meta().toString())
        listOf("pcm","finals.jsonl","asr.jsonl","timing.jsonl","ended","uploaded").forEach { File(dir,"s.$it").writeText("private") }
        val day7=Instant.parse(start).toEpochMilli()+7L*86_400_000
        assertTrue(RecordingExpiry.prune(dir, active="s", nowMs=day7).contains("s:audio"))
        assertFalse(File(dir,"s.pcm").exists());assertTrue(File(dir,"s.finals.jsonl").exists());assertFalse(File(dir,"s.uploaded").exists())
        assertTrue(File(dir,"s.ended").exists());assertFalse(File(dir,"s.expired").exists())
        val parsed=JSONObject(File(dir,"s.json").readText());assertEquals(start, parsed.getString("archive_started_at"))
        RecordingExpiry.prune(dir, nowMs=Instant.parse(start).toEpochMilli()+90L*86_400_000)
        assertTrue(File(dir,"s.expired").exists());assertFalse(File(dir,"s.ended").exists());assertFalse(File(dir,"s.asr.jsonl").exists())
    }
    @Test fun `audio expiry clears retained bytes without resetting the absolute meeting timeline`() {
        val ring=com.oops.app.buffer.AudioRingBuffer(16000)
        ring.append(ByteArray(3200){1});val end=ring.endSample;ring.discardAudio()
        assertEquals(end,ring.endSample);assertEquals(end,ring.startSample);assertFalse(ring.contains(0,end))
        ring.append(ByteArray(320){2});assertEquals(end,ring.startSample);assertTrue(ring.contains(end,end+160))
        ring.reset();assertEquals(0L,ring.startSample);assertEquals(0L,ring.endSample)
    }
    @Test fun `new expiry does not retroactively delete old data`() {
        val dir=Files.createTempDirectory("legacy").toFile();File(dir,"old.json").writeText(JSONObject().put("started_at",start).toString());File(dir,"old.pcm").writeText("legacy")
        RecordingExpiry.prune(dir,nowMs=Instant.parse(start).toEpochMilli()+365L*86_400_000)
        assertTrue(File(dir,"old.pcm").exists())
    }
    @Test fun `five-minute daily prune removes full index digest pending and retained pcm`() {
        val index=SessionIndex();index.reset("d")
        val old=Utterance("old",0,1000,"short evidence",null,tag="commitment")
        index.add("d",old);index.beginAnalysis("d","old");index.retainAudio("d","old",0,ByteArray(32))
        index.add("d",Utterance("edge",300_000,301_000,"recent",null))
        assertEquals(listOf("old"),index.prune(301_001,300_000))
        assertNull(index.get("old"));assertNull(index.audio(0,1));assertEquals(listOf("edge"),index.snapshot().map{it.id})
        assertTrue(index.commitments().isEmpty())
    }
    @Test fun `daily private candidates are short unconfirmed and independent of the cleared transcript`() {
        val dir=Files.createTempDirectory("candidates").toFile();val store=DailyCandidateStore(dir)
        store.upsert("d",Utterance("u",0,300,"长".repeat(500),null,tag="idea"))
        store.upsert("d",Utterance("ordinary",400,800,"ordinary",null))
        val item=store.find("d","u")!!;assertEquals(280,item.getString("quote").length);assertFalse(item.getBoolean("confirmed"));assertFalse(item.getBoolean("original_available"));assertEquals("private",item.getString("visibility"))
        assertEquals(1,store.list().size);assertNull(store.find("other","u"));store.remove("d","u");assertTrue(store.list().isEmpty())
    }
    @Test fun `daily conflict notice cannot keep expired quoted content`() {
        val tracker=NoticeTracker();tracker.add(Notice(kind="conflict",title="conflict",detail="private quote",atMs=1000,evidenceIds=listOf("gone")))
        tracker.add(Notice(kind="time",title="recent",atMs=301_000))
        assertTrue(tracker.prune(1001,setOf("recent")));assertEquals(listOf("recent"),tracker.list().map{it.title})
    }
    @Test fun `meeting sync and crash recovery use the exact persisted consent and deadlines`() {
        val contract=meta();val q=MeetingSync("session-123",start,"UTC",contract)
        q.upsert(Utterance("u",0,300,"approved meeting",null).toCandidate())
        val batch=q.batch(20_000)!!
        assertTrue(q.explicitArchive);assertTrue(batch.body.getBoolean("cloud_save_confirmed"));assertEquals(90,batch.body.getInt("transcript_retention_days"))
        val recovered=SessionRecovery.endBody("session-123",start,contract)
        assertEquals(start,recovered.getString("archive_started_at"));assertEquals(7,recovered.getInt("audio_retention_days"));assertEquals(start,recovered.getString("started_at"))
    }
    @Test fun `server asset expiry cleans only that category and never resets the original contract`() {
        val dir=Files.createTempDirectory("server-expiry").toFile()
        val current=RecordingPolicy("meeting",7,90).contract(Instant.now().toString());File(dir,"session-123.json").writeText(current.toString());File(dir,"session-123.pcm").writeText("audio");File(dir,"session-123.finals.jsonl").writeText("text")
        val transport=object:RecordingTransport {
            override fun recordingManifest(sessionId:String,body:JSONObject):JSONObject {
                assertEquals(current.getString("archive_started_at"),body.getString("archive_started_at"));throw RecordingAssetExpired("audio")
            }
            override fun recordingChunk(sessionId:String,name:String,offset:Long,bytes:ByteArray,sha256:String)=throw AssertionError("must not upload expired audio")
            override fun recordingComplete(sessionId:String)=throw AssertionError("must not complete expired archive")
        }
        assertFalse(RecordingUploader(dir,transport).upload("session-123"));assertFalse(File(dir,"session-123.pcm").exists());assertTrue(File(dir,"session-123.finals.jsonl").exists());assertFalse(File(dir,"session-123.expired").exists())
    }
}
