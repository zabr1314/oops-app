import Foundation
import Combine
import WatchConnectivity

/// State, files and durable receipts only; recording commands are never queued or replayed.
final class BusinessTransport: NSObject, ObservableObject, WCSessionDelegate {
    static let shared = BusinessTransport()
    @Published private(set) var activated = false
    @Published private(set) var reachable = false
    @Published private(set) var peerReady: PhoneReadiness?
    @Published private(set) var progress: PhoneMeetingProgress?
    @Published private(set) var latestMeeting: WatchMeeting?
    @Published private(set) var issue: String?
    var onMeeting: ((WatchMeeting) -> Void)?
    var onAudio: ((WatchMeeting, AudioChunkDescriptor, URL) -> Void)?
    var onRefresh: (() -> Void)?
    private var session: WCSession?
    private var revisions: [String: Int] = [:]
    private var meetings: [String: WatchMeeting] = [:]
    private var progressDates: [String: Date] = [:]
    private var publishedPhoneAt = Date.distantPast
    // WC file delegates run off-main. Serialize authorization changes with private copies.
    private let grantLock = NSRecursiveLock()
    private var authorizedGrantID: String?
    private var grantEpoch = 0
    private var pendingAudio: [String: PendingAudio] = [:]
    private let ledgerURL = BusinessFiles.root.appendingPathComponent("watch-audio-outbox.json")
    private let peerURL = BusinessFiles.root.appendingPathComponent("watch-phone-readiness.json")

    private struct PendingAudio: Codable {
        var meeting: WatchMeeting
        var chunk: AudioChunkDescriptor
        var relativePath: String
        var acknowledged: Bool
    }

    private override init() {
        super.init()
        #if os(watchOS)
        if let data = try? Data(contentsOf: ledgerURL), let saved = try? BusinessCodec.decode([String: PendingAudio].self, data) { pendingAudio = saved }
        if let data = try? Data(contentsOf: peerURL) { peerReady = try? BusinessCodec.decode(PhoneReadiness.self, data) }
        #endif
        guard WCSession.isSupported() else { issue = "此设备不支持与配对设备同步"; return }
        let session = WCSession.default; self.session = session
        session.delegate = self; session.activate()
    }

    /// Phone: nil rejects new file copies immediately, including queued old-grant transfers.
    func setAuthorizedGrantID(_ id: String?) {
        let next = id.flatMap { $0.isEmpty ? nil : $0 }
        grantLock.lock()
        let changed = authorizedGrantID != next
        if changed { authorizedGrantID = next; grantEpoch += 1 }
        grantLock.unlock()
        guard changed else { return }
        onMain {
            self.progress = nil; self.latestMeeting = nil
            self.revisions.removeAll(); self.meetings.removeAll(); self.progressDates.removeAll()
            for transfer in self.session?.outstandingUserInfoTransfers ?? [] {
                if let data = transfer.userInfo["audioReceipt"] as? Data,
                   let receipt = try? BusinessCodec.decode(PhoneAudioReceipt.self, data), receipt.grantID != next { transfer.cancel() }
            }
        }
    }

    func refresh() {
        guard let session else { return }
        activated = session.activationState == .activated
        reachable = activated && session.isReachable
        if activated { consume(session.receivedApplicationContext) }
        cancelExpiredAudioTransfers(); flushPendingAudio()
        if reachable { session.sendMessage(["oopsBusinessVersion": 1, "refresh": true], replyHandler: { _ in }, errorHandler: { _ in }) }
        if let progress, progress.validUntil <= Date() { self.progress = nil }
    }

