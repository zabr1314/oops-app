#if os(watchOS)
import AVFoundation
import Foundation

/// Watch-owned recording only. The caller owns consent, transfer receipts and the end manifest.
/// No initializer, connectivity callback or interruption-end notification starts the microphone.
@MainActor
final class WatchAudioRecorder: NSObject {
    enum Phase: String, Sendable {
        case idle, requestingPermission, starting, recording, pausing, paused, stopping, stopped, failed
    }

    struct State: Sendable {
        var phase: Phase = .idle
        var sessionID = ""
        var elapsedMs: Int64 = 0
        var level: Float = 0
        var error: String?
        /// Include this count in a separate end manifest, including when there is no tail file.
        var completedChunkCount = 0
    }

    struct Chunk: Sendable {
        let fileURL: URL
        let sessionID: String
        let sequence: Int
        let startMs: Int64
        let endMs: Int64
        let isFinal: Bool
    }

    enum RecordingError: LocalizedError {
        case refused(String)
        var errorDescription: String? { if case let .refused(message) = self { return message }; return nil }
    }

    var onStateChange: ((State) -> Void)?
    var onChunk: ((Chunk) -> Void)?
    private(set) var state = State()

    // Leave AAC encoder padding below the 30-second per-file input limit.
    private let segmentDuration: TimeInterval = 29
    private let fileManager = FileManager.default
    private let audioSession = AVAudioSession.sharedInstance()
    private var recorder: AVAudioRecorder?
    private var meterTimer: Timer?
    private var generation = UUID()
    private var transitionPending = false
    private var wantsRecording = false
    private var manifest: Manifest?
    private var completedMs: Int64 = 0
    private var segmentElapsed: TimeInterval = 0
    private var lastObservedRecorderTime: TimeInterval = 0
    private var lastClockAdvanceUptime: TimeInterval?
    private var observedClockProgress = false
    private var notRecordingSince: TimeInterval?

    private struct SwitchDiagnostics: Codable {
        // This is a lower bound, not a sample-accurate gap: the system can deliver the
        // finish callback late, and record() does not report the first captured sample.
        // It must never be added to the existing audio-sample startMs/endMs timeline.
        var measurement = "finish_callback_to_next_record_request_lower_bound"
        var count = 0
        var totalMs: Int64 = 0
        var maxMs: Int64 = 0
        var lastCompletedSequence: Int?
        var lastMs: Int64?
    }

    private struct Manifest: Codable {
        let version: Int
        let sessionID: String
        let startedAt: Date
        let expiresAt: Date
        var completedChunkCount: Int
        var switchDiagnostics: SwitchDiagnostics?
    }

