package com.oops.app.engine

import android.app.Application
import android.util.Base64
import com.oops.app.audio.VoiceprintCapture
import androidx.core.net.toUri
import android.os.SystemClock
import android.util.Log
import com.oops.app.asr.RawUtterance
import com.oops.app.asr.VolcAsrClient
import com.oops.app.asr.VolcRequest
import com.oops.app.audio.AudioSource
import com.oops.app.audio.BeanAudioSource
import com.oops.app.audio.BeanAuth
import com.oops.app.audio.BeanSdk
import com.oops.app.audio.MediaCodecOpusDecoder
import com.oops.app.audio.MicAudioSource
import com.oops.app.audio.ReplayBeanLink
import com.oops.app.audio.RemoteAudioSource
import com.oops.app.audio.WavFileAudioSource
import com.oops.app.backend.ActionDraft
import com.oops.app.backend.ActionWorkflow
import com.oops.app.backend.ActionResult
import com.oops.app.backend.ConfirmRequest
import com.oops.app.backend.DraftRequest
import com.oops.app.backend.Evidence
import com.oops.app.backend.HttpOopsApi
import com.oops.app.backend.MockOopsApi
import com.oops.app.backend.OopsApi
import com.oops.app.backend.RecallRequest
import com.oops.app.backend.RecallResponse
import com.oops.app.backend.SpeakerRequest
import com.oops.app.backend.TaskBoardPolicy
import com.oops.app.backend.TaskSourceBinding
import com.oops.app.backend.RetainedTaskEvidence
import com.oops.app.backend.TaskSourceVersions
import com.oops.app.backend.toCandidate
import com.oops.app.buffer.AudioRingBuffer
import com.oops.app.buffer.TranscriptBuffer
import com.oops.app.buffer.Utterance
import com.oops.app.core.Pcm
import com.oops.app.core.Settings
import com.oops.app.playback.ClipPlayer
import com.oops.app.recall.CandidateWindow
import com.oops.app.recall.CardItem
import com.oops.app.recall.OopsCommand
import com.oops.app.recall.PickPolicy
import com.oops.app.recall.RecallCard
import com.oops.app.service.CaptureService
import com.oops.app.store.ActionOperationStore
import com.oops.app.store.SavedClipStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.time.Instant
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/**
 * AudioSource → 5-minute ring buffer + streaming ASR → transcript → recall → action.
 * Process-wide; CaptureService keeps the process alive while capturing.
 */
object OopsEngine {
    private const val TAG = "Oops"
    const val RETENTION_MS = 5 * 60_000L
    private const val CLIP_PAD_MS = 500L
    /** Shorter sentences carry too little voice to identify reliably. */
    private const val SPEAKER_MIN_MS = 1_000L
    private const val SPLIT_POLLS = 3
    private const val BOARD_POLL_MS = 6_000L
    private const val BOARD_POLLS = 6
    private const val TEST_WAV = "test/dialog.wav"
    private const val TEST_BEAN_STREAM = "test/dialog.opusraw" // dialog.wav through scripts/bean_opus.py encode
    private val MANUAL_OTHER = setOf("other", "multi", "unclear")
    private const val REVIEW_RETRIES = 3
    private const val REVIEW_RETRY_MS = 25_000L

    private lateinit var app: Application
    lateinit var settings: Settings
        private set
    private lateinit var store: SavedClipStore
    private lateinit var operations: ActionOperationStore
    private lateinit var ownerFeedback: com.oops.app.store.OwnerFeedbackStore
    private val ownerFeedbackJobs = kotlinx.coroutines.channels.Channel<() -> Unit>(kotlinx.coroutines.channels.Channel.UNLIMITED)
    private val submitted = ConcurrentHashMap<String, ActionOperationStore.Operation>()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .callTimeout(10, TimeUnit.SECONDS)
        // Per-request network phases for the calls that decide how fast a name or tag appears.
        .eventListenerFactory {
            com.oops.app.backend.NetTimer({ p -> p.startsWith("/v1/speaker") || p == "/v1/utterances" || p.startsWith("/v1/actions/draft") },
                { path, fields -> timing(sessionId, path, "net", *fields.map { it.key to it.value }.toTypedArray()) })
        }
        .build()

    /** The ASR socket can stay silent through long pauses: no read timeout. */
    private val asrHttp = http.newBuilder().readTimeout(0, TimeUnit.SECONDS).callTimeout(0, TimeUnit.SECONDS)
        .pingInterval(10, TimeUnit.SECONDS).build()

    private val ring = AudioRingBuffer((RETENTION_MS / 1000).toInt() * Pcm.SAMPLE_RATE)
    private val transcript = TranscriptBuffer(RETENTION_MS)
    private val sessionIndex = com.oops.app.buffer.SessionIndex()
    @Volatile private var optionalRequests = com.oops.app.backend.OptionalRequests()
    private val player = ClipPlayer(::onClipState)

    @Volatile private var api: OopsApi = MockOopsApi(Settings.TEAM)
    @Volatile private var previewApi: OopsApi = api
    @Volatile private var serviceEpoch = 0L
    private var configuredService: Triple<Boolean, String, String>? = null

