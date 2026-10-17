import SwiftUI

@main struct OopsPhoneApp: App {
    var body: some Scene { WindowGroup { OopsPhoneHome() } }
}

struct OopsPhoneHome: View {
    @StateObject private var store = PhoneBusinessStore()
    @ObservedObject private var transport = BusinessTransport.shared
    @Environment(\.scenePhase) private var scenePhase
    @State private var settings = false
    @State private var handledUSBPreparation = false
    @State private var handledASRVerification = false
    private let purple = Color(red: 0.59, green: 0.39, blue: 0.91)

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 10) {
                        Label("让每一次交流有下文", systemImage: "waveform").font(.title3.bold()).foregroundStyle(purple)
                        Text("用 Apple Watch 记录，iPhone 把音频交给 Oops 后端转写，再同步会后结果。")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }.padding(.vertical, 8)
                    Label(transport.activated ? "已启用手表同步" : "正在激活手表同步", systemImage: "applewatch")
                    if store.configuration == nil { Button("连接 Oops 服务") { settings = true } }
                    Label(store.asrStatus.message, systemImage: store.asrReady ? "checkmark.circle" : "network")
                    if !store.asrReady { Button("核对 Oops 后端转写") { Task { await store.refreshASRCapability() } } }
                    if let issue = store.issue { Text(issue).font(.footnote).foregroundStyle(.orange) }
                }
                Section("手表会话") {
                    if store.visibleRecords.isEmpty {
                        ContentUnavailableView("等待第一场会话", systemImage: "mic", description: Text("完成手机设置后，在手表选择保存期限并开始正式会议。"))
                    }
                    ForEach(store.visibleRecords) { record in
                        NavigationLink {
                            PhoneMeetingDetail(store: store, id: record.id)
                        } label: {
                            VStack(alignment: .leading, spacing: 6) {
                                Text(record.meeting.title).font(.headline)
                                Text(record.meeting.startedAt, style: .date).font(.caption).foregroundStyle(.secondary)
                                Text(record.status).font(.subheadline)
                                if record.frozenASRClosure == "incomplete" {
                                    Label("转写未完整，请结合原音核对", systemImage: "exclamationmark.triangle")
                                        .font(.caption).foregroundStyle(.orange)
                                }
                                Text("已接收 \(record.chunks.count) 段 · 原音 \(record.meeting.audioDays) 天 · 全文 \(record.meeting.textDays) 天").font(.caption).foregroundStyle(.secondary)
                            }.padding(.vertical, 6)
                        }
                    }
                }
                Section {
                    Button(store.busy ? "正在处理…" : "核对并继续处理") { store.retry() }.disabled(store.busy)
                    Text("录音由手表明确开始。手机退出前台后停止读取，回来继续查询原任务；已提交的后端转写可继续处理。原音、文字和会后结果分别核对。")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Oops")
            .tint(purple)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("连接", systemImage: "gearshape") { settings = true } } }
            .sheet(isPresented: $settings) { PhoneConnectionSettings(store: store) }
            .task {
                store.setActive(true); transport.refresh()
                #if DEBUG
                if !handledUSBPreparation, ProcessInfo.processInfo.arguments.contains("--oops-connect-prepared") {
                    handledUSBPreparation = true
                    await connectUSBPreparation()
                }
                await store.refreshASRCapability()
                if ProcessInfo.processInfo.arguments.contains("--oops-reconcile-saved-requests") {
                    await store.reconcileSavedRequestsForUSB()
                }
                if !handledASRVerification, ProcessInfo.processInfo.arguments.contains("--oops-verify-backend-asr") {
                    handledASRVerification = true
                    await store.verifyAuthorizedBackendASR()
                }
                #endif
            }
            .onChange(of: scenePhase) { _, phase in store.setActive(phase == .active); if phase == .active { transport.refresh() } }
        }
    }
    #if DEBUG
    /// Explicit, one-shot developer launch argument. No microphone or recording command.
    private func connectUSBPreparation() async {
        let file = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("oops-pairing.json")
        guard let data = try? Data(contentsOf: file),
              let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: String],
              let endpoint = value["endpoint"], let code = value["code"] else { return }
        if store.configuration?.isValid != true { await store.connect(endpoint: endpoint, code: code) }
        if store.configuration?.isValid == true { try? FileManager.default.removeItem(at: file) }
    }
    #endif
}

