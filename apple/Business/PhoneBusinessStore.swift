#if os(iOS)
import Combine
import CryptoKit
import Foundation
#if DEBUG
import CoreFoundation

struct PhoneCapabilityNSErrorDiagnostic: Codable, Equatable {
    var domain: String
    var code: Int
    var streamErrorDomain: Int?
    var streamErrorCode: Int?
}

struct PhoneCapabilityDiagnostic: Codable, Equatable {
    var outcome: String
    var schemaMatched: Bool?
    var available: Bool?
    var error: PhoneCapabilityNSErrorDiagnostic?
    var underlyingErrors: [PhoneCapabilityNSErrorDiagnostic]?
    var httpStatus: Int?
    var gatewayCode: String?
}
#endif

struct PhoneASRStatus: Codable, Equatable {
    var phase = "disconnected"
    var engine = "volc-bigmodel-async"
    var available = false
    var message = "请先连接 Oops 业务服务"
    var checkedAt: Date?
    #if DEBUG
    var diagnostics: PhoneCapabilityDiagnostic?
    #endif
}

struct PhoneASRDisplayUtterance: Decodable, Identifiable {
    var id: String
    var text: String
    var start_ms: Int64
    var end_ms: Int64
}

/// Provider literals are evidence for review, never a meeting audio timestamp.
struct PhoneASRProviderCoordinate: Codable {
    var present: Bool
    var raw_json: String
}

struct PhoneASRProviderCoordinates: Codable {
    var start_time: PhoneASRProviderCoordinate
    var end_time: PhoneASRProviderCoordinate
}

struct PhoneASRRejectedFinal: Codable, Identifiable {
    var id: Int { index }
    var index: Int
    var text: String
    var reason: String
    var provider_coordinates: PhoneASRProviderCoordinates
}

struct PhoneChunkRecord: Codable, Identifiable {
    var id: String { "\(descriptor.sequence):\(descriptor.sha256)" }
    var descriptor: AudioChunkDescriptor
    var state = "pending"
    var text: String?
    var issue: String?
    var audioFile: String?
    var pcmFile: String?
    var pcmHash: String?
    var asrProvider: String?
    var backendUtterances: Data?
    var providerClosure: String?
    var backendProcessing: Data?
    var backendRejectedFinals: [PhoneASRRejectedFinal]?
    var backendASRDiagnostics: Data?
    var rejectedFinals: [PhoneASRRejectedFinal] { backendRejectedFinals ?? [] }
    var rejectedOverflowCount: Int { diagnosticCount("rejected_overflow_count") }
    var hasRejectedFinals: Bool {
        !rejectedFinals.isEmpty || diagnosticCount("rejected_final_count") > 0 || rejectedOverflowCount > 0
    }
    var utterances: [PhoneASRDisplayUtterance] {
        guard let data = backendUtterances else { return [] }
        return (try? JSONDecoder().decode([PhoneASRDisplayUtterance].self, from: data)) ?? []
    }
    private func diagnosticCount(_ key: String) -> Int {
        guard let data = backendASRDiagnostics,
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let count = object[key] as? Int, count > 0 else { return 0 }
        return count
    }
}

fileprivate struct PhoneASRRequest: Codable {
    var id: String
    var sequence: Int
    var pcmFile: String
    var pcmHash: String
    var size: Int
    var startMs: Int64
    var endMs: Int64
    var state: String
    var response: Data?
}

fileprivate struct PhoneWriteReceipt: Codable {
    var id: String
    var path: String
    var body: Data?
    var uploadOffset: Int?
    var uploadLength: Int?
    var contentHash: String
    var asset: String
    var state = "attempted"
    var response: Data?
}

struct PhoneMeetingRecord: Codable, Identifiable {
    var id: String { meeting.id }
    var meeting: WatchMeeting
    var chunks: [PhoneChunkRecord] = []
    var serverID: String?
    var status = "等待手表音频"
    var summary: String?
    var endpoint: String
    var grantID: String
    var serverStartedAt: String?
    var serverTimeZone: String?
    var storagePolicy: Data?
    var summaryCheckedAt: Date?
    var audioUploaded = false
    var asrClosed = false
    var frozenASRClosure: String?
    var unavailableAssets: [String]?
    var sourceUnavailable = false
    var lastSyncHash: String?
    var transcriptionEngine: String?
    var legacyASRLocked: Bool?
    fileprivate var asrRequests: [PhoneASRRequest]?
    fileprivate var requests: [PhoneWriteReceipt] = []
}

/// iPhone owns transcription, canonical backend mapping and receipts. No credential reaches Watch.
@available(iOS 26.0, *)
@MainActor
final class PhoneBusinessStore: ObservableObject {
    @Published private(set) var records: [PhoneMeetingRecord] = []
    @Published private(set) var issue: String?
    @Published private(set) var busy = false
    @Published private(set) var asrReady = false
    @Published private(set) var asrStatus = PhoneASRStatus()
    var configuration: MobileConfiguration? { gateway.configuration }
    var visibleRecords: [PhoneMeetingRecord] { records.filter { matchesConfiguration($0) && !$0.sourceUnavailable } }

    private let transport: BusinessTransport
    private let gateway: MobileGateway
    private let audio = PhoneAudioProcessing()
    private var active = false
    private var connecting = false
    private var generation = 0
    private var worker: Task<Void, Never>?
    private var maintenance: Task<Void, Never>?
    private var capabilityTask: Task<Void, Never>?
    private var capabilityBinding: MobileConfiguration?
    private let backendEngine = "volc-bigmodel-async"
    private var workAgain = false
    private var storageHealthy = true
    private var durableAudio: [String: [Int: String]] = [:]
    #if DEBUG
    private var lastReadinessDiagnostic: Data?
    private var verificationTask: Task<Void, Never>?
    #endif
    private let maximumPCMBytes = 64 * 1_024 * 1_024
    private let maximumRecordingMs: Int64 = 30 * 60 * 1_000
    private var databaseURL: URL { BusinessFiles.root.appendingPathComponent("phone-meetings-v1.json") }