    private val _state = MutableStateFlow(EngineState())
    val state: StateFlow<EngineState> = _state.asStateFlow()
    private val _events = MutableSharedFlow<OopsEvent>(
        extraBufferCapacity = 256,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
    val events: SharedFlow<OopsEvent> = _events.asSharedFlow()

    // Guarded by `pipeline`: each frame reaches the ring and the current ASR connection
    // atomically, so a connection's time zero is an exact offset on the session timeline.
    private val pipeline = Any()
    private var source: AudioSource? = null
    private var captureStopping = false
    private var voiceprintCapture: VoiceprintCapture? = null
    private var voiceprintPcm: ByteArray? = null
    private var voiceprintClient: HttpOopsApi? = null
    private var voiceprintSampleId = ""
    private var voiceprintRevision = ""
    private var asr: VolcAsrClient? = null
    private var pausedAsrClosure: VolcAsrClient.Closure? = null
    private var pauseAsrHadFailure = false
    private var asrGeneration = 0
    private var asrDownSinceMs: Long? = null
    private var reconnectAttempt = 0
    private var reconnectJob: Job? = null
    private var tickJob: Job? = null
    private val previewBusy = java.util.concurrent.atomic.AtomicBoolean(false)
    private var previewEpoch = 0L
    private var previewAudioStartMs = 0L
    private var previewRequestedMs = 0L
    private var previewResultMs = 0L

    @Volatile private var recordingPolicy = com.oops.app.store.RecordingPolicy()
    @Volatile private var recordingArchiveStartedAt = ""
    private val sessionModes = ConcurrentHashMap<String, String>()
    @Volatile private var sessionId = ""
    @Volatile private var recorder: com.oops.app.store.SessionRecorder? = null
    @Volatile private var level = 0f

    private lateinit var dailyCandidateStore: com.oops.app.store.DailyCandidateStore
    private val cards = ConcurrentHashMap<String, RecallCard>()
    private val drafts = ConcurrentHashMap<String, ActionDraft>()
    private val ownerHints = ConcurrentHashMap<String, com.oops.app.backend.DraftResponse>()
    /** The server's running task list for this session (P0–P3); display only, confirming still goes through drafts. */
    @Volatile private var taskBoard: JSONObject? = null
    private var taskBoardContext: TaskBoardPolicy.Context? = null
    private var boardSourceRevision = 0L
    private val boardBlockedSources = mutableSetOf<String>()
    private val boardLocalReviews = mutableMapOf<String, Map<String, String>>()
    private val boardMutationVersions = mutableMapOf<String, Long>()
    private val taskSourceVersions = TaskSourceVersions()
    private var boardPoll: Job? = null
    private val hintEpochs = ConcurrentHashMap<String, Long>()
    private val suggestionEpochs = ConcurrentHashMap<String, Long>()
    private val opIds = ConcurrentHashMap<String, String>() // draftId → op_id, reused on retry
    private val inFlight: MutableSet<String> = ConcurrentHashMap.newKeySet()
    private val recallLatencies = ArrayDeque<Long>()
    private val invalidSessions = ConcurrentHashMap.newKeySet<String>()
    private val recoveryFailures = ConcurrentHashMap.newKeySet<String>()
    private val recoveryRunning = java.util.concurrent.atomic.AtomicBoolean(false)
    private fun currentOrigin() = com.oops.app.store.RecordingOrigin.from(settings.backendBaseUrl, api.name == "mock")
    private fun currentSessionService(session: String, epoch: Long) = session.isNotBlank() && session == sessionId &&
        epoch == serviceEpoch && session !in invalidSessions
    private fun currentSource(session: String, epoch: Long) = currentSessionService(session, epoch) && !_state.value.transcriptExpired

    private fun clearUnsubmittedSources() {
        taskBoard = null; boardPoll?.cancel(); boardPoll = null
        cards.clear(); drafts.keys.removeAll { !submitted.containsKey(it) }
        ownerHints.clear(); hintEpochs.clear(); suggestionEpochs.clear(); topicEvidence.clear(); conflictPairs.clear()
        sessionIndex.snapshot().forEach { sessionIndex.finishAnalysis(sessionId, it.id) }
    }

    fun retryArchives() {
        require(!_state.value.capturing && !isCaptureStopping()) { "请先结束当前记录再重试恢复" }
        recoverUnfinishedMeetings()
        scheduleUpload()
    }

    private fun archiveMessage(dir: File, origin: com.oops.app.store.RecordingOrigin?) {
        val blocked = dir.listFiles { f -> f.name.endsWith(".json") && f.name.count { it == '.' } == 1 }.orEmpty().count { file ->
            val id = file.name.removeSuffix(".json")
            val meta = runCatching { JSONObject(file.readText()) }.getOrNull()
            val uploaded = File(dir, "$id.uploaded")
            val pending = !uploaded.isFile || dir.listFiles { f -> f.name.startsWith("$id.") &&
                f.name !in setOf("$id.uploaded", "$id.ended", "$id.expired") }.orEmpty().any { it.lastModified() > uploaded.lastModified() }
            pending && !File(dir, "$id.expired").exists() && meta != null && (origin == null || !origin.matches(meta))
        }
        val failed = recoveryFailures.any { id -> runCatching { JSONObject(File(dir, "$id.json").readText()) }
            .getOrNull()?.let { origin?.matches(it) } == true }
        _state.update { it.copy(recordingsBlocked = blocked, recordingArchiveMessage = when {
            blocked > 0 -> "$blocked 场本机录音缺少服务归属或属于其他服务，已保留，未自动上传或恢复"
            failed -> "部分本机会议尚未恢复完整原话；文件已保留，请核对来源、保存期限或连接后重试"
            else -> null
        }) }
    }

    /** "Now" on the session timeline = audio received so far. */
    val nowMs: Long get() = Pcm.samplesToMs(ring.endSample)

    fun init(application: Application) {
        if (::app.isInitialized) return
        app = application
        settings = Settings(application)
        noticeAlert = com.oops.app.notice.NoticeAlert(application)
        tracker = com.oops.app.notice.NoticeTracker(runCatching {
            com.oops.app.notice.Agenda.fromBridge(JSONObject(settings.agendaJson), ++agendaRevision)
        }.getOrDefault(com.oops.app.notice.Agenda()))
        store = SavedClipStore(File(application.filesDir, "saved"))
        dailyCandidateStore = com.oops.app.store.DailyCandidateStore(File(application.filesDir, "daily-candidates"))
        operations = ActionOperationStore(File(application.filesDir, "actions"))
        ownerFeedback = com.oops.app.store.OwnerFeedbackStore(File(application.filesDir, "owner-feedback"))
        scope.launch(Dispatchers.IO) {
            for (job in ownerFeedbackJobs) runCatching(job)
                .onFailure { Log.w(TAG, "local owner feedback unavailable: ${it.javaClass.simpleName}") }
        }
        operations.list().forEach { operation ->
            val draft = operation.request.draft
            submitted[draft.draftId] = operation
            drafts[draft.draftId] = draft
            opIds[draft.draftId] = operation.request.opId
        }
        rebuildApi()
        BeanSdk.onScratchFailure = { detail -> fail("bean.storage", detail) }
        runCatching { BeanSdk.cleanupScratch(application) }.onFailure {
            _state.update { state -> state.copy(sourceDetail = "录音豆临时副本清理失败，请检查设备后重试") }
            fail("capture", "录音豆临时副本清理失败，请检查设备后重试")
        }
        recoverUnfinishedMeetings() // before any capture can start, so the new session is never mistaken for one
        watchNetwork()
        updateAssistanceState()
        _state.update {
            it.copy(
                source = settings.source,
                savedCount = store.count(),
                testWavName = settings.testWavName,
                remoteAddress = settings.remoteAddress,
            )
        }
        scope.launch {
            delay(5_000)
            while (isActive) {
                scheduleUpload()
                delay(15 * 60_000L)
            }
        }
    }

    /** A meeting the app never stopped still tells the server it ended, so its minutes go out (see [SessionRecovery]). */
    private fun recoverUnfinishedMeetings() {
        if (!recoveryRunning.compareAndSet(false, true)) return
        val dir = File(app.filesDir, "recordings")
        val origin = currentOrigin()
        val epoch = serviceEpoch
        archiveMessage(dir, origin)
        runCatching { com.oops.app.store.RecordingExpiry.prune(dir) }
            .onFailure { Log.w(TAG, "recording expiry unavailable: ${it.javaClass.simpleName}") }
        val ended = runCatching { com.oops.app.store.SessionRecovery.scan(dir, active = null,
            accepts = { _, meta -> origin?.matches(meta) == true }) }
            .onFailure { Log.w(TAG, "unfinished meeting scan failed: ${it.message}") }.getOrDefault(emptyList())
        if (ended.isEmpty()) { recoveryRunning.set(false); return }
        val client = api
        scope.launch(Dispatchers.IO) {
          try {
            for ((id, at) in ended) {
                try {
                    if (epoch != serviceEpoch) return@launch
                    val meta = runCatching { JSONObject(File(dir, "$id.json").readText()) }.getOrNull()
                    if (meta == null || origin?.matches(meta) != true) continue
                    if (!settings.memorySync && meta?.has("recording_mode") != true) continue
                    val bodies = com.oops.app.store.SessionRecovery.replayBodies(dir, id, at, meta)
                    val existing = client.historyOpen(id)
                    require(existing?.optString("transcript_status") != "expired") { "服务完整文字已到期，不能恢复" }
                    val previous = existing?.optJSONArray("utterances") ?: JSONArray()
                    val known = (0 until previous.length()).map { previous.getJSONObject(it) }.associateBy { it.getString("id") }
                    for (body in bodies) {
                        if (epoch != serviceEpoch) return@launch
                        val rows = body.getJSONArray("utterances")
                        val missing = JSONArray()
                        for (n in 0 until rows.length()) {
                            val row = rows.getJSONObject(n); val before = known[row.getString("id")]
                            if (before == null) missing.put(row) else require(before.getString("text") == row.getString("text") &&
                                before.getDouble("start_ms") == row.getDouble("start_ms") && before.getDouble("end_ms") == row.getDouble("end_ms")) {
                                "服务原话已变化，请重新核对，不覆盖当前内容"
                            }
                        }
                        body.put("utterances", missing)
                        if (missing.length() == 0 && !body.has("ended_at")) continue
                        val result = client.syncMeeting(body)
                        require(result != null && (result.optJSONArray("rejected")?.length() ?: 0) == 0 &&
                            result.optInt("utterance_count", -1) >= missing.length()) { "服务未完整确认恢复原话" }
                    }
                    if (epoch != serviceEpoch) return@launch
                    com.oops.app.store.SessionRecovery.markSent(dir, id)
                    recoveryFailures.remove(id)
                    Log.i(TAG, "unfinished meeting $id: end $at sent")
                } catch (error: CancellationException) { throw error }
                catch (error: Exception) {
                    recoveryFailures.add(id)
                    if (epoch == serviceEpoch) _state.update { it.copy(recordingArchiveMessage =
                        "部分本机会议尚未恢复完整原话；文件已保留，请核对来源、保存期限或连接后重试") }
                    Log.w(TAG, "unfinished meeting $id: end not sent: ${error.javaClass.simpleName}")
                }
            }
          } finally {
            recoveryRunning.set(false)
            if (epoch == serviceEpoch) archiveMessage(dir, origin)
          }
        }
    }

    // ---- raw asset upload ----------------------------------------------------------------

    private val uploading = java.util.concurrent.atomic.AtomicBoolean(false)
    private val uploadRequested = java.util.concurrent.atomic.AtomicBoolean(false)

    /** Finished sessions go to the team server; never while a meeting is capturing (live ASR keeps the network). */
    fun scheduleUpload(delayMs: Long = 0) {
        uploadRequested.set(true)
        scope.launch(Dispatchers.IO) {
            delay(delayMs)
            if (!uploading.compareAndSet(false, true)) return@launch
            val dir = File(app.filesDir, "recordings")
            try {
              do {
                uploadRequested.set(false)
                com.oops.app.store.RecordingExpiry.prune(dir, active = if (source != null || isCaptureStopping()) sessionId else null)
                expireSessionMemory(dir)
                val transport = api as? com.oops.app.backend.HttpOopsApi ?: return@launch
                val epoch = serviceEpoch
                val origin = currentOrigin()
                archiveMessage(dir, origin)
                val uploader = com.oops.app.store.RecordingUploader(dir, transport)
                fun active() = if (source != null || isCaptureStopping()) sessionId else null
                fun pending() = uploader.pending(active()).filter { id ->
                    val meta = runCatching { JSONObject(File(dir, "$id.json").readText()) }.getOrNull()
                    meta != null && origin?.matches(meta) == true
                }
                for (id in pending()) {
                    _state.update { it.copy(recordingsPending = pending().size, recordingUpload = "uploading") }
                    if (epoch != serviceEpoch) break
                    if (source != null) break
                    runCatching { uploader.upload(id) { source == null && epoch == serviceEpoch } }
                        .onSuccess { if (it) Log.i(TAG, "recording uploaded: $id") }
                        .onFailure { Log.w(TAG, "recording upload $id failed: ${it.message}") }
                }
                val left = pending().size
                if (epoch == serviceEpoch) _state.update { it.copy(recordingsPending = left, recordingUpload = if (left == 0) "done" else "pending") }
                com.oops.app.store.SessionRecorder.prune(dir, keep = active())
              } while (uploadRequested.get())
            } catch (error: Exception) {
                Log.w(TAG, "recording upload pass failed: ${error.message}")
            } finally {
                uploading.set(false)
                if (uploadRequested.get()) scheduleUpload()
            }
        }
    }

    /** Disk expiry must also invalidate any still-open in-memory copy of this meeting. */
    private fun expireSessionMemory(dir: File) {
        val session = sessionId
        val meta = runCatching { JSONObject(File(dir, "$session.json").readText()) }.getOrNull() ?: return
        if (!meta.has("recording_mode")) return
        synchronized(pipeline) {
            if (session != sessionId) return
            val audio = meta.optBoolean("audio_expired")
            val text = meta.optBoolean("transcript_expired")
            val audioChanged = audio && !_state.value.audioExpired
            val textChanged = text && !_state.value.transcriptExpired
            if (audioChanged) { ring.discardAudio(); sessionIndex.discardAudio(); player.stop() }
            if (textChanged) {
                _state.update { it.copy(transcriptExpired = true) }
                invalidateTaskBoard("transcript_expired")
                clearUnsubmittedSources()
                val ids = transcript.snapshot().map { it.id }
                transcript.clear(); sessionIndex.reset(session); cards.clear()
                drafts.keys.removeAll { !submitted.containsKey(it) }
                ownerHints.clear(); hintEpochs.clear(); suggestionEpochs.clear(); topicEvidence.clear(); conflictPairs.clear()
                tracker = com.oops.app.notice.NoticeTracker(tracker.agenda)
                emit(OopsEvent.Pruned(ids)); emit(OopsEvent.Json("capture.assetsExpired", JSONObject().put("asset", "transcript")))
                refreshTaskBoard() // the server may still have independently confirmed short evidence
            }
            if (audioChanged || textChanged) {
                _state.update { it.copy(audioExpired = audio, transcriptExpired = text) }
                updateAssistanceState(); publishSessionSummary(session)
            }
        }
    }

    // ---- capture -------------------------------------------------------------------------

    suspend fun requireRecordingPolicySupport() { (api as? HttpOopsApi)?.requireArchivePolicy() }

    fun captureStartRejected(message: String) {
        fail("capture", message)
    }

    fun startCapture(kind: String, policy: com.oops.app.store.RecordingPolicy = com.oops.app.store.RecordingPolicy()) {
        synchronized(pipeline) {
            if (source != null) return
            try {
                requireCaptureSource(kind, policy)
            } catch (error: Exception) {
                // Service starts are asynchronous: throwing here bypasses MainActivity's
                // bridge handler and crashes the process instead of reporting the refusal.
                fail("capture", "无法开始收音：${error.message}")
                CaptureService.stop(app)
                return
            }
            if (captureStopping || asr?.isFinishing == true) {
                emit(OopsEvent.Toast("正在接收上一场的最后转写，请稍候"))
                return
            }
            settings.source = kind
            val origin = requireNotNull(currentOrigin()) { "服务地址无效，无法绑定本场保存来源" }
            recordingPolicy = policy
            ring.reset()
            resetSpeakerPreview()
            transcript.clear()
            cards.clear()
            drafts.keys.removeAll { !submitted.containsKey(it) }
            ownerHints.clear(); hintEpochs.clear(); suggestionEpochs.clear()
            taskBoard = null; taskBoardContext = null; boardPoll?.cancel(); boardSourceRevision++; boardBlockedSources.clear(); boardLocalReviews.clear(); boardMutationVersions.clear()
            taskSourceVersions.invalidate(null)
            sessionId = UUID.randomUUID().toString()
            sessionModes[sessionId] = policy.mode
            val archiveStartedAt = Instant.now().toString()
            recordingArchiveStartedAt = archiveStartedAt
            sessionIndex.reset(sessionId)
            recorder?.closeAudio()
            runCatching { com.oops.app.store.SessionRecorder.prune(File(app.filesDir, "recordings"), keep = null) }
                .onSuccess { if (it.isNotEmpty()) Log.i(TAG, "pruned recordings: ${it.size}") }
            recorder = if (!policy.archives) null else runCatching {
                com.oops.app.store.SessionRecorder(File(app.filesDir, "recordings"), sessionId,
                    origin.attach(org.json.JSONObject().put("session_id", sessionId).put("source", kind))
                        .put("started_at", archiveStartedAt).put("time_zone", java.time.ZoneId.systemDefault().id).also { meta ->
                            val contract = policy.contract(archiveStartedAt); contract.keys().forEach { key -> meta.put(key, contract.get(key)) }
                        })
            }.onFailure { Log.e(TAG, "session recording unavailable", it) }.getOrNull()
            tracker = com.oops.app.notice.NoticeTracker(tracker.agenda)
            _state.update { it.copy(syncStatus = "idle", recordingCapped = false, micBusy = false) }
            lastTopicAt = 0; lastTopicCount = 0; lastVoiceAt = -5_000
            topicEvidence.clear(); conflictPairs.clear()
            syncContext = if (policy.archives) SyncContext(com.oops.app.backend.MeetingSync(sessionId, archiveStartedAt, java.time.ZoneId.systemDefault().id, policy.contract(archiveStartedAt)), api) else null
            syncContext?.let { it.queue.agenda(tracker.agenda.wire()); syncContexts.add(it) }
            optionalRequests = com.oops.app.backend.OptionalRequests()
            reconnectAttempt = 0
            asrDownSinceMs = null
            pausedAsrClosure = null
            pauseAsrHadFailure = false
            var src: AudioSource? = null
            _state.update {
                it.copy(
                    capturing = true, source = kind, sessionId = sessionId, sessionMs = 0, bufferedMs = 0,
                    recordingMode = policy.mode, cloudSaveConfirmed = policy.archives,
                    audioRetentionDays = policy.audioDays, transcriptRetentionDays = policy.transcriptDays,
                    audioExpired = false, transcriptExpired = false,
                    boardSourceRevision = boardSourceRevision,
                    asr = if (kind == "bean") "off" else "connecting", asrDetail = null, asrGaps = emptyList(), sourceDetail = null, sourceReady = false,
                    captureControl = "waiting", captureControlError = null,
                    digestCounts = emptyMap(), notices = emptyList(), commitmentCount = 0, analysisPending = 0, analysisFailed = 0, tagsSupported = null, sessionTruncated = false,
                )
            }
            try {
                val created = createAudioSource(kind)
                src = created
                source = created
                // Hardware discovery may take longer than the ASR server's no-audio timeout.
                // Start its ASR only when the first hardware packet arrives.
                if (kind != "bean") openAsrLocked()
                created.start(audioListenerFor(created))
            } catch (e: Throwable) {
                Log.e(TAG, "capture failed to start", e)
                source = null
                runCatching { src?.stop() }.onFailure { fail("bean.storage", "音源启动失败后的临时副本清理失败，请检查设备后重试") }
                asr?.cancel()
                asr = null
                _state.update { it.copy(capturing = false, asr = "off", sourceDetail = null, sourceReady = false) }
                syncContext?.let { it.stopped = true; it.queue.halt(endToo = true); it.job?.cancel() }
                recorder?.discard() // nothing was captured: no empty recording to upload later
                recorder = null
                sessionId = ""; sessionIndex.reset(""); ring.reset()
                _state.update { it.copy(sessionId = "", sessionMs = 0, bufferedMs = 0) }
                fail("capture", "无法开始收音：${e.message}")
                CaptureService.stop(app)
                return
            }
        }
        syncContext?.let(::ensureSyncWorker)
        Log.i(TAG, "capture started: source=$kind session=$sessionId")
        tickJob?.cancel()
        tickJob = scope.launch {
            while (isActive) {
                delay(500)
                tick()
            }
        }
    }

    fun isCaptureStopping(): Boolean = synchronized(pipeline) { captureStopping }

    fun setCapturePaused(paused: Boolean) {
        val target = synchronized(pipeline) {
            val current = source
            if (current == null || !current.supportsPause || captureStopping) {
                fail("capture.control", "当前音源尚不能暂停或继续")
                return
            }
            if (voiceprintCapture != null) {
                fail("capture.control", "请先完成或取消声音采集，再控制录音")
                return
            }
            if (!paused && asr?.isFinishing == true) {
                emit(OopsEvent.Toast("正在接收暂停前的最后转写，请稍候"))
                return
            }
            _state.update { it.copy(captureControlError = null) }
            current
        }
        // Do not hold the pipeline lock while entering the SDK callback lock.
        runCatching { if (paused) target.pause() else target.resume() }.onFailure {
            _state.update { s -> s.copy(captureControlError = it.message) }
            fail("capture.control", it.message ?: "录音控制失败，请重试")
        }
    }

    fun stopCapture() {
        val src: AudioSource
        val client: VolcAsrClient?
        val archives: Boolean
        val stoppedSession: String
        val stoppedTracker: com.oops.app.notice.NoticeTracker
        val stoppedSync: SyncContext?
        val stoppedRecorder: com.oops.app.store.SessionRecorder?
        val stoppedPauseClosure: VolcAsrClient.Closure?
        val stoppedPauseFailure: Boolean
        synchronized(pipeline) {
            src = source ?: return
            captureStopping = true
            source = null
            if (voiceprintCapture != null) cancelVoiceprintRecording()
            client = asr
            stoppedPauseClosure = pausedAsrClosure
            stoppedPauseFailure = pauseAsrHadFailure
            archives = recordingPolicy.archives
            stoppedSession = sessionId
            stoppedTracker = tracker
            stoppedSync = syncContext
            stoppedRecorder = recorder
            reconnectJob?.cancel()
        }
        runCatching { src.stop() }.onFailure {
            fail("capture", "音源关闭或录音豆临时副本清理失败：${it.message ?: "请检查设备后重试"}")
        }
        stoppedRecorder?.closeAudio() // finals that flush after stop are still appended
        if (archives && client != null) {
            _state.update { it.copy(asr = "finishing", asrDetail = "正在等待最后转写与结束确认") }
        }
        if (archives) client?.finish() else client?.cancel() // daily stop cannot flush text back into the cleared buffer
        tickJob?.cancel()
        player.stop()
        level = 0f
        _state.update { it.copy(capturing = false, level = 0f, sourceDetail = null, sourceReady = false, asr = if (client != null) it.asr else "off") }
        resetSpeakerPreview()
        if (!archives) {
            synchronized(pipeline) {
                invalidateTaskBoard("daily_stopped")
                val ids = transcript.snapshot().map { it.id }
                sessionId = ""; asrGeneration++; asr = null
                captureStopping = false
                transcript.clear(); sessionIndex.reset(""); ring.reset(); cards.clear()
                drafts.keys.removeAll { !submitted.containsKey(it) }
                ownerHints.clear(); hintEpochs.clear(); suggestionEpochs.clear(); topicEvidence.clear(); conflictPairs.clear()
                tracker = com.oops.app.notice.NoticeTracker(tracker.agenda)
                _state.update { it.copy(sessionId = "", sessionMs = 0, bufferedMs = 0, asr = "off", digestCounts = emptyMap(), notices = emptyList(), commitmentCount = 0, analysisPending = 0) }
                emit(OopsEvent.Pruned(ids)); emit(OopsEvent.Json("capture.cleared", JSONObject().put("mode", "daily")))
            }
            scheduleUpload()
            return
        }
        val endedAt = Instant.now().toString()
        scope.launch {
          try {
            // The client owns the bounded EOS/ack timeout. Never cancel after an arbitrary 5 s,
            // or publish the end before the final provider response has been delivered.
            val terminated = client == null || withContext(Dispatchers.IO) { client.awaitTermination() }
            if (!terminated) {
                client.cancel()
                if (stoppedSession == sessionId) _state.update {
                    it.copy(asr = "error", asrDetail = "ASR结束未确认，已收到的转写已保留")
                }
            }
            val outcome = client?.closure ?: stoppedPauseClosure
            val closure = when {
                !terminated -> "incomplete"
                stoppedPauseFailure -> "incomplete"
                outcome?.acknowledged == true -> "acknowledged"
                outcome?.errorCode == "cancelled" -> "cancelled"
                else -> "incomplete"
            }
            val errorCode = if (!terminated) "finish_timeout" else if (stoppedPauseFailure) "pause_asr_incomplete" else outcome?.errorCode ?: if (outcome == null) "asr_unavailable" else null
            val error = if (!terminated) "ASR结束未确认，已收到的转写已保留" else if (stoppedPauseFailure) "暂停前有转写结束未确认，已收到的原话仍保留" else outcome?.error ?: if (outcome == null) "ASR未连接，完整性未确认" else null
            withContext(Dispatchers.IO) {
                stoppedRecorder?.flush()
                runCatching { stoppedRecorder?.recordAsrClosure(closure, errorCode, error) }
                    .onFailure { Log.w(TAG, "ASR closure metadata failed: ${it.javaClass.simpleName}") }
            }
            stoppedSync?.let { it.stopped = true; it.queue.stop(endedAt, closure, errorCode, error); ensureSyncWorker(it) }
            if (stoppedSession == sessionId && stoppedTracker === tracker) {
                val todos = sessionIndex.commitments()
                val pendingOwners = todos.count { u -> submitted.values.none {
                    it.request.sessionId == stoppedSession && u.id in it.request.draft.evidence.utteranceIds } }
                stoppedTracker.onStop(nowMs, pendingOwners,
                    todos.count { com.oops.app.backend.CommitmentRules.deadline(it.text) == null }).forEach { publishNotice(it, stoppedSession) }
                if (pendingOwners > 0) emit(OopsEvent.Toast("$pendingOwners 条负责人待确认"))
                checkResolutions(nowMs)
                publishSessionSummary(stoppedSession)
            }
            stoppedSync?.let(::ensureSyncWorker)
          } finally {
            synchronized(pipeline) { captureStopping = false }
            scheduleUpload() // now eligible, with every final delivered before termination
          }
        }
        Log.i(TAG, "capture stopped")
    }

    /** Starts a new archive at the explicit switch, never copies the previous daily buffer. */
    fun startMeeting(policy: com.oops.app.store.RecordingPolicy) {
        require(policy.archives) { "请选择正式会议并确认云端保存" }
        require(source != null && !recordingPolicy.archives) { "请先开始日常聆听，再切换正式会议" }
        val kind = source!!.kind
        stopCapture()
        startCapture(kind, policy)
    }

    fun requireCaptureSource(kind: String, policy: com.oops.app.store.RecordingPolicy) {
        if (kind != Settings.SOURCE_BEAN) return
        BeanSdk.requireCaptureAllowed(policy)
        check(BeanSdk.included) { "这个安装包没有包含录音豆 SDK，请选择手机麦克风" }
        BeanAuth.fromBuildConfig().requireUsable()
    }

    private fun createAudioSource(kind: String): AudioSource = when (kind) {
        Settings.SOURCE_WAV -> WavFileAudioSource {
            val uri = settings.testWavUri
            if (uri.isBlank()) app.assets.open(TEST_WAV)
            else requireNotNull(app.contentResolver.openInputStream(uri.toUri())) { "无法打开测试 WAV" }
        }
        Settings.SOURCE_REMOTE -> {
            val (host, port) = Settings.parseAddress(settings.remoteAddress)
                ?: ("127.0.0.1" to RemoteAudioSource.DEFAULT_PORT)
            RemoteAudioSource(host, port)
        }
        Settings.SOURCE_BEAN -> BeanAudioSource(BeanSdk.link(app, BeanAuth.fromBuildConfig(), recordingPolicy, sessionId, recordingArchiveStartedAt), ::MediaCodecOpusDecoder, kind)
        Settings.SOURCE_BEAN_SIM -> BeanAudioSource(
            ReplayBeanLink("录音豆模拟（内置对话）", { app.assets.open(TEST_BEAN_STREAM) }), ::MediaCodecOpusDecoder, kind)
        else -> MicAudioSource()
    }

    /** Replace only the input; the timeline, transcript, retained clips and pending work survive. */
    private fun switchCaptureSource(kind: String) {
        requireCaptureSource(kind, recordingPolicy)
        val next = createAudioSource(kind) // construction failures must not stop the current working source
        val previous = synchronized(pipeline) {
            val active = source ?: return
            source = null // invalidate callbacks before closing the old worker
            _state.update { it.copy(sourceReady = false, sourceDetail = null, level = 0f) }
            active
        }
        runCatching { previous.stop() }.onFailure {
            fail("capture", "音源关闭或录音豆临时副本清理失败：${it.message ?: "请检查设备后重试"}")
        }
        synchronized(pipeline) {
            source = next
            resetSpeakerPreview()
            level = 0f
            _state.update { it.copy(source = kind, sourceDetail = null, sourceReady = false, level = 0f) }
            try {
                // Flush the old input's unfinished sentence, keeping session coordinates intact.
                reconnectJob?.cancel()
                restartAsrLocked()
                next.start(audioListenerFor(next))
                Log.i(TAG, "capture source switched: ${previous.kind} -> $kind session=$sessionId")
            } catch (error: Exception) {
                Log.e(TAG, "source switch failed", error)
                fail("capture", "无法切换音源：${error.message}")
                CaptureService.stop(app)
            }
        }
    }

    private fun audioListenerFor(owner: AudioSource) = object : AudioSource.Listener {
        override fun onControlState(state: String) {
            synchronized(pipeline) {
                if (source !== owner) return
                _state.update { it.copy(captureControl = state) }
                if (state in listOf("paused", "stopped")) {
                    level = 0f
                    reconnectJob?.cancel()
                    asrDownSinceMs = null
                    _state.update { it.copy(sourceReady = false, level = 0f,
                        asr = if (asr != null) "finishing" else "off",
                        asrDetail = if (asr != null) "正在接收暂停前的最后转写" else null) }
                    // The audio worker sends this only after all queued tail packets and partial PCM.
                    asr?.finish()
                }
            }
        }

        override fun onControlError(message: String) {
            if (source !== owner) return
            _state.update { it.copy(captureControlError = message) }
            fail("capture.control", message)
        }
        override fun onAudio(pcm: ByteArray) {
            synchronized(pipeline) {
                if (source !== owner) return
                val pausedTail = _state.value.captureControl in listOf("draining", "paused")
                _state.update { if (it.sourceReady || pausedTail) it else it.copy(sourceReady = true) }
                voiceprintCapture?.let { recording ->
                    val complete = recording.append(pcm)
                    _state.update { it.copy(voiceprint = it.voiceprint.copy(phase = "recording", elapsedMs = recording.elapsedMs)) }
                    if (complete) finishVoiceprintRecording()
                }
                ring.append(pcm)
                recorder?.let { r ->
                    r.audio(pcm)
                    if (r.capped && !_state.value.recordingCapped) _state.update { it.copy(recordingCapped = true) }
                }
                // 回听时给 ASR 送静音：外放的原声不会被再转写一遍，连接和时间轴也不断。
                if (pausedTail && (asr == null || asr?.isFinishing == true)) {
                    if (!pauseAsrHadFailure) {
                        val message = "暂停后有迟到尾音，原音已保留，文字完整性需核对"
                        _state.update { it.copy(captureControlError = message) }
                        fail("capture.control", message)
                    }
                    pauseAsrHadFailure = true
                } else asr?.sendAudio(if (player.isPlaying) ByteArray(pcm.size) else pcm)
                level = if (pausedTail) 0f else maxOf((Pcm.rms(pcm) * 5).toFloat().coerceAtMost(1f), level * 0.7f)
            }
        }

        override fun onMark(mark: AudioSource.Mark) {
            synchronized(pipeline) {
                if (source === owner && mark == AudioSource.Mark.DOUBLE_TAP) triggerRecall("double_tap", null)
            }
        }

        override fun onGap(missingMs: Long) {
            synchronized(pipeline) {
                if (source !== owner) return
                ring.appendSilence(Pcm.msToSamples(missingMs))
                recorder?.silence(Pcm.msToSamples(missingMs))
                resetSpeakerPreview()
                // ASR times are relative to the audio it received, so a gap needs a fresh connection.
                if (asrDownSinceMs == null) asrDownSinceMs = nowMs - missingMs
                asr?.cancel()
                asr = null
                openAsrLocked()
            }
        }

        override fun onStatus(detail: String?) {
            synchronized(pipeline) {
                if (source !== owner) return
                if (detail != _state.value.sourceDetail) Log.i(TAG, "source: ${detail ?: "-"}")
                _state.update { it.copy(sourceDetail = detail) }
            }
        }

        override fun onReady(ready: Boolean) {
            synchronized(pipeline) {
                if (source !== owner) return
                _state.update { it.copy(sourceReady = ready) }
                if (ready && owner.kind == "bean" && asr == null && _state.value.asr == "off") openAsrLocked()
                if (!ready) _state.update { it.copy(liveSpeakers = emptyList(), liveOverlap = false, liveSpeakerStatus = "waiting") }
            }
        }

        override fun onSilenced(silenced: Boolean) {
            synchronized(pipeline) {
                if (source === owner && _state.value.micBusy != silenced) _state.update { it.copy(micBusy = silenced) }
            }
        }

        override fun onError(error: Throwable) {
            synchronized(pipeline) {
                if (source !== owner) return
                Log.e(TAG, "audio source failed", error)
                fail("capture", "收音中断：${error.message}")
                CaptureService.stop(app)
            }
        }
    }

    private fun tick() {
        val now = nowMs
        val removed = transcript.prune(now)
        if (!recordingPolicy.archives) {
            val removedIds = sessionIndex.prune(now, RETENTION_MS).toSet()
            ownerHints.keys.removeAll(removedIds); hintEpochs.keys.removeAll(removedIds); suggestionEpochs.keys.removeAll(removedIds)
            topicEvidence.values.forEach { it.removeAll(removedIds) }
            cards.entries.removeAll { (_, card) -> card.pool().any { it.endMs < now - RETENTION_MS } }
            drafts.entries.removeAll { (id, draft) -> !submitted.containsKey(id) && draft.evidence.utteranceIds.any { sessionIndex.get(it) == null } }
            val noticesChanged = tracker.prune(now - RETENTION_MS, sessionIndex.snapshot().map { it.id }.toSet())
            if (noticesChanged) updateAssistanceState()
            if (removedIds.isNotEmpty() || noticesChanged) publishSessionSummary(sessionId)
        }
        if (removed.isNotEmpty()) {
            emit(OopsEvent.Pruned(removed.map { it.id }))
            Log.i(TAG, "pruned ${removed.size} utterance(s); retained=${transcript.snapshot().size}")
            val cutoff = now - RETENTION_MS
            cards.entries.removeAll { (_, card) -> card.items.all { it.endMs < cutoff && sessionIndex.get(it.utteranceId) == null } }
            drafts.entries.removeAll { (id, draft) -> !submitted.containsKey(id) && draft.evidence.clipEndMs < cutoff &&
                draft.evidence.utteranceIds.all { sessionIndex.get(it) == null } }
        }
        level *= 0.85f
        _state.update {
            it.copy(
                sessionMs = now,
                bufferedMs = Pcm.samplesToMs(ring.endSample - ring.startSample),
                level = level,
                playing = player.isPlaying,
            )
        }
        requestSpeakerPreview()
        noticeTick(now)
    }

    private fun resetSpeakerPreview() = synchronized(pipeline) {
        previewEpoch++
        previewAudioStartMs = nowMs
        previewRequestedMs = nowMs
        previewResultMs = 0
        _state.update { it.copy(liveSpeakerStatus = null, liveSpeakers = emptyList(), liveOverlap = false) }
    }

    /** One rolling display request at a time; ASR and the audio thread never wait for it. */
    private fun requestSpeakerPreview() {
        val client = previewApi
        if (!settings.speakerPreview || client is MockOopsApi) return
        val request = synchronized(pipeline) {
            val end = nowMs
            if (source == null || !_state.value.sourceReady || player.isPlaying) return
            if (previewResultMs > 0 && end - previewResultMs > 5000) {
                _state.update { it.copy(liveSpeakerStatus = "waiting", liveSpeakers = emptyList(), liveOverlap = false) }
            }
            if (end - previewAudioStartMs < 3000 || end - previewRequestedMs < 2000 || !previewBusy.compareAndSet(false, true)) return
            previewRequestedMs = end
            Triple(sessionId, previewEpoch, maxOf(previewAudioStartMs, end - 10000) to end)
        }
        val policy = optionalRequests
        scope.launch(Dispatchers.IO) {
            try {
                val (session, epoch, bounds) = request
                val result = policy.request("speaker-preview") {
                    val pcm = synchronized(pipeline) {
                        if (session != sessionId || epoch != previewEpoch) null else
                            ring.read(Pcm.msToSamples(bounds.first), Pcm.msToSamples(bounds.second))
                    } ?: throw SpeakerAudioUnavailable()
                    client.previewSpeakers(SpeakerRequest(session, "live", pcm, clipStartMs = bounds.first))
                }
                synchronized(pipeline) {
                    if (session != sessionId || epoch != previewEpoch || !settings.speakerPreview || !_state.value.sourceReady) return@synchronized
                    if (result == null) {
                        _state.update { it.copy(liveSpeakerStatus = "unsupported", liveSpeakers = emptyList(), liveOverlap = false) }
                    } else {
                        require(result.validFor(bounds.first, bounds.second, Settings.TEAM.toSet())) { "试验预览时间或身份无效" }
                        if (nowMs - bounds.second > 5000) return@synchronized
                        val recent = result.activities.filter { it.endMs > bounds.second - 1500 }
                        val overlap = recent.any { it.kind == "overlap" }
                        val names = if (overlap) emptyList() else recent.mapNotNull { it.speaker }.distinct()
                        previewResultMs = bounds.second
                        _state.update { it.copy(liveSpeakerStatus = if (recent.any { a -> a.kind != "silence" }) "live" else "silence",
                            liveSpeakers = names, liveOverlap = overlap) }
                        Log.i(TAG, "speaker preview: overlap=$overlap names=${names.joinToString()} window=${bounds.first}-${bounds.second}")
                    }
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                synchronized(pipeline) {
                    if (request.first == sessionId && request.second == previewEpoch) {
                        _state.update { it.copy(liveSpeakerStatus = "error", liveSpeakers = emptyList(), liveOverlap = false) }
                    }
                }
                Log.w(TAG, "speaker preview failed: ${error.javaClass.simpleName}")
            } finally { previewBusy.set(false) }
        }
    }

    // ---- streaming ASR ---------------------------------------------------------------------

    private fun openAsrLocked() {
        if (source?.kind == "bean" && !_state.value.sourceReady) return
        pausedAsrClosure = null
        val credentials = settings.volc
        if (!credentials.isConfigured) {
            _state.update { it.copy(asr = "unconfigured", asrDetail = "android/local.properties 里还没配置火山 ASR 密钥") }
            return
        }
        val generation = ++asrGeneration
        val session = sessionId
        val baseMs = nowMs
        asrDownSinceMs?.let { down ->
            if (baseMs - down >= 300) _state.update { it.copy(asrGaps = (it.asrGaps + AsrGap(down, baseMs)).takeLast(10)) }
            asrDownSinceMs = null
        }
        val client = VolcAsrClient(
            asrHttp,
            credentials,
            VolcRequest.json(uid = session, speakerInfo = settings.speakerInfo, hotwords = Settings.HOTWORDS),
            object : VolcAsrClient.Listener {
                override fun onOpen() = onAsrOpen(generation)

                override fun onPartial(text: String, startMs: Long, endMs: Long) {
                    if (session == sessionId) emit(OopsEvent.Partial(text, baseMs + startMs, baseMs + endMs))
                }

                override fun onFinal(utterance: RawUtterance) = onAsrFinal(session, baseMs, utterance)

                override fun onRaw(payload: String) {
                    recorder?.takeIf { it.sessionId == session }?.let { r -> runCatching { r.asr(generation, baseMs, payload) } }
                }

                override fun onClosed(error: String?, fatal: Boolean) = onAsrClosed(generation, error, fatal)
            },
        )
        asr = client
        _state.update { it.copy(asr = if (reconnectAttempt > 0) "reconnecting" else "connecting") }
        client.connect()
    }

    private fun onAsrOpen(generation: Int) {
        synchronized(pipeline) {
            if (generation != asrGeneration) return
            reconnectAttempt = 0
        }
        _state.update {
            if (captureStopping && source == null) it.copy(asr = "finishing", asrDetail = "正在等待最后转写与结束确认")
            else it.copy(asr = "live", asrDetail = null)
        }
        Log.i(TAG, "ASR connected")
    }

    private fun onAsrFinal(session: String, baseMs: Long, raw: RawUtterance) {
        val u = synchronized(pipeline) {
            if (session != sessionId || _state.value.transcriptExpired) return
            val shifted = raw.shift(baseMs)
            if (!recordingPolicy.archives && (source == null || shifted.endMs < nowMs - RETENTION_MS)) return
            transcript.add(shifted.startMs, shifted.endMs, shifted.text, null, shifted.words)
                .let { added -> if (api is MockOopsApi) added else
                    transcript.setSpeaker(added.id, added.speaker, speakerState = "pending")!! }
                .also { sessionIndex.add(session, it) }
        }
        Log.i(TAG, "final ${u.id} [${u.startMs}-${u.endMs}]")
        timing(session, u.id, "final", "final_lag_ms" to synchronized(pipeline) { nowMs - u.endMs },
            "audio_ms" to (u.endMs - u.startMs), "filler" to com.oops.app.core.TextClean.isFiller(u.text))
        recorder?.takeIf { it.sessionId == session }?.let { r -> runCatching { r.final(u) } }
        emit(OopsEvent.Final(u))
        syncUtterance(session, u)
        if (settings.voiceTrigger) OopsCommand.parseVoice(u.text)?.let { command ->
            synchronized(pipeline) {
                val now = SystemClock.elapsedRealtime()
                if (now - lastVoiceAt >= 5_000) {
                    lastVoiceAt = now
                    if (command.ask && command.query != null) askSession(command.query.take(500), "voice")
                    else triggerRecall("voice", command.query)
                }
            }
        }
        // An interjection on its own ('嗯', '呃') is hidden in the transcript and not worth a tag or voiceprint request.
        if (!com.oops.app.core.TextClean.isFiller(u.text)) {
            tagUtterance(session, u)
            identifySpeaker(session, u)
        }
    }

    private fun tagUtterance(session: String, u: Utterance) {
        val client = api
        val service = serviceEpoch
        val policy = optionalRequests
        val reservation = policy.tryReserve("tag") ?: run {
            synchronized(pipeline) {
                if (session == sessionId) _state.update { it.copy(analysisFailed = it.analysisFailed + 1) }
            }
            return
        }
        val context = sessionIndex.preceding(u.id, 4)
        if (!sessionIndex.beginAnalysis(session, u.id)) { reservation.close(); return }
        publishSessionSummary(session)
        val queuedAt = SystemClock.elapsedRealtime()
        scope.launch(Dispatchers.IO) {
            try {
                val request = com.oops.app.backend.TagRequest(session, u.toCandidate(), context.map { it.toCandidate() })
                var httpStart = 0L
                val result = policy.request(reservation) { httpStart = SystemClock.elapsedRealtime(); client.tagUtterance(request) }
                val done = SystemClock.elapsedRealtime()
                timing(session, u.id, "tag", "queue_ms" to (httpStart - queuedAt), "http_ms" to (done - httpStart),
                    "since_final_ms" to (done - queuedAt), "tag" to result?.tag)
                synchronized(pipeline) {
                    if (!currentSource(session, service)) return@synchronized
                    if (result == null) {
                        _state.update { it.copy(tagsSupported = false) }
                    } else {
                        require(result.utteranceId == u.id) { "分析结果句子编号不匹配" }
                        val updated = sessionIndex.setTag(session, u.id, result.tag, result.prob, result.engine)
                        transcript.setTag(u.id, result.tag, result.prob, result.engine)
                        _state.update { it.copy(tagsSupported = true) }
                        if (updated != null) {
                            if (!recordingPolicy.archives) dailyCandidateStore.upsert(session, updated)
                            if (!_state.value.audioExpired && result.tag in com.oops.app.buffer.SessionIndex.RETAINED_TAGS) {
                                val slice = ring.readAvailable(Pcm.msToSamples((u.startMs - CLIP_PAD_MS).coerceAtLeast(0)),
                                    Pcm.msToSamples(u.endMs + CLIP_PAD_MS))
                                if (slice != null && slice.first <= Pcm.msToSamples(u.startMs) &&
                                    slice.first + slice.second.size / 2 >= Pcm.msToSamples(u.endMs)) {
                                    sessionIndex.retainAudio(session, u.id, Pcm.samplesToMs(slice.first), slice.second)
                                }
                            }
                            emit(OopsEvent.UtteranceTagged(updated))
                            syncUtterance(session, updated)
                            checkConflict(session, updated)
                            refreshOwnerHint(session, updated)
                        }
                    }
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                Log.w(TAG, "tag failed for ${u.id}: ${error.javaClass.simpleName}")
                synchronized(pipeline) {
                    if (currentSource(session, service)) _state.update { it.copy(analysisFailed = it.analysisFailed + 1) }
                }
            } finally {
                if (currentSource(session, service)) { sessionIndex.finishAnalysis(session, u.id); publishSessionSummary(session) }
            }
        }.invokeOnCompletion { reservation.close() }
    }

    fun sessionSummary(): OopsEvent.SessionSummary {
        val summary = sessionIndex.summary()
        val hints = summary.commitments.associate { u ->
            val task = submitted.values.filter { it.request.sessionId == summary.sessionId && u.id in it.request.draft.evidence.utteranceIds }
                .maxByOrNull { if (it.result.status == "created") 2 else if (it.result.status == "pending") 1 else 0 }
            val model = ownerHints[u.id]
            u.id to JSONObject().put("ownerHint", task?.request?.draft?.who ?: model?.let { com.oops.app.backend.DraftPolicy.prefilledOwner(it) } ?: JSONObject.NULL)
                .put("suggestedOwner", model?.suggestedOwner ?: model?.who ?: com.oops.app.backend.CommitmentRules.evidence(u.text, Settings.TEAM).owner ?: JSONObject.NULL)
                .put("ownerConfidence", model?.ownerConfidence ?: JSONObject.NULL).put("tier", model?.tier ?: "C")
                .put("reason", model?.reason ?: "负责人尚待核对")
                .put("ownerCandidates", com.oops.app.backend.ApiJson.speakerCandidates(model?.ownerCandidates.orEmpty()))
                .put("reviewStatus", if (task != null) "confirmed" else "unreviewed")
                .put("whenRaw", com.oops.app.backend.CommitmentRules.deadline(u.text) ?: JSONObject.NULL)
                .put("taskStatus", task?.result?.status ?: JSONObject.NULL).put("taskUrl", task?.result?.taskUrl ?: JSONObject.NULL)
        }
        return OopsEvent.SessionSummary(summary.sessionId, summary.commitments, summary.audioIds, summary.grouped, hints, tracker.list().map { it.bridge() })
    }

    private fun publishSessionSummary(session: String) {
        synchronized(pipeline) {
            if (session != sessionId) return
            _state.update { it.copy(digestCounts = sessionIndex.summary().grouped.mapValues { group -> group.value.size }, commitmentCount = sessionIndex.discoveredCommitments,
                analysisPending = sessionIndex.pendingCount(), sessionTruncated = sessionIndex.truncated) }
        }
        // Copy/serialize the commitment list outside the audio pipeline lock.
        val summary = sessionSummary()
        if (summary.sessionId == session) emit(summary)
    }

    /** Asks the backend whose voice this sentence is; the caption gains a name when it answers. */
    private fun identifySpeaker(session: String, u: Utterance) {
        val client = api
        val epoch = serviceEpoch
        val policy = optionalRequests
        if (client is MockOopsApi) return
        if (u.endMs - u.startMs < SPEAKER_MIN_MS) {
            publishSpeakerMatch(session, u, null, "too_short")
            return
        }
        val reservation = policy.tryReserve("speaker") ?: run {
            publishSpeakerMatch(session, u, null, "busy")
            return
        }
        val queuedAt = SystemClock.elapsedRealtime()
        var httpStart = 0L
        var httpDone = 0L
        scope.launch(Dispatchers.IO) {
            runCatching { policy.request(reservation) {
                // A queued job retains only text/id; PCM is copied only with an execution permit.
                val pcm = synchronized(pipeline) {
                    if (!currentSource(session, epoch)) null else ring.readWithEndTolerance(Pcm.msToSamples(u.startMs),
                        Pcm.msToSamples(u.endMs), Pcm.msToSamples(Pcm.FRAME_MS.toLong()))
                }
                    ?: throw SpeakerAudioUnavailable()
                val request = SpeakerRequest(session, u.id, pcm, u.text, u.startMs, u.words,
                    sessionIndex.preceding(u.id, 4).map { it.toCandidate() }, settings.speakerPreview, u.endMs)
                httpStart = SystemClock.elapsedRealtime()
                val result = client.identifySpeaker(request)
                httpDone = SystemClock.elapsedRealtime()
                if (settings.speakerPreview && result != null && result.preview == null) {
                    val preview = runCatching { previewApi.previewSpeakers(request) }.getOrNull()
                    result.copy(preview = preview)
                } else result
            } }
                .onSuccess { result ->
                    if (!currentSource(session, epoch)) return@onSuccess
                    publishSpeakerMatch(session, u, result, when {
                        result == null -> "unsupported"
                        com.oops.app.backend.namedSpeaker(result.speaker) != null || result.usableSegments(u).any { it.speaker != null } -> "matched"
                        else -> "unconfirmed"
                    })
                    timing(session, u.id, "speaker", "queue_ms" to (httpStart - queuedAt), "http_ms" to (httpDone - httpStart),
                        "since_final_ms" to (SystemClock.elapsedRealtime() - queuedAt), "split_pending" to (result?.splitPending == true),
                        "server" to JSONObject(result?.timingMs.orEmpty()))
                    if (result?.splitPending == true) fetchSplit(session, u, queuedAt)
                }
                .onFailure { error ->
                    if (!currentSource(session, epoch)) return@onFailure
                    Log.w(TAG, "speaker id failed for ${u.id}: ${error.message}")
                    publishSpeakerMatch(session, u, null, if (error is SpeakerAudioUnavailable) "audio_unavailable" else "error")
                }
        }.invokeOnCompletion { reservation.close() }
    }

    /**
     * The server answered the whole sentence first and computes the in-sentence split in the background.
     * Poll for it (the server holds each request up to 8 s); it only ever adds suggestions to the line.
     */
    private fun fetchSplit(session: String, u: Utterance, finalAt: Long) {
        val client = api
        val epoch = serviceEpoch
        val policy = optionalRequests
        scope.launch(Dispatchers.IO) {
            try {
                for (poll in 1..SPLIT_POLLS) {
                    if (!currentSource(session, epoch)) return@launch
                    val fetch = policy.request("speaker-split") { client.speakerSplit(session, u.id) } ?: return@launch
                    if (!currentSource(session, epoch)) return@launch
                    if (fetch.status == "pending") continue
                    val trial = if (fetch.status == "done") fetch.usableTrial(u) else emptyList()
                    timing(session, u.id, "split", "status" to fetch.status, "polls" to poll, "parts" to trial.size,
                        "since_final_ms" to (SystemClock.elapsedRealtime() - finalAt), "server" to JSONObject(fetch.timingMs))
                    if (trial.isNotEmpty()) publishSplit(session, u, trial)
                    return@launch
                }
                timing(session, u.id, "split", "status" to "gave_up", "since_final_ms" to (SystemClock.elapsedRealtime() - finalAt))
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                Log.w(TAG, "speaker split unavailable for ${u.id}: ${error.javaClass.simpleName}")
            }
        }
    }

    /** Adds the late split to a line without touching its whole-sentence label; never synced, drafted or an owner. */
    private fun publishSplit(session: String, u: Utterance, trial: List<com.oops.app.buffer.SpeakerSegment>) {
        synchronized(pipeline) {
            if (session != sessionId) return
            val current = sessionIndex.get(u.id) ?: return
            if (current.segments.isNotEmpty()) return // validated segments always win over suggestions
            sessionIndex.setTrial(session, u.id, trial)
            transcript.setTrial(u.id, trial)?.let { line ->
                emit(OopsEvent.SpeakerIdentified(line.id, line.speaker, line.speakerScore, line.segments,
                    line.speakerState ?: "unconfirmed", line.speakerPreview, line.speakerCandidates, trial))
            }
        }
    }

    /** One JSON line per stage and sentence (logcat and the archived `timing.jsonl`): where the time goes after speech. */
    private fun timing(session: String, id: String, stage: String, vararg fields: Pair<String, Any?>) {
        val line = JSONObject().put("id", id).put("stage", stage).put("at", System.currentTimeMillis())
        fields.forEach { (key, value) -> line.put(key, value ?: JSONObject.NULL) }
        if (sessionModes[session] == "meeting") Log.i(TAG, "timing $line")
        recorder?.takeIf { it.sessionId == session }?.let { r -> runCatching { r.timing(line) } }
    }

    private class SpeakerAudioUnavailable : IllegalStateException("声纹音频已过期或尚未完整到达")

    private fun publishSpeakerMatch(session: String, u: Utterance, result: com.oops.app.backend.SpeakerResult?, status: String) {
        synchronized(pipeline) {
            if (session != sessionId) return
            val name = com.oops.app.backend.namedSpeaker(result?.speaker)
            val segments = result?.usableSegments(u).orEmpty()
            val score = result?.score?.takeIf { it.isFinite() }
            val preview = if (settings.speakerPreview) result?.preview?.forUtterance(u, Settings.TEAM.toSet()) else null
            val hints = if (name != null) emptyList() else result?.candidates.orEmpty()
                .filter { com.oops.app.backend.namedSpeaker(it.name) != null && it.score.isFinite() }.take(2)
            val trial = if (segments.isEmpty()) result?.usableTrial(u).orEmpty() else emptyList()
            val previous = sessionIndex.get(u.id)
            if (previous != null && (previous.speaker != name || previous.segments != segments)) invalidateTaskBoard("speaker_changed", setOf(u.id))
            sessionIndex.setSpeaker(session, u.id, name, segments, status, score, preview, hints, trial)?.let {
                syncUtterance(session, it)
                refreshOwnerHint(session, it)
            }
            transcript.setSpeaker(u.id, name, segments, status, score, preview, hints, trial)?.let {
                Log.i(TAG, "speaker ${u.id}: $status name=$name score=$score hint=${hints.joinToString { "${it.name}:${it.score}" }}" +
                    " trial=${trial.joinToString("|") { "${if (it.overlap) "多人" else it.speaker ?: "?"}:${it.text.length}" }}")
                emit(OopsEvent.SpeakerIdentified(u.id, name, score, segments, status, preview, hints, trial))
            }
        }
        publishSessionSummary(session)
        refreshDraftSuggestions(session, u.id)
    }

    private fun refreshOwnerHint(session: String, utterance: Utterance) {
        if (utterance.tag != "commitment") return
        val epoch = hintEpochs.merge(utterance.id, 1L, Long::plus)!!
        val (client, requestContext) = synchronized(pipeline) { api to currentTaskBoardContext() }
        val policy = optionalRequests
        val reservation = policy.tryReserve("owner-hint") ?: return
        scope.launch {
            try {
                val hintStart = SystemClock.elapsedRealtime()
                val result = policy.request(reservation) { client.draftAction(DraftRequest(session,
                    listOf(utterance.toTaskCandidate()), sessionIndex.preceding(utterance.id, 4).map { it.toTaskCandidate() }, board = sessionModes[session] == "meeting")) }
                timing(session, utterance.id, "draft", "http_ms" to (SystemClock.elapsedRealtime() - hintStart))
                synchronized(pipeline) {
                    if (!currentSource(session, requestContext.serviceEpoch) || requestContext.sourceRevision != boardSourceRevision ||
                        session != sessionId || hintEpochs[utterance.id] != epoch || sessionIndex.get(utterance.id) == null) return@synchronized
                    if (result != null) {
                        ownerHints[utterance.id] = result
                        publishSessionSummary(session)
                        result.board?.let { updateTaskBoard(requestContext, it) }
                    }
                }
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) { Log.w(TAG, "owner hint unavailable: ${error.javaClass.simpleName}") }
        }.invokeOnCompletion { reservation.close() }
    }

    /** The draft answer carries the list before this sentence; the server folds it in meanwhile, so read it again shortly. */
    private fun currentTaskBoardContext() = TaskBoardPolicy.Context(sessionId, serviceEpoch, _state.value.backendUrl,
        boardSourceRevision, recordingPolicy.mode, _state.value.transcriptExpired)

    private fun Utterance.toTaskCandidate() = copy(speaker = manualSpeaker ?: speaker).toCandidate()

    /** Daily confirmation may retain only a bounded set of complete necessary sentences. */
    private fun boundedTaskContext(chosen: List<Utterance>, context: List<Utterance>): List<Utterance> {
        if (recordingPolicy.archives) return context
        var chars = chosen.joinToString(" ") { it.text }.length
        if (chars > 280 || chosen.isEmpty()) return emptyList()
        val selected = mutableListOf<Utterance>()
        val first = chosen.minOf { it.startMs }; val last = chosen.maxOf { it.endMs }
        for (row in context.sortedBy { minOf(kotlin.math.abs(it.endMs - first), kotlin.math.abs(it.startMs - last)) }) {
            val added = row.text.length + 1
            if (chosen.size + selected.size < 20 && chars + added <= 280) { selected.add(row); chars += added }
        }
        return selected.sortedBy { it.startMs }
    }

    private fun filteredTaskBoard(board: JSONObject, context: TaskBoardPolicy.Context): JSONObject? {
        val rows = sessionIndex.snapshot()
        return TaskBoardPolicy.filter(board, context, rows.associate { it.id to it.text }, boardBlockedSources,
            rows.associate { it.id to (it.manualSpeaker ?: it.speaker) }, boardLocalReviews)
    }

    private fun rememberTaskReview(id: String, result: JSONObject) {
        val review = result.optJSONObject("review") ?: return
        boardLocalReviews[id] = review.keys().asSequence().filter { it in setOf("speaker", "owner", "verdict") && !review.isNull(it) }
            .associateWith { review.getString(it) }
    }

    private fun taskSourceTicket(ids: Collection<String>) = taskSourceVersions.ticket(ids)
    private fun taskSourcesCurrent(ticket: TaskSourceVersions.Ticket) = taskSourceVersions.current(ticket)

    /** Call under pipeline. A new final/ordinary live-caption prune never calls this. */
    private fun invalidateTaskBoard(reason: String, sourceIds: Set<String>? = null) {
        val previous = taskBoard
        taskSourceVersions.invalidate(sourceIds)
        boardSourceRevision++
        boardPoll?.cancel(); boardPoll = null
        taskBoard = null; taskBoardContext = null
        drafts.entries.forEach { (id, draft) ->
            val dependencies = TaskSourceBinding.allSources(draft.evidence.sourceBinding, sessionId, draft.evidence.utteranceIds)
            if (!submitted.containsKey(id) && (sourceIds == null || draft.evidence.utteranceIds.any { it in sourceIds } ||
                    dependencies?.any { it.id in sourceIds } == true)) {
                drafts[id] = draft.copy(evidence = draft.evidence.copy(sourceBinding = null), sourceReceipt = null)
                suggestionEpochs.remove(id)
            }
        }
        _state.update { it.copy(boardSourceRevision = boardSourceRevision) }
        val context = currentTaskBoardContext()
        if (previous != null && sourceIds != null) {
            val remaining = TaskBoardPolicy.withoutSources(previous, sourceIds).put("invalidated", false).put("reason", reason)
                .put("invalidatedSourceIds", JSONArray(sourceIds.toList()))
            if (remaining.getJSONArray("tasks").length() > 0) {
                updateTaskBoard(context, remaining)
                return
            }
        }
        emit(OopsEvent.Json("tasks.board", serviceContext(context.serviceEpoch)
            .put("session_id", context.sessionId).put("sourceRevision", context.sourceRevision)
            .put("recording_mode", context.mode).put("tasks", JSONArray()).put("pending", false)
            .put("invalidated", true).put("reason", reason).put("invalidatedSourceIds", sourceIds?.let { JSONArray(it.toList()) } ?: JSONObject.NULL)))
    }

    private fun updateTaskBoard(request: TaskBoardPolicy.Context, board: JSONObject, poll: Boolean = true) {
        synchronized(pipeline) {
            if (!currentSessionService(request.sessionId, request.serviceEpoch) || !TaskBoardPolicy.accepts(request, currentTaskBoardContext())) return
            val accepted = filteredTaskBoard(board, request) ?: return
            if (taskBoard?.toString() != accepted.toString()) {
                taskBoard = accepted; taskBoardContext = request
                emit(OopsEvent.Json("tasks.board", JSONObject(accepted.toString())))
            }
            if (!poll || !accepted.optBoolean("pending") || boardPoll?.isActive == true) return
            val client = api
            boardPoll = scope.launch {
                repeat(BOARD_POLLS) {
                    delay(BOARD_POLL_MS)
                    if (!synchronized(pipeline) { TaskBoardPolicy.accepts(request, currentTaskBoardContext()) }) return@launch
                    val fresh = try { client.meetingBoard(request.sessionId) } catch (error: CancellationException) { throw error }
                        catch (_: Exception) { null } ?: return@repeat
                    if (!synchronized(pipeline) { TaskBoardPolicy.accepts(request, currentTaskBoardContext()) }) return@launch
                    updateTaskBoard(request, fresh, poll = false)
                    if (!fresh.optBoolean("pending")) return@launch
                }
            }
        }
    }

    private fun refreshTaskBoard() {
        val (client, request) = synchronized(pipeline) {
            val context = currentTaskBoardContext().takeIf { it.mode == "meeting" && it.sessionId.isNotBlank() } ?: return
            api to context
        }
        scope.launch {
            val result = try { client.meetingBoard(request.sessionId) } catch (error: CancellationException) { throw error }
                catch (_: Exception) { null } ?: return@launch
            updateTaskBoard(request, result)
        }
    }

    fun taskBoardSnapshot(): JSONObject? = synchronized(pipeline) {
        val request = taskBoardContext ?: return@synchronized null
        if (!currentSessionService(request.sessionId, request.serviceEpoch) || !TaskBoardPolicy.accepts(request, currentTaskBoardContext())) return@synchronized null
        taskBoard?.let { filteredTaskBoard(it, request) }
    }

    private fun refreshDraftSuggestions(session: String, utteranceId: String) {
        drafts.values.filter { utteranceId in it.evidence.utteranceIds && !submitted.containsKey(it.draftId) }.forEach { draft ->
            val revision = suggestionEpochs.merge(draft.draftId, draft.modelRevision + 1) { a, b -> maxOf(a + 1, b) }!!
            val client = api
            val service = serviceEpoch
            val policy = optionalRequests
            val reservation = policy.tryReserve("draft-suggestion") ?: return@forEach
            scope.launch {
                try {
                    val chosen = draft.evidence.utteranceIds.mapNotNull(sessionIndex::get)
                    if (chosen.size != draft.evidence.utteranceIds.size) return@launch
                    if (!recordingPolicy.archives && chosen.joinToString(" ") { it.text }.length > 280) return@launch
                    val context = boundedTaskContext(chosen, sessionIndex.neighbors(draft.evidence.utteranceIds, 4, 1)
                        .filter { it.id !in draft.evidence.utteranceIds })
                    val sourceTicket = taskSourceTicket((chosen + context).map { it.id })
                    val result = policy.request(reservation) { client.draftAction(DraftRequest(session,
                        chosen.map { it.toTaskCandidate() }, context.map { it.toTaskCandidate() })) }
                    synchronized(pipeline) {
                        if (!currentSource(session, service) || !taskSourcesCurrent(sourceTicket) || result == null || submitted.containsKey(draft.draftId) ||
                            suggestionEpochs[draft.draftId] != revision || "confirm:${draft.draftId}" in inFlight) return@synchronized
                        drafts.computeIfPresent(draft.draftId) { _, current ->
                            val updated = com.oops.app.backend.DraftPolicy.updateModel(current, result, revision)
                            val bound = TaskSourceBinding.sources(result.sourceBinding, session, current.evidence.utteranceIds)
                            updated.copy(evidence = updated.evidence.copy(sourceBinding = if (bound != null) result.sourceBinding else null,
                                quote = bound?.joinToString(" ") { it.quote } ?: updated.evidence.quote), sourceError = result.sourceError).also {
                                emit(OopsEvent.Json("action.suggestion", com.oops.app.bridge.BridgeJson.draft(it)))
                            }
                        }
                    }
                } catch (error: CancellationException) { throw error }
                catch (error: Exception) { Log.w(TAG, "draft suggestion unavailable: ${error.javaClass.simpleName}") }
            }.invokeOnCompletion { reservation.close() }
        }
    }

    /** The backoff (up to 15 s) is for a dead network; once a network is back, reconnect at once. */
    private fun watchNetwork() {
        val manager = app.getSystemService(android.net.ConnectivityManager::class.java) ?: return
        runCatching {
            manager.registerDefaultNetworkCallback(object : android.net.ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: android.net.Network) = reconnectAsrNow()
            })
        }.onFailure { Log.w(TAG, "network watch unavailable: ${it.javaClass.simpleName}") }
    }

    private fun reconnectAsrNow() {
        synchronized(pipeline) {
            // A live or connecting client exists while `asr` is set; it is null only during the backoff wait.
            if (source == null || asr != null || _state.value.asr == "error" || source?.kind == "bean" && !_state.value.sourceReady) return
            reconnectJob?.cancel()
            reconnectAttempt = 0
            Log.i(TAG, "network available, reconnecting ASR now")
            openAsrLocked()
        }
    }

    private fun onAsrClosed(generation: Int, error: String?, fatal: Boolean) {
        synchronized(pipeline) {
            if (generation != asrGeneration) return
            val closedClient = asr
            asr = null
            if (source == null) {
                _state.update { it.copy(asr = if (error == null) "off" else "error", asrDetail = error) }
                return
            }
            if (_state.value.captureControl in listOf("paused", "stopped")) {
                pausedAsrClosure = closedClient?.closure
                if (pausedAsrClosure?.acknowledged != true) pauseAsrHadFailure = true
                _state.update { it.copy(asr = "off", asrDetail = error) }
                if (error != null) fail("capture.control", "暂停前的转写结束未确认，已收到的原话仍保留：$error")
                return
            }
            if (asrDownSinceMs == null) asrDownSinceMs = nowMs
            if (fatal) {
                _state.update { it.copy(asr = "error", asrDetail = error) }
                fail("asr", "语音识别连接失败：$error")
                return
            }
            reconnectAttempt++
            val wait = minOf(1_000L shl minOf(reconnectAttempt - 1, 4), 15_000L)
            _state.update { it.copy(asr = "reconnecting", asrDetail = error ?: "连接已断开") }
            reconnectJob = scope.launch {
                delay(wait)
                synchronized(pipeline) {
                    if (source != null && asr == null && generation == asrGeneration) openAsrLocked()
                }
            }
        }
        Log.w(TAG, "ASR closed (fatal=$fatal): $error")
    }

    /** Applies new ASR options mid-session; the old connection still flushes its last sentence. */
    private fun restartAsrLocked() {
        if (source == null) return
        asr?.finish()
        asr = null
        openAsrLocked()
    }

    // ---- recall ----------------------------------------------------------------------------

    fun triggerRecall(trigger: String, query: String?) {
        if (!inFlight.add("recall")) {
            emit(OopsEvent.Toast("正在召回，请稍等"))
            return
        }
        val startedAt = SystemClock.elapsedRealtime()
        val session = sessionId; val epoch = serviceEpoch
        emit(OopsEvent.RecallPending(trigger))
        Log.i(TAG, "recall triggered by $trigger")
        scope.launch {
            try {
                recall(trigger, query, startedAt)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "recall failed", e)
                if (currentSource(session, epoch)) fail("recall", "召回失败：${e.message ?: e.javaClass.simpleName}")
            } finally {
                inFlight.remove("recall")
            }
        }
    }