    func publishMeeting(_ meeting: WatchMeeting) {
        guard meeting.valid else { return }
        meetings[meeting.id] = meeting
        if latestMeeting == nil || latestMeeting?.id == meeting.id || meeting.startedAt >= latestMeeting!.startedAt { latestMeeting = meeting }
        #if os(watchOS)
        var changed = false
        for key in Array(pendingAudio.keys) where pendingAudio[key]?.meeting.id == meeting.id {
            if let old = pendingAudio[key]?.meeting, sameContract(old, meeting), meeting.revision >= old.revision { pendingAudio[key]?.meeting = meeting; changed = true }
        }
        if changed { do { try persistLedger() } catch { issue = "片段清单更新失败：\(error.localizedDescription)" } }
        #endif
        guard let data = try? BusinessCodec.encode(meeting), let session, session.activationState == .activated else { return }
        let value: [String: Any] = ["oopsBusinessVersion": 1, "meeting": data]
        do { try session.updateApplicationContext(value); session.transferUserInfo(value) }
        catch { issue = "会话状态待同步：\(error.localizedDescription)" }
    }

    func sendAudio(_ url: URL, meeting: WatchMeeting, sequence: Int, startMs: Int64, endMs: Int64) {
        #if os(watchOS)
        do {
            guard meeting.valid, meeting.audioExpiresAt > Date() else { throw BusinessError.message("此段原音已到期或来源无效") }
            let data = try Data(contentsOf: url, options: .mappedIfSafe)
            let chunk = AudioChunkDescriptor(sessionID: meeting.id, sequence: sequence, startMs: startMs, endMs: endMs, size: data.count, sha256: BusinessCodec.hash(data))
            guard chunk.valid else { throw BusinessError.message("录音片段格式无效") }
            let key = audioKey(chunk)
            if let old = pendingAudio[key] {
                guard old.chunk == chunk, sameContract(old.meeting, meeting) else { throw BusinessError.message("同一序号的音频发生变化，已阻止重复传送") }
            } else {
                pendingAudio[key] = PendingAudio(meeting: meeting, chunk: chunk, relativePath: try relativeAudioPath(url), acknowledged: false)
                do { try persistLedger() } catch { pendingAudio.removeValue(forKey: key); throw error }
            }
            flushPendingAudio()
        } catch { issue = "音频未发出，仍保留在手表：\(error.localizedDescription)" }
        #endif
    }

    func publishPhone(readiness: PhoneReadiness, progress: PhoneMeetingProgress?) {
        guard let session, session.activationState == .activated else { return }
        do {
            var readiness = readiness
            readiness.issuedAt = max(readiness.issuedAt, publishedPhoneAt.addingTimeInterval(0.001))
            publishedPhoneAt = readiness.issuedAt
            var value: [String: Any] = ["oopsBusinessVersion": 1, "phone": try BusinessCodec.encode(readiness)]
            if var progress {
                progress.updatedAt = max(progress.updatedAt, readiness.issuedAt)
                value["progress"] = try BusinessCodec.encode(progress)
            }
            try session.updateApplicationContext(value)
            if session.isReachable { session.sendMessage(value, replyHandler: nil, errorHandler: { _ in }) }
        } catch { issue = "手机状态暂未同步到手表" }
    }

    /// Receipt for any authorized meeting; does not replace the currently visible progress.
    func publishAudioReceipt(meetingID: String, grantID: String, receivedSHA256: [Int: String]) {
        guard UUID(uuidString: meetingID) != nil, !receivedSHA256.isEmpty,
              authorization().id == grantID, let session, session.activationState == .activated else { return }
        do {
            let receipt = PhoneAudioReceipt(sessionID: meetingID, grantID: grantID, receivedSHA256: receivedSHA256)
            let value: [String: Any] = ["oopsBusinessVersion": 1, "audioReceipt": try BusinessCodec.encode(receipt)]
            if session.isReachable { session.sendMessage(value, replyHandler: nil, errorHandler: { _ in }) }
            let queued = session.outstandingUserInfoTransfers.contains { transfer in
                guard let data = transfer.userInfo["audioReceipt"] as? Data,
                      let old = try? BusinessCodec.decode(PhoneAudioReceipt.self, data) else { return false }
                return old.sessionID == meetingID && old.grantID == grantID && old.receivedSHA256 == receivedSHA256
            }
            if !queued { session.transferUserInfo(value) }
        } catch { issue = "原音接收回执暂未同步到手表" }
    }

