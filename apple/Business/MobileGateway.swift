#if os(iOS)
import Foundation
import Security

struct MobileConfiguration: Codable, Equatable {
    var endpoint: String
    var grantID: String
    var expiresAt: Date
    var isValid: Bool { expiresAt > Date() }
}

/// Compatibility is restricted to the existing gateway's read-only capability probe.
private enum MobileTLSCompatibilityPolicy {
    static func eligible(_ binding: MobileConfiguration) -> Bool {
        guard binding.isValid, !binding.grantID.isEmpty,
              let parts = URLComponents(string: binding.endpoint), parts.url != nil else { return false }
        return parts.scheme == "https" && parts.percentEncodedHost?.lowercased() == "giftedprofessor.xyz"
            && (parts.port == nil || parts.port == 443)
            && parts.percentEncodedPath == "/oops-meeting/apple-mobile"
            && parts.user == nil && parts.password == nil && parts.query == nil && parts.fragment == nil
    }

    static func permitsFallback(_ binding: MobileConfiguration, method: String, path: String, error: Error) -> Bool {
        guard method == "GET", path == "/capabilities", eligible(binding) else { return false }
        var current = error as NSError
        guard current.domain == NSURLErrorDomain, current.code == NSURLErrorSecureConnectionFailed else { return false }
        for depth in 0...2 {
            // CFStream domain 3 is SSL; -9816 is errSSLClosedNoNotify.
            if number(current.userInfo["_kCFStreamErrorDomainKey"], equals: 3)
                && number(current.userInfo["_kCFStreamErrorCodeKey"], equals: -9816) { return true }
            if depth > 0, current.domain == NSOSStatusErrorDomain, current.code == -9816 { return true }
            guard let next = current.userInfo[NSUnderlyingErrorKey] as? NSError, next !== current else { break }
            current = next
        }
        return false
    }

    static func canReuse(_ selected: MobileConfiguration?, for current: MobileConfiguration) -> Bool {
        selected == current && eligible(current)
    }

    static func confirmsCapability(_ body: [String: Any]) -> Bool {
        guard let asr = body["asr"] as? [String: Any] else { return false }
        return asr["engine"] as? String == "volc-bigmodel-async" && asr["available"] as? Bool == true
            && (asr["version"] as? Int ?? 0) >= 1 && (asr["max_chunk_ms"] as? Int ?? 0) >= 30_000
    }

    private static func number(_ value: Any?, equals expected: Int) -> Bool {
        guard let number = value as? NSNumber, number.doubleValue.isFinite else { return false }
        return number.doubleValue == Double(expected)
    }
}