    private suspend fun recall(trigger: String, query: String?, startedAt: Long) {
        val session = sessionId
        val epoch = serviceEpoch
        val client = api
        val now = nowMs
        val all = transcript.snapshot()
        // The recall command itself ("Oops，把刚刚那个想法留下来") is never evidence.
        val commands = all.filter { OopsCommand.matches(it.text) }.map { it.id }.toSet()
        var windowMs = 0L
        var candidates = emptyList<Utterance>()
        var response: RecallResponse? = null
        for (w in CandidateWindow.DEFAULT_WINDOWS_MS) {
            val inWindow = CandidateWindow.within(all, now, w, exclude = commands)
            if (inWindow.isEmpty() || inWindow.size == candidates.size) continue // nothing new to ask about
            windowMs = w
            candidates = inWindow
            val received = client.recall(RecallRequest(session, trigger, query, now, inWindow.map { it.toCandidate() }))
            if (!currentSource(session, epoch)) return
            val byId = inWindow.associateBy { it.id }
            response = received.copy(picks = PickPolicy.validated(received.picks, byId.keys) { id ->
                val u = byId.getValue(id)
                u.endMs > u.startMs && ring.contains(Pcm.msToSamples(u.startMs), Pcm.msToSamples(u.endMs))
            })
            if (PickPolicy.isConfident(response.picks)) break
        }
        if (response == null) {
            val reason = if (all.isEmpty()) "还没有转写内容，先说几句话试试" else "最近 5 分钟内没有可召回的内容"
            emit(OopsEvent.RecallNotFound(reason))
            return
        }
        // 后端只返回编号：编号必须存在、时间有效、原声仍在缓存里。
        val byId = candidates.associateBy { it.id }
        val valid = response.picks.filter { pick ->
            val u = byId[pick.id]
            u != null && u.endMs > u.startMs &&
                ring.contains(Pcm.msToSamples(u.startMs), Pcm.msToSamples(u.endMs))
        }
        val decision = PickPolicy.decide(valid)
        if (decision == null) {
            emit(OopsEvent.RecallNotFound("没有找到对得上的原话"))
            return
        }
        val items = decision.picks.map { pick ->
            val u = byId.getValue(pick.id)
            CardItem(u.id, u.startMs, u.endMs, u.text, u.speaker, pick.prob)
        }
        val card = RecallCard(
            id = "c" + UUID.randomUUID().toString().take(8),
            trigger = trigger,
            query = query,
            nowMs = now,
            items = items,
            single = decision.single,
            context = transcript.neighbors(items.map { it.utteranceId }, before = 2, after = 2),
            engine = response.engine,
            windowMs = windowMs,
            latencyMs = SystemClock.elapsedRealtime() - startedAt,
        )
        if (!currentSource(session, epoch) || (!recordingPolicy.archives && card.pool().any { sessionIndex.get(it.id) == null })) return
        cards[card.id] = card
        Log.i(TAG, "recall ${card.id} in ${card.latencyMs}ms via ${card.engine}")
        emit(OopsEvent.RecallReady(card))
        recordLatency(card.latencyMs)
    }