    func revokeAudio(sessionID: String) {
        for transfer in session?.outstandingFileTransfers ?? [] {
            if let data = transfer.file.metadata?["meeting"] as? Data,
               let meeting = try? BusinessCodec.decode(WatchMeeting.self, data), meeting.id == sessionID { transfer.cancel() }
        }
        for transfer in session?.outstandingUserInfoTransfers ?? [] {
            if let data = transfer.userInfo["meeting"] as? Data,
               let meeting = try? BusinessCodec.decode(WatchMeeting.self, data), meeting.id == sessionID { transfer.cancel() }
        }
        #if os(watchOS)
        for key in Array(pendingAudio.keys) where pendingAudio[key]?.meeting.id == sessionID {
            if let path = pendingAudio[key]?.relativePath, let url = try? audioURL(path) { try? FileManager.default.removeItem(at: url) }
            pendingAudio.removeValue(forKey: key)
        }
        do { try persistLedger() } catch { issue = "撤回片段清单保存失败" }
        #endif
    }

    func cancelExpiredAudioTransfers() {
        let now = Date()
        for transfer in session?.outstandingFileTransfers ?? [] {
            if let data = transfer.file.metadata?["meeting"] as? Data,
               let meeting = try? BusinessCodec.decode(WatchMeeting.self, data), meeting.audioExpiresAt <= now { transfer.cancel() }
        }
        #if os(watchOS)
        var changed = false
        for key in Array(pendingAudio.keys) {
            guard let item = pendingAudio[key], item.meeting.audioExpiresAt <= now else { continue }
            if let url = try? audioURL(item.relativePath) { try? FileManager.default.removeItem(at: url) }
            pendingAudio.removeValue(forKey: key); changed = true
        }
        if changed { do { try persistLedger() } catch { issue = "过期片段清单保存失败" } }
        #endif
    }

    private func consume(_ value: [String: Any]) {
        guard value["oopsBusinessVersion"] as? Int == 1 else { return }
        var acceptSnapshot = value["phone"] == nil
        if let data = value["phone"] as? Data, let incoming = try? BusinessCodec.decode(PhoneReadiness.self, data),
           incoming.issuedAt <= Date().addingTimeInterval(300) {
            if peerReady == nil || incoming.issuedAt > peerReady!.issuedAt {
                let oldGrant = peerReady?.grantID
                peerReady = incoming; acceptSnapshot = true
                if oldGrant != incoming.grantID { progress = nil; progressDates.removeAll(); revokeOtherAudioGrants(incoming.grantID) }
                #if os(watchOS)
                if let data = try? BusinessCodec.encode(incoming) { try? BusinessFiles.write(data, to: peerURL) }
                #endif
            } else if incoming == peerReady { acceptSnapshot = true }
        }
        if acceptSnapshot, value["phone"] != nil, value["progress"] == nil { progress = nil }
        if acceptSnapshot, let data = value["progress"] as? Data,
           let incoming = try? BusinessCodec.decode(PhoneMeetingProgress.self, data),
           incoming.validUntil > Date(), incoming.grantID == peerReady?.grantID,
           incoming.updatedAt <= Date().addingTimeInterval(300),
           incoming.updatedAt >= (progressDates[incoming.sessionID] ?? .distantPast) {
            progressDates[incoming.sessionID] = incoming.updatedAt
            if latestMeeting == nil || incoming.sessionID == latestMeeting?.id { progress = incoming }
            acceptReceipt(sessionID: incoming.sessionID, grantID: incoming.grantID, hashes: incoming.receivedSHA256)
        }
        if let data = value["audioReceipt"] as? Data, let receipt = try? BusinessCodec.decode(PhoneAudioReceipt.self, data) {
            acceptReceipt(sessionID: receipt.sessionID, grantID: receipt.grantID, hashes: receipt.receivedSHA256)
        }
        if let data = value["meeting"] as? Data, let meeting = try? BusinessCodec.decode(WatchMeeting.self, data), meeting.valid {
            #if os(iOS)
            guard authorization().id == meeting.grantID else { return }
            #endif
            if let old = meetings[meeting.id], !sameContract(old, meeting) { issue = "会话保存合同变化，已拒绝旧来源"; return }
            if meeting.revision > (revisions[meeting.id] ?? -1) {
                revisions[meeting.id] = meeting.revision; meetings[meeting.id] = meeting
                if latestMeeting == nil || latestMeeting?.id == meeting.id || meeting.startedAt >= latestMeeting!.startedAt { latestMeeting = meeting }
                onMeeting?(meeting)
            }
        }
        if value["refresh"] as? Bool == true { onRefresh?() }
        flushPendingAudio()
    }