private struct PhoneMeetingDetail: View {
    @ObservedObject var store: PhoneBusinessStore
    let id: String
    var body: some View {
        List {
            if let record = store.visibleRecords.first(where: { $0.id == id }) {
                Section("当前进度") {
                    Text(record.status)
                    if record.frozenASRClosure == "incomplete" {
                        Label("转写未完整，请结合原音核对", systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.orange)
                    }
                    Text("手表原音保存至 \(record.meeting.audioExpiresAt.formatted(date: .abbreviated, time: .shortened))").font(.caption)
                    Text("全文保存至 \(record.meeting.textExpiresAt.formatted(date: .abbreviated, time: .shortened))").font(.caption)
                }
                Section(record.legacyASRLocked == true ? "历史 iPhone 本机转写" : "Oops 后端原始转写") {
                    if record.legacyASRLocked == true {
                        Text("这里保留旧版识别结果；没有文字的片段仍可能包含讲话，不表示手表没有录到声音。")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    ForEach(record.chunks) { chunk in
                        VStack(alignment: .leading, spacing: 6) {
                            Text("第 \(chunk.descriptor.sequence + 1) 段").font(.caption).foregroundStyle(.secondary)
                            if !chunk.utterances.isEmpty {
                                ForEach(chunk.utterances) { utterance in
                                    Text(String(format: "%.2f–%.2f 秒", Double(utterance.start_ms) / 1000, Double(utterance.end_ms) / 1000))
                                        .font(.caption2).foregroundStyle(.secondary)
                                    Text(utterance.text).textSelection(.enabled)
                                }
                            } else if let text = chunk.text { Text(text).textSelection(.enabled) }
                            else {
                                Text(chunk.issue ?? (chunk.state == "silence"
                                    ? "未识别出文字，原音请单独核对"
                                    : record.legacyASRLocked == true ? "旧版尚未完成识别，原音请单独核对" : "等待 Oops 后端转写"))
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                if min(record.meeting.audioExpiresAt, record.meeting.textExpiresAt) > Date(),
                   record.chunks.contains(where: { $0.hasRejectedFinals }) {
                    Section("未对齐／待核对原话") {
                        Text("请结合原音核对这些文字。它们尚未纳入已对齐原文和会后整理。")
                            .font(.footnote).foregroundStyle(.secondary)
                        ForEach(record.chunks.filter { $0.hasRejectedFinals }) { chunk in
                            ForEach(chunk.rejectedFinals) { rejected in
                                VStack(alignment: .leading, spacing: 6) {
                                    Text("第 \(chunk.descriptor.sequence + 1) 段 · 待核对原话 \(rejected.index + 1)")
                                        .font(.caption).foregroundStyle(.secondary)
                                    if rejected.text.isEmpty {
                                        Text("供应商未返回可读正文").foregroundStyle(.secondary)
                                    } else { Text(rejected.text).textSelection(.enabled) }
                                    Text(rejectionReason(rejected.reason)).font(.footnote).foregroundStyle(.orange)
                                    Text("原始片段起点：\(providerCoordinate(rejected.provider_coordinates.start_time))")
                                        .font(.caption2).foregroundStyle(.secondary).textSelection(.enabled)
                                    Text("原始片段终点：\(providerCoordinate(rejected.provider_coordinates.end_time))")
                                        .font(.caption2).foregroundStyle(.secondary).textSelection(.enabled)
                                }
                            }
                            if chunk.rejectedOverflowCount > 0 {
                                Text("第 \(chunk.descriptor.sequence + 1) 段另有 \(chunk.rejectedOverflowCount) 条原话未能完整保留，请结合原音核对。")
                                    .font(.footnote).foregroundStyle(.orange)
                            } else if chunk.rejectedFinals.isEmpty {
                                Text("第 \(chunk.descriptor.sequence + 1) 段有原话未能对齐，请结合原音核对。")
                                    .font(.footnote).foregroundStyle(.orange)
                            }
                        }
                    }
                }
                Section("会后结果") {
                    if let summary = record.summary { Text(summary).textSelection(.enabled) }
                    else { Text("结果尚未就绪。手机只读取本场已有结果，不从旧会话补造。").foregroundStyle(.secondary) }
                    Button("读取本场结果") { Task { await store.refreshResult(id) } }.disabled(store.busy)
                }
            } else { Text("本场内容已不可用") }
        }
        .navigationTitle("会话详情")
        .task { await store.refreshResult(id) }
    }
    private func providerCoordinate(_ value: PhoneASRProviderCoordinate) -> String {
        value.present ? value.raw_json : "未提供"
    }
    private func rejectionReason(_ reason: String) -> String {
        switch reason {
        case "invalid_final": "供应商原话结构不完整，需核对"
        case "invalid_text": "供应商正文格式无效，需结合原音核对"
        case "text_limit": "原话超过本次处理长度，尚未对齐"
        case "invalid_coordinates": "供应商原始时间范围与本段录音不符"
        case "final_count_limit": "原话条目超过本次处理范围"
        case "result_limit": "原话结果超过本次保存范围"
        default: "原话尚未对齐，需结合原音核对"
        }
    }
}

private struct PhoneConnectionSettings: View {
    @ObservedObject var store: PhoneBusinessStore
    @Environment(\.dismiss) private var dismiss
    @State private var endpoint = ""
    @State private var code = ""
    @State private var connecting = false
    @State private var disconnecting = false
    var body: some View {
        NavigationStack {
            Form {
                if let configuration = store.configuration {
                    Section("当前服务") {
                        Text(configuration.endpoint).font(.footnote)
                        Text("手机授权至 \(configuration.expiresAt.formatted(date: .abbreviated, time: .shortened))")
                        Button("断开本机连接", role: .destructive) { disconnecting = true }
                    }
                } else {
                    Section("手机专用连接") {
                        TextField("HTTPS 服务地址", text: $endpoint).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                        SecureField("单次配对码", text: $code).textInputAutocapitalization(.never).autocorrectionDisabled()
                        Button(connecting ? "正在连接…" : "连接服务") {
                            connecting = true
                            Task { await store.connect(endpoint: endpoint.trimmingCharacters(in: .whitespacesAndNewlines), code: code); code = ""; connecting = false }
                        }.disabled(connecting || endpoint.isEmpty || code.isEmpty)
                        Text("此连接只管理本手机新建的会话。配对码用后失效；服务凭据不会发送到手表。")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                Section("Oops 后端转写") {
                    Label(store.asrStatus.message, systemImage: "text.bubble")
                    Button("核对后端转写能力") { Task { await store.refreshASRCapability() } }
                    Text("手表原音沿用 Oops 的火山识别与语句处理链路，保留实际句子和词时间。失败时显示真实状态，不回退到 Apple 本机识别。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if let issue = store.issue { Section { Text(issue).foregroundStyle(.orange) } }
            }
            .navigationTitle("连接与转写")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
            .confirmationDialog("断开会清除本机可见的会后结果；云端既有保存不因此删除。", isPresented: $disconnecting, titleVisibility: .visible) {
                Button("断开连接", role: .destructive) { store.disconnect() }
                Button("取消", role: .cancel) { }
            }
            .task { readPairingPreparation() }
        }
    }
    private func readPairingPreparation() {
        let file = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("oops-pairing.json")
        if let data = try? Data(contentsOf: file), let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: String] {
            endpoint = value["endpoint"] ?? ""; code = value["code"] ?? ""
            try? FileManager.default.removeItem(at: file)
        }
    }
}
