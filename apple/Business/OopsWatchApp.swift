import SwiftUI

@main struct OopsWatchApp: App {
    var body: some Scene { WindowGroup { OopsWatchHome() } }
}

struct OopsWatchHome: View {
    @StateObject private var store = WatchBusinessStore()
    @ObservedObject private var transport = BusinessTransport.shared
    @Environment(\.scenePhase) private var scenePhase
    @State private var preparing = false
    @State private var ending = false
    @State private var audioDays = 30
    @State private var textDays = 30
    @State private var consent = false
    @State private var handledUSBRecording = false
    private let purple = Color(red: 0.59, green: 0.39, blue: 0.91)

    var body: some View {
        NavigationStack {
            TimelineView(.periodic(from: .now, by: 1)) { _ in
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        Label("Oops", systemImage: "waveform").font(.title2.bold()).foregroundStyle(purple)
                        if let meeting = store.meeting {
                            Text(phase(meeting.phase)).font(.headline)
                            Text(Duration.milliseconds(store.elapsedMs).formatted(.time(pattern: .minuteSecond))).font(.system(.title, design: .rounded).monospacedDigit())
                            if store.isActive {
                                if meeting.phase == "paused" {
                                    Button("继续录音", systemImage: "mic.fill") { Task { await store.resume() } }.tint(purple)
                                } else {
                                    Button("暂停", systemImage: "pause.fill") { store.pause() }.disabled(meeting.phase != "recording")
                                }
                                Button("结束并保存", systemImage: "stop.fill", role: .destructive) { ending = true }
                                    .disabled(!["recording", "paused"].contains(meeting.phase))
                            }
                            if let progress = transport.progress, progress.sessionID == meeting.id, progress.validUntil > Date() {
                                Text(progress.message).font(.footnote)
                                if progress.state == "incomplete" {
                                    Text("转写未完整，请在手机核对原音").font(.caption2).foregroundStyle(.orange)
                                }
                                Text("已接收 \(progress.receivedChunks) 段 · 已转写 \(progress.transcribedChunks) 段").font(.caption2).foregroundStyle(.secondary)
                                if let summary = progress.summary, !summary.isEmpty { Text(summary).font(.footnote) }
                            }
                        }
                        if !store.isActive {
                            Button("开始正式会议", systemImage: "mic.fill") { consent = false; preparing = true }
                                .buttonStyle(.borderedProminent).tint(purple).disabled(!store.canStart)
                        }
                        if transport.peerReady?.canStart != true { Text(transport.peerReady?.message ?? "先在 iPhone 打开 Oops，连接服务并准备后端转写。").font(.caption2).foregroundStyle(.secondary) }
                        if let issue = store.issue ?? transport.issue { Text(issue).font(.caption2).foregroundStyle(.orange) }
                        Label(transport.reachable ? "手机即时消息可用" : "音频等待系统传送", systemImage: "iphone.radiowaves.left.and.right").font(.caption2).foregroundStyle(.secondary)
                        Button("刷新手机状态") { store.refresh() }.font(.caption)
                    }.padding(.horizontal, 4)
                }
            }
            .navigationTitle("Oops")
            .sheet(isPresented: $preparing) {
                NavigationStack {
                    Form {
                        Text("手表录音，经 iPhone 发送到你已连接的 Oops 服务转写；本次原音和全文按所选期限云保存。")
                        Text("此版单场最多接收 30 分钟音频。").font(.caption2).foregroundStyle(.secondary)
                        Picker("原音保存", selection: $audioDays) { ForEach([7,30,90], id: \.self) { Text("\($0) 天").tag($0) } }
                        Picker("全文保存", selection: $textDays) { ForEach([7,30,90], id: \.self) { Text("\($0) 天").tag($0) } }
                        Toggle("确认本次录音及云保存", isOn: $consent)
                        Button("确认并开始") { preparing = false; Task { await store.start(audioDays: audioDays, textDays: textDays, confirmed: consent) } }.disabled(!consent || !store.canStart).tint(purple)
                    }.navigationTitle("正式会议")
                }
            }
            .confirmationDialog("结束本次会议并保存？", isPresented: $ending, titleVisibility: .visible) {
                Button("结束并保存", role: .destructive) { store.stop() }
                Button("继续会议", role: .cancel) { }
            }
            .onChange(of: scenePhase) { _, phase in
                #if DEBUG
                store.foregroundForUSBCheck = phase == .active
                #endif
                if phase == .active { store.refresh() }
            }
            .onChange(of: transport.peerReady) { _, _ in store.checkPhoneAuthorization() }
            .onChange(of: transport.progress) { _, _ in store.checkPhoneAuthorization() }
            .task {
                store.refresh()
                #if DEBUG
                store.foregroundForUSBCheck = scenePhase == .active
                if !handledUSBRecording, ProcessInfo.processInfo.arguments.contains("--oops-record-prepared-once") {
                    handledUSBRecording = true
                    await recordUSBPreparationOnce()
                }
                #endif
            }
        }
    }
    #if DEBUG
    /// A foreground, expiring, one-shot developer command, issued only after this
    /// exact microphone/cloud-save check is authorized. Never runs on reconnect.
    private func recordUSBPreparationOnce() async {
        let file = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("oops-recording-check.json")
        guard let data = try? Data(contentsOf: file),
              let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let id = value["id"] as? String, let sessionID = UUID(uuidString: id),
              let grantID = value["grant_id"] as? String,
              value["audio_days"] as? Int == 7, value["text_days"] as? Int == 7,
              let durationSeconds = value["duration_seconds"] as? Int, [20, 40].contains(durationSeconds),
              value["confirmed"] as? Bool == true,
              let expiresAt = value["expires_at"] as? Double,
              expiresAt > Date().timeIntervalSince1970,
              expiresAt <= Date().addingTimeInterval(600).timeIntervalSince1970 else { return }
        let readyDeadline = min(expiresAt, Date().addingTimeInterval(15).timeIntervalSince1970)
        usbRecordingStatus("waiting_for_readiness")
        while (!store.canStart || !store.foregroundForUSBCheck), Date().timeIntervalSince1970 < readyDeadline {
            do { try await Task.sleep(for: .milliseconds(250)) }
            catch { return }
        }
        guard store.canStart, store.foregroundForUSBCheck, grantID == transport.peerReady?.grantID,
              expiresAt > Date().timeIntervalSince1970 else { usbRecordingStatus("readiness_not_met"); return }
        let key = "oops.usb.recording.once." + id
        guard !UserDefaults.standard.bool(forKey: key) else { return }
        UserDefaults.standard.set(true, forKey: key)
        try? FileManager.default.removeItem(at: file)
        usbRecordingStatus("permission_or_starting")
        await store.start(audioDays: 7, textDays: 7, confirmed: true, sessionID: sessionID)
        usbRecordingStatus("start_returned")
        defer { if store.isActive, store.meeting?.id == sessionID.uuidString { store.stop() } }
        let deadline = Date().addingTimeInterval(Double(durationSeconds + 10))
        while store.isActive, store.meeting?.id == sessionID.uuidString, store.elapsedMs < Int64(durationSeconds * 1_000), Date() < deadline {
            do { try await Task.sleep(for: .milliseconds(200)) }
            catch { return }
        }
        if store.isActive, store.meeting?.id == sessionID.uuidString { store.stop() }
        usbRecordingStatus("finished")
    }
    private func usbRecordingStatus(_ stage: String) {
        let value: [String: Any] = ["stage": stage, "activated": transport.activated,
            "canStart": store.canStart, "foreground": store.foregroundForUSBCheck,
            "phase": store.meeting?.phase ?? "none", "updated_at": BusinessCodec.iso(Date())]
        if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) {
            try? BusinessFiles.write(data, to: BusinessFiles.root.appendingPathComponent("usb-recording-check-status.json"))
        }
    }
    #endif
    private func phase(_ value: String) -> String {
        ["preparing":"准备录音", "requestingPermission":"等待麦克风授权", "starting":"正在启动麦克风", "recording":"手表正在录音", "pausing":"正在暂停", "paused":"已暂停", "stopping":"正在结束", "stopped":"录音已结束", "interrupted":"录音曾中断", "failed":"录音未完成"][value] ?? "等待录音状态"
    }
}
