#if os(watchOS)
import Foundation
import Combine

@MainActor final class WatchBusinessStore: ObservableObject {
    @Published private(set) var meeting: WatchMeeting?
    @Published private(set) var elapsedMs: Int64 = 0
    @Published private(set) var level: Float = 0
    @Published private(set) var issue: String?
    let recorder = WatchAudioRecorder()
    let transport = BusinessTransport.shared
    private var lastPhase = ""
    private var lastCount = -1
    #if DEBUG
    var foregroundForUSBCheck = false
    #endif
    private let stateURL = BusinessFiles.root.appendingPathComponent("watch-current.json")

    init() {
        if let data = try? Data(contentsOf: stateURL), var old = try? BusinessCodec.decode(WatchMeeting.self, data), old.valid {
            if old.active {
                old.phase = "interrupted"; old.endedAt = Date(); old.revision += 1
                old.expectedChunkCount = old.expectedChunkCount ?? 0
                old.error = "录音进程曾中断；仅保留已经封口的片段，未自动继续。"
            }
            meeting = old; elapsedMs = old.elapsedMs
        }
        recorder.onStateChange = { [weak self] state in self?.stateChanged(state) }
        recorder.onChunk = { [weak self] chunk in self?.chunkReady(chunk) }
        transport.onRefresh = { [weak self] in
            guard let self, let meeting = self.meeting else { return }
            self.transport.publishMeeting(meeting)
        }
        cleanExpired()
        persist()
    }
    var isActive: Bool { meeting?.active == true }
    var canStart: Bool { !isActive && transport.activated && transport.peerReady?.canStart == true }
    func start(audioDays: Int, textDays: Int, confirmed: Bool, sessionID: UUID = UUID()) async {
        guard canStart, confirmed, [7,30,90].contains(audioDays), [7,30,90].contains(textDays), let ready = transport.peerReady, ready.canStart else {
            issue = "先在 iPhone 完成服务连接与转写授权，并确认本次保存。"; return
        }
        let now = Date()
        meeting = WatchMeeting(id: sessionID.uuidString, title: "手表会议", startedAt: now, endedAt: nil, phase: "preparing", revision: 0, audioDays: audioDays, textDays: textDays, cloudSaveConfirmed: true, grantID: ready.grantID, expectedChunkCount: 0, elapsedMs: 0, error: nil)
        issue = nil; lastPhase = ""; lastCount = -1; elapsedMs = 0
        persist(); if let meeting { transport.publishMeeting(meeting) }
        do { try await recorder.start(sessionID: meeting!.id, audioRetentionDays: audioDays, cloudSaveConfirmed: true, startedAt: now) }
        catch { issue = error.localizedDescription }
    }
    func pause() { do { try recorder.pause() } catch { issue = error.localizedDescription } }
    func resume() async { do { try await recorder.resume() } catch { issue = error.localizedDescription } }
    func stop() { do { try recorder.stop() } catch { issue = error.localizedDescription } }
    func refresh() { cleanExpired(); transport.refresh() }
    func checkPhoneAuthorization() {
        guard let meeting else { return }
        let changedGrant = transport.peerReady.map { $0.grantID != meeting.grantID } ?? false
        let revokedSource = transport.progress.map { $0.sessionID == meeting.id && $0.state == "unavailable" } ?? false
        guard changedGrant || revokedSource else { return }
        transport.revokeAudio(sessionID: meeting.id)
        do { try recorder.purge(sessionID: meeting.id) }
        catch { issue = "已停止本场接力，原音清理需重试：\(error.localizedDescription)"; return }
        var revoked = meeting
        revoked.phase = "failed"; revoked.endedAt = revoked.endedAt ?? Date(); revoked.revision += 1
        revoked.error = "本场手机授权或来源已失效，已停止录音并撤回本机原音。"
        self.meeting = revoked; issue = revoked.error; persist()
    }
    private func stateChanged(_ state: WatchAudioRecorder.State) {
        guard var meeting, state.sessionID == meeting.id else { return }
        elapsedMs = state.elapsedMs; level = state.level
        let phase = String(describing: state.phase)
        guard phase != lastPhase || state.completedChunkCount != lastCount || state.error != meeting.error else { return }
        lastPhase = phase; lastCount = state.completedChunkCount
        meeting.phase = phase; meeting.elapsedMs = state.elapsedMs; meeting.error = state.error
        meeting.expectedChunkCount = state.completedChunkCount
        meeting.revision += 1
        if phase == "stopped" || phase == "failed" { meeting.endedAt = Date() }
        self.meeting = meeting; issue = state.error
        persist(); transport.publishMeeting(meeting)
    }
    private func chunkReady(_ chunk: WatchAudioRecorder.Chunk) {
        guard var meeting, chunk.sessionID == meeting.id else { return }
        meeting.expectedChunkCount = max(meeting.expectedChunkCount ?? 0, chunk.sequence + 1)
        meeting.revision += 1; self.meeting = meeting; persist()
        transport.sendAudio(chunk.fileURL, meeting: meeting, sequence: chunk.sequence, startMs: chunk.startMs, endMs: chunk.endMs)
    }
    private func persist() { if let meeting, let data = try? BusinessCodec.encode(meeting) { try? BusinessFiles.write(data, to: stateURL) } }
    private func cleanExpired() {
        transport.cancelExpiredAudioTransfers()
        try? recorder.purgeExpiredRecordings()
        if let meeting, max(meeting.audioExpiresAt, meeting.textExpiresAt) <= Date() {
            self.meeting = nil; try? FileManager.default.removeItem(at: stateURL)
        }
    }
}
#endif