    private func acceptReceipt(sessionID: String, grantID: String, hashes: [Int: String]) {
        #if os(watchOS)
        guard !grantID.isEmpty, grantID == peerReady?.grantID else { return }
        var changed = false
        for (sequence, hash) in hashes {
            let key = "\(sessionID):\(sequence)"
            guard let item = pendingAudio[key], item.meeting.grantID == grantID,
                  item.meeting.audioExpiresAt > Date(), item.chunk.sha256 == hash, !item.acknowledged else { continue }
            pendingAudio[key]?.acknowledged = true; changed = true
        }
        if changed { do { try persistLedger() } catch { issue = "手机已接收，手表回执保存失败" } }
        #endif
    }

    private func flushPendingAudio() {
        #if os(watchOS)
        guard let session, session.activationState == .activated, let ready = peerReady,
              !ready.grantID.isEmpty, ready.validUntil > Date() else { return }
        for item in pendingAudio.values.sorted(by: { ($0.meeting.startedAt, $0.chunk.sequence) < ($1.meeting.startedAt, $1.chunk.sequence) }) {
            guard !item.acknowledged, item.meeting.audioExpiresAt > Date(), item.meeting.grantID == ready.grantID else { continue }
            let queued = session.outstandingFileTransfers.contains { transfer in
                guard let data = transfer.file.metadata?["chunk"] as? Data,
                      let chunk = try? BusinessCodec.decode(AudioChunkDescriptor.self, data) else { return false }
                return chunk.sessionID == item.chunk.sessionID && chunk.sequence == item.chunk.sequence && chunk.sha256 == item.chunk.sha256
            }
            guard !queued else { continue }
            do {
                let url = try audioURL(item.relativePath)
                let data = try Data(contentsOf: url, options: .mappedIfSafe)
                guard data.count == item.chunk.size, BusinessCodec.hash(data) == item.chunk.sha256 else { throw BusinessError.message("原音与待传清单不一致") }
                session.transferFile(url, metadata: ["oopsBusinessVersion": 1, "meeting": try BusinessCodec.encode(item.meeting), "chunk": try BusinessCodec.encode(item.chunk)])
            } catch { issue = "片段仍待核对：\(error.localizedDescription)" }
        }
        #endif
    }

    private func revokeOtherAudioGrants(_ grantID: String) {
        #if os(watchOS)
        for transfer in session?.outstandingFileTransfers ?? [] {
            if let data = transfer.file.metadata?["meeting"] as? Data,
               let meeting = try? BusinessCodec.decode(WatchMeeting.self, data), meeting.grantID != grantID { transfer.cancel() }
        }
        var changed = false
        for key in Array(pendingAudio.keys) {
            guard let item = pendingAudio[key], item.meeting.grantID != grantID else { continue }
            if let url = try? audioURL(item.relativePath) { try? FileManager.default.removeItem(at: url) }
            pendingAudio.removeValue(forKey: key); changed = true
        }
        if changed { do { try persistLedger() } catch { issue = "撤回原音后的清单保存失败" } }
        #endif
    }