    init(onStateChange: ((State) -> Void)? = nil, onChunk: ((Chunk) -> Void)? = nil) {
        self.onStateChange = onStateChange
        self.onChunk = onChunk
        super.init()
        let notifications = NotificationCenter.default
        notifications.addObserver(self, selector: #selector(interrupted(_:)), name: AVAudioSession.interruptionNotification, object: audioSession)
        notifications.addObserver(self, selector: #selector(mediaServicesUnavailable(_:)), name: AVAudioSession.mediaServicesWereLostNotification, object: audioSession)
        notifications.addObserver(self, selector: #selector(mediaServicesUnavailable(_:)), name: AVAudioSession.mediaServicesWereResetNotification, object: audioSession)
        notifications.addObserver(self, selector: #selector(routeChanged(_:)), name: AVAudioSession.routeChangeNotification, object: audioSession)
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
        meterTimer?.invalidate()
        recorder?.delegate = nil
        recorder?.stop()
    }

    /// Call only from an explicit foreground Watch action after the phone-authorized meeting consent.
    /// startedAt must be the frozen contract start; retries must not give it a later date.
    func start(sessionID: String, audioRetentionDays: Int, cloudSaveConfirmed: Bool,
               startedAt: Date = Date()) async throws {
        guard !transitionPending, recorder == nil, !wantsRecording,
              state.phase == .idle || state.phase == .stopped || state.phase == .failed else {
            throw RecordingError.refused("请先结束当前手表录音")
        }
        try validateSessionID(sessionID)
        guard cloudSaveConfirmed, [7, 30, 90].contains(audioRetentionDays) else {
            throw RecordingError.refused("请先明确确认本次正式会议云保存及原音期限")
        }
        let deadline = startedAt.addingTimeInterval(TimeInterval(audioRetentionDays) * 86_400)
        guard startedAt <= Date().addingTimeInterval(60), deadline > Date() else {
            throw RecordingError.refused("本次保存起点或期限无效，请重新核对")
        }
        try purgeExpiredRecordings()
        let directory = try sessionDirectory(sessionID)
        guard !fileManager.fileExists(atPath: directory.path) else {
            throw RecordingError.refused("此会话已有原音，请先核对原请求；不会覆盖或重复开始")
        }

        let token = UUID()
        generation = token
        transitionPending = true
        wantsRecording = true
        completedMs = 0
        segmentElapsed = 0
        manifest = nil
        state = State(phase: .requestingPermission, sessionID: sessionID)
        publish()
        defer { transitionPending = false }
        do {
            guard generation == token, wantsRecording else { throw CancellationError() }
            let permitted = await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
                AVAudioApplication.requestRecordPermission { continuation.resume(returning: $0) }
            }
            guard generation == token, wantsRecording else { throw CancellationError() }
            guard permitted else { throw RecordingError.refused("未获得手表麦克风权限，请在手表设置中允许后重新开始") }
            state.phase = .starting
            publish()
            try audioSession.setCategory(.record, mode: .default, options: [])
            try await activateAudioSession()
            guard generation == token, wantsRecording else {
                try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
                throw CancellationError()
            }
            try createPrivateDirectory(directory)
            manifest = Manifest(version: 1, sessionID: sessionID, startedAt: startedAt,
                                expiresAt: deadline, completedChunkCount: 0)
            try writeManifest()
            try beginSegment()
            startMeterTimer()
        } catch {
            if generation == token {
                wantsRecording = false
                discardOpenRecorder()
                try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
                state.phase = .failed
                state.level = 0
                state.error = error.localizedDescription
                publish()
            }
            throw error
        }
    }

    func pause() throws {
        guard !transitionPending, wantsRecording, let recorder,
              state.phase == .starting || state.phase == .recording else {
            throw RecordingError.refused("当前没有可以暂停的手表录音")
        }
        if recorder.isRecording { updateElapsed(recorder) }
        wantsRecording = false
        let previousPhase = state.phase
        state.phase = .pausing
        publish()
        recorder.pause()
        guard !recorder.isRecording else {
            wantsRecording = true
            state.phase = previousPhase
            state.error = "手表尚未确认暂停，请核对录音状态"
            publish()
            throw RecordingError.refused("手表尚未确认暂停，请核对录音状态")
        }
        clearClockMonitoring()
        state.phase = .paused
        state.level = 0
        state.error = nil
        // Close the short segment now. Explicit resume opens a new file in the same session;
        // it cannot overwrite a file that the system may have closed during an interruption.
        do { try finishSegment(isFinal: false) }
        catch { state.error = "已暂停，本段原音封口未确认：\(error.localizedDescription)" }
        do { try audioSession.setActive(false, options: .notifyOthersOnDeactivation) }
        catch { state.error = "已暂停，音频会话释放未确认：\(error.localizedDescription)" }
        publish()
    }

    /// Explicit user action only; interruptions and WatchConnectivity never call this method.
    func resume() async throws {
        guard !transitionPending, state.phase == .paused, let manifest else {
            throw RecordingError.refused("当前没有可继续的手表会话")
        }
        guard manifest.expiresAt > Date() else {
            try purge(sessionID: manifest.sessionID)
            throw RecordingError.refused("本场原音保存期限已到，不能继续")
        }
        let token = generation
        transitionPending = true
        wantsRecording = true
        state.phase = .starting
        state.error = nil
        publish()
        defer { transitionPending = false }
        do {
            try audioSession.setCategory(.record, mode: .default, options: [])
            try await activateAudioSession()
            guard generation == token, wantsRecording else {
                try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
                throw CancellationError()
            }
            if let recorder {
                resetClockMonitoring(startingAt: segmentElapsed)
                guard recorder.record(forDuration: max(0.01, segmentDuration - segmentElapsed)), recorder.isRecording else {
                    throw RecordingError.refused("手表未能恢复录音，未自动重试")
                }
            } else {
                try beginSegment()
            }
            startMeterTimer()
        } catch {
            if generation == token {
                wantsRecording = false
                recorder?.pause()
                try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
                state.phase = .paused
                state.level = 0
                state.error = error.localizedDescription
                publish()
            }
            throw error
        }
    }

    /// Finalizes at most one real tail file. Repeated stops never emit it again.
    func stop() throws {
        guard state.phase != .idle, state.phase != .stopped else { return }
        generation = UUID()
        wantsRecording = false
        let previousError = state.error
        state.phase = .stopping
        state.level = 0
        publish()
        var failure: Error?
        do { try finishSegment(isFinal: true) } catch { failure = error }
        meterTimer?.invalidate()
        meterTimer = nil
        clearClockMonitoring()
        do { try audioSession.setActive(false, options: .notifyOthersOnDeactivation) }
        catch { if failure == nil { failure = error } }
        state.phase = .stopped
        state.error = failure?.localizedDescription ?? previousError
        publish()
        if let failure { throw failure }
    }

    /// Source revocation/expiry deletes locally even if transfer has not completed.
    /// Otherwise the transport must keep files until its explicit successful delivery receipt.
    func purge(sessionID: String) throws {
        try validateSessionID(sessionID)
        if state.sessionID == sessionID, state.phase != .idle, state.phase != .stopped {
            generation = UUID()
            wantsRecording = false
            discardOpenRecorder() // revoked audio must not be handed to the transport
            meterTimer?.invalidate()
            meterTimer = nil
            try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
            manifest = nil
            state.phase = .failed
            state.level = 0
            state.error = "本场原音已撤回或到期，已停止采集并清除本机副本"
            publish()
        }
        let directory = try sessionDirectory(sessionID)
        if fileManager.fileExists(atPath: directory.path) { try fileManager.removeItem(at: directory) }
    }

    /// Call on launch/foreground as well as before starting; no microphone or transfer is activated.
    func purgeExpiredRecordings(now: Date = Date()) throws {
        let root = try recordingsRoot()
        guard fileManager.fileExists(atPath: root.path) else { return }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        for directory in try fileManager.contentsOfDirectory(at: root, includingPropertiesForKeys: [.isDirectoryKey]) {
            let path = directory.appendingPathComponent("recording.json")
            guard let data = try? Data(contentsOf: path),
                  let stored = try? decoder.decode(Manifest.self, from: data), stored.version == 1,
                  directory.lastPathComponent == stored.sessionID, stored.expiresAt <= now else { continue }
            try purge(sessionID: stored.sessionID)
        }
    }

    @discardableResult
    private func beginSegment() throws -> TimeInterval {
        guard wantsRecording, let manifest, manifest.expiresAt > Date() else {
            throw RecordingError.refused("会话已停止或原音保存期限已到")
        }
        let url = try sessionDirectory(manifest.sessionID)
            .appendingPathComponent(String(format: "%06d", state.completedChunkCount) + "-" + UUID().uuidString + ".m4a")
        guard !fileManager.fileExists(atPath: url.path) else {
            throw RecordingError.refused("此段原音已存在，已阻止覆盖")
        }
        let next = try AVAudioRecorder(url: url, settings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 16_000,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 48_000,
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
        ])
        next.isMeteringEnabled = true
        next.delegate = self
        guard next.prepareToRecord() else { throw RecordingError.refused("手表无法准备本段录音文件") }
        try protectFile(url)
        recorder = next
        segmentElapsed = 0
        resetClockMonitoring(startingAt: 0)
        let requestedAt = ProcessInfo.processInfo.systemUptime
        guard next.record(forDuration: segmentDuration), next.isRecording else {
            throw RecordingError.refused("手表未能开始真实录音，未自动重试")
        }
        state.phase = .starting
        state.level = 0
        return requestedAt
    }

    @discardableResult
    private func finishSegment(isFinal: Bool, deferDelivery: Bool = false) throws -> Chunk? {
        guard let finished = recorder else { return nil }
        if finished.isRecording { updateElapsed(finished) }
        recorder = nil // detach before stop; a later delegate callback cannot finalize twice
        finished.delegate = nil
        finished.stop() // synchronously closes the m4a before it is read or transferred
        let file = try AVAudioFile(forReading: finished.url)
        guard file.length > 0, file.processingFormat.sampleRate > 0 else {
            segmentElapsed = 0
            state.elapsedMs = completedMs
            return nil
        }
        let duration = Double(file.length) / file.processingFormat.sampleRate
        guard duration.isFinite, duration > 0, duration <= 30 else {
            throw RecordingError.refused("本段音频时长无效或超过30秒，未交给转写")
        }
        let durationMs = max(1, Int64((duration * 1_000).rounded()))
        let chunk = Chunk(fileURL: finished.url, sessionID: state.sessionID,
                          sequence: state.completedChunkCount, startMs: completedMs,
                          endMs: completedMs + durationMs, isFinal: isFinal)
        try protectFile(finished.url)
        let previousManifest = manifest
        manifest?.completedChunkCount = state.completedChunkCount + 1
        do { try writeManifest() } // persist the count before handing the exact file to transport
        catch { manifest = previousManifest; throw error }
        completedMs += durationMs
        segmentElapsed = 0
        state.elapsedMs = completedMs
        state.completedChunkCount += 1
        if !deferDelivery { onChunk?(chunk) }
        return chunk
    }

    private func startMeterTimer() {
        meterTimer?.invalidate()
        let timer = Timer(timeInterval: 0.2, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.pollMeters() }
        }
        meterTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    private func pollMeters() {
        if let manifest, manifest.expiresAt <= Date() {
            do { try purge(sessionID: manifest.sessionID) }
            catch { state.phase = .failed; state.error = "原音到期清理失败：\(error.localizedDescription)"; publish() }
            return
        }
        guard wantsRecording, !transitionPending else { return }
        guard let recorder else {
            pauseForSystemEvent("手表录音器已停止，已暂停；请核对后明确继续")
            return
        }
        let now = ProcessInfo.processInfo.systemUptime
        guard recorder.isRecording else {
            state.level = 0
            if notRecordingSince == nil { notRecordingSince = now }
            // A normal record(forDuration:) completion can precede its delegate Task.
            // Allow that handoff, but never leave a stopped recorder looking live forever.
            if let since = notRecordingSince, now - since >= 2 {
                pauseForSystemEvent("手表未继续采集音频，已暂停；请核对后明确继续")
            }
            return
        }
        notRecordingSince = nil
        let time = recorder.currentTime // SDK: currentTime is valid only while recording.
        // The duration limit can stop capture between the isRecording and clock reads.
        guard recorder.isRecording else { return }
        guard time.isFinite, time >= 0, time + 0.005 >= lastObservedRecorderTime else {
            pauseForSystemEvent("手表录音时钟异常，已暂停；请核对后明确继续")
            return
        }
        updateElapsed(recorder)
        recorder.updateMeters()
        let average = recorder.averagePower(forChannel: 0)
        state.level = average.isFinite ? min(1, max(0, pow(10, average / 20))) : 0
        // A silent room is valid audio; require the recorder's sample clock to advance,
        // rather than treating a low meter floor as failed microphone input.
        if time > lastObservedRecorderTime + 0.001 {
            lastObservedRecorderTime = time
            lastClockAdvanceUptime = now
            observedClockProgress = true
            state.phase = .recording
            state.error = nil
        } else if let since = lastClockAdvanceUptime,
                  now - since > (observedClockProgress ? 3 : 12) {
            pauseForSystemEvent("录音时钟未能正常前进，已暂停；请检查后明确继续")
            return
        }
        publish()
    }

    private func resetClockMonitoring(startingAt time: TimeInterval) {
        lastObservedRecorderTime = time
        lastClockAdvanceUptime = ProcessInfo.processInfo.systemUptime
        observedClockProgress = false
        notRecordingSince = nil
    }

    private func clearClockMonitoring() {
        lastClockAdvanceUptime = nil
        observedClockProgress = false
        notRecordingSince = nil
    }

    private func recordSwitchGapLowerBound(after sequence: Int, callbackAt: TimeInterval,
                                           requestedAt: TimeInterval) {
        guard callbackAt.isFinite, requestedAt.isFinite, requestedAt >= callbackAt else { return }
        let milliseconds = Int64(((requestedAt - callbackAt) * 1_000).rounded(.down))
        var diagnostics = manifest?.switchDiagnostics ?? SwitchDiagnostics()
        diagnostics.count += 1
        diagnostics.totalMs += milliseconds
        diagnostics.maxMs = max(diagnostics.maxMs, milliseconds)
        diagnostics.lastCompletedSequence = sequence
        diagnostics.lastMs = milliseconds
        manifest?.switchDiagnostics = diagnostics
        // The audio count is already durable. A diagnostic write must not stop valid
        // capture; a later count write also carries these in-memory measurements.
        try? writeManifest()
    }

    private func updateElapsed(_ recorder: AVAudioRecorder) {
        let time = recorder.currentTime
        if time.isFinite, time >= 0 { segmentElapsed = max(segmentElapsed, time) }
        state.elapsedMs = completedMs + Int64((segmentElapsed * 1_000).rounded())
    }

    private func activateAudioSession() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            audioSession.activate(options: []) { active, error in
                if let error { continuation.resume(throwing: error) }
                else if active { continuation.resume() }
                else { continuation.resume(throwing: RecordingError.refused("手表音频会话未激活")) }
            }
        }
    }