    private fun recordLatency(ms: Long) {
        val recent = synchronized(recallLatencies) {
            recallLatencies.addLast(ms)
            while (recallLatencies.size > 50) recallLatencies.removeFirst()
            recallLatencies.toList()
        }
        val sorted = recent.sorted()
        emit(OopsEvent.Latency(recent.takeLast(10), sorted[sorted.size / 2]))
    }

    /** Local audio first; with [session] given, a sentence no longer on the phone is fetched from the server's archive. */
    fun playClip(key: String, startMs: Long, endMs: Long, session: String? = null) {
        // Another meeting's timestamps would point into this meeting's audio: only this meeting may play locally.
        val slice = if (session == null || session == sessionId) evidenceAudio(startMs, endMs) else null
        when {
            slice != null -> player.play(key, slice)
            session != null -> playRemoteClip(key, session, startMs, endMs)
            else -> emit(OopsEvent.Clip(key, "expired"))
        }
    }

    private fun evidenceAudio(startMs: Long, endMs: Long): ByteArray? {
        if (ring.contains(Pcm.msToSamples(startMs), Pcm.msToSamples(endMs))) {
            return ring.readAvailable(Pcm.msToSamples((startMs - CLIP_PAD_MS).coerceAtLeast(0)),
                Pcm.msToSamples(endMs + CLIP_PAD_MS))?.second
        }
        return sessionIndex.audio(startMs, endMs)?.pcm
    }