final class MobileGateway {
    static let configurationKey = "oops.mobile.configuration.v1"
    private let session: URLSession
    private let explicitTLS12Diagnostic: Bool
    private let compatibilityLock = NSLock()
    private var compatibilityEpoch = 0
    private var compatibleSession: (binding: MobileConfiguration, session: URLSession)?
    #if DEBUG
    var tlsDiagnosticProfile: String {
        if explicitTLS12Diagnostic { return "tls12_only_diagnostic" }
        if let configuration, selectedSession(for: configuration) != nil { return "tls12_gateway_compat" }
        return "system_default"
    }
    #endif
    private var storedConfiguration: MobileConfiguration?
    var configuration: MobileConfiguration? {
        compatibilityLock.lock(); defer { compatibilityLock.unlock() }
        return storedConfiguration
    }
    var isConfigured: Bool {
        guard let configuration, configuration.isValid else { return false }
        return token(account: configuration.endpoint) != nil
    }
    init() {
        #if DEBUG
        explicitTLS12Diagnostic = ProcessInfo.processInfo.arguments.contains("--oops-tls12-diagnostic")
        #else
        explicitTLS12Diagnostic = false
        #endif
        session = Self.makeSession(tls12Only: explicitTLS12Diagnostic)
        if let data = UserDefaults.standard.data(forKey: Self.configurationKey) { storedConfiguration = try? BusinessCodec.decode(MobileConfiguration.self, data) }
    }
    private static func makeSession(tls12Only: Bool) -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 25; config.timeoutIntervalForResource = 90
        if tls12Only {
            config.tlsMinimumSupportedProtocolVersion = .TLSv12
            config.tlsMaximumSupportedProtocolVersion = .TLSv12
        }
        return URLSession(configuration: config, delegate: NoMobileRedirect(), delegateQueue: nil)
    }
    func pair(endpoint: String, code: String) async throws {
        clearCompatibilitySelection()
        guard let url = URL(string: endpoint), url.scheme == "https", url.host != nil, url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else { throw BusinessError.message("请输入手机专用服务的 HTTPS 地址") }
        let base = endpoint.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let result = try await call(base: base, path: "/pair", method: "POST", json: ["code": code], token: nil)
        guard let token = result["mobile_token"] as? String, let grant = result["grant_id"] as? String,
              let expires = result["expires_at"] as? String, let date = Self.date(expires) else { throw BusinessError.message("配对响应缺少有效的手机授权") }
        try saveToken(token, account: base)
        let binding = MobileConfiguration(endpoint: base, grantID: grant, expiresAt: date)
        replaceConfiguration(binding)
        UserDefaults.standard.set(try BusinessCodec.encode(binding), forKey: Self.configurationKey)
    }
    func disconnect() {
        clearCompatibilitySelection()
        if let endpoint = configuration?.endpoint { SecItemDelete(keychainQuery(endpoint) as CFDictionary) }
        replaceConfiguration(nil); UserDefaults.standard.removeObject(forKey: Self.configurationKey)
    }
    /// Only this read-only probe may make one independent compatibility request.
    /// Common calls and pairing never retry a POST/PUT or an unknown paid operation.
    func capabilities() async throws -> [String: Any] {
        guard let binding = configuration, binding.isValid, let token = token(account: binding.endpoint) else {
            throw BusinessError.message("请先在手机连接业务服务")
        }
        if let selected = selectedSession(for: binding) {
            return try await call(base: binding.endpoint, path: "/capabilities", method: "GET", json: nil, token: token, using: selected)
        }
        let epoch = currentCompatibilityEpoch()
        do {
            return try await call(base: binding.endpoint, path: "/capabilities", method: "GET", json: nil, token: token)
        } catch {
            guard !explicitTLS12Diagnostic, !Task.isCancelled, configuration == binding,
                  MobileTLSCompatibilityPolicy.permitsFallback(binding, method: "GET", path: "/capabilities", error: error) else { throw error }
            let candidate = Self.makeSession(tls12Only: true)
            do {
                let body = try await call(base: binding.endpoint, path: "/capabilities", method: "GET", json: nil, token: token, using: candidate)
                try Task.checkCancellation()
                guard configuration == binding, binding.isValid else { throw CancellationError() }
                if MobileTLSCompatibilityPolicy.confirmsCapability(body) {
                    guard select(candidate, for: binding, epoch: epoch) else { throw CancellationError() }
                } else { candidate.finishTasksAndInvalidate() }
                return body
            } catch {
                candidate.invalidateAndCancel()
                throw error // No loop, recursive probe or business-request replay.
            }
        }
    }
    func json(_ path: String, method: String = "GET", body: [String: Any]? = nil, requestID: String? = nil) async throws -> [String: Any] {
        guard let configuration, configuration.isValid, let token = token(account: configuration.endpoint) else { throw BusinessError.message("请先在手机连接业务服务") }
        return try await call(base: configuration.endpoint, path: path, method: method, json: body, token: token, requestID: requestID,
                              using: selectedSession(for: configuration))
    }
    func upload(_ path: String, data: Data, requestID: String) async throws -> [String: Any] {
        guard data.count <= 1_100_000, let configuration, configuration.isValid, let token = token(account: configuration.endpoint) else { throw BusinessError.message("上传配置或片段大小无效") }
        return try await call(base: configuration.endpoint, path: path, method: "PUT", json: nil, token: token, requestID: requestID, bytes: data,
                              using: selectedSession(for: configuration))
    }
    /// A paid ASR operation is registered once; its 202 response is not a final transcript.
    func submitASR(sessionID: String, sequence: Int, startMs: Int64, endMs: Int64, pcm: Data, requestID: String) async throws -> [String: Any] {
        guard UUID(uuidString: sessionID) != nil, sequence >= 0, startMs >= 0,
              endMs > startMs, endMs - startMs <= 32_000,
              !pcm.isEmpty, pcm.count % 2 == 0, pcm.count <= 1_100_000 else {
            throw BusinessError.message("后端转写的音频片段或时间范围无效")
        }
        return try await upload("/sessions/\(sessionID)/asr/chunks/\(sequence)?start_ms=\(startMs)&end_ms=\(endMs)", data: pcm, requestID: requestID)
    }
    func asrJob(sessionID: String, sequence: Int) async throws -> [String: Any] {
        guard UUID(uuidString: sessionID) != nil, sequence >= 0 else { throw BusinessError.message("后端转写任务编号无效") }
        return try await json("/sessions/\(sessionID)/asr/chunks/\(sequence)")
    }
    private func call(base: String, path: String, method: String, json: [String: Any]?, token: String?, requestID: String? = nil, bytes: Data? = nil,
                      using transport: URLSession? = nil) async throws -> [String: Any] {
        guard let url = URL(string: base + path), url.scheme == "https" else { throw BusinessError.message("服务地址无效") }
        var request = URLRequest(url: url); request.httpMethod = method
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        if let token { request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization") }
        if let requestID { request.setValue(requestID, forHTTPHeaderField: "X-Request-ID") }
        if let bytes {
            request.httpBody = bytes; request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
            request.setValue(BusinessCodec.hash(bytes), forHTTPHeaderField: "X-Content-SHA256")
        } else if let json {
            request.httpBody = try JSONSerialization.data(withJSONObject: json, options: [.sortedKeys]); request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await (transport ?? session).data(for: request)
        guard let http = response as? HTTPURLResponse, data.count <= 8_000_000 else { throw BusinessError.message("服务响应无效") }
        let result = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        guard (200..<300).contains(http.statusCode) else {
            let error = result["error"] as? [String: Any]
            throw GatewayHTTPError(status: http.statusCode, code: error?["code"] as? String ?? "HTTP_ERROR", message: (error?["message"] as? String) ?? "服务请求失败（\(http.statusCode)），写入结果需核对", asset: error?["asset"] as? String)
        }
        return result
    }
    private func currentCompatibilityEpoch() -> Int {
        compatibilityLock.lock(); defer { compatibilityLock.unlock() }
        return compatibilityEpoch
    }
    private func selectedSession(for binding: MobileConfiguration) -> URLSession? {
        compatibilityLock.lock(); defer { compatibilityLock.unlock() }
        guard storedConfiguration == binding, let selected = compatibleSession,
              MobileTLSCompatibilityPolicy.canReuse(selected.binding, for: binding) else { return nil }
        return selected.session
    }
    private func select(_ candidate: URLSession, for binding: MobileConfiguration, epoch: Int) -> Bool {
        compatibilityLock.lock(); defer { compatibilityLock.unlock() }
        guard compatibilityEpoch == epoch, storedConfiguration == binding,
              MobileTLSCompatibilityPolicy.eligible(binding) else { return false }
        compatibleSession = (binding, candidate)
        return true
    }
    private func clearCompatibilitySelection() {
        compatibilityLock.lock()
        compatibilityEpoch += 1
        let old = compatibleSession?.session
        compatibleSession = nil
        compatibilityLock.unlock()
        old?.finishTasksAndInvalidate()
    }
    private func replaceConfiguration(_ binding: MobileConfiguration?) {
        compatibilityLock.lock()
        compatibilityEpoch += 1
        storedConfiguration = binding
        let old = compatibleSession?.session
        compatibleSession = nil
        compatibilityLock.unlock()
        old?.finishTasksAndInvalidate()
    }
    static func date(_ text: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        if let date = formatter.date(from: text) { return date }
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: text)
    }
    private func keychainQuery(_ account: String) -> [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "com.oops.apple.mobile", kSecAttrAccount as String: account] }
    private func saveToken(_ value: String, account: String) throws {
        var query = keychainQuery(account); SecItemDelete(query as CFDictionary)
        query[kSecValueData as String] = Data(value.utf8); query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(query as CFDictionary, nil) == errSecSuccess else { throw BusinessError.message("无法安全保存手机授权") }
    }
    private func token(account: String) -> String? {
        var query = keychainQuery(account); query[kSecReturnData as String] = true; query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
}
struct GatewayHTTPError: LocalizedError {
    let status: Int
    let code: String
    let message: String
    var asset: String? = nil
    var errorDescription: String? { message }
}
private final class NoMobileRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
#endif