    private func pauseForSystemEvent(_ message: String) {
        guard wantsRecording || state.phase == .recording || state.phase == .starting else { return }
        generation = UUID() // invalidate in-flight explicit activation; never reactivate automatically
        wantsRecording = false
        var detail = message
        do { try finishSegment(isFinal: false) }
        catch { detail += "；本段封口未确认：\(error.localizedDescription)" }
        try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
        clearClockMonitoring()
        state.phase = .paused
        state.level = 0
        state.error = detail
        publish()
    }

    private func discardOpenRecorder() {
        let previous = recorder
        recorder = nil
        previous?.delegate = nil
        previous?.stop()
        clearClockMonitoring()
    }

    private func recordingsRoot() throws -> URL {
        guard let support = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            throw RecordingError.refused("无法定位手表私人录音目录")
        }
        return support.appendingPathComponent("OopsWatchAudio", isDirectory: true)
    }

    private func sessionDirectory(_ sessionID: String) throws -> URL {
        try validateSessionID(sessionID)
        return try recordingsRoot().appendingPathComponent(sessionID, isDirectory: true)
    }

    private func validateSessionID(_ value: String) throws {
        guard value.range(of: "^[A-Za-z0-9_-]{1,100}$", options: .regularExpression) != nil else {
            throw RecordingError.refused("手表会话编号无效")
        }
    }

    private func createPrivateDirectory(_ directory: URL) throws {
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication,
                         .posixPermissions: 0o700])
        var root = try recordingsRoot()
        var rootValues = URLResourceValues()
        rootValues.isExcludedFromBackup = true
        try root.setResourceValues(rootValues)
        var destination = directory
        try destination.setResourceValues(rootValues)
    }

    private func protectFile(_ url: URL) throws {
        try fileManager.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication,
                                       .posixPermissions: 0o600], ofItemAtPath: url.path)
        var protected = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try protected.setResourceValues(values)
    }

    private func writeManifest() throws {
        guard let manifest else { return }
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let url = try sessionDirectory(manifest.sessionID).appendingPathComponent("recording.json")
        try encoder.encode(manifest).write(to: url, options: .atomic)
        try protectFile(url)
    }

    private func publish() { onStateChange?(state) }

    @objc nonisolated private func interrupted(_ notification: Notification) {
        let kind = (notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? NSNumber)?.uintValue
        guard kind == AVAudioSession.InterruptionType.began.rawValue else { return }
        Task { @MainActor [weak self] in self?.pauseForSystemEvent("系统中断了手表录音，已暂停；中断结束后需明确继续") }
    }

    @objc nonisolated private func mediaServicesUnavailable(_ notification: Notification) {
        Task { @MainActor [weak self] in self?.pauseForSystemEvent("手表音频服务已中断，已暂停；请检查后明确继续") }
    }

    @objc nonisolated private func routeChanged(_ notification: Notification) {
        let reason = (notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? NSNumber)?.uintValue
        guard reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue else { return }
        Task { @MainActor [weak self] in self?.pauseForSystemEvent("手表音频输入发生变化，已暂停；请核对音源后明确继续") }
    }
}

