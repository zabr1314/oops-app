import SwiftUI

struct ConnectionCheckView: View {
    @StateObject private var connection = ConnectionCheckSession()
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Label("Oops 连接检查", systemImage: "applewatch.radiowaves.left.and.right")
                    .font(.headline)
                    .foregroundStyle(.purple)
                Text("开发验证 · 固定文本")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(connection.activation)
                Text(connection.counterpart).font(.caption)
                Label(connection.reachable ? "对端当前可达" : "对端当前不可达",
                      systemImage: connection.reachable ? "checkmark.circle" : "circle.dashed")
                    .font(.caption)
                Button(connection.pending ? "等待回复…" : "发送一次连接检查") {
                    connection.sendCheck()
                }
                .buttonStyle(.borderedProminent)
                .tint(.purple)
                .disabled(!connection.canSend)
                Button("刷新连接状态") { connection.refresh() }
                    .buttonStyle(.bordered)
                Text(connection.result).font(.caption)
                Text("请求 ID\n\(connection.lastRequestID)")
                    .font(.system(.caption2, design: .monospaced))
                Divider()
                Text(connection.received).font(.caption2)
                Text("请在已配对的 iPhone 与手表上打开此检查 App。")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Text("仅检查设备连接。未接入 Oops 业务服务，不录音、不读取会议、不发送用户资料。")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .padding()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { connection.refresh() }
        }
    }
}