    init(transport: BusinessTransport = .shared, gateway: MobileGateway = MobileGateway()) {
        self.transport = transport
        self.gateway = gateway
        do {
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: BusinessFiles.root.path)
            if FileManager.default.fileExists(atPath: databaseURL.path) {
                records = try BusinessCodec.decode([PhoneMeetingRecord].self, Data(contentsOf: databaseURL))
                guard Set(records.map(\.id)).count == records.count,
                      records.allSatisfy({ UUID(uuidString: $0.id) != nil && Set($0.chunks.map { $0.descriptor.sequence }).count == $0.chunks.count }) else {
                    throw BusinessError.message("本机记录的会话或片段编号冲突")
                }
                records.sort { $0.meeting.startedAt > $1.meeting.startedAt }
            }
            // A killed process cannot establish whether an in-flight write was delivered.
            for index in records.indices {
                records[index].summary = nil
                records[index].summaryCheckedAt = nil
                for chunk in records[index].chunks.indices where records[index].chunks[chunk].state == "processing" {
                    records[index].chunks[chunk].state = "pending"
                }
                for request in records[index].requests.indices where records[index].requests[request].state == "attempted" {
                    records[index].requests[request].state = "unknown"
                }
                migrateTranscription(at: index)
            }
            try pruneExpired()
            try persist()
        } catch {
            storageHealthy = false
            issue = "本机业务记录读取失败，请先恢复本机记录，避免丢失原请求回执。"
        }
        transport.setAuthorizedGrantID(storageHealthy && gateway.isConfigured ? gateway.configuration?.grantID : nil)
        transport.onMeeting = { [weak self] meeting in
            Task { @MainActor [weak self] in self?.receive(meeting) }
        }
        transport.onAudio = { [weak self] meeting, chunk, url in
            Task { @MainActor [weak self] in self?.receive(meeting, chunk: chunk, file: url) }
        }
        transport.onRefresh = { [weak self] in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.publish()
                for id in self.visibleRecords.map(\.id) { self.publishAudioReceipt(id) }
                self.beginWork()
            }
        }
        publish()
    }

    func connect(endpoint: String, code: String) async {
        guard !connecting else { return }
        guard !busy, !hasUnfinishedMeeting else {
            issue = "当前手表录音或收尾尚未完成，请先结束并等本场同步，再切换业务服务。"
            return
        }
        connecting = true
        generation += 1
        let current = generation
        worker?.cancel(); worker = nil; busy = true
        capabilityTask?.cancel(); capabilityTask = nil; capabilityBinding = nil
        asrStatus = PhoneASRStatus()
        transport.setAuthorizedGrantID(nil)
        clearSummaries()
        publish()
        defer {
            connecting = false
            busy = false
            publish()
            if generation == current { beginWork() }
        }
        do {
            try await gateway.pair(endpoint: endpoint.trimmingCharacters(in: .whitespacesAndNewlines), code: code.trimmingCharacters(in: .whitespacesAndNewlines))
            guard generation == current else { gateway.disconnect(); return }
            try Task.checkCancellation()
            for id in records.filter({ !matchesConfiguration($0) && !$0.sourceUnavailable }).map(\.id) {
                try purgeContent(id, message: "原手机授权已切换，本机正文与音频已清除")
            }
            transport.setAuthorizedGrantID(storageHealthy ? gateway.configuration?.grantID : nil)
            issue = nil
            try persist()
            await refreshASRCapability()
        } catch {
            if generation == current { issue = error.localizedDescription }
        }
    }

    func refreshASRCapability() async {
        guard active, gateway.isConfigured, let binding = gateway.configuration else { publish(); return }
        if let task = capabilityTask { await task.value; return }
        let current = generation
        asrStatus.phase = "checking"; asrStatus.available = false
        asrStatus.message = "正在核对 Oops 后端转写能力"
        #if DEBUG
        asrStatus.diagnostics = PhoneCapabilityDiagnostic(outcome: "checking")
        #endif
        publish()
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                if self.generation == current { self.capabilityTask = nil; self.publish(); self.beginWork() }
            }
            do {
                let response = try await self.gateway.capabilities()
                guard self.active, self.generation == current, self.gateway.configuration == binding else { return }
                try Task.checkCancellation()
                #if DEBUG
                let diagnosticASR = response["asr"] as? [String: Any]
                let schemaMatched = diagnosticASR?["engine"] as? String == self.backendEngine
                    && (diagnosticASR?["version"] as? Int ?? 0) >= 1
                    && (diagnosticASR?["max_chunk_ms"] as? Int ?? 0) >= 30_000
                    && diagnosticASR?["available"] is Bool
                self.asrStatus.diagnostics = PhoneCapabilityDiagnostic(outcome: "response_received",
                    schemaMatched: schemaMatched, available: diagnosticASR?["available"] as? Bool)
                #endif
                guard let asr = response["asr"] as? [String: Any],
                      asr["engine"] as? String == self.backendEngine,
                      (asr["version"] as? Int ?? 0) >= 1,
                      (asr["max_chunk_ms"] as? Int ?? 0) >= 30_000 else {
                    throw BusinessError.message("当前业务服务尚未提供兼容的 Oops 后端转写能力")
                }
                let available = asr["available"] as? Bool == true
                self.capabilityBinding = binding
                self.asrStatus = PhoneASRStatus(phase: available ? "ready" : "unavailable", engine: self.backendEngine,
                                               available: available,
                                               message: available ? "Oops 后端转写已就绪" : "Oops 后端转写当前不可用，请核对服务配置",
                                               checkedAt: Date())
                #if DEBUG
                self.asrStatus.diagnostics = PhoneCapabilityDiagnostic(outcome: available ? "ready" : "available_false",
                    schemaMatched: schemaMatched, available: available)
                #endif
            } catch {
                guard self.generation == current else { return }
                self.capabilityBinding = nil
                self.asrStatus.phase = "unavailable"; self.asrStatus.available = false
                self.asrStatus.message = error is CancellationError ? "后端转写核对已暂停" : error.localizedDescription
                #if DEBUG
                self.asrStatus.diagnostics = self.capabilityErrorDiagnostic(error, previous: self.asrStatus.diagnostics)
                #endif
                if let error = error as? GatewayHTTPError, [401, 403].contains(error.status) {
                    self.handleRevocation(error, id: "")
                }
            }
        }
        capabilityTask = task
        await task.value
    }

    func setActive(_ value: Bool) {
        guard active != value else { publish(); return }
        active = value
        generation += 1
        worker?.cancel(); worker = nil
        capabilityTask?.cancel(); capabilityTask = nil; capabilityBinding = nil
        asrStatus = PhoneASRStatus()
        maintenance?.cancel(); maintenance = nil
        #if DEBUG
        verificationTask?.cancel(); verificationTask = nil
        #endif
        busy = connecting
        for index in records.indices {
            for chunk in records[index].chunks.indices where records[index].chunks[chunk].state == "processing" {
                records[index].chunks[chunk].state = "pending"
            }
        }
        clearSummaries()
        do { try pruneExpired(); try persist() } catch { issue = "本机保留期限清理未完成，请重试。" }
        publish()
        guard value else { return }
        beginWork()
        Task { @MainActor [weak self] in await self?.refreshASRCapability() }
        maintenance = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(60)) } catch { return }
                guard let self, self.active else { return }
                do { try self.pruneExpired(); try self.persist() }
                catch { self.issue = "本机保留期限清理未完成，请重试。" }
                self.publish()
                await self.refreshASRCapability()
                self.beginWork()
                for id in self.records.filter({ $0.serverID != nil && $0.asrClosed && !$0.sourceUnavailable }).prefix(10).map(\.id) {
                    guard self.active, !Task.isCancelled else { return }
                    await self.refreshResult(id)
                }
            }
        }
    }

    /// Explicit recovery: query original requests first; never invent another request ID.
    func retry() {
        guard active, !connecting, worker == nil else { return }
        let current = generation
        busy = true
        worker = Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.finishWorker(generation: current) }
            do {
                try self.pruneExpired()
                for id in self.records.filter({ self.matchesConfiguration($0) && !$0.sourceUnavailable }).map(\.id) {
                    try self.checkWork(id, generation: current)
                    if let receipt = self.record(id)?.requests.first(where: { ["attempted", "unknown"].contains($0.state) }) {
                        let state: [String: Any]
                        do {
                            state = try await self.gateway.json("/requests/" + receipt.id)
                        } catch let error as GatewayHTTPError where error.status == 404 && error.code == "REQUEST_NOT_FOUND" {
                            // The gateway proves this ID was never reserved. Explicit retry may
                            // submit the exact persisted operation, with the very same ID.
                            _ = try await self.sendReceipt(receipt, id: id, generation: current)
                            self.workAgain = true
                            continue
                        }
                        try self.checkWork(id, generation: current)
                        guard state["request_id"] as? String == receipt.id,
                              state["route"] as? String == receipt.path,
                              state["method"] as? String == (receipt.uploadOffset == nil ? "POST" : "PUT"),
                              self.record(id)?.serverID == nil || state["session_id"] as? String == self.record(id)?.serverID,
                              state["state"] as? String == "done",
                              let status = state["upstream_http_status"] as? Int,
                              (200..<300).contains(status) else {
                            self.update(id) { $0.status = "原请求送达结果未知，已停止写入，等待核对" }
                            continue
                        }
                        // Done is proved by the gateway. Same request/body only retrieves its receipt.
                        _ = try await self.sendReceipt(receipt, id: id, generation: current)
                    }
                    if self.record(id)?.legacyASRLocked != true {
                        self.update(id) { record in
                            for index in record.chunks.indices where record.chunks[index].state == "failed" {
                                record.chunks[index].state = "pending"; record.chunks[index].issue = nil
                            }
                        }
                    }
                }
                try self.persist()
                self.workAgain = true
                if self.records.contains(where: { $0.requests.contains(where: { ["attempted", "unknown"].contains($0.state) }) }) {
                    self.issue = "仍有原请求结果未知，已停止相应会话写入；未重发"
                } else { self.issue = nil }
            } catch {
                if let error = error as? GatewayHTTPError, [401, 403].contains(error.status) {
                    self.purgeCurrentGrant(message: "手机授权已失效，本机正文与音频已清除")
                    self.gateway.disconnect(); self.transport.setAuthorizedGrantID(nil)
                }
                if !(error is CancellationError) { self.issue = error.localizedDescription }
            }
        }
    }

    func refreshResult(_ id: String) async {
        guard active, let record = record(id), let sid = record.serverID,
              matchesConfiguration(record), assetLive("transcript", record), !record.sourceUnavailable else {
            update(id) { $0.summary = nil; $0.summaryCheckedAt = nil }
            publish(id)
            return
        }
        let current = generation
        update(id) { $0.summary = nil; $0.summaryCheckedAt = nil }
        publish(id)
        do {
            let result = try await gateway.json("/sessions/\(sid)/minutes")
            try checkWork(id, generation: current)
            guard result["session_id"] as? String == sid else { throw BusinessError.message("会后结果的会话编号不匹配") }
            guard result["status"] as? String == "ready", let minutes = result["minutes"] as? [String: Any] else {
                let message = result["message"] as? String
                let reason = result["reason"] as? String
                update(id) {
                    $0.summary = nil
                    if reason == "source_changed" { $0.status = "原话已变化，会后结果需重新核对"; $0.sourceUnavailable = true }
                    else if result["status"] as? String == "pending" { $0.status = message ?? "会后结果尚未就绪" }
                    else { $0.status = message ?? "当前没有可用会后结果" }
                }
                if reason == "source_changed" { try purgeContent(id, message: "原话来源已变化，本机旧正文与音频已清除，需重新核对") }
                try persist(); publish(id); return
            }
            let summary = summaryText(minutes)
            update(id) {
                $0.summary = summary.isEmpty ? nil : String(summary.prefix(600))
                $0.summaryCheckedAt = Date()
                if $0.chunks.contains(where: { $0.hasRejectedFinals }) {
                    $0.status = summary.isEmpty ? "本场有未对齐原话待核对，请结合原音查看" : "会后结果已同步；另有未对齐原话待核对"
                } else {
                    $0.status = summary.isEmpty ? "本场没有可整理的会后内容" : "会后结果已同步，待本人核对"
                }
            }
            try persist()
        } catch {
            guard generation == current else { return }
            update(id) { $0.summary = nil; $0.summaryCheckedAt = nil; $0.status = "会后结果读取失败，请重试" }
            handleRevocation(error, id: id)
            try? persist()
            if !(error is CancellationError) { issue = error.localizedDescription }
        }
        publish(id)
    }

    func disconnect() {
        guard !busy, !hasUnfinishedMeeting else {
            issue = "当前手表录音或收尾尚未完成，请先结束并等本场同步，再断开业务服务。"
            return
        }
        generation += 1
        worker?.cancel(); worker = nil
        capabilityTask?.cancel(); capabilityTask = nil; capabilityBinding = nil
        asrStatus = PhoneASRStatus()
        purgeCurrentGrant(message: "已断开手机授权，本机正文与音频已清除")
        gateway.disconnect()
        transport.setAuthorizedGrantID(nil)
        clearSummaries()
        busy = connecting
        issue = nil
        try? persist()
        publish()
    }

    private func receive(_ meeting: WatchMeeting) {
        do {
            try accept(meeting)
            try pruneExpired()
            try persist()
            publish(meeting.id)
            beginWork()
        } catch { issue = error.localizedDescription; publish() }
    }

    private func receive(_ meeting: WatchMeeting, chunk: AudioChunkDescriptor, file: URL) {
        do {
            try accept(meeting)
            guard chunk.valid, chunk.sessionID == meeting.id, chunk.endMs <= maximumRecordingMs,
                  let existing = record(meeting.id), assetLive("audio", existing) else {
                throw BusinessError.message("音频片段无效、超过首版单场 30 分钟或原音已到期；未接收的原音需保留在手表")
            }
            if let expected = existing.meeting.expectedChunkCount, existing.meeting.endedAt != nil, chunk.sequence >= expected {
                throw BusinessError.message("音频序号超出手表已封口的片段数，请核对本场录音")
            }
            let bytes = try Data(contentsOf: file, options: .mappedIfSafe)
            guard bytes.count == chunk.size, BusinessCodec.hash(bytes) == chunk.sha256 else {
                throw BusinessError.message("音频片段的大小或 SHA-256 校验失败")
            }
            if let previous = existing.chunks.first(where: { $0.descriptor.sequence == chunk.sequence }) {
                guard previous.descriptor == chunk else { throw BusinessError.message("同一片段序号对应了不同音频，已停止接收冲突内容") }
                discardIncoming(file)
                publishAudioReceipt(meeting.id)
                publish(meeting.id)
                return
            }
            guard existing.chunks.reduce(0, { $0 + $1.descriptor.size }) + chunk.size <= maximumPCMBytes,
                  !existing.chunks.contains(where: { $0.descriptor.startMs < chunk.endMs && chunk.startMs < $0.descriptor.endMs }) else {
                throw BusinessError.message("音频时间重叠或超过单场 64 MB 容量，请核对手表录音")
            }
            let folder = try BusinessFiles.session(meeting.id)
            let target = folder.appendingPathComponent("phone-chunk-\(chunk.sequence)-\(chunk.sha256).m4a")
            try privateWrite(bytes, to: target)
            update(meeting.id) { $0.chunks.append(PhoneChunkRecord(descriptor: chunk, audioFile: target.lastPathComponent)); $0.chunks.sort { $0.descriptor.sequence < $1.descriptor.sequence } }
            try persist()
            if file != target { discardIncoming(file) }
            publishAudioReceipt(meeting.id)
            publish(meeting.id)
            beginWork()
        } catch {
            discardIncoming(file)
            issue = error.localizedDescription
            if let record = record(meeting.id), matchesConfiguration(record) {
                update(meeting.id) { $0.status = "片段未接收：" + error.localizedDescription }
                try? persist()
            }
            publish(meeting.id)
        }
    }

    private func accept(_ meeting: WatchMeeting) throws {
        guard storageHealthy else { throw BusinessError.message("本机记录尚未恢复，已停止接收，避免覆盖原请求回执") }
        guard meeting.valid, let configuration = gateway.configuration, gateway.isConfigured,
              configuration.grantID == meeting.grantID,
              meeting.audioExpiresAt > Date() || meeting.textExpiresAt > Date() else {
            throw BusinessError.message("手表会话未匹配当前手机授权，或保存期限已过；未接入其他服务")
        }
        if let old = record(meeting.id) {
            guard old.endpoint == configuration.endpoint, old.grantID == configuration.grantID,
                  old.meeting.startedAt == meeting.startedAt, old.meeting.audioDays == meeting.audioDays,
                  old.meeting.textDays == meeting.textDays, old.meeting.cloudSaveConfirmed == meeting.cloudSaveConfirmed else {
                throw BusinessError.message("本场已冻结的服务或保存合同不一致，不能覆盖")
            }
            guard meeting.revision >= old.meeting.revision else { return }
            guard meeting.revision != old.meeting.revision || old.meeting == meeting else {
                throw BusinessError.message("同一会话版本出现冲突，请先核对手表状态")
            }
            guard old.meeting.endedAt == nil || old.meeting.endedAt == meeting.endedAt else {
                throw BusinessError.message("已结束会话不能被迟到状态重新开启")
            }
            update(meeting.id) { $0.meeting = meeting }
        } else {
            guard meeting.audioExpiresAt > Date(), meeting.textExpiresAt > Date() else {
                throw BusinessError.message("新接收会话的原音或全文已到期，不能补造保存授权")
            }
            records.insert(PhoneMeetingRecord(meeting: meeting, endpoint: configuration.endpoint, grantID: configuration.grantID,
                                              transcriptionEngine: backendEngine, legacyASRLocked: false), at: 0)
        }
        records.sort { $0.meeting.startedAt > $1.meeting.startedAt }
    }

    private func beginWork() {
        guard storageHealthy, active, !connecting, gateway.isConfigured else { return }
        guard worker == nil else { workAgain = true; return }
        let current = generation
        busy = true
        workAgain = false
        worker = Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.finishWorker(generation: current) }
            for id in self.records.map(\.id) {
                guard !Task.isCancelled, self.generation == current else { return }
                guard let record = self.record(id), self.matchesConfiguration(record), !record.sourceUnavailable,
                      !record.requests.contains(where: { ["attempted", "unknown"].contains($0.state) }) else { continue }
                do { try await self.process(id, generation: current) }
                catch {
                    guard self.generation == current else { return }
                    if !(error is CancellationError) {
                        self.issue = error.localizedDescription
                        self.update(id) { $0.status = error.localizedDescription; $0.summary = nil; $0.summaryCheckedAt = nil }
                        self.handleRevocation(error, id: id)
                        try? self.persist()
                    }
                    self.publish(id)
                }
            }
        }
    }

    private func process(_ id: String, generation current: Int) async throws {
        try checkWork(id, generation: current)
        try pruneExpired()
        guard let initial = record(id), assetLive("audio", initial) || assetLive("transcript", initial) else { return }
        if initial.legacyASRLocked == true, initial.audioUploaded {
            let pending = initial.chunks.filter { !["transcribed", "silence", "text_expired", "unavailable"].contains($0.state) }.count
            if pending > 0, assetLive("transcript", initial) {
                update(id) { $0.status = "旧场原音已完成保存；另有 \(pending) 段旧文字尚未完整处理，未自动重转写或更改收尾" }
                try persist(); publish(id)
            }
            return
        }
        if initial.legacyASRLocked != true { try await register(id, generation: current) }
        // Format conversion is local; all formal recognition is a separately receipted backend job.
        if assetLive("audio", initial) {
            for sequence in initial.chunks.map({ $0.descriptor.sequence }) {
                try checkWork(id, generation: current)
                guard let chunk = self.chunk(id, sequence), chunk.pcmFile == nil, let name = chunk.audioFile else { continue }
                let folder = try BusinessFiles.session(id)
                let pcm = try audio.pcm16k(fileURL: folder.appendingPathComponent(name))
                let pcmURL = folder.appendingPathComponent("phone-pcm-\(sequence)-\(chunk.descriptor.sha256).pcm")
                try privateWrite(pcm, to: pcmURL)
                updateChunk(id, sequence) {
                    $0.pcmFile = pcmURL.lastPathComponent; $0.pcmHash = BusinessCodec.hash(pcm)
                }
                try persist()
            }
        }
        publish()
        #if DEBUG
        if try heldPreparationRecording(initial) {
            update(id) { $0.status = "本场为测试准备录音，已暂缓云端提交；原音按原期限保留在本机" }
            try persist(); publish(id)
            return
        }
        if ProcessInfo.processInfo.arguments.contains("--oops-hold-cloud-sync") {
            update(id) { $0.status = "USB检查：音频已转换，等待私有保存范围核对；尚未发送后端转写" }
            try persist(); publish(id)
            return
        }
        #endif
        if initial.legacyASRLocked == true {
            try checkWork(id, generation: current)
            guard let legacy = record(id), legacy.serverID != nil else {
                update(id) { $0.status = "旧场服务器映射尚未核对，原音保留在本机；未新建或重写旧会话" }
                try persist(); publish(id)
                return
            }
            if allAudioArrived(legacy), !legacy.chunks.isEmpty, assetLive("audio", legacy), !legacy.audioUploaded {
                try await uploadRecording(id, generation: current)
                try checkWork(id, generation: current)
            }
            if let saved = record(id) {
                let pending = saved.chunks.filter { !["transcribed", "silence", "text_expired", "unavailable"].contains($0.state) }.count
                update(id) { record in
                    if saved.audioUploaded, pending > 0, assetLive("transcript", saved) {
                        record.status = "旧场原音已完成保存；另有 \(pending) 段旧文字尚未完整处理，未自动重转写或更改收尾"
                    } else if saved.audioUploaded {
                        record.status = "旧场原音已完成保存；旧文字与原有收尾状态保留为历史"
                    } else if !assetLive("audio", saved) {
                        record.status = "旧场原音已到期，未补传；旧文字与原有收尾状态保留"
                    } else if !allAudioArrived(saved) {
                        record.status = "旧场原音尚未收齐，等待缺失片段；未标为保存完成"
                    } else {
                        record.status = "旧场尚无可归档原音；旧文字与原有收尾状态保留"
                    }
                }
            }
            try persist(); publish(id)
            return // Legacy audio recovery never invokes ASR, re-syncs text or changes closure.
        }
        if assetLive("both", initial) {
            for sequence in (record(id)?.chunks ?? []).filter({ !["transcribed", "silence", "failed", "text_expired", "unavailable"].contains($0.state) || !processingFinished($0) }).map({ $0.descriptor.sequence }) {
                try checkWork(id, generation: current)
                let finished = try await processASRChunk(id, sequence: sequence, generation: current)
                if !finished { return }
            }
        }
        try checkWork(id, generation: current)
        if let record = record(id), assetLive("transcript", record) { try await sync(id, generation: current) }
        if let record = record(id), allAudioArrived(record), !record.chunks.isEmpty, assetLive("audio", record), !record.audioUploaded {
            try await uploadRecording(id, generation: current)
        }
        try checkWork(id, generation: current)
        update(id) { record in
            if !assetLive("transcript", record) { record.status = "全文已到期清除；原音保存状态单独核对" }
            else if !assetLive("audio", record), record.chunks.contains(where: { $0.state == "pending" }) { record.status = "原音已到期清除，未转写片段无法继续处理" }
            else if record.chunks.contains(where: { $0.state == "failed" }) { record.status = "部分片段后端转写不完整，已收到的原话保留供核对；未自动重新付费识别" }
            else if !asrReady && record.meeting.textExpiresAt > Date() { record.status = "等待 Oops 后端转写服务就绪" }
            else if record.meeting.endedAt == nil { record.status = "已接收 \(record.chunks.count) 段，等待手表后续录音" }
            else if !allAudioArrived(record) { record.status = "手表已结束，仍在等待缺失音频片段" }
            else if record.chunks.isEmpty { record.status = "本场没有收到有效音频，已按不完整收尾" }
            else if record.chunks.allSatisfy({ $0.state == "silence" }) { record.status = "本场未识别到文字；原音保存状态单独核对" }
            else if record.frozenASRClosure == "incomplete" { record.status = "本场已按不完整收尾，已收到的文字已同步，待核对" }
            else { record.status = "文字已同步，等待已有会后结果" }
        }
        try persist(); publish(id)
        if record(id)?.asrClosed == true { await refreshResult(id) }
    }

    private func processASRChunk(_ id: String, sequence: Int, generation current: Int) async throws -> Bool {
        try checkWork(id, generation: current)
        guard let record = record(id), let sid = record.serverID, let chunk = chunk(id, sequence),
              let name = chunk.pcmFile, let hash = chunk.pcmHash, assetLive("both", record) else {
            throw BusinessError.message("本段 PCM 或保存授权已不可用，未发送后端识别")
        }
        var request = record.asrRequests?.first(where: { $0.sequence == sequence })
        if request == nil {
            guard asrReady else {
                update(id) { $0.status = asrStatus.message }
                try persist(); publish(id)
                return false
            }
            let bytes = try Data(contentsOf: BusinessFiles.session(id).appendingPathComponent(name), options: .mappedIfSafe)
            guard BusinessCodec.hash(bytes) == hash, !bytes.isEmpty, bytes.count <= 1_100_000 else { throw BusinessError.message("本段 PCM 校验失败，未发送识别") }
            let value = PhoneASRRequest(id: BusinessCodec.operationID(id, "asr-v1:\(sid):\(sequence):\(hash)"), sequence: sequence,
                                        pcmFile: name, pcmHash: hash, size: bytes.count,
                                        startMs: chunk.descriptor.startMs, endMs: chunk.descriptor.endMs, state: "attempted")
            update(id) { var requests = $0.asrRequests ?? []; requests.append(value); $0.asrRequests = requests }
            updateChunk(id, sequence) { $0.state = "asr_queued"; $0.issue = nil; $0.asrProvider = backendEngine }
            try persist() // PCM locator/hash and the paid request ID exist before the first send.
            request = value
            do {
                _ = try await gateway.submitASR(sessionID: sid, sequence: sequence, startMs: value.startMs, endMs: value.endMs, pcm: bytes, requestID: value.id)
                try checkWork(id, generation: current)
                updateASRRequest(id, sequence) { $0.state = "accepted" }
                try persist()
            } catch {
                if generation == current {
                    updateASRRequest(id, sequence) { $0.state = "unknown" }
                    updateChunk(id, sequence) { $0.state = "asr_unknown"; $0.issue = "登记回执未完整到达，仅查询原任务；未重发音频" }
                    try? persist()
                }
                if error is CancellationError { throw error }
                if let error = error as? GatewayHTTPError, [401, 403, 410].contains(error.status) { throw error }
                // A missing HTTP reply cannot prove the paid job was not registered. Only GET below.
            }
        }
        guard let request, request.pcmHash == hash, request.pcmFile == name,
              request.startMs == chunk.descriptor.startMs, request.endMs == chunk.descriptor.endMs else {
            throw BusinessError.message("原 ASR 请求的音频或时间发生变化，已停止识别")
        }
        for attempt in 0..<6 {
            try checkWork(id, generation: current)
            do {
                let job = try await gateway.asrJob(sessionID: sid, sequence: sequence)
                try checkWork(id, generation: current)
                if try applyASRJob(job, request: request, id: id) { return true }
                if job["state"] as? String == "unknown" { return false }
            } catch let error as GatewayHTTPError where error.status == 404 {
                updateASRRequest(id, sequence) { $0.state = "unknown" }
                updateChunk(id, sequence) { $0.state = "asr_unknown"; $0.issue = "原 ASR 任务尚未查到，送达需核对；未重发付费音频" }
                update(id) { $0.status = "本段后端识别送达待核对，请查询原请求；未重发音频" }
                try persist(); publish(id)
                return false
            }
            if attempt < 5 { try await Task.sleep(for: .seconds(1)) }
        }
        update(id) { $0.status = "后端仍在处理本段，前台稍后继续查询原任务；未重发音频" }
        try persist(); publish(id)
        return false
    }

    private func applyASRJob(_ job: [String: Any], request: PhoneASRRequest, id: String) throws -> Bool {
        guard let record = record(id), assetLive("both", record), job["session_id"] as? String == record.serverID,
              job["request_id"] as? String == request.id, job["sequence"] as? Int == request.sequence,
              job["pcm_sha256"] as? String == request.pcmHash,
              job["asr_engine"] as? String == backendEngine, let state = job["state"] as? String,
              ["queued", "running", "ready", "incomplete", "failed", "unknown"].contains(state) else {
            throw BusinessError.message("后端 ASR 回包未匹配本场、片段、请求或 PCM 校验值")
        }
        updateASRRequest(id, request.sequence) { $0.state = state }
        if ["queued", "running"].contains(state) {
            updateChunk(id, request.sequence) { $0.state = "asr_" + state }
            update(id) { $0.status = "Oops 后端正在转写第 \(request.sequence + 1) 段" }
            try persist(); publish(id)
            return false
        }
        if state == "unknown" {
            updateChunk(id, request.sequence) { $0.state = "asr_unknown"; $0.issue = "供应商结果未知，已停止重发，等待核对原任务" }
            update(id) { $0.status = "本段 ASR 结果未知，已停止本场后续写入；未重发音频" }
            try persist(); publish(id)
            return false
        }
        let rows = try validatedASRRows(job, startMs: request.startMs, endMs: request.endMs)
        let rejected = try validatedRejectedFinals(job)
        let diagnostics = try validatedASRDiagnostics(job)
        let hasRejected = !rejected.isEmpty || ["rejected_final_count", "rejected_overflow_count"].contains {
            (diagnostics?[$0] as? Int ?? 0) > 0
        }
        let data = try JSONSerialization.data(withJSONObject: rows, options: [.sortedKeys])
        let closure = hasRejected ? "incomplete" : job["provider_closure"] as? String ?? "unknown"
        let complete = !hasRejected && state == "ready" && closure == "acknowledged"
        var processing = job["processing"] as? [String: Any]
        // The job also nests quarantine evidence inside processing. Keep a single
        // typed quarantine copy; normal processing follows aligned-text retention.
        processing?.removeValue(forKey: "rejected_finals")
        processing?.removeValue(forKey: "diagnostics")
        let processingData = try processing.map { try jsonData($0) }
        let diagnosticsData = try diagnostics.map { try jsonData($0) }
        let response = try jsonData(job)
        updateASRRequest(id, request.sequence) { $0.response = response; if hasRejected { $0.state = "incomplete" } }
        updateChunk(id, request.sequence) {
            $0.backendUtterances = data; $0.backendProcessing = processingData
            $0.backendRejectedFinals = rejected; $0.backendASRDiagnostics = diagnosticsData
            $0.asrProvider = backendEngine; $0.providerClosure = closure
            $0.text = rows.isEmpty ? nil : rows.compactMap { $0["text"] as? String }.joined(separator: "\n")
            $0.state = complete ? (rows.isEmpty ? "silence" : "transcribed") : "failed"
            $0.issue = hasRejected ? "部分原话时间未对齐，已单独保留待核对；本段转写未完整" : complete ? nil : "后端 ASR 未完整结束，已收到的真实原话保留供核对；未自动重新识别"
        }
        let finished = processingFinished(chunk(id, request.sequence)!)
        if !finished { update(id) { $0.status = "本段原话已收到，等待 Oops 语句处理；仅查询原任务" } }
        try persist(); publish(id)
        return finished
    }

    private func validatedRejectedFinals(_ job: [String: Any]) throws -> [PhoneASRRejectedFinal] {
        guard let value = job["rejected_finals"] else { return [] } // Older jobs have no quarantine field.
        let reasons: Set<String> = ["invalid_final", "invalid_text", "text_limit", "invalid_coordinates", "final_count_limit", "result_limit"]
        guard let values = value as? [[String: Any]], values.count <= 500,
              let data = try? JSONSerialization.data(withJSONObject: values, options: [.sortedKeys]),
              data.count <= 1_000_000,
              let rows = try? JSONDecoder().decode([PhoneASRRejectedFinal].self, from: data),
              Set(rows.map(\.index)).count == rows.count,
              rows.allSatisfy({ $0.index >= 0 && reasons.contains($0.reason) }) else {
            throw BusinessError.message("后端待核对原话格式无效，未标为静音或完整转写")
        }
        // Preserve the original text and raw JSON coordinate literals exactly. No trimming,
        // clipping to a chunk boundary, synthetic UUID or business timestamp is permitted.
        return rows
    }

    private func validatedASRDiagnostics(_ job: [String: Any]) throws -> [String: Any]? {
        guard let value = job["diagnostics"] else { return nil }
        guard let object = value as? [String: Any] else {
            throw BusinessError.message("后端 ASR 诊断元数据格式无效")
        }
        for key in ["rejected_final_count", "rejected_overflow_count"] where object[key] != nil {
            guard let count = object[key] as? Int, count >= 0 else {
                throw BusinessError.message("后端待核对原话计数无效，未标为完整转写")
            }
        }
        return object
    }

    private func validatedASRRows(_ job: [String: Any], startMs: Int64, endMs: Int64) throws -> [[String: Any]] {
        if job["utterances"] == nil, ["queued", "running", "failed", "unknown"].contains(job["state"] as? String ?? "") { return [] }
        guard let rows = job["utterances"] as? [[String: Any]], rows.count <= 500 else { throw BusinessError.message("后端 ASR 原句列表无效") }
        var ids = Set<String>()
        for row in rows {
            guard let uid = row["id"] as? String, UUID(uuidString: uid) != nil, ids.insert(uid).inserted,
                  let a = row["start_ms"] as? Int64, let b = row["end_ms"] as? Int64,
                  a >= startMs, b > a, b <= endMs + 100,
                  let text = row["text"] as? String, !text.isEmpty, text.count <= 20_000,
                  row["speaker"] == nil || row["speaker"] is NSNull else { throw BusinessError.message("后端 ASR 的句子编号、原文或绝对时间无效") }
            if let words = row["words"] as? [[String: Any]] {
                for word in words {
                    guard word["text"] is String, let wa = word["start_ms"] as? Int64, let wb = word["end_ms"] as? Int64,
                          wa >= a, wb >= wa, wb <= b + 100 else { throw BusinessError.message("后端 ASR 词时间无效，未重算或伪造时间") }
                }
            }
        }
        return rows
    }

    private func processingFinished(_ chunk: PhoneChunkRecord) -> Bool {
        guard let data = chunk.backendProcessing, let value = try? jsonObject(data), let state = value["state"] as? String else { return true }
        return !["pending", "running"].contains(state)
    }

    private func updateASRRequest(_ id: String, _ sequence: Int, _ mutation: (inout PhoneASRRequest) -> Void) {
        update(id) { record in
            var values = record.asrRequests ?? []
            guard let index = values.firstIndex(where: { $0.sequence == sequence }) else { return }
            mutation(&values[index]); record.asrRequests = values
        }
    }

    private func migrateTranscription(at index: Int) {
        guard records[index].transcriptionEngine == nil else { return }
        let locked = records[index].lastSyncHash != nil || records[index].asrClosed
            || records[index].requests.contains { $0.path.hasSuffix("/sync") || ["attempted", "unknown"].contains($0.state) }
        records[index].transcriptionEngine = locked ? "apple-legacy" : backendEngine
        records[index].legacyASRLocked = locked
        if !locked {
            for chunk in records[index].chunks.indices where !["text_expired", "unavailable"].contains(records[index].chunks[chunk].state) {
                records[index].chunks[chunk].text = nil; records[index].chunks[chunk].backendUtterances = nil
                records[index].chunks[chunk].backendRejectedFinals = nil; records[index].chunks[chunk].backendASRDiagnostics = nil
                records[index].chunks[chunk].asrProvider = backendEngine
                records[index].chunks[chunk].state = "pending"; records[index].chunks[chunk].issue = nil
            }
        }
    }

    private func register(_ id: String, generation current: Int) async throws {
        guard let record = record(id), record.serverID == nil else { return }
        guard assetLive("both", record) else { throw BusinessError.message("本场保存期限已过，不能新建服务器会话") }
        var body = policyBody(record)
        body["started_at"] = BusinessCodec.iso(record.meeting.startedAt)
        body["time_zone"] = "Asia/Shanghai"
        let content = try jsonData(body)
        let requestID = BusinessCodec.operationID(id, BusinessCodec.hash(content) + ":create")
        body["request_id"] = requestID
        let result = try await write(id, path: "/sessions", body: body, asset: "both", operation: "create", forcedID: requestID, generation: current)
        guard let sid = result["session_id"] as? String, UUID(uuidString: sid) != nil,
              let start = result["started_at"] as? String, let startDate = MobileGateway.date(start),
              abs(startDate.timeIntervalSince(record.meeting.startedAt)) < 1,
              let zone = result["time_zone"] as? String, zone == "Asia/Shanghai",
              let policy = result["storage_policy"] as? [String: Any],
              policy["recording_mode"] as? String == "meeting", policy["cloud_save_confirmed"] as? Bool == true,
              (policy["audio_retention_days"] as? Int) == record.meeting.audioDays,
              (policy["transcript_retention_days"] as? Int) == record.meeting.textDays,
              let archive = policy["archive_started_at"] as? String, MobileGateway.date(archive) == startDate,
              let audioExpiry = policy["audio_expires_at"] as? String, let audioDate = MobileGateway.date(audioExpiry),
              let textExpiry = policy["transcript_expires_at"] as? String, let textDate = MobileGateway.date(textExpiry),
              abs(audioDate.timeIntervalSince(record.meeting.audioExpiresAt)) < 1,
              abs(textDate.timeIntervalSince(record.meeting.textExpiresAt)) < 1 else {
            throw BusinessError.message("服务器会话或保存合同与本场不匹配，已停止继续写入")
        }
        let policyData = try jsonData(policy)
        update(id) { $0.serverID = sid; $0.serverStartedAt = start; $0.serverTimeZone = zone; $0.storagePolicy = policyData }
        try persist()
    }

    private func sync(_ id: String, generation current: Int) async throws {
        guard let record = record(id), let sid = record.serverID else { return }
        guard record.frozenASRClosure != "acknowledged" || !record.chunks.contains(where: { $0.hasRejectedFinals }) else {
            throw BusinessError.message("原有完整收尾与新待核对原话不一致，已停止写入，未改写冻结的收尾状态")
        }
        let done = allAudioArrived(record) && record.chunks.allSatisfy({ ["transcribed", "silence", "failed"].contains($0.state) })
        var closure = record.frozenASRClosure
        if done, record.meeting.endedAt != nil, closure == nil {
            // Migrate a prior persisted closing request before calculating a new closure.
            // A manual ASR retry may improve text, but must not rewrite incomplete to acknowledged.
            closure = record.requests.reversed().compactMap { receipt -> String? in
                guard let body = receipt.body, let object = try? jsonObject(body),
                      let value = object["asr_closure"] as? String,
                      ["incomplete", "acknowledged"].contains(value) else { return nil }
                return value
            }.first
            if closure == "acknowledged", record.chunks.contains(where: { $0.hasRejectedFinals }) {
                throw BusinessError.message("原完整收尾请求仍需核对，已停止写入，未替换原请求或忽略待核对原话")
            }
            if closure == nil {
                closure = ["interrupted", "failed"].contains(record.meeting.phase)
                    || record.chunks.isEmpty || record.chunks.contains(where: { $0.state == "failed" || $0.hasRejectedFinals })
                    ? "incomplete" : "acknowledged"
            }
            update(id) { $0.frozenASRClosure = closure }
            try persist() // Freeze before the first closing write is attempted.
        }
        let utterances: [[String: Any]] = try record.chunks.flatMap { chunk -> [[String: Any]] in
            guard chunk.asrProvider == backendEngine, let data = chunk.backendUtterances else { return [] }
            guard let rows = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { throw BusinessError.message("本机后端转写原句记录无效") }
            return rows.map { row in
                var value: [String: Any] = ["id": row["id"]!, "text": row["text"]!, "start_ms": row["start_ms"]!, "end_ms": row["end_ms"]!, "speaker": NSNull(), "segments": row["segments"] ?? []]
                if let tag = row["tag"] as? String { value["tag"] = tag }
                return value
            }
        }
        let count = max(1, Int(ceil(Double(utterances.count) / 500)))
        for batch in 0..<count {
            var body = policyBody(record)
            body["session_id"] = sid; body["started_at"] = record.serverStartedAt
            body["time_zone"] = record.serverTimeZone
            body["utterances"] = Array(utterances.dropFirst(batch * 500).prefix(500)); body["notices"] = []
            if let end = record.meeting.endedAt, done, let closure, batch == count - 1 {
                body["ended_at"] = BusinessCodec.iso(end)
                body["asr_closure"] = closure
            }
            let hash = BusinessCodec.hash(try jsonData(body))
            let result = try await write(id, path: "/sessions/\(sid)/sync", body: body, asset: "transcript", operation: "sync", generation: current)
            guard (result["rejected"] as? [Any] ?? []).isEmpty else {
                update(id) { $0.sourceUnavailable = true }
                throw BusinessError.message("服务器拒绝了部分原话，已停止同步，请先核对内容；未标为整场完成")
            }
            if let closure = body["asr_closure"] as? String, result["asr_closure"] as? String != closure {
                throw BusinessError.message("未收到匹配的 ASR 收尾状态，不能标为已完成")
            }
            if body["asr_closure"] != nil { update(id) { $0.asrClosed = true } }
            update(id) { $0.lastSyncHash = hash }
            try persist()
        }
    }

    private func uploadRecording(_ id: String, generation current: Int) async throws {
        guard let record = record(id), let sid = record.serverID else { return }
        let assembled = try assembledPCMFile(record)
        let hash = assembled.hash
        var manifest = policyBody(record)
        manifest["session_id"] = sid; manifest["started_at"] = record.serverStartedAt
        manifest["files"] = [["name": "audio.pcm", "size": assembled.size, "sha256": hash]]
        manifest["meta"] = ["source": "apple_watch", "format": "16000hz-mono-s16le"]
        _ = try await write(id, path: "/sessions/\(sid)/recordings/manifest", body: manifest, asset: "audio", operation: "manifest", generation: current)
        for offset in stride(from: 0, to: assembled.size, by: 1_048_576) {
            try checkWork(id, generation: current)
            let bytes = try pcmPart(id, offset: offset, length: min(1_048_576, assembled.size - offset))
            let digest = BusinessCodec.hash(bytes)
            let receipt = PhoneWriteReceipt(id: BusinessCodec.operationID(id, digest + ":audio:" + String(offset)), path: "/sessions/\(sid)/recordings/audio.pcm?offset=\(offset)", uploadOffset: offset, uploadLength: bytes.count, contentHash: digest, asset: "audio")
            _ = try await prepareAndSend(receipt, id: id, generation: current)
        }
        let completed = try await write(id, path: "/sessions/\(sid)/recordings/complete", body: [:], asset: "audio", operation: "complete:" + hash, generation: current)
        guard completed["complete"] as? Bool == true else { throw BusinessError.message("原音尚未通过服务器完整校验") }
        update(id) { $0.audioUploaded = true }
        try persist()
    }

    private func assembledPCMFile(_ record: PhoneMeetingRecord) throws -> (size: Int, hash: String) {
        guard let last = record.chunks.max(by: { $0.descriptor.endMs < $1.descriptor.endMs }), last.descriptor.endMs <= maximumRecordingMs else {
            throw BusinessError.message("没有可合并的音频片段，或超过首版单场 30 分钟；未标记原音保存完成")
        }
        let byteCount = Int(last.descriptor.endMs) * 32
        let folder = try BusinessFiles.session(record.id)
        let target = folder.appendingPathComponent("phone-audio.pcm")
        let temporary = folder.appendingPathComponent("phone-assembly-" + UUID().uuidString + ".pcm")
        try privateWrite(Data(), to: temporary)
        defer { try? FileManager.default.removeItem(at: temporary) }
        let handle = try FileHandle(forWritingTo: temporary)
        defer { try? handle.close() }
        // Sparse holes read as zero PCM, including gaps between Watch segments.
        try handle.truncate(atOffset: UInt64(byteCount))
        for chunk in record.chunks.sorted(by: { $0.descriptor.startMs < $1.descriptor.startMs }) {
            try Task.checkCancellation()
            guard let name = chunk.pcmFile, let hash = chunk.pcmHash else { throw BusinessError.message("部分音频尚未完成真实 PCM 转换") }
            let bytes = try Data(contentsOf: folder.appendingPathComponent(name), options: .mappedIfSafe)
            guard bytes.count % 2 == 0, !bytes.isEmpty, BusinessCodec.hash(bytes) == hash else { throw BusinessError.message("本机 PCM 校验失败") }
            let start = Int(chunk.descriptor.startMs) * 32
            let slot = Int(chunk.descriptor.endMs - chunk.descriptor.startMs) * 32
            // Allow only codec framing roundoff, never silently drop a large part of a recording.
            guard abs(bytes.count - slot) <= 6_400, start + slot <= byteCount else { throw BusinessError.message("音频时长与片段时间不一致，请核对录音") }
            let used = min(bytes.count, slot)
            try handle.seek(toOffset: UInt64(start))
            try handle.write(contentsOf: bytes.prefix(used))
        }
        try handle.synchronize()
        let hash = try fileHash(temporary)
        if FileManager.default.fileExists(atPath: target.path) {
            guard try fileHash(target) == hash else { throw BusinessError.message("已冻结原音与当前片段不一致，不能换内容继续上传") }
        } else { try FileManager.default.moveItem(at: temporary, to: target) }
        return (byteCount, hash)
    }

    private func pcmPart(_ id: String, offset: Int, length: Int) throws -> Data {
        guard offset >= 0, length > 0, length <= 1_048_576 else { throw BusinessError.message("原上传片段范围无效") }
        let handle = try FileHandle(forReadingFrom: BusinessFiles.session(id).appendingPathComponent("phone-audio.pcm"))
        defer { try? handle.close() }
        try handle.seek(toOffset: UInt64(offset))
        guard let bytes = try handle.read(upToCount: length), bytes.count == length else { throw BusinessError.message("原上传片段已缺失，不能更换内容") }
        return bytes
    }

    private func fileHash(_ url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hash = SHA256()
        while let data = try handle.read(upToCount: 1_048_576), !data.isEmpty {
            try Task.checkCancellation()
            hash.update(data: data)
        }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private func write(_ id: String, path: String, body: [String: Any], asset: String, operation: String, forcedID: String? = nil, generation current: Int) async throws -> [String: Any] {
        let data = try jsonData(body)
        let hash = BusinessCodec.hash(data)
        let receipt = PhoneWriteReceipt(id: forcedID ?? BusinessCodec.operationID(id, hash + ":" + operation), path: path, body: data, contentHash: hash, asset: asset)
        return try await prepareAndSend(receipt, id: id, generation: current)
    }

    private func prepareAndSend(_ receipt: PhoneWriteReceipt, id: String, generation current: Int) async throws -> [String: Any] {
        try checkWork(id, generation: current)
        if let saved = record(id)?.requests.first(where: { $0.id == receipt.id }) {
            guard saved.path == receipt.path, saved.contentHash == receipt.contentHash else { throw BusinessError.message("原请求内容发生冲突，已停止写入") }
            if saved.state == "done", let response = saved.response { return try jsonObject(response) }
            throw BusinessError.message("原请求结果待核对，请点击重试查询；未自动重发")
        }
        guard record(id)?.requests.contains(where: { ["attempted", "unknown"].contains($0.state) }) == false else {
            throw BusinessError.message("本场仍有结果未知的请求，已停止后续写入")
        }
        update(id) { $0.requests.append(receipt) }
        try persist() // The exact operation exists on disk before any external write.
        return try await sendReceipt(receipt, id: id, generation: current)
    }

    private func sendReceipt(_ receipt: PhoneWriteReceipt, id: String, generation current: Int) async throws -> [String: Any] {
        try checkWork(id, generation: current)
        guard let record = record(id), assetLive(receipt.asset, record) else { throw BusinessError.message("原请求对应资产已到期，已停止写入") }
        do {
            let result: [String: Any]
            if let offset = receipt.uploadOffset, let length = receipt.uploadLength {
                let bytes = try pcmPart(id, offset: offset, length: length)
                guard BusinessCodec.hash(bytes) == receipt.contentHash else { throw BusinessError.message("原上传片段校验失败") }
                result = try await gateway.upload(receipt.path, data: bytes, requestID: receipt.id)
                guard result["received"] as? Int == offset + length else { throw BusinessError.message("服务器音频接收位置不匹配，已停止上传") }
            } else {
                guard let body = receipt.body, BusinessCodec.hash(body) == receipt.contentHash else { throw BusinessError.message("原请求正文缺失或校验失败") }
                result = try await gateway.json(receipt.path, method: "POST", body: jsonObject(body), requestID: receipt.id)
                if receipt.path != "/sessions", result["session_id"] as? String != record.serverID {
                    throw BusinessError.message("服务器回执的会话编号不匹配，已停止写入")
                }
            }
            try checkWork(id, generation: current)
            let response = try jsonData(result)
            update(id) { record in
                guard let index = record.requests.firstIndex(where: { $0.id == receipt.id }) else { return }
                record.requests[index].state = "done"; record.requests[index].response = response
            }
            try persist()
            return result
        } catch {
            update(id) { record in
                if let index = record.requests.firstIndex(where: { $0.id == receipt.id }) { record.requests[index].state = "unknown" }
                record.status = "写入结果待核对，已停止本场后续请求"
            }
            try? persist()
            throw error
        }
    }

    private func policyBody(_ record: PhoneMeetingRecord) -> [String: Any] {
        ["recording_mode": "meeting", "cloud_save_confirmed": true,
         "archive_started_at": record.serverStartedAt ?? BusinessCodec.iso(record.meeting.startedAt),
         "audio_retention_days": record.meeting.audioDays, "transcript_retention_days": record.meeting.textDays]
    }

    private func publish(_ id: String? = nil) {
        let configured = gateway.isConfigured
        asrReady = configured && capabilityBinding == gateway.configuration && asrStatus.available
            && asrStatus.checkedAt.map { Date().timeIntervalSince($0) < 300 } == true
        transport.setAuthorizedGrantID(storageHealthy && !connecting && configured ? gateway.configuration?.grantID : nil)
        let ready = storageHealthy && active && !connecting && configured && asrReady
        let readiness = PhoneReadiness(ready: ready, grantID: gateway.configuration?.grantID ?? "",
                                      validUntil: min(asrStatus.checkedAt?.addingTimeInterval(300) ?? Date(), gateway.configuration?.expiresAt ?? Date()),
                                      message: !configured ? "请先在 iPhone 连接业务服务" : !active ? "请先打开 iPhone 的 Oops" : !asrReady ? asrStatus.message : "Oops 后端转写已就绪，可接收手表录音")
        #if DEBUG
        writeReadinessDiagnostic(ready: ready, configured: configured)
        #endif
        let candidates = records.filter { matchesConfiguration($0) }
        let preferred = candidates.first(where: { $0.meeting.active }) ?? candidates.first
        let record = id == preferred?.id ? id.flatMap { self.record($0) } : preferred
        let progress: PhoneMeetingProgress?
        if let record, matchesConfiguration(record) {
            progress = PhoneMeetingProgress(sessionID: record.id, state: record.sourceUnavailable ? "unavailable" : record.meeting.endedAt == nil ? "recording" : record.chunks.contains(where: { $0.hasRejectedFinals }) || record.asrClosed && record.frozenASRClosure == "incomplete" ? "incomplete" : record.summary == nil ? "processing" : "ready",
                                            receivedChunks: durableAudio[record.id]?.count ?? 0,
                                            transcribedChunks: record.chunks.filter({ ["transcribed", "silence"].contains($0.state) }).count,
                                            message: record.status,
                                            summary: active && assetLive("transcript", record) ? record.summary.map { String($0.prefix(600)) } : nil,
                                            validUntil: assetLive("transcript", record) ? min(Date().addingTimeInterval(300), record.meeting.textExpiresAt) : Date(),
                                            grantID: record.grantID,
                                            receivedSHA256: durableAudio[record.id] ?? [:])
        } else { progress = nil }
        transport.publishPhone(readiness: readiness, progress: progress)
    }

    #if DEBUG
    /// A USB-created, expiring hold for an unspoken preparation recording.
    /// It cannot apply to another grant or extend the original audio contract.
    private func heldPreparationRecording(_ record: PhoneMeetingRecord) throws -> Bool {
        let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("oops-test-holds.json")
        guard FileManager.default.fileExists(atPath: url.path) else { return false }
        let data = try Data(contentsOf: url)
        guard data.count <= 16_384, let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              value["version"] as? Int == 1, let rows = value["sessions"] as? [[String: Any]], rows.count <= 8 else {
            throw BusinessError.message("测试暂缓清单读取失败，未提交后端转写")
        }
        let matches = rows.filter { $0["id"] as? String == record.id && $0["grant_id"] as? String == record.grantID }
        guard matches.count <= 1 else { throw BusinessError.message("测试暂缓清单重复，未提交后端转写") }
        guard let row = matches.first else { return false }
        guard let until = row["until"] as? Double, until.isFinite,
              until <= record.meeting.audioExpiresAt.timeIntervalSince1970 else {
            throw BusinessError.message("测试暂缓期限无效，未提交后端转写")
        }
        return until > Date().timeIntervalSince1970
    }

    /// Only this explicitly selected historical segment is authorized for the developer check.
    /// Its isolated receipt/result metadata never changes meeting text, closure, sync or minutes.
    /// Explicit USB recovery uses the same persisted-request reconciliation as the UI.
    /// It never starts a recording or creates a replacement ASR request.
    func reconcileSavedRequestsForUSB() async {
        for _ in 0..<4 {
            guard active, records.allSatisfy({ $0.meeting.endedAt != nil }) else { return }
            if let task = worker { await task.value; continue }
            retry()
            if let task = worker { await task.value }
            return
        }
    }

    func verifyAuthorizedBackendASR() async {
        if let task = verificationTask { await task.value; return }
        let task = Task<Void, Never> { @MainActor [weak self] in
            guard let self else { return }
            await self.runAuthorizedBackendASRCheck()
        }
        verificationTask = task
        await task.value
        verificationTask = nil
    }

    private func runAuthorizedBackendASRCheck() async {
        let watchID = "9C4B6DE9-7E7E-48CA-AB7E-95B1D3707CA3"
        let serverID = "b3e23c2f-6143-48a9-8745-699836341ad9"
        let sequence = 2
        let url = BusinessFiles.root.appendingPathComponent("backend-asr-verification.json")
        var metadata: [String: Any] = [:]
        do {
            await refreshASRCapability()
            let current = generation
            guard active, let record = records.first(where: { $0.id.caseInsensitiveCompare(watchID) == .orderedSame }),
                  record.serverID == serverID, matchesConfiguration(record), assetLive("both", record),
                  let chunk = record.chunks.first(where: { $0.descriptor.sequence == sequence }),
                  chunk.descriptor.startMs == 57_848, chunk.descriptor.endMs == 86_772,
                  let name = chunk.pcmFile, let hash = chunk.pcmHash else {
                throw BusinessError.message("指定旧场的原 PCM、时间、授权或服务器映射未匹配，未开始验证")
            }
            let pcm = try Data(contentsOf: BusinessFiles.session(record.id).appendingPathComponent(name), options: .mappedIfSafe)
            guard BusinessCodec.hash(pcm) == hash, !pcm.isEmpty, pcm.count <= 1_100_000 else { throw BusinessError.message("指定验证 PCM 校验失败") }
            let rid = BusinessCodec.operationID(record.id, "asr-v1:\(serverID):\(sequence):\(hash)")
            if FileManager.default.fileExists(atPath: url.path) {
                metadata = try jsonObject(Data(contentsOf: url))
                guard metadata["request_id"] as? String == rid, metadata["pcm_sha256"] as? String == hash,
                      metadata["server_id"] as? String == serverID,
                      metadata["grant_id"] as? String == record.grantID,
                      metadata["endpoint"] as? String == record.endpoint else {
                    throw BusinessError.message("原验证回执与当前授权或音频不一致；未创建另一付费请求")
                }
            } else {
                metadata = ["watch_id": watchID, "server_id": serverID, "sequence": sequence,
                            "request_id": rid, "pcm_sha256": hash, "pcm_size": pcm.count,
                            "grant_id": record.grantID, "endpoint": record.endpoint,
                            "clip_start_ms": chunk.descriptor.startMs, "clip_end_ms": chunk.descriptor.endMs,
                            "attempted": false, "same_session": true, "same_hash": true]
            }
            if metadata["attempted"] as? Bool != true {
                guard asrReady else { throw BusinessError.message("Oops 后端转写尚未就绪，未开始验证") }
                metadata["attempted"] = true; metadata["state"] = "attempted"
                metadata["attempted_at"] = BusinessCodec.iso(Date())
                try privateWrite(jsonData(metadata), to: url)
                do {
                    _ = try await gateway.submitASR(sessionID: serverID, sequence: sequence,
                                                     startMs: chunk.descriptor.startMs, endMs: chunk.descriptor.endMs,
                                                     pcm: pcm, requestID: rid)
                    metadata["registration_reply_received"] = true
                } catch {
                    metadata["registration_reply_received"] = false
                    metadata["state"] = "registration_outcome_unknown"
                    metadata["registration_error_code"] = (error as? GatewayHTTPError)?.code ?? String((error as NSError).code)
                    try privateWrite(jsonData(metadata), to: url)
                    if error is CancellationError { return }
                }
            }
            // Any prior attempted flag, including a lost first reply, permits only GET here.
            for attempt in 0..<45 {
                try checkWork(record.id, generation: current)
                let job = try await gateway.asrJob(sessionID: serverID, sequence: sequence)
                try checkWork(record.id, generation: current)
                let sameSession = job["session_id"] as? String == serverID
                let sameHash = job["pcm_sha256"] as? String == hash
                metadata["same_session"] = sameSession; metadata["same_hash"] = sameHash
                metadata["same_request"] = job["request_id"] as? String == rid
                guard sameSession, sameHash, job["request_id"] as? String == rid,
                      job["sequence"] as? Int == sequence, job["asr_engine"] as? String == backendEngine else {
                    throw BusinessError.message("验证 ASR 回包未匹配原会话、音频或请求")
                }
                let rows = try validatedASRRows(job, startMs: chunk.descriptor.startMs, endMs: chunk.descriptor.endMs)
                metadata.removeValue(forKey: "error_code")
                metadata.removeValue(forKey: "updated_at")
                let processing = job["processing"] as? [String: Any]
                let items = processing?["items"] as? [[String: Any]] ?? []
                metadata["state"] = job["state"] as? String ?? "unknown"
                metadata["closure"] = job["provider_closure"] ?? NSNull()
                metadata["asr_engine"] = job["asr_engine"] ?? NSNull()
                metadata["utterance_count"] = rows.count
                metadata["character_count"] = rows.reduce(0) { $0 + (($1["text"] as? String)?.count ?? 0) }
                metadata["word_time_count"] = rows.reduce(0) { $0 + (($1["words"] as? [[String: Any]])?.count ?? 0) }
                metadata["result_start_ms"] = rows.compactMap { $0["start_ms"] as? Int64 }.min() ?? 0
                metadata["result_end_ms"] = rows.compactMap { $0["end_ms"] as? Int64 }.max() ?? 0
                metadata["processing_state"] = processing?["state"] as? String ?? "not_reported"
                metadata["processing_item_count"] = items.count
                metadata["processing_ready_count"] = items.filter { $0["state"] as? String == "ready" }.count
                metadata["processing_failed_count"] = items.filter { ["failed", "unknown"].contains($0["state"] as? String ?? "") }.count
                metadata["queried_at"] = BusinessCodec.iso(Date())
                for key in ["created_at", "started_at", "finished_at", "updated_at", "elapsed_ms"] {
                    if let value = job[key] as? NSNumber { metadata["job_" + key] = value }
                    else if let value = job[key] as? String, value.count <= 80 { metadata["job_" + key] = value }
                }
                try privateWrite(jsonData(metadata), to: url)
                let state = job["state"] as? String ?? "unknown"
                let processingState = processing?["state"] as? String ?? "not_reported"
                if state == "unknown" || (!["queued", "running"].contains(state) && !["pending", "running"].contains(processingState)) { return }
                if attempt < 44 { try await Task.sleep(for: .seconds(2)) }
            }
        } catch {
            metadata["state"] = error is CancellationError ? "query_paused" : "query_or_validation_failed"
            metadata["error_code"] = (error as? GatewayHTTPError)?.code ?? String((error as NSError).code)
            metadata["updated_at"] = BusinessCodec.iso(Date())
            if metadata["request_id"] != nil { try? privateWrite(jsonData(metadata), to: url) }
            if !(error is CancellationError) { issue = error.localizedDescription }
        }
    }

    private func capabilityErrorDiagnostic(_ error: Error, previous: PhoneCapabilityDiagnostic?) -> PhoneCapabilityDiagnostic {
        let nsError = error as NSError
        var value = PhoneCapabilityDiagnostic(outcome: "other_error", schemaMatched: previous?.schemaMatched,
                                               available: previous?.available, error: safeNSErrorDiagnostic(nsError))
        if error is CancellationError || nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled {
            value.outcome = "cancelled"
        } else if let http = error as? GatewayHTTPError {
            value.outcome = "http_error"; value.httpStatus = http.status
            let codes: Set<String> = ["MOBILE_UNAUTHORIZED", "ASR_UNAVAILABLE", "GATEWAY_UNAVAILABLE", "HTTP_ERROR"]
            value.gatewayCode = codes.contains(http.code) ? http.code : "OTHER_GATEWAY_CODE"
        } else if nsError.domain == NSURLErrorDomain {
            value.outcome = "url_error"
        } else if error is BusinessError {
            value.outcome = "local_validation_error"
        }
        var underlying: [PhoneCapabilityNSErrorDiagnostic] = []
        var current = nsError
        for _ in 0..<2 {
            guard let next = current.userInfo[NSUnderlyingErrorKey] as? NSError, next !== current else { break }
            underlying.append(safeNSErrorDiagnostic(next))
            current = next
        }
        if !underlying.isEmpty { value.underlyingErrors = underlying }
        return value
    }

    private func safeNSErrorDiagnostic(_ error: NSError) -> PhoneCapabilityNSErrorDiagnostic {
        let domains: Set<String> = [NSURLErrorDomain, NSCocoaErrorDomain, NSOSStatusErrorDomain,
                                    NSPOSIXErrorDomain, NSMachErrorDomain,
                                    "kCFErrorDomainCFNetwork", "kCFErrorDomainCFSocket"]
        return PhoneCapabilityNSErrorDiagnostic(domain: domains.contains(error.domain) ? error.domain : "OtherNSErrorDomain",
            code: error.code,
            streamErrorDomain: safeDiagnosticInteger(error.userInfo["_kCFStreamErrorDomainKey"]),
            streamErrorCode: safeDiagnosticInteger(error.userInfo["_kCFStreamErrorCodeKey"]))
    }

    private func safeDiagnosticInteger(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite else { return nil }
        let integer = number.int64Value
        guard number.compare(NSNumber(value: integer)) == .orderedSame else { return nil }
        return Int(exactly: integer)
    }

    private func writeReadinessDiagnostic(ready: Bool, configured: Bool) {
        // Deliberately omit the raw business error: an upstream error could echo private text.
        var value: [String: Any] = [
            "asrStatus": ["phase": asrStatus.phase, "engine": asrStatus.engine, "available": asrStatus.available],
            "active": active, "ready": ready, "configured": configured, "asrReady": asrReady,
            "connecting": connecting, "storageHealthy": storageHealthy,
            "tls_profile": gateway.tlsDiagnosticProfile,
            "watchTransportActivated": transport.activated, "watchInstantReachable": transport.reachable,
            "issue": issue == nil ? NSNull() : "business_issue_present"
        ]
        if let diagnostic = asrStatus.diagnostics,
           let data = try? BusinessCodec.encode(diagnostic), let object = try? jsonObject(data) {
            value["capabilityDiagnostics"] = object
        }
        guard let signature = try? jsonData(value), signature != lastReadinessDiagnostic else { return }
        var snapshot = value
        snapshot["updated_at"] = BusinessCodec.iso(Date())
        guard let data = try? jsonData(snapshot) else { return }
        do {
            try BusinessFiles.write(data, to: BusinessFiles.root.appendingPathComponent("usb-readiness.json"))
            lastReadinessDiagnostic = signature
        } catch {
            // Diagnostics must not alter permissions, ready state or the business error.
        }
    }
    #endif

    /// Delivery acknowledgement is independent of the single currently visible meeting.
    private func publishAudioReceipt(_ id: String) {
        guard let record = record(id), matchesConfiguration(record), !record.sourceUnavailable,
              assetLive("audio", record), let hashes = durableAudio[id], !hashes.isEmpty else { return }
        transport.publishAudioReceipt(meetingID: id, grantID: record.grantID, receivedSHA256: hashes)
    }

    private func checkWork(_ id: String, generation current: Int) throws {
        try Task.checkCancellation()
        guard active, generation == current, let record = record(id), matchesConfiguration(record), !record.sourceUnavailable else {
            throw CancellationError()
        }
    }

    private func matchesConfiguration(_ record: PhoneMeetingRecord) -> Bool {
        guard let configuration = gateway.configuration, gateway.isConfigured else { return false }
        return record.endpoint == configuration.endpoint && record.grantID == configuration.grantID && record.meeting.grantID == configuration.grantID
    }

    private var hasUnfinishedMeeting: Bool {
        records.contains { record in
            guard let configuration = gateway.configuration, configuration.isValid,
                  record.endpoint == configuration.endpoint, record.grantID == configuration.grantID,
                  !record.sourceUnavailable else { return false }
            if record.meeting.active { return true }
            let audioPending = assetLive("audio", record) && !record.chunks.isEmpty && !record.audioUploaded
            let textPending = assetLive("transcript", record) && !record.asrClosed
            let requestPending = record.requests.contains { ["attempted", "unknown"].contains($0.state) }
            return audioPending || textPending || requestPending
        }
    }

    private func allAudioArrived(_ record: PhoneMeetingRecord) -> Bool {
        guard record.meeting.endedAt != nil, let expected = record.meeting.expectedChunkCount, expected >= 0, expected <= 20_000,
              record.chunks.count == expected else { return false }
        return record.chunks.map({ $0.descriptor.sequence }).sorted() == Array(0..<expected)
    }

    private func assetLive(_ asset: String, _ record: PhoneMeetingRecord) -> Bool {
        let unavailable = record.unavailableAssets ?? []
        return (asset != "audio" && asset != "both" || record.meeting.audioExpiresAt > Date() && !unavailable.contains("audio"))
            && (asset != "transcript" && asset != "both" || record.meeting.textExpiresAt > Date() && !unavailable.contains("transcript"))
    }

    private func finishWorker(generation current: Int) {
        guard generation == current else { return }
        worker = nil; busy = connecting
        publish()
        if workAgain { workAgain = false; beginWork() }
    }

    private func record(_ id: String) -> PhoneMeetingRecord? { records.first(where: { $0.id == id }) }
    private func chunk(_ id: String, _ sequence: Int) -> PhoneChunkRecord? { record(id)?.chunks.first(where: { $0.descriptor.sequence == sequence }) }
    private func update(_ id: String, _ mutation: (inout PhoneMeetingRecord) -> Void) {
        guard let index = records.firstIndex(where: { $0.id == id }) else { return }
        mutation(&records[index])
    }
    private func updateChunk(_ id: String, _ sequence: Int, _ mutation: (inout PhoneChunkRecord) -> Void) {
        update(id) { record in
            guard let index = record.chunks.firstIndex(where: { $0.descriptor.sequence == sequence }) else { return }
            mutation(&record.chunks[index])
        }
    }

    private func persist() throws {
        guard storageHealthy else { throw BusinessError.message("本机记录未恢复，已停止覆盖保存") }
        try privateWrite(BusinessCodec.encode(records), to: databaseURL)
        durableAudio = Dictionary(uniqueKeysWithValues: records.map { record in
            (record.id, Dictionary(uniqueKeysWithValues: record.chunks.filter({ $0.audioFile != nil }).map { ($0.descriptor.sequence, $0.descriptor.sha256) }))
        })
    }
    private func privateWrite(_ data: Data, to url: URL) throws {
        try BusinessFiles.write(data, to: url)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
    private func jsonData(_ value: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) }
    private func jsonObject(_ data: Data) throws -> [String: Any] {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw BusinessError.message("本机请求回执无效") }
        return object
    }

    private func clearSummaries() {
        for index in records.indices { records[index].summary = nil; records[index].summaryCheckedAt = nil }
    }

    private func pruneExpired() throws {
        let now = Date()
        if let configuration = gateway.configuration, !configuration.isValid {
            purgeCurrentGrant(message: "手机授权已过期，本机旧正文与音频已清除")
            gateway.disconnect(); transport.setAuthorizedGrantID(nil)
        }
        // A transient Keychain read failure makes the UI unavailable, but is not proof of
        // revocation. Purge only known expiry, removed/replaced binding or explicit source loss.
        for id in records.filter({ $0.sourceUnavailable || $0.endpoint != gateway.configuration?.endpoint || $0.grantID != gateway.configuration?.grantID }).map(\.id) {
            try purgeContent(id, message: record(id)?.status ?? "原手机授权已失效，本机正文与音频已清除")
        }
        for index in records.indices {
            let folder = try BusinessFiles.session(records[index].id)
            let audioExpired = !assetLive("audio", records[index])
            let textExpired = !assetLive("transcript", records[index])
            if audioExpired || textExpired {
                let hadRejected = records[index].chunks.contains(where: { $0.hasRejectedFinals })
                var evidenceChanged = records[index].chunks.contains { $0.backendRejectedFinals != nil || $0.backendASRDiagnostics != nil }
                for chunk in records[index].chunks.indices {
                    records[index].chunks[chunk].backendRejectedFinals = nil
                    records[index].chunks[chunk].backendASRDiagnostics = nil
                    if let data = records[index].chunks[chunk].backendProcessing {
                        if var processing = try? jsonObject(data) {
                            let hadFinals = processing.removeValue(forKey: "rejected_finals") != nil
                            let hadDiagnostics = processing.removeValue(forKey: "diagnostics") != nil
                            if hadFinals || hadDiagnostics {
                                records[index].chunks[chunk].backendProcessing = try jsonData(processing)
                                evidenceChanged = true
                            }
                        } else { records[index].chunks[chunk].backendProcessing = nil; evidenceChanged = true }
                    }
                }
                var requests = records[index].asrRequests ?? []
                for request in requests.indices where requests[request].response != nil {
                    requests[request].response = nil; requests[request].state = "expired"
                    evidenceChanged = true
                }
                records[index].asrRequests = requests
                if hadRejected, audioExpired, !textExpired {
                    records[index].status = "待核对原话已按较短期限清除；有效已对齐原文仍按全文期限保留"
                }
                // Erase durable evidence before protected audio-file deletion can fail.
                if evidenceChanged { try persist() }
            }
            if audioExpired {
                for url in try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil) {
                    if url.lastPathComponent.hasPrefix("chunk-") || url.lastPathComponent.hasPrefix("phone-chunk-") || url.lastPathComponent.hasPrefix("phone-pcm-") || url.lastPathComponent.hasPrefix("phone-assembly-") {
                        try FileManager.default.removeItem(at: url)
                    }
                }
                for chunk in records[index].chunks {
                    for name in [chunk.audioFile, chunk.pcmFile].compactMap({ $0 }) {
                        let url = folder.appendingPathComponent(name)
                        if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
                    }
                }
                let combined = folder.appendingPathComponent("phone-audio.pcm")
                if FileManager.default.fileExists(atPath: combined.path) { try FileManager.default.removeItem(at: combined) }
                for chunk in records[index].chunks.indices {
                    records[index].chunks[chunk].audioFile = nil; records[index].chunks[chunk].pcmFile = nil
                    if ["pending", "processing"].contains(records[index].chunks[chunk].state), !textExpired {
                        records[index].chunks[chunk].state = "failed"
                        records[index].chunks[chunk].issue = "原音已到期清除，无法继续转写本段"
                    }
                }
            }
            if textExpired {
                for chunk in records[index].chunks.indices {
                    records[index].chunks[chunk].text = nil; records[index].chunks[chunk].issue = nil; records[index].chunks[chunk].state = "text_expired"
                    records[index].chunks[chunk].backendUtterances = nil; records[index].chunks[chunk].backendProcessing = nil
                    records[index].chunks[chunk].backendRejectedFinals = nil; records[index].chunks[chunk].backendASRDiagnostics = nil
                }
                records[index].summary = nil; records[index].summaryCheckedAt = nil
            } else if let checked = records[index].summaryCheckedAt, now.timeIntervalSince(checked) >= 300 {
                records[index].summary = nil; records[index].summaryCheckedAt = nil
            }
            for request in records[index].requests.indices {
                let asset = records[index].requests[request].asset
                if (audioExpired && ["audio", "both"].contains(asset)) || (textExpired && ["transcript", "both"].contains(asset)) {
                    records[index].requests[request].body = nil; records[index].requests[request].response = nil; records[index].requests[request].state = "expired"
                }
            }
            var asrRequests = records[index].asrRequests ?? []
            for request in asrRequests.indices {
                if audioExpired { asrRequests[request].pcmFile = ""; asrRequests[request].state = "expired" }
                if audioExpired || textExpired { asrRequests[request].response = nil; asrRequests[request].state = "expired" }
            }
            records[index].asrRequests = asrRequests
            if audioExpired && textExpired { records[index].status = "原音与全文均已到期清除" }
        }
    }

    private func discardIncoming(_ url: URL) {
        guard url.path.hasPrefix(BusinessFiles.root.path + "/"),
              !records.contains(where: { $0.chunks.contains(where: { $0.audioFile == url.lastPathComponent || $0.pcmFile == url.lastPathComponent }) }) else { return }
        try? FileManager.default.removeItem(at: url)
    }

    private func handleRevocation(_ error: Error, id: String) {
        guard let error = error as? GatewayHTTPError else { return }
        if [401, 403].contains(error.status) {
            purgeCurrentGrant(message: "手机授权已失效，本机正文与音频已清除")
            gateway.disconnect(); transport.setAuthorizedGrantID(nil)
            issue = "手机业务授权已失效，请重新连接"
        }
        if error.status == 410, let asset = error.asset, ["audio", "transcript"].contains(asset) {
            update(id) {
                var assets = $0.unavailableAssets ?? []
                if !assets.contains(asset) { assets.append(asset) }
                $0.unavailableAssets = assets
                $0.status = asset == "audio" ? "原音已到期清除；有效全文仍保留" : "全文已到期清除；未到期原音仍保留"
            }
            do { try persist(); try pruneExpired(); try persist() }
            catch { issue = "对应资产已停止使用，本机分项清理未完成，请重新打开 App 重试。" }
            workAgain = true
            return
        }
        let sourceLost = ["SOURCE_DELETED", "SESSION_DELETED", "MEETING_DELETED", "SOURCE_REVOKED", "GRANT_REVOKED"].contains(error.code.uppercased())
        if error.status == 410 && sourceLost || error.status == 404 && record(id)?.lastSyncHash != nil {
            try? purgeContent(id, message: "服务器来源已不存在或失效，本机旧正文与音频已清除")
        } else if error.status == 410 {
            // An unclassified expiry is not permission to erase the other independent asset.
            update(id) { $0.summary = nil; $0.summaryCheckedAt = nil; $0.status = "服务器返回到期状态，资产类别待核对；未清除另一类内容" }
        }
    }

    private func purgeCurrentGrant(message: String) {
        guard let configuration = gateway.configuration else { return }
        for id in records.filter({ $0.endpoint == configuration.endpoint && $0.grantID == configuration.grantID }).map(\.id) {
            do { try purgeContent(id, message: message) }
            catch { issue = "授权已停止，本机音频清理尚未完成，请重新打开 App 重试清理。" }
        }
        try? persist()
    }

    /// Retain only routing identifiers, hashes and outcome metadata after revocation.
    private func purgeContent(_ id: String, message: String) throws {
        issue = message
        update(id) { record in
            record.summary = nil; record.summaryCheckedAt = nil; record.sourceUnavailable = true
            record.status = message; record.meeting.title = "已失效会话"; record.meeting.error = nil
            for index in record.chunks.indices {
                record.chunks[index].text = nil; record.chunks[index].issue = nil
                record.chunks[index].backendUtterances = nil; record.chunks[index].backendProcessing = nil
                record.chunks[index].backendRejectedFinals = nil; record.chunks[index].backendASRDiagnostics = nil
                record.chunks[index].state = "unavailable"
                record.chunks[index].audioFile = nil; record.chunks[index].pcmFile = nil
            }
            for index in record.requests.indices {
                record.requests[index].body = nil; record.requests[index].response = nil
                if record.requests[index].state == "attempted" { record.requests[index].state = "unknown" }
            }
            var asrRequests = record.asrRequests ?? []
            for index in asrRequests.indices {
                asrRequests[index].pcmFile = ""; asrRequests[index].response = nil
                if asrRequests[index].state == "attempted" { asrRequests[index].state = "unknown" }
            }
            record.asrRequests = asrRequests
        }
        // Clear persisted plaintext even if deleting a protected audio file subsequently fails.
        try persist()
        let folder = try BusinessFiles.session(id)
        for file in try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil) {
            if ["m4a", "pcm"].contains(file.pathExtension.lowercased()) { try FileManager.default.removeItem(at: file) }
        }
    }

    private func summaryText(_ minutes: [String: Any]) -> String {
        var parts: [String] = []
        if let overview = minutes["overview"] as? String, !overview.isEmpty { parts.append(overview) }
        for decision in (minutes["decisions"] as? [[String: Any]] ?? []) {
            if let text = decision["text"] as? String { parts.append("决定：" + text) }
        }
        for action in (minutes["actions"] as? [[String: Any]] ?? []) {
            if let text = action["task"] as? String { parts.append("待核对：" + text) }
        }
        return String(parts.joined(separator: "\n").prefix(600))
    }
}
#endif