    private func persistLedger() throws { try BusinessFiles.write(try BusinessCodec.encode(pendingAudio), to: ledgerURL) }
    private func audioKey(_ chunk: AudioChunkDescriptor) -> String { "\(chunk.sessionID):\(chunk.sequence)" }
    private func relativeAudioPath(_ url: URL) throws -> String {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].standardizedFileURL.path + "/"
        let path = url.standardizedFileURL.path
        guard path.hasPrefix(base) else { throw BusinessError.message("录音文件不在本机私人目录") }
        return String(path.dropFirst(base.count))
    }
    private func audioURL(_ path: String) throws -> URL {
        guard !path.isEmpty, !path.hasPrefix("/"), !path.split(separator: "/").contains("..") else { throw BusinessError.message("待传音频路径无效") }
        return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent(path)
    }
    private func sameContract(_ lhs: WatchMeeting, _ rhs: WatchMeeting) -> Bool {
        lhs.id == rhs.id && lhs.grantID == rhs.grantID && lhs.startedAt == rhs.startedAt && lhs.audioDays == rhs.audioDays
            && lhs.textDays == rhs.textDays && lhs.cloudSaveConfirmed == rhs.cloudSaveConfirmed
    }
    private func authorization() -> (id: String?, epoch: Int) {
        grantLock.lock(); defer { grantLock.unlock() }
        return (authorizedGrantID, grantEpoch)
    }
    private func onMain(_ body: @escaping () -> Void) { if Thread.isMainThread { body() } else { DispatchQueue.main.async(execute: body) } }

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        DispatchQueue.main.async { self.refresh(); self.onRefresh?(); if let error { self.issue = error.localizedDescription } }
    }
    func sessionReachabilityDidChange(_ session: WCSession) { DispatchQueue.main.async { self.refresh(); self.onRefresh?() } }
    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) { DispatchQueue.main.async { self.consume(applicationContext) } }
    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any]) { DispatchQueue.main.async { self.consume(userInfo) } }
    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) { DispatchQueue.main.async { self.consume(message) } }
    func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
        replyHandler(["received": true]); DispatchQueue.main.async { self.consume(message) }
    }
    func session(_ session: WCSession, didReceive file: WCSessionFile) {
        // WC deletes this temporary URL on return: authorization and private copy are synchronous.
        guard let meta = file.metadata, meta["oopsBusinessVersion"] as? Int == 1,
              let md = meta["meeting"] as? Data, let cd = meta["chunk"] as? Data,
              let meeting = try? BusinessCodec.decode(WatchMeeting.self, md), meeting.valid,
              let chunk = try? BusinessCodec.decode(AudioChunkDescriptor.self, cd), chunk.valid,
              chunk.sessionID == meeting.id, meeting.audioExpiresAt > Date() else { return }
        grantLock.lock()
        guard authorizedGrantID == meeting.grantID else { grantLock.unlock(); return }
        let epoch = grantEpoch
        do {
            let data = try Data(contentsOf: file.fileURL, options: .mappedIfSafe)
            guard data.count == chunk.size, BusinessCodec.hash(data) == chunk.sha256 else { throw BusinessError.message("音频校验未通过") }
            // Each delegate delivery owns its temporary copy. Duplicate WC callbacks
            // may reach the main actor together; one must not delete another's file.
            let url = try BusinessFiles.session(meeting.id).appendingPathComponent("chunk-\(chunk.sequence)-\(chunk.sha256)-\(UUID().uuidString).m4a")
            try BusinessFiles.write(data, to: url)
            grantLock.unlock()
            DispatchQueue.main.async {
                let current = self.authorization()
                guard current.id == meeting.grantID, current.epoch == epoch, meeting.audioExpiresAt > Date() else { try? FileManager.default.removeItem(at: url); return }
                self.onAudio?(meeting, chunk, url)
            }
        } catch {
            grantLock.unlock()
            DispatchQueue.main.async { self.issue = "接收音频失败：\(error.localizedDescription)" }
        }
    }
    func session(_ session: WCSession, didFinish fileTransfer: WCSessionFileTransfer, error: Error?) {
        if let error { DispatchQueue.main.async { self.issue = "片段传输未确认，原音仍在手表：\(error.localizedDescription)" } }
        // WC delivery is not the phone's durable receipt. Never acknowledge or delete here.
    }
    #if os(iOS)
    func sessionDidBecomeInactive(_ session: WCSession) { DispatchQueue.main.async { self.refresh() } }
    func sessionDidDeactivate(_ session: WCSession) { session.activate() }
    func sessionWatchStateDidChange(_ session: WCSession) { DispatchQueue.main.async { self.refresh(); self.onRefresh?() } }
    #endif
}
