import Combine
import Foundation
import WatchConnectivity

final class ConnectionCheckSession: NSObject, ObservableObject, WCSessionDelegate {
    @Published private(set) var activation = "尚未激活"
    @Published private(set) var counterpart = "等待设备状态"
    @Published private(set) var reachable = false
    @Published private(set) var pending = false
    @Published private(set) var result = "点击后只发送一次固定连接检查。"
    @Published private(set) var lastRequestID = "尚无请求"
    @Published private(set) var received = "尚未收到检查"
    private var tracker = PendingConnectionCheck()
    private var session: WCSession?

    override init() {
        super.init()
        guard WCSession.isSupported() else {
            activation = "此设备不支持 WatchConnectivity"
            return
        }
        let session = WCSession.default
        self.session = session
        session.delegate = self
        session.activate()
    }

    var canSend: Bool {
        session?.activationState == .activated && reachable && !pending
    }

    func refresh() {
        guard let session else { return }
        switch session.activationState {
        case .activated: activation = "已激活"
        case .inactive: activation = "未激活"
        case .notActivated: activation = "尚未激活"
        @unknown default: activation = "未知激活状态"
        }
        reachable = session.isReachable
        #if os(iOS)
        counterpart = "手表配对：\(session.isPaired ? "是" : "否") · 检查 App：\(session.isWatchAppInstalled ? "已安装" : "未安装")"
        #elseif os(watchOS)
        counterpart = "iPhone 检查 App：\(session.isCompanionAppInstalled ? "已安装" : "未安装")"
        #endif
    }

    func sendCheck() {
        refresh()
        guard canSend, let session else {
            result = "当前不可达，请在两端打开检查 App 后重新点击。未排队或重发。"
            return
        }
        let id = UUID()
        guard let message = tracker.begin(id: id) else { return }
        pending = true
        lastRequestID = id.uuidString
        result = "已发出一次检查，等待同一请求的确切回复…"
        session.sendMessage(message.dictionary, replyHandler: { [weak self] reply in
            DispatchQueue.main.async {
                guard let self, self.tracker.requestID == id else { return }
                guard let parsed = ConnectionCheckMessage(dictionary: reply), self.tracker.accept(parsed) else {
                    self.finish(id: id, text: "回复不匹配本次请求，检查未通过。未重发。")
                    return
                }
                self.pending = false
                self.result = "连接检查通过：\(ConnectionCheckMessage.pongText)"
                self.refresh()
            }
        }, errorHandler: { [weak self] error in
            DispatchQueue.main.async {
                self?.finish(id: id, text: "发送失败：\(error.localizedDescription)。未排队或重发。")
            }
        })
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in
            self?.finish(id: id, text: "15 秒内未收到匹配回复，送达未知。未自动重发。")
        }
    }

    private func finish(id: UUID, text: String) {
        guard tracker.finish(id: id) else { return }
        pending = false
        result = text
        refresh()
    }

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        DispatchQueue.main.async { [weak self] in
            self?.refresh()
            if let error { self?.result = "激活失败：\(error.localizedDescription)" }
        }
    }

    func sessionReachabilityDidChange(_ session: WCSession) {
        DispatchQueue.main.async { [weak self] in self?.refresh() }
    }

    func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
        guard let request = ConnectionCheckMessage(dictionary: message), let reply = request.reply else {
            replyHandler(["error": "invalid-development-check"])
            return
        }
        replyHandler(reply.dictionary)
        DispatchQueue.main.async { [weak self] in
            self?.received = "已收到并回复固定检查\n\(request.requestID.uuidString)"
            self?.refresh()
        }
    }

    #if os(iOS)
    func sessionWatchStateDidChange(_ session: WCSession) {
        DispatchQueue.main.async { [weak self] in self?.refresh() }
    }

    func sessionDidBecomeInactive(_ session: WCSession) {
        DispatchQueue.main.async { [weak self] in self?.refresh() }
    }

    func sessionDidDeactivate(_ session: WCSession) {
        // Refresh the system session after a Watch switch; no message is resent.
        session.activate()
        DispatchQueue.main.async { [weak self] in self?.refresh() }
    }
    #endif
}