extension WatchAudioRecorder: AVAudioRecorderDelegate {
    nonisolated func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        let identity = ObjectIdentifier(recorder)
        let recordingURL = recorder.url
        let callbackAt = ProcessInfo.processInfo.systemUptime
        Task { @MainActor [weak self] in
            guard let self, let current = self.recorder, ObjectIdentifier(current) == identity,
                  current.url == recordingURL else { return }
            guard flag else {
                self.pauseForSystemEvent("手表本段录音未能正常结束，已暂停；请核对后明确继续")
                return
            }
            let token = self.generation
            do {
                // A paused session is not ended. Explicit stop detaches its delegate first.
                let chunk = try self.finishSegment(isFinal: false, deferDelivery: true)
                guard self.generation == token, self.wantsRecording else {
                    if let chunk { self.onChunk?(chunk) }
                    return
                }
                let requestedAt: TimeInterval
                do {
                    // Keep the count durable first, then restart before the caller's
                    // synchronous business persistence, hashing and WC file transfer.
                    requestedAt = try self.beginSegment()
                } catch {
                    if let chunk { self.onChunk?(chunk) } // preserve the sealed old file
                    throw error
                }
                if let chunk {
                    self.recordSwitchGapLowerBound(after: chunk.sequence, callbackAt: callbackAt,
                                                   requestedAt: requestedAt)
                    self.onChunk?(chunk)
                }
                self.publish()
            } catch {
                self.pauseForSystemEvent("手表无法继续分段录音：\(error.localizedDescription)")
            }
        }
    }

    nonisolated func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
        let identity = ObjectIdentifier(recorder)
        let recordingURL = recorder.url
        let detail = error?.localizedDescription ?? "未知编码错误"
        Task { @MainActor [weak self] in
            guard let self, let current = self.recorder, ObjectIdentifier(current) == identity,
                  current.url == recordingURL else { return }
            self.pauseForSystemEvent("手表音频编码失败：\(detail)；已暂停，不会自动重录")
        }
    }
}
#endif