    fun openCommitment(utteranceId: String) = openDigestItems(listOf(utteranceId))

    fun stopClip() = player.stop()

    private fun onClipState(key: String, state: String) {
        Log.i(TAG, "clip $key → $state")
        emit(OopsEvent.Clip(key, state))
        _state.update { it.copy(playing = player.isPlaying) }
    }

    /** 用户确认后才进入长期记忆：原句 + 原声写到 filesDir/saved。 */
    fun saveRecall(cardId: String, utteranceIds: List<String>, startMs: Long, endMs: Long) {
        val card = cards[cardId] ?: return fail("save", "这张卡片已失效")
        val session = sessionId; val epoch = serviceEpoch
        val chosen = synchronized(pipeline) {
            if (!currentSource(session, epoch)) emptyList() else card.pool().filter { it.id in utteranceIds }
                .mapNotNull { sessionIndex.get(it.id) }.takeIf { it.size == utteranceIds.distinct().size }.orEmpty()
        }
        if (chosen.isEmpty()) return fail("save", "所选原话已失效，请重新打开核对")
        val pcm = synchronized(pipeline) { if (currentSource(session, epoch)) evidenceAudio(startMs, endMs) else null }
        scope.launch(Dispatchers.IO) {
            if (!currentSource(session, epoch) || cards[cardId] !== card || chosen.any { sessionIndex.get(it.id)?.text != it.text }) {
                fail("save", "会话或原话已变化，请重新核对后保存")
                return@launch
            }
            val utterances = JSONArray(
                chosen.map {
                    com.oops.app.backend.ApiJson.candidate(it.toCandidate())
                },
            )
            val meta = JSONObject()
                .put("id", cardId)
                .put("saved_at", Instant.now().toString())
                .put("session_id", session)
                .put("trigger", card.trigger)
                .put("source", "语音转写")
                .put("clip_start_ms", startMs)
                .put("clip_end_ms", endMs)
                .put("utterances", utterances)
                .put("audio_expired", pcm == null)
            synchronized(pipeline) {
                if (!currentSource(session, epoch) || cards[cardId] !== card) return@launch
                store.save(cardId, meta, pcm)
            }
            val count = store.count()
            _state.update { it.copy(savedCount = count) }
            Log.i(TAG, "saved $cardId: ${chosen.size} utterance(s), audio=${pcm != null}")
            emit(OopsEvent.Saved(cardId, count))
        }
    }

    fun dismissRecall(cardId: String) {
        cards.remove(cardId)
    }

    fun dailyCandidates() {
        scope.launch(Dispatchers.IO) { emit(OopsEvent.Json("daily.candidates", JSONObject().put("items", JSONArray(dailyCandidateStore.list())))) }
    }

    fun discardDailyCandidate(session: String, id: String) {
        scope.launch(Dispatchers.IO) {
            if (dailyCandidateStore.find(session, id) != null) dailyCandidateStore.remove(session, id)
            dailyCandidates()
        }
    }

    /** User confirmation saves only this edited short excerpt, never the daily full transcript or audio. */
    fun confirmDailyCandidate(session: String, id: String, quote: String, confirmed: Boolean) {
        require(confirmed && quote.isNotBlank() && quote.length <= 280) { "请核对 1–280 字内容后明确确认" }
        scope.launch(Dispatchers.IO) {
            val candidates = dailyCandidateStore
            val candidate = candidates.find(session, id) ?: return@launch fail("save", "候选已失效，请重新打开核对")
            val savedId = "daily-$session-$id"
            val line = JSONObject().put("id", id).put("text", quote).put("start_ms", candidate.getLong("start_ms"))
                .put("end_ms", candidate.getLong("end_ms")).put("tag", candidate.getString("tag"))
            store.save(savedId, JSONObject().put("id", savedId).put("saved_at", Instant.now().toString()).put("session_id", session)
                .put("source", "本人核对的日常短摘录").put("visibility", "private").put("confirmed", true)
                .put("original_available", false).put("audio_expired", true).put("utterances", JSONArray().put(line)), null)
            candidates.remove(session, id)
            _state.update { it.copy(savedCount = store.count()) }
            emit(OopsEvent.Saved(savedId, store.count()))
        }
    }

    fun savedItems(): List<JSONObject> = store.list()

    fun transcriptSnapshot(): List<Utterance> = transcript.snapshot()

    // ---- action ----------------------------------------------------------------------------

    fun draftAction(cardId: String, utteranceIds: List<String>) {
        val card = cards[cardId] ?: return fail("action", "这张卡片已失效")
        if (!inFlight.add("draft:$cardId")) return
        val client = api
        val epoch = serviceEpoch
        val session = sessionId
        scope.launch {
            try {
                if (session != sessionId) return@launch
                val pool = card.pool().filter { recordingPolicy.archives || sessionIndex.get(it.id) != null }.map { sessionIndex.get(it.id) ?: it }
                val chosen = pool.filter { it.id in utteranceIds }
                if (chosen.isEmpty()) {
                    fail("action", "没有选中任何原话")
                    return@launch
                }
                if (!recordingPolicy.archives && chosen.joinToString(" ") { it.text }.length > 280) {
                    fail("action", "日常待办请重新选择不超过280字的必要短原话")
                    return@launch
                }
                val chosenIds = chosen.map { it.id }.toSet()
                val context = boundedTaskContext(chosen, (pool + sessionIndex.neighbors(chosenIds, before = 8, after = 1))
                    .distinctBy { it.id }
                    .filter { it.id !in chosenIds }
                    .sortedBy { it.startMs })
                val sourceTicket = taskSourceTicket((chosen + context).map { it.id })
                val response = client.draftAction(
                    DraftRequest(session, chosen.map { it.toTaskCandidate() }, context.map { it.toTaskCandidate() }),
                )
                if (!currentSessionService(session, epoch)) return@launch
                if (_state.value.transcriptExpired && card.engine != "saved_excerpt") {
                    fail("action", "完整原话已到期，请重新打开独立保留的短依据并起草")
                    return@launch
                }
                if (!taskSourcesCurrent(sourceTicket) || (!recordingPolicy.archives && chosen.any { sessionIndex.get(it.id) == null })) {
                    fail("action", "原话或其上下文已变化，请重新核对并起草")
                    return@launch
                }
                val binding = TaskSourceBinding.sources(response.sourceBinding, session, chosen.map { it.id })
                if (_state.value.transcriptExpired && !TaskSourceBinding.valid(response.sourceBinding, session,
                        chosen.map { it.id }, retainedOnly = true)) {
                    fail("action", "当前短依据尚未通过服务器核对，请重新读取；不会恢复到期全文")
                    return@launch
                }
                val draft = ActionDraft(
                    draftId = "d" + UUID.randomUUID().toString().take(8),
                    cardId = cardId,
                    who = com.oops.app.backend.DraftPolicy.prefilledOwner(response).orEmpty(),
                    what = response.what,
                    whenIso = response.whenIso,
                    whenRaw = response.whenRaw,
                    constraint = response.constraint,
                    assigneeCandidates = response.assigneeCandidates.ifEmpty { Settings.TEAM },
                    evidence = Evidence(
                        utteranceIds = chosen.map { it.id },
                        quote = binding?.joinToString(" ") { it.quote } ?: chosen.joinToString(" ") { it.text },
                        clipStartMs = chosen.first().startMs,
                        clipEndMs = chosen.last().endMs,
                        sourceBinding = if (binding != null) response.sourceBinding else null,
                    ),
                    suggestedOwner = response.suggestedOwner ?: response.who,
                    ownerSource = response.ownerSource, ownerConfidence = response.ownerConfidence,
                    tier = response.tier, reason = response.reason, ownerCandidates = response.ownerCandidates,
                    modelRevision = 1, context = response.context, sourceError = response.sourceError, sourceReceipt = response.sourceReceipt,
                )
                drafts[draft.draftId] = draft
                Log.i(TAG, "draft ${draft.draftId}: ready")
                emit(OopsEvent.DraftReady(draft))
                // A speaker answer may have arrived while this extraction request was in flight.
                chosen.filter { sessionIndex.get(it.id)?.segments != it.segments }.forEach { refreshDraftSuggestions(session, it.id) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (epoch == serviceEpoch) fail("action", "生成行动草稿失败：${e.message ?: e.javaClass.simpleName}")
            } finally {
                inFlight.remove("draft:$cardId")
            }
        }
    }

    /** Only a confirmed draft is written to Feishu. Retries reuse the draft's op_id. */
    fun recordOwnerFeedback(payload: JSONObject) {
        val draft = drafts[payload.optString("draftId")] ?: return
        if (submitted.containsKey(draft.draftId)) return
        val session = sessionId
        val selected = payload.optString("selectedOwner").ifBlank { null }
        val previous = payload.optString("previousOwner").ifBlank { null }
        val suggestion = payload.optString("modelSuggestion").ifBlank { null }
        val tier = payload.optString("modelTier", "C").takeIf { it in setOf("A", "B", "C") } ?: "C"
        val confidence = if (payload.isNull("modelConfidence")) null else payload.optDouble("modelConfidence")
            .takeIf { it.isFinite() && it in 0.0..1.0 }
        val revision = payload.optLong("modelRevision", draft.modelRevision)
        ownerFeedbackJobs.trySend { ownerFeedback.record(session, draft.draftId, draft.evidence.utteranceIds,
            previous, selected, suggestion, tier, confidence, revision); Unit }
    }

    fun confirmAction(
        draftId: String,
        who: String,
        what: String,
        whenIso: String?,
        whenRaw: String?,
        constraint: String?,
        ownerSelectionSource: String = "user",
    ) {
        val base = drafts[draftId] ?: return fail("action", "这份草稿已失效")
        if (who.isBlank() || what.isBlank()) return fail("action", "请先填写负责人和事项")
        submitted[draftId]?.result?.let { result ->
            if (result.status == ActionResult.FAILED && result.errorCode == "SOURCE_CHANGED")
                return fail("action", "原操作的来源已变化，请重新核对当前原话并起草")
        }
        val existing = submitted[draftId]
        if (existing?.result?.sourceInvalidated == true)
            return fail("action", "旧依据已撤回，请重新核对原话并生成新草稿；本次没有创建任务")
        if (ActionWorkflow.shouldSubmit(existing?.result) && !(existing?.mock ?: (api is MockOopsApi))) {
            val evidence = existing?.request?.draft?.evidence ?: base.evidence
            val session = existing?.request?.sessionId ?: sessionId
            if (!TaskSourceBinding.valid(evidence.sourceBinding, session, evidence.utteranceIds, evidence.quote))
                return fail("action", base.sourceError ?: "原话尚未由当前服务器核对，请重新打开来源并生成草稿；不会创建飞书任务")
        }
        if (!inFlight.add("confirm:$draftId")) return // 防连点
        val opId = opIds.getOrPut(draftId) { UUID.randomUUID().toString() }
        val confirmedDraft = com.oops.app.backend.DraftPolicy.confirm(base, who, what, whenIso, whenRaw, constraint, ownerSelectionSource)
        val draft = existing?.request?.draft ?: if (recordingPolicy.archives) confirmedDraft else confirmedDraft.copy(
            evidence = confirmedDraft.evidence.copy(quote = confirmedDraft.evidence.quote.take(280)), context = null)
        val operation = existing ?: ActionOperationStore.Operation(
            ConfirmRequest(opId, sessionId, draft), settings.backendBaseUrl, api.name == "mock",
            ActionResult(opId, ActionResult.PENDING, mock = api.name == "mock"),
        )
        // Persist before the network call. A retry uses this frozen request, even after a restart.
        try { operations.save(operation) } catch (e: Exception) {
            inFlight.remove("confirm:$draftId")
            return fail("action", "无法保存操作编号：${e.message}")
        }
        submitted[draftId] = operation
        drafts[draftId] = draft
        ownerFeedbackJobs.trySend { ownerFeedback.confirm(operation.request.sessionId, draftId, operation.request.draft.who) }
        runAction(operation, submit = ActionWorkflow.shouldSubmit(existing?.result))
    }

    fun queryAction(draftId: String) {
        val operation = submitted[draftId] ?: return fail("action", "没有已提交的操作")
        if (operation.result.sourceInvalidated) return fail("action", "已确认本次没有创建任务，请重新核对原话并起草")
        if (!inFlight.add("confirm:$draftId")) return
        runAction(operation, submit = false)
    }

    private fun runAction(operation: ActionOperationStore.Operation, submit: Boolean) {
        val request = operation.request
        val draftId = request.draft.draftId
        val client = if (operation.mock) api.takeIf { it.name == "mock" } ?: MockOopsApi(Settings.TEAM)
            else HttpOopsApi(http, operation.backendUrl, settings.backendTokenFor(operation.backendUrl))
        emit(OopsEvent.ActionUpdate(draftId,
            if (!submit && operation.result.sourceBlocked) ActionWorkflow.restoredPending(operation.result).copy(polling = true)
            else ActionResult(request.opId, ActionResult.PENDING, polling = true, mock = operation.mock,
                message = if (!submit) "正在查询原操作结果，不会重复提交" else null)))
        scope.launch {
            val result = try {
                if (operation.result.status == ActionResult.CREATED && operation.mock) operation.result
                else ActionWorkflow.execute(client, request, submit)
            } finally {
                inFlight.remove("confirm:$draftId")
            }
            val updated = operation.copy(result = result.copy(mock = operation.mock))
            submitted[draftId] = updated
            runCatching { operations.save(updated) }.onFailure { Log.w(TAG, "action journal update failed", it) }
            Log.i(TAG, "action $draftId → ${result.status} op_id=${request.opId} readback=${result.readBackConfirmed}")
            emit(OopsEvent.ActionUpdate(draftId, updated.result))
            publishSessionSummary(sessionId)
        }
    }

    fun pendingActions(): List<Pair<ActionDraft, ActionResult>> = submitted.values
        .filter { it.result.status == ActionResult.PENDING }
        .filter { com.oops.app.store.RecordingOrigin.from(it.backendUrl, it.mock) == currentOrigin() }
        .map { it.request.draft to ActionWorkflow.restoredPending(it.result) }

    fun selectTestWav(uri: String, name: String) {
        settings.testWavUri = uri
        settings.testWavName = name
        settings.source = Settings.SOURCE_WAV
        _state.update { it.copy(testWavName = name, source = if (it.capturing) it.source else Settings.SOURCE_WAV) }
        emit(OopsEvent.Toast("已选择测试音频，下次开始收音时生效"))
    }

    // ---- self-service voiceprint recording -------------------------------------------------

    fun loadVoiceprints() {
        require(_state.value.voiceprint.phase !in setOf("saving", "testing")) { "请等待当前请求结束" }
        cancelVoiceprintRecording()
        val client = api as? HttpOopsApi ?: run { voiceprintError("请先连接真实服务器，Mock 不支持录入声纹"); return }
        val id = UUID.randomUUID().toString()
        synchronized(pipeline) {
            voiceprintSampleId = id
            _state.update { it.copy(voiceprint = it.voiceprint.copy(phase = "loading", message = "")) }
        }
        scope.launch {
            runCatching { client.voiceprints() }.onSuccess { catalog ->
                synchronized(pipeline) {
                    if (voiceprintSampleId == id) _state.update { it.copy(voiceprint = VoiceprintState(catalog = catalog)) }
                }
            }.onFailure { synchronized(pipeline) { if (voiceprintSampleId == id) voiceprintError(it.message ?: "加载失败") } }
        }
    }

    fun beginVoiceprintRecording(name: String, consent: Boolean, mode: String) {
        synchronized(pipeline) {
            require(consent) { "请确认本人同意上传声音用于声纹匹配" }
            require(mode in setOf("enroll", "test")) { "录音模式无效" }
            require(mode == "test" || name in Settings.TEAM) { "请先选择本人姓名" }
            require(_state.value.voiceprint.phase !in setOf("saving", "testing", "checking", "loading", "recording")) { "请等待当前操作结束" }
            val kind = source?.kind ?: settings.source
            require(kind in setOf(Settings.SOURCE_MIC, Settings.SOURCE_REMOTE, Settings.SOURCE_BEAN)) { "请先切换到手机、Mac 麦克风或录音豆，不能用测试音频注册" }
            val client = api as? HttpOopsApi ?: error("请先连接真实服务器")
            val catalog = _state.value.voiceprint.catalog ?: error("请先刷新声纹列表")
            voiceprintClient = client
            voiceprintRevision = catalog.getString("revision")
            voiceprintSampleId = UUID.randomUUID().toString()
            voiceprintPcm = null
            voiceprintCapture = VoiceprintCapture(if (mode == "test") 10_000 else 30_000)
            _state.update { it.copy(voiceprint = VoiceprintState("recording", name, mode, source = kind, catalog = catalog)) }
        }
    }

    fun finishVoiceprintRecording() {
        synchronized(pipeline) {
            val recording = voiceprintCapture ?: return
            val elapsed = recording.elapsedMs
            voiceprintPcm = recording.finish()
            voiceprintCapture = null
            _state.update { it.copy(voiceprint = it.voiceprint.copy(phase = "review", elapsedMs = elapsed,
                message = if (elapsed < 15_000 && it.voiceprint.mode == "enroll") "录音不足 15 秒，请重新朗读" else "录音已完成")) }
            if (_state.value.voiceprint.mode == "test" && elapsed >= 1_000) submitVoiceprintRecording()
            else if (_state.value.voiceprint.mode == "enroll" && elapsed >= 15_000) checkVoiceprintRecording()
        }
    }

    private fun checkVoiceprintRecording() {
        val id = voiceprintSampleId
        val client = requireNotNull(voiceprintClient)
        val body = JSONObject().put("sample_rate", 16000).put("pcm_base64",
            Base64.encodeToString(requireNotNull(voiceprintPcm), Base64.NO_WRAP))
        _state.update { it.copy(voiceprint = it.voiceprint.copy(phase = "checking", message = "")) }
        scope.launch {
            runCatching { client.testVoiceprint(body) }.onSuccess { result ->
                synchronized(pipeline) {
                    if (id != voiceprintSampleId) return@synchronized
                    val q = result.getJSONObject("quality")
                    val passed = q.getDouble("seconds") >= 15 && q.getDouble("active_seconds") >= 8 && q.getDouble("clipped_ratio") <= .01
                    _state.update { it.copy(voiceprint = it.voiceprint.copy(phase = "review", quality = q, qualityPassed = passed,
                        message = if (passed) "音量与时长检查通过；保存时还会检查片段一致性" else "有效声音不足或音量过大，请靠近麦克风自然朗读后重录")) }
                }
            }.onFailure { error -> synchronized(pipeline) { if (id == voiceprintSampleId) _state.update {
                it.copy(voiceprint = it.voiceprint.copy(phase = "review", qualityPassed = false,
                    message = "质量检查失败：${error.message}，请放弃并重录"))
            } } }
        }
    }

    fun submitVoiceprintRecording() {
        val id: String
        val client: HttpOopsApi
        val body: JSONObject
        val testing: Boolean
        synchronized(pipeline) {
            val state = _state.value.voiceprint
            require(state.phase == "review") { "请先完成录音" }
            val pcm = voiceprintPcm ?: error("录音已清除，请重新录入")
            testing = state.mode == "test"
            require(testing || state.qualityPassed) { "录音质量尚未通过，请重新朗读" }
            require(pcm.size >= if (testing) 32000 else 15 * 32000) { "录音太短，请重新朗读" }
            client = requireNotNull(voiceprintClient)
            id = voiceprintSampleId
            body = JSONObject().put("name", state.name).put("source", state.source).put("sample_id", id)
                .put("sample_rate", 16000).put("pcm_base64", Base64.encodeToString(pcm, Base64.NO_WRAP))
                .put("consent", true).put("single_speaker", true).put("expected_revision", voiceprintRevision)
            _state.update { it.copy(voiceprint = state.copy(phase = if (testing) "testing" else "saving", message = "")) }
        }
        scope.launch {
            runCatching { if (testing) client.testVoiceprint(body) else client.enrollVoiceprint(body) }.onSuccess { result ->
                synchronized(pipeline) {
                    if (id != voiceprintSampleId) return@synchronized
                    voiceprintPcm = null
                    _state.update { it.copy(voiceprint = it.voiceprint.copy(phase = "idle",
                        catalog = if (testing) it.voiceprint.catalog else result,
                        diagnosis = if (testing) result else null,
                        message = if (testing) "匹配测试完成" else "声纹已保存，可换一段文字测试")) }
                }
            }.onFailure { error ->
                synchronized(pipeline) {
                    if (id == voiceprintSampleId) _state.update { it.copy(voiceprint = it.voiceprint.copy(phase = "review",
                        message = (error.message ?: "请求失败") + "；可重试同一录音，或刷新核对保存结果")) }
                }
            }
        }
    }

    fun deleteVoiceprint(name: String) {
        require(_state.value.voiceprint.phase == "idle") { "请等待当前操作结束" }
        require(name in Settings.TEAM) { "成员无效" }
        val client = api as? HttpOopsApi ?: error("请先连接真实服务器")
        val catalog = requireNotNull(_state.value.voiceprint.catalog)
        val id = UUID.randomUUID().toString()
        synchronized(pipeline) {
            voiceprintSampleId = id
            voiceprintCapture = null
            voiceprintPcm = null
            _state.update { it.copy(voiceprint = it.voiceprint.copy(phase = "saving", message = "")) }
        }
        scope.launch {
            runCatching { client.deleteVoiceprint(JSONObject().put("name", name).put("confirm", true)
                .put("expected_revision", catalog.getString("revision"))) }.onSuccess { result ->
                synchronized(pipeline) { if (id == voiceprintSampleId) _state.update {
                    it.copy(voiceprint = VoiceprintState(catalog = result, message = "已删除 $name 的声纹"))
                } }
            }.onFailure { synchronized(pipeline) { if (id == voiceprintSampleId) voiceprintError(it.message ?: "删除失败，请刷新核对") } }
        }
    }

    fun cancelVoiceprintRecording() {
        synchronized(pipeline) {
            voiceprintSampleId = UUID.randomUUID().toString()
            voiceprintCapture = null
            voiceprintPcm = null
            voiceprintClient = null
            _state.update { it.copy(voiceprint = VoiceprintState(catalog = it.voiceprint.catalog)) }
        }
    }

    private fun voiceprintError(message: String) {
        _state.update { it.copy(voiceprint = it.voiceprint.copy(phase = "idle", message = message)) }
    }

    // ---- meeting assistance ---------------------------------------------------------------
    private var agendaRevision = 0L
    private var tracker = com.oops.app.notice.NoticeTracker()
    private lateinit var noticeAlert: com.oops.app.notice.NoticeAlert
    private var lastVoiceAt = -5_000L
    private var lastTopicAt = 0L
    private var lastTopicCount = 0
    private val noticeBusy = java.util.concurrent.atomic.AtomicBoolean(false)
    private val topicEvidence = ConcurrentHashMap<String, MutableSet<String>>()
    private val conflictPairs = ConcurrentHashMap.newKeySet<String>()
    private class SyncContext(val queue: com.oops.app.backend.MeetingSync, @Volatile var client: OopsApi) {
        var job: Job? = null
        @Volatile var stopped = false
    }
    @Volatile private var syncContext: SyncContext? = null
    private val syncContexts = ConcurrentHashMap.newKeySet<SyncContext>()

    fun setAgenda(value: JSONObject) {
        val parsed = com.oops.app.notice.Agenda.fromBridge(value, ++agendaRevision)
        val available = tracker.agenda.items.toMutableList()
        val next = parsed.copy(items = parsed.items.mapIndexed { n, i ->
            val old = available.firstOrNull { it.title == i.title }
            if (old != null) { available.remove(old); i.copy(id = old.id) }
            else i.copy(id = "a${agendaRevision}_${n + 1}")
        })
        val persisted = JSONObject().put("goal", next.goal).put("minutes", next.plannedMs?.div(60_000) ?: JSONObject.NULL)
            .put("items", JSONArray(next.items.map { JSONObject().put("id", it.id).put("title", it.title).put("minutes", it.plannedMs?.div(60_000) ?: JSONObject.NULL) }))
        settings.agendaJson = persisted.toString()
        tracker.update(next, nowMs)
        topicEvidence.keys.retainAll(next.items.map { it.id }.toSet())
        syncContext?.queue?.agenda(next.wire())
        updateAssistanceState()
        syncContext?.let(::ensureSyncWorker)
    }

    fun clearAgenda() = setAgenda(JSONObject().put("items", JSONArray()))

    private fun updateAssistanceState() {
        val q = syncContext?.queue
        _state.update { it.copy(agenda = tracker.state(nowMs), notices = tracker.list().map { n -> n.bridge() },
            voiceTrigger = settings.voiceTrigger, noticeVibrate = settings.noticeVibrate, memorySync = recordingPolicy.archives,
            selfName = settings.selfName,
            syncPending = q?.pendingCount() ?: 0,
            syncStatus = when { !recordingPolicy.archives -> "off"; q == null -> "idle"; q.unsupported -> "unsupported"; q.failed -> "failed";
                q.pendingCount() > 0 -> if (it.syncStatus == "retrying") "retrying" else "pending"; else -> "synced" }) }
    }

    private fun publishNotice(n: com.oops.app.notice.Notice, session: String = sessionId) {
        if (session != sessionId) return
        noticeAlert.alert(settings.noticeVibrate, n.kind)
        emit(OopsEvent.Json("notice", n.bridge()))
        syncContext?.queue?.notice(n.wire())
        syncContext?.let(::ensureSyncWorker)
        updateAssistanceState()
        publishSessionSummary(session)
    }

    fun dismissNotice(id: String) {
        tracker.dismiss(id)?.let { syncContext?.queue?.notice(it.wire()) }
        Log.i(TAG, "notice dismissed: $id")
        updateAssistanceState(); publishSessionSummary(sessionId)
    }
    fun noticeFeedback(id: String, useful: Boolean) {
        tracker.feedback(id, useful)?.let { syncContext?.queue?.notice(it.wire()) }
        Log.i(TAG, "notice feedback: $id useful=$useful")
        updateAssistanceState(); publishSessionSummary(sessionId)
    }

    private fun syncUtterance(session: String, u: Utterance) {
        synchronized(pipeline) {
            if (session != sessionId) return
            syncContext?.let { ctx -> ctx.queue.upsert(u.toCandidate()); ensureSyncWorker(ctx) }
        }
    }

    private fun ensureSyncWorker(ctx: SyncContext) = synchronized(ctx) {
        if (ctx.job?.isActive == true) return@synchronized
        ctx.job = scope.launch(Dispatchers.IO) {
            while (isActive) {
                if (settings.memorySync || ctx.queue.explicitArchive) {
                    val batch = ctx.queue.batch(SystemClock.elapsedRealtime(), force = ctx.stopped)
                    if (batch != null) {
                        try {
                            val result = ctx.client.syncMeeting(batch.body)
                            val accepted = result != null && (result.optJSONArray("rejected")?.length() ?: 0) == 0
                            ctx.queue.complete(batch, SystemClock.elapsedRealtime(), accepted, result != null)
                            if (result != null && !accepted) ctx.queue.halt(endToo = true)
                            if (accepted && batch.body.has("ended_at") && !batch.body.isNull("ended_at") &&
                                ctx.queue.pendingCount() == 0 && !ctx.queue.failed) {
                                com.oops.app.store.SessionRecovery.markSent(File(app.filesDir, "recordings"), ctx.queue.sessionId)
                            }
                        } catch (error: CancellationException) { throw error }
                        catch (error: Exception) {
                            ctx.queue.complete(batch, SystemClock.elapsedRealtime(), false)
                            // A refused batch stops the sentences; a refused end (or a deleted meeting) stops everything.
                            if (error is com.oops.app.backend.HttpFailure && error.status in setOf(400, 409, 410, 413))
                                ctx.queue.halt(endToo = ctx.queue.failed || error.status == 410)
                            if (syncContext === ctx) _state.update { it.copy(syncStatus = "retrying") }
                            Log.w(TAG, "meeting sync failed: ${error.javaClass.simpleName}")
                        }
                    }
                }
                if (syncContext === ctx) updateAssistanceState()
                if (ctx.queue.finished() || ctx.stopped && ctx.queue.pendingCount() == 0) break
                delay(1_000)
            }
            if (ctx.stopped && ctx.queue.pendingCount() == 0) syncContexts.remove(ctx)
        }
    }

    fun askSession(query: String, trigger: String = "ask") {
        require(query.isNotBlank() && query.length <= 500) { "请输入 1–500 字的问题" }
        if (!inFlight.add("recall")) { emit(OopsEvent.Toast("正在召回，请稍等")); return }
        val session = sessionId
        val client = api
        val epoch = serviceEpoch
        val started = SystemClock.elapsedRealtime()
        val now = nowMs
        val candidates = com.oops.app.recall.AskCandidates.select(sessionIndex.snapshot(), query, now)
        emit(OopsEvent.RecallPending(trigger))
        scope.launch {
            try {
                val response = client.recall(RecallRequest(session, trigger, query, now, candidates.map { it.toCandidate() }))
                if (!currentSource(session, epoch)) return@launch
                val byId = candidates.filter { recordingPolicy.archives || sessionIndex.get(it.id) != null }.associateBy { it.id }
                val picks = PickPolicy.decide(PickPolicy.validated(response.picks, byId.keys))
                if (picks == null) emit(OopsEvent.RecallNotFound("本场原话里没有找到答案"))
                else {
                    val items = picks.picks.map { p -> byId.getValue(p.id).let { u ->
                        CardItem(u.id, u.startMs, u.endMs, u.text, u.speaker, p.prob, evidenceAudioAvailable(u)) } }
                    val card = RecallCard("c" + UUID.randomUUID().toString().take(8), trigger, query, now, items, picks.single,
                        sessionIndex.neighbors(items.map { it.utteranceId }, 2, 2), response.engine, now, SystemClock.elapsedRealtime() - started)
                    cards[card.id] = card; emit(OopsEvent.RecallReady(card)); recordLatency(card.latencyMs)
                }
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) { if (currentSource(session, epoch)) fail("recall", "问答失败：${error.message}") }
            finally { inFlight.remove("recall") }
        }
    }

    private fun evidenceAudioAvailable(u: Utterance) = ring.contains(Pcm.msToSamples(u.startMs), Pcm.msToSamples(u.endMs)) ||
        sessionIndex.audio(u.startMs, u.endMs) != null

    fun openDigestItems(ids: List<String>) {
        require(ids.size in 1..3)
        val current = ids.mapNotNull(sessionIndex::get)
        val history = tracker.list().mapNotNull { it.history }.filter { it.optString("id") in ids }
        if (history.isNotEmpty()) {
            val rows = current.map { com.oops.app.bridge.BridgeJson.utterance(it).put("audioAvailable", false).put("prob", 1) } +
                history.map { h -> JSONObject().put("id", h.getString("id")).put("text", h.getString("text"))
                    .put("startMs", h.getLong("start_ms")).put("endMs", h.getLong("end_ms"))
                    .put("prob", 1).put("audioAvailable", false).put("startedAt", h.getString("started_at")) }
            emit(OopsEvent.Json("recall.card", JSONObject().put("id", "history-conflict").put("trigger", "conflict")
                .put("items", JSONArray(rows)).put("pool", JSONArray(rows)).put("single", false).put("readOnly", true)
                .put("engine", "evidence").put("latencyMs", 0)))
            return
        }
        if (current.size != ids.distinct().size) {
            if (recordingPolicy.archives && _state.value.transcriptExpired) return openRetainedTaskEvidence(ids)
            return fail("recall", "原话已不在本场索引里")
        }
        val card = RecallCard("c" + UUID.randomUUID().toString().take(8), if (ids.size > 1) "conflict" else "digest", null, nowMs,
            current.map { u -> CardItem(u.id, u.startMs, u.endMs, u.text, u.speaker, u.tagProb ?: 1.0, evidenceAudioAvailable(u)) },
            current.size == 1, sessionIndex.neighbors(ids, 2, 2), "session", 0, 0)
        cards[card.id] = card; emit(OopsEvent.RecallReady(card))
    }

    private fun openRetainedTaskEvidence(ids: List<String>) {
        val (client, request) = synchronized(pipeline) {
            val context = currentTaskBoardContext().takeIf { it.mode == "meeting" && it.transcriptExpired } ?: return
            api to context
        }
        scope.launch {
            try {
                val history = client.historyOpen(request.sessionId)
                synchronized(pipeline) {
                    if (!currentSessionService(request.sessionId, request.serviceEpoch) ||
                        !TaskBoardPolicy.accepts(request, currentTaskBoardContext())) return@synchronized
                    val rows = history?.let { RetainedTaskEvidence.select(it, request.sessionId, ids) }
                    if (rows == null) { fail("recall", "这段短依据未单独确认保留，或已变化；不会恢复已到期的全文或原音"); return@synchronized }
                    val card = RecallCard("c" + UUID.randomUUID().toString().take(8), "digest", null, nowMs,
                        rows.map { CardItem(it.id, it.startMs, it.endMs, it.text, it.speaker, 1.0, false) },
                        rows.size == 1, emptyList(), "saved_excerpt", 0, 0)
                    cards[card.id] = card
                    emit(OopsEvent.RecallReady(card))
                }
            } catch (error: CancellationException) { throw error }
            catch (_: Exception) { if (synchronized(pipeline) { TaskBoardPolicy.accepts(request, currentTaskBoardContext()) })
                fail("recall", "短依据读取失败，请重试；不会恢复已到期的全文") }
        }
    }

    private fun noticeTick(now: Long) {
        tracker.onTick(now).forEach { n -> publishNotice(n); if (n.title == "会议还剩 5 分钟") checkResolutions(now) }
        updateAssistanceState()
        val ag = tracker.agenda
        val all = sessionIndex.snapshot()
        if (ag.items.isEmpty() && ag.goal.isBlank() || now - lastTopicAt < 60_000 || all.size - lastTopicCount < 3 ||
            tracker.tracking == "unsupported" || !noticeBusy.compareAndSet(false, true)) return
        lastTopicAt = now; lastTopicCount = all.size
        val rows = all.filter { it.endMs >= now - 90_000 && !OopsCommand.matches(it.text) }.takeLast(40)
        var chars = 0
        val limited = rows.asReversed().takeWhile { chars += it.text.length; chars <= 4000 }.asReversed()
        val request = JSONObject().put("kind", "topic").put("session_id", sessionId).put("agenda", ag.wire())
            .put("utterances", JSONArray(limited.map { com.oops.app.backend.ApiJson.candidate(it.toCandidate()) }))
        val session = sessionId; val t = tracker; val policy = optionalRequests; val client = api; val epoch = serviceEpoch
        scope.launch {
            try {
                val result = policy.request("notice") { client.notice(request) }
                if (!currentSource(session, epoch) || t !== tracker || ag.revision != tracker.agenda.revision) return@launch
                if (result == null) t.tracking = "unsupported"
                else {
                    val topic = result.getString("topic")
                    if (topic in ag.items.map { it.id }) topicEvidence.computeIfAbsent(topic) { ConcurrentHashMap.newKeySet() }.addAll(limited.map { it.id })
                    val (notices, old) = t.onTopic(topic, if (result.isNull("prob")) null else result.getDouble("prob"), now)
                    notices.forEach { publishNotice(it, session) }
                    old?.let { checkResolution(it, now) }
                }
                updateAssistanceState()
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) { Log.w(TAG, "topic failed: ${error.javaClass.simpleName}") }
            finally { noticeBusy.set(false) }
        }
    }

    private fun checkResolutions(now: Long) = tracker.resolutionCandidates(now).forEach { checkResolution(it, now) }
    private fun checkResolution(id: String, now: Long) {
        val ag = tracker.agenda; val item = ag.items.firstOrNull { it.id == id } ?: return
        val session = sessionId; val t = tracker; val policy = optionalRequests; val client = api; val epoch = serviceEpoch
        val ids = topicEvidence[id].orEmpty()
        val rows = sessionIndex.snapshot().filter { it.id in ids }
            .sortedByDescending { it.tag in com.oops.app.buffer.SessionIndex.DIGEST_TAGS }.take(60).sortedBy { it.startMs }
        if (rows.isEmpty() || !inFlight.add("resolution:$session:$id")) return
        scope.launch {
            try {
                val request = JSONObject().put("kind", "resolution").put("session_id", session)
                    .put("item", JSONObject().put("id", id).put("title", item.title))
                    .put("utterances", JSONArray(rows.map { com.oops.app.backend.ApiJson.candidate(it.toCandidate()) }))
                val result = policy.request("notice") { client.notice(request) }
                if (currentSource(session, epoch) && t === tracker && ag.revision == tracker.agenda.revision && result != null) {
                    t.onResolution(id, if (result.isNull("resolved")) null else result.getBoolean("resolved"),
                        if (result.isNull("prob")) null else result.getDouble("prob"), now)?.let { publishNotice(it, session) }
                }
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) { Log.w(TAG, "resolution failed: ${error.javaClass.simpleName}") }
            finally { inFlight.remove("resolution:$session:$id") }
        }
    }

    private fun checkConflict(session: String, u: Utterance) {
        if (u.tag !in com.oops.app.buffer.SessionIndex.RETAINED_TAGS) return
        val previous = sessionIndex.snapshot().filter { it.id != u.id && it.startMs < u.startMs && it.tag in setOf("decision", "constraint") }.takeLast(30)
        // Empty local evidence still permits server-side comparison with earlier meetings.
        val request = JSONObject().put("kind", "conflict").put("session_id", session)
            .put("utterance", com.oops.app.backend.ApiJson.candidate(u.toCandidate()))
            .put("previous", JSONArray(previous.map { com.oops.app.backend.ApiJson.candidate(it.toCandidate()) }))
        val t = tracker; val client = api; val policy = optionalRequests; val epoch = serviceEpoch
        val reservation = policy.tryReserve("notice") ?: return
        scope.launch {
            try {
                val result = policy.request(reservation) { client.notice(request) } ?: return@launch
                if (!currentSource(session, epoch) || t !== tracker || (!recordingPolicy.archives && sessionIndex.get(u.id) == null) || !result.getBoolean("conflict")) return@launch
                val h = result.getJSONObject("with"); val otherId = h.getString("id")
                val prior = previous.firstOrNull { it.id == otherId }
                if (prior == null && !otherId.startsWith("h:")) return@launch
                if (!conflictPairs.add("${u.id}:$otherId")) return@launch
                val priorText = prior?.text ?: h.getString("text")
                val confirmed = prior == null && h.optBoolean("confirmed")
                val day = if (prior == null) java.time.Instant.parse(h.getString("started_at")).atZone(java.time.ZoneId.systemDefault())
                    .format(java.time.format.DateTimeFormatter.ofPattern("MM/dd")) else ""
                val meeting = h.optString("meeting_title").takeIf { prior == null && it.isNotBlank() && it != "null" }
                val prefix = when {
                    prior != null -> "${(prior.startMs / 60000)} 分钟"
                    else -> "$day ${meeting?.let { "《$it》" } ?: "会议"}${if (confirmed) "已确认" else "（未核对）"}"
                }
                publishNotice(t.add(com.oops.app.notice.Notice(kind = "conflict",
                    title = if (confirmed) "可能与已确认的决定冲突" else "可能与之前的约束冲突",
                    detail = "$prefix：「$priorText」\n本场：「${u.text}」", atMs = nowMs,
                    evidenceIds = listOf(u.id, otherId), history = if (prior == null) h else null)), session)
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) { Log.w(TAG, "conflict failed: ${error.javaClass.simpleName}") }
        }.invokeOnCompletion { reservation.close() }
    }

    fun history(action: String, value: String = "", confirm: Boolean = false, requestId: String = "") {
        val client = api
        val epoch = serviceEpoch
        val context = serviceContext(epoch).put("operation", "history.$action").put("requestId", requestId)
        if (action in setOf("open", "delete")) context.put("sessionId", value)
        scope.launch {
            try {
                val result = when (action) {
                    "list" -> client.historyList()
                    "open" -> client.historyOpen(value)
                    "delete" -> {
                        require(confirm) { "请确认删除会议文字" }
                        require(value != sessionId || !_state.value.capturing) { "请先停止收音，再删除本场文字" }
                        val result = client.historyDelete(value)
                        if (epoch != serviceEpoch) return@launch
                        if (result != null) {
                            synchronized(pipeline) { if (value == sessionId) invalidateTaskBoard("source_deleted") }
                            if (result.optBoolean("deleted") != true) error("服务未确认删除")
                            invalidSessions.add(value)
                            syncContexts.filter { it.queue.sessionId == value }.forEach { it.queue.halt(endToo = true); it.job?.cancel() }
                            if (value == sessionId) synchronized(pipeline) {
                                clearUnsubmittedSources(); tracker = com.oops.app.notice.NoticeTracker(tracker.agenda)
                                player.stop()
                            }
                            withContext(Dispatchers.IO) {
                                val dir = File(app.filesDir, "recordings")
                                listOf("audio", "transcript").forEach { com.oops.app.store.RecordingExpiry.removeAsset(dir, value, it) }
                                expireSessionMemory(dir)
                            }
                        }
                        result
                    }
                    "search" -> { require(value.isNotBlank() && value.length <= 500); client.historySearch(value) }
                    else -> error("未知往期操作")
                }
                if (epoch != serviceEpoch) return@launch
                if (result == null) fail("history", "当前后端不支持往期会议", context)
                else emit(OopsEvent.Json("history.$action", result.put("query", if (action == "search") value else "")
                    .put("requestId", requestId).also { if (action in setOf("open", "delete")) it.put("sessionId", value) }
                    .put("serviceEpoch", epoch).put("backendUrl", context.getString("backendUrl"))))
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) { if (epoch == serviceEpoch) fail("history", "往期会议请求失败：${error.message}", context) }
        }
    }

    /** Independent confirmed excerpts survive expiry; automatic minutes never call this. */
    fun retainMeeting(payload: JSONObject) {
        val body = com.oops.app.store.MeetingRetentionRequest.fromBridge(payload)
        val client = api; val epoch = serviceEpoch
        val context = serviceContext(epoch).put("operation", "meeting.retain").put("sessionId", body.getString("session_id"))
            .put("requestId", payload.optString("requestId"))
        scope.launch {
            try {
                val result = client.retainMeeting(body)
                if (epoch != serviceEpoch) return@launch
                if (result == null) fail("retention", "当前服务不支持独立保留，请更新服务后重试", context)
                else {
                    emit(OopsEvent.Json("meeting.retained", result.put("sessionId", body.getString("session_id"))
                        .put("requestId", payload.optString("requestId")).put("serviceEpoch", epoch).put("backendUrl", context.getString("backendUrl"))))
                    if (body.getString("session_id") == sessionId) synchronized(pipeline) {
                        invalidateTaskBoard("retained_source_changed"); refreshTaskBoard()
                    }
                }
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { if (epoch == serviceEpoch) {
                val changed = e is com.oops.app.backend.HttpFailure && e.status == 409
                fail("retention", if (changed) "原话已变化，请重新读取会议并核对" else "没有保存：${e.message}", context.put("sourceChanged", changed))
            } }
        }
    }

    /** Read already stored minutes; this endpoint never generates or sends external results. */
    fun minutes(sessionId: String, requestId: String = "") {
        val client = api
        val epoch = serviceEpoch
        val context = serviceContext(epoch).put("operation", "history.minutes").put("sessionId", sessionId).put("requestId", requestId)
        scope.launch {
            try {
                val result = client.historyMinutes(sessionId)
                if (epoch != serviceEpoch) return@launch
                if (result == null) fail("minutes", "当前后端不支持 AI 纪要", context)
                else emit(OopsEvent.Json("history.minutes", result.put("session_id", sessionId).put("requestId", requestId)
                    .put("serviceEpoch", epoch).put("backendUrl", context.getString("backendUrl"))))
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) { if (epoch == serviceEpoch) fail("minutes", "纪要读取失败：${error.message}", context) }
        }
    }

    // ---- people's corrections, archived audio, tasks -----------------------------------------

    /**
     * A person says who spoke a sentence (a team name, other/multi/unclear, or null to undo). In the live meeting the
     * line changes at once and the server is told once it holds the meeting text; a past meeting goes straight to the server.
     */
    fun correctSpeaker(session: String, utteranceId: String, speaker: String?) {
        require(speaker == null || speaker in Settings.TEAM || speaker in MANUAL_OTHER) { "说话人无效" }
        val epoch = serviceEpoch
        val context = serviceContext(epoch).put("operation", "speaker.correct").put("sessionId", session).put("utteranceId", utteranceId)
        var mutationVersion: Long? = null
        val live = synchronized(pipeline) {
            if (session != sessionId) return@synchronized null
            boardBlockedSources.add(utteranceId)
            invalidateTaskBoard("speaker_corrected", setOf(utteranceId))
            mutationVersion = boardSourceRevision
            boardMutationVersions[utteranceId] = boardSourceRevision
            sessionIndex.setManual(session, utteranceId, speaker)?.also { transcript.setManual(utteranceId, speaker) }
        }
        if (live != null) {
            emit(OopsEvent.Json("speaker.corrected", corrected(session, utteranceId, speaker, "local")))
            publishSessionSummary(session)
            if (!recordingPolicy.archives) {
                emit(OopsEvent.Toast("仅核对日常临时显示，不写入团队服务器"))
                return
            }
        }
        val client = api
        scope.launch {
            val body = JSONObject().put("session_id", session).put("utterance_id", utteranceId)
                .put("speaker", speaker ?: JSONObject.NULL).put("by", settings.selfName.ifEmpty { JSONObject.NULL })
            try {
                // The live meeting may not have reached the server yet: the sync queue sends every 20 s.
                var result = client.reviewMeeting(body)
                var tries = 0
                while (result == null && live != null && tries++ < REVIEW_RETRIES) {
                    delay(REVIEW_RETRY_MS)
                    if (epoch != serviceEpoch) return@launch
                    result = client.reviewMeeting(body)
                }
                if (epoch != serviceEpoch) return@launch
                if (mutationVersion != null && synchronized(pipeline) { boardMutationVersions[utteranceId] != mutationVersion }) return@launch
                if (result == null) {
                    fail("review", if (live != null) "服务器还没有这场会议的文字，改动只在本机" else "当前后端不支持修改说话人", context)
                    return@launch
                }
                emit(OopsEvent.Json("speaker.corrected", corrected(session, utteranceId, speaker, "saved")))
                if (live != null) synchronized(pipeline) {
                    boardBlockedSources.remove(utteranceId)
                    boardMutationVersions.remove(utteranceId)
                    rememberTaskReview(utteranceId, result)
                    // The server now drafts with the corrected speaker; ask again for this sentence's owner.
                    sessionIndex.get(utteranceId)?.let { refreshOwnerHint(session, it) }
                    refreshDraftSuggestions(session, utteranceId)
                    refreshTaskBoard()
                }
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) { if (epoch == serviceEpoch) fail("review", "说话人修改没有保存到服务器：${error.message}", context) }
        }
    }

    /** After-meeting check of one sentence: verdict (confirmed/rejected) and owner; null clears that field. */
    fun review(session: String, utteranceId: String, fields: JSONObject) {
        val epoch = serviceEpoch
        val context = serviceContext(epoch).put("operation", "review.set").put("sessionId", session).put("utteranceId", utteranceId)
        val body = JSONObject().put("session_id", session).put("utterance_id", utteranceId)
            .put("by", settings.selfName.ifEmpty { JSONObject.NULL })
        for (key in fields.keys()) {
            val value = if (fields.isNull(key)) null else fields.getString(key)
            require(when (key) {
                "verdict" -> value == null || value in setOf("confirmed", "rejected")
                "owner" -> value == null || value in Settings.TEAM
                else -> false
            }) { "核对内容无效" }
            body.put(key, value ?: JSONObject.NULL)
        }
        require(body.has("verdict") || body.has("owner")) { "没有要保存的核对" }
        val mutationVersion = synchronized(pipeline) { if (session == sessionId) {
            boardBlockedSources.add(utteranceId)
            invalidateTaskBoard("review_changed", setOf(utteranceId))
            boardSourceRevision.also { boardMutationVersions[utteranceId] = it }
        } else null }
        val client = api
        scope.launch {
            try {
                val result = client.reviewMeeting(body)
                if (epoch != serviceEpoch) return@launch
                if (mutationVersion != null && synchronized(pipeline) { boardMutationVersions[utteranceId] != mutationVersion }) return@launch
                if (result == null) fail("review", "服务器上没有这场会议，核对没有保存", context)
                else {
                    emit(OopsEvent.Json("review.saved", JSONObject().put("sessionId", session).put("utteranceId", utteranceId)
                        .put("review", result.opt("review") ?: JSONObject.NULL).put("serviceEpoch", epoch).put("backendUrl", context.getString("backendUrl"))))
                    if (session == sessionId) synchronized(pipeline) {
                        boardBlockedSources.remove(utteranceId); boardMutationVersions.remove(utteranceId)
                        rememberTaskReview(utteranceId, result); refreshTaskBoard()
                    }
                }
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) { if (epoch == serviceEpoch) fail("review", "核对没有保存到服务器：${error.message}", context) }
        }
    }

    /**
     * After-meeting check of one minutes item: confirm (optionally with kind/title/due/owner), reject, merge into another
     * item, or reopen. The server validates names and returns the meeting's current items and queue.
     */
    fun reviewItem(session: String, p: JSONObject) {
        val epoch = serviceEpoch
        val itemId = p.getString("itemId")
        val action = p.getString("action")
        val context = serviceContext(epoch).put("operation", "items.review").put("sessionId", session).put("itemId", itemId)
        require(action in setOf("confirm", "reject", "merge", "reopen")) { "核对操作无效" }
        val body = JSONObject().put("session_id", session).put("item_id", itemId).put("action", action)
            .put("fingerprint", p.getString("fingerprint")).put("by", settings.selfName.ifEmpty { JSONObject.NULL })
        for (key in listOf("kind", "title", "due", "owner", "into")) {
            if (p.has(key) && !p.isNull(key)) body.put(key, p.getString(key).take(200))
        }
        val client = api
        scope.launch {
            try {
                val result = client.reviewMeetingItem(body)
                if (epoch != serviceEpoch) return@launch
                if (result == null) fail("items", "当前后端不支持核对纪要事项", context)
                else emit(OopsEvent.Json("items.saved", result.put("sessionId", session).put("itemId", itemId)
                    .put("serviceEpoch", epoch).put("backendUrl", context.getString("backendUrl"))))
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) {
                if (epoch != serviceEpoch) return@launch
                val changed = error is com.oops.app.backend.HttpFailure && error.status == 409
                fail("items", if (changed) "这件事或它的原话已变化，已重新读取" else "核对没有保存到服务器：${error.message}",
                    context.put("changed", changed))
            }
        }
    }

    private fun corrected(session: String, id: String, speaker: String?, status: String) = JSONObject()
        .put("sessionId", session).put("utteranceId", id).put("speaker", speaker ?: JSONObject.NULL).put("status", status)
        .put("serviceEpoch", serviceEpoch).put("backendUrl", _state.value.backendUrl)

    fun projects(name: String? = null) {
        val client = api
        val epoch = serviceEpoch
        val context = serviceContext(epoch).put("operation", if (name == null) "projects.list" else "project.open").put("name", name ?: JSONObject.NULL)
        scope.launch {
            try {
                val result = if (name == null) client.projects() else client.project(name)
                if (epoch != serviceEpoch) return@launch
                if (result == null) fail("projects", "当前后端不支持项目", context)
                else emit(OopsEvent.Json(if (name == null) "projects.list" else "project.open", result.put("serviceEpoch", epoch).put("backendUrl", context.getString("backendUrl"))))
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) { if (epoch == serviceEpoch) fail("projects", "项目请求失败：${error.message}", context) }
        }
    }

    /** Puts a meeting in a project; this meeting's text may still be on its way to the server, so a live one retries. */
    fun setMeetingProject(session: String, project: String) {
        val name = project.trim()
        require(name.length <= 30) { "项目名称最多 30 个字" }
        val live = session == sessionId
        val client = api
        val epoch = serviceEpoch
        val context = serviceContext(epoch).put("operation", "meeting.project").put("sessionId", session)
        scope.launch {
            try {
                var result = client.setMeetingProject(session, name)
                var tries = 0
                while (result == null && live && tries++ < REVIEW_RETRIES) {
                    delay(REVIEW_RETRY_MS)
                    if (epoch != serviceEpoch) return@launch
                    result = client.setMeetingProject(session, name)
                }
                if (epoch != serviceEpoch) return@launch
                if (result == null) fail("projects", if (live) "服务器还没有这场会议的文字，稍后再设项目" else "当前后端不支持项目", context)
                else emit(OopsEvent.Json("meeting.project", result.put("serviceEpoch", epoch).put("backendUrl", context.getString("backendUrl"))))
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) { if (epoch == serviceEpoch) fail("projects", "项目没有保存：${error.message}", context) }
        }
    }

    fun renameMeeting(session: String, title: String) {
        require(title.trim().length <= 40) { "会议名称最多 40 个字" }
        val client = api
        val epoch = serviceEpoch
        val context = serviceContext(epoch).put("operation", "history.rename").put("sessionId", session)
        scope.launch {
            try {
                val result = client.renameMeeting(session, title.trim())
                if (epoch != serviceEpoch) return@launch
                if (result == null) fail("history", "当前后端不支持改会议名称", context)
                else emit(OopsEvent.Json("history.renamed", result.put("serviceEpoch", epoch).put("backendUrl", context.getString("backendUrl"))))
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) { if (epoch == serviceEpoch) fail("history", "改名没有保存：${error.message}", context) }
        }
    }

    /** Plays a sentence from the server's archive (a past meeting, or this one once its recording is uploaded). */
    fun playRemoteClip(key: String, session: String, startMs: Long, endMs: Long) {
        val client = api
        val epoch = serviceEpoch
        scope.launch {
            try {
                emit(OopsEvent.Clip(key, "loading"))
                val pcm = client.recordingClip(session, startMs, endMs)
                if (epoch != serviceEpoch) return@launch
                if (pcm == null || pcm.isEmpty()) emit(OopsEvent.Clip(key, "unavailable")) else player.play(key, pcm)
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) {
                if (epoch != serviceEpoch) return@launch
                if (error is com.oops.app.store.RecordingAssetExpired) {
                    withContext(Dispatchers.IO) { com.oops.app.store.RecordingExpiry.removeAsset(File(app.filesDir, "recordings"), session, "audio") }
                    emit(OopsEvent.Clip(key, "expired"))
                } else emit(OopsEvent.Clip(key, "unavailable"))
                fail("clip", "原声取不到：${error.message}")
            }
        }
    }

    fun tasks(mine: Boolean, status: String, requestId: String = "") {
        val client = api
        val epoch = serviceEpoch
        val self = settings.selfName.ifEmpty { null }
        val context = serviceContext(epoch).put("operation", "tasks.list").put("mine", mine).put("status", status).put("selfName", self ?: JSONObject.NULL).put("requestId", requestId)
        scope.launch {
            try {
                require(!mine || self != null) { "请先在设置里选择本人" }
                val result = client.tasks(if (mine) self else null, status)
                if (epoch != serviceEpoch) return@launch
                if (result == null) fail("tasks", "当前后端不支持任务列表", context)
                else emit(OopsEvent.Json("tasks.list", result.put("mine", mine).put("status", status).put("selfName", self ?: JSONObject.NULL).put("requestId", requestId)
                    .put("serviceEpoch", epoch).put("backendUrl", context.getString("backendUrl"))))
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) { if (epoch == serviceEpoch) fail("tasks", "任务列表请求失败：${error.message}", context) }
        }
    }

    // ---- settings --------------------------------------------------------------------------

    fun applySettings(json: JSONObject) {
        val nextOrigin = com.oops.app.store.RecordingOrigin.from(
            if (json.has("backendBaseUrl")) json.getString("backendBaseUrl") else settings.backendBaseUrl,
            if (json.has("mockBackend")) json.getBoolean("mockBackend") else settings.mockBackend)
        require(!(_state.value.capturing || isCaptureStopping()) || nextOrigin == currentOrigin()) {
            "请先结束当前记录并等待转写收尾，再切换服务"
        }
        if (json.has("voiceTrigger")) settings.voiceTrigger = json.getBoolean("voiceTrigger")
        if (json.has("noticeVibrate")) settings.noticeVibrate = json.getBoolean("noticeVibrate")
        if (json.has("memorySync")) {
            settings.memorySync = json.getBoolean("memorySync")
            if (settings.memorySync) {
                sessionIndex.snapshot().forEach { u -> syncContext?.queue?.upsert(u.toCandidate()) }
                syncContexts.forEach(::ensureSyncWorker)
            }
        }
        val previousBackend = settings.backendBaseUrl
        val previousMock = settings.mockBackend
        val activeKind = synchronized(pipeline) { source?.kind }
        val previousAddress = settings.remoteAddress
        if (json.has("source")) {
            val kind = json.getString("source")
            require(kind in setOf(Settings.SOURCE_MIC, Settings.SOURCE_WAV, Settings.SOURCE_REMOTE, Settings.SOURCE_BEAN, Settings.SOURCE_BEAN_SIM)) { "音源无效" }
            require(kind != Settings.SOURCE_BEAN || BeanSdk.included) { "这个安装包没有包含录音豆 SDK" }
            settings.source = kind
        }
        if (json.has("remoteAddress")) {
            val address = json.getString("remoteAddress").trim()
            if (Settings.parseAddress(address) != null) settings.remoteAddress = address
            else fail("settings", "Mac 收音地址格式应为 主机:端口，例如 127.0.0.1:7790")
        }
        if (json.has("backendBaseUrl")) settings.backendBaseUrl = json.getString("backendBaseUrl")
        if (json.has("backendToken")) settings.backendToken = json.getString("backendToken")
        if (json.has("selfName")) {
            val name = json.getString("selfName")
            require(name.isEmpty() || name in Settings.TEAM) { "本人必须是团队成员" }
            settings.selfName = name
        }
        if (json.has("mockBackend")) settings.mockBackend = json.getBoolean("mockBackend")
        val url = settings.backendBaseUrl
        if (!settings.mockBackend && !(url.startsWith("http://") || url.startsWith("https://"))) {
            settings.mockBackend = true
            fail("settings", "后端地址要以 http:// 或 https:// 开头，已切回 Mock")
        }
        val speakerChanged = json.has("speakerInfo") && json.getBoolean("speakerInfo") != settings.speakerInfo
        if (json.has("speakerInfo")) settings.speakerInfo = json.getBoolean("speakerInfo")
        if (json.has("speakerPreview")) settings.speakerPreview = json.getBoolean("speakerPreview")
        if (json.has("recordSession")) settings.recordSession = json.getBoolean("recordSession")
        if (com.oops.app.BuildConfig.DEBUG && json.has("speakerPreviewUrl")) {
            val value = json.getString("speakerPreviewUrl").trim()
            require(value.isEmpty() || value.toUri().host in setOf("127.0.0.1", "localhost") && value.startsWith("http://")) {
                "独立试验分析地址仅允许本机回环"
            }
            settings.speakerPreviewUrl = value
            if (json.has("speakerPreviewToken") && value.isNotEmpty()) settings.setBackendTokenFor(value, json.getString("speakerPreviewToken"))
        }
        if (json.has("speakerPreview") || json.has("speakerPreviewUrl") || previousBackend != settings.backendBaseUrl || previousMock != settings.mockBackend) {
            optionalRequests = com.oops.app.backend.OptionalRequests()
            resetSpeakerPreview()
        }
        if (previousBackend != settings.backendBaseUrl || previousMock != settings.mockBackend) {
            cancelVoiceprintRecording()
            _state.update { it.copy(voiceprint = VoiceprintState(message = "服务器已切换，请刷新声纹列表")) }
        }
        rebuildApi()
        if (previousBackend == settings.backendBaseUrl && previousMock == settings.mockBackend) syncContext?.client = api
        val sourceChanged = activeKind != null && ((json.has("source") && activeKind != settings.source) ||
            (activeKind == Settings.SOURCE_REMOTE && previousAddress != settings.remoteAddress))
        if (sourceChanged) {
            cancelVoiceprintRecording()
            switchCaptureSource(settings.source)
        }
        else if (speakerChanged) synchronized(pipeline) { restartAsrLocked() }
        updateAssistanceState()
        emit(OopsEvent.Toast("设置已保存"))
    }

    private fun rebuildApi() = synchronized(pipeline) {
        val url = settings.backendBaseUrl
        val nextService = Triple(settings.mockBackend, url, settings.backendToken)
        val serviceChanged = configuredService != null && configuredService != nextService
        val endpointChanged = configuredService?.let { old ->
            com.oops.app.store.RecordingOrigin.from(old.second, old.first) !=
                com.oops.app.store.RecordingOrigin.from(url, settings.mockBackend)
        } == true
        if (serviceChanged) serviceEpoch += 1
        if (serviceChanged) synchronized(pipeline) {
            clearUnsubmittedSources()
            optionalRequests = com.oops.app.backend.OptionalRequests()
            tracker = com.oops.app.notice.NoticeTracker(tracker.agenda)
            player.stop()
            if (endpointChanged) {
                val ids = transcript.snapshot().map { it.id }
                transcript.clear(); ring.reset(); sessionIndex.reset(""); sessionId = ""
                recordingPolicy = com.oops.app.store.RecordingPolicy()
                _state.update { it.copy(sessionId = "", sessionMs = 0, bufferedMs = 0, recordingMode = "daily",
                    cloudSaveConfirmed = false, audioExpired = false, transcriptExpired = false,
                    notices = emptyList(), digestCounts = emptyMap(), commitmentCount = 0, analysisPending = 0) }
                emit(OopsEvent.Pruned(ids))
            }
        }
        configuredService = nextService
        api = if (settings.mockBackend || url.isBlank()) MockOopsApi(Settings.TEAM) else HttpOopsApi(http, url, settings.backendToken, sessionMode = { sessionModes[it] })
        val previewUrl = if (com.oops.app.BuildConfig.DEBUG) settings.speakerPreviewUrl else ""
        previewApi = if (previewUrl.isBlank()) api else HttpOopsApi(http, previewUrl, settings.backendTokenFor(previewUrl), sessionMode = { sessionModes[it] })
        _state.update {
            it.copy(
                backend = api.name,
                backendUrl = url,
                hasBackendToken = settings.backendToken.isNotBlank(),
                speakerInfo = settings.speakerInfo,
                speakerPreviewEnabled = settings.speakerPreview,
                recordSession = settings.recordSession,
                source = if (it.capturing) it.source else settings.source,
                remoteAddress = settings.remoteAddress,
            )
        }
        if (serviceChanged) {
            emit(OopsEvent.Json("backend.changed", JSONObject().put("backend", api.name).put("backendUrl", url).put("serviceEpoch", serviceEpoch)))
            synchronized(pipeline) { invalidateTaskBoard("service_changed") }
            archiveMessage(File(app.filesDir, "recordings"), currentOrigin())
            scheduleUpload()
        }
    }

    private fun serviceContext(epoch: Long) = JSONObject().put("serviceEpoch", epoch).put("backendUrl", _state.value.backendUrl)

    private fun emit(event: OopsEvent) {
        _events.tryEmit(event)
    }

    private fun fail(scope: String, message: String, context: JSONObject? = null) {
        Log.w(TAG, "$scope: operation failed")
        if (context == null) emit(OopsEvent.Failure(scope, message))
        else emit(OopsEvent.Json("error", context.put("scope", scope).put("message", message)))
    }
}
