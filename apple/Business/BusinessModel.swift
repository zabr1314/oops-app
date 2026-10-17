import Foundation
import CryptoKit

enum BusinessCodec {
    static func encode<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .millisecondsSince1970
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(value)
    }
    static func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .millisecondsSince1970
        return try decoder.decode(type, from: data)
    }
    static func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    static func operationID(_ session: String, _ operation: String) -> String {
        let h = hash(Data((session + ":" + operation).utf8))
        return "\(h.prefix(8))-\(h.dropFirst(8).prefix(4))-\(h.dropFirst(12).prefix(4))-\(h.dropFirst(16).prefix(4))-\(h.dropFirst(20).prefix(12))"
    }
    static func iso(_ date: Date) -> String { ISO8601DateFormatter().string(from: date) }
}

struct WatchMeeting: Codable, Identifiable, Equatable {
    var id: String
    var title: String
    var startedAt: Date
    var endedAt: Date?
    var phase: String
    var revision: Int
    var audioDays: Int
    var textDays: Int
    var cloudSaveConfirmed: Bool
    var grantID: String
    var expectedChunkCount: Int?
    var elapsedMs: Int64
    var error: String?
    var audioExpiresAt: Date { startedAt.addingTimeInterval(Double(audioDays) * 86400) }
    var textExpiresAt: Date { startedAt.addingTimeInterval(Double(textDays) * 86400) }
    var valid: Bool {
        UUID(uuidString: id) != nil && [7,30,90].contains(audioDays) && [7,30,90].contains(textDays)
            && cloudSaveConfirmed && !grantID.isEmpty && startedAt <= Date().addingTimeInterval(300)
    }
    var active: Bool { endedAt == nil && !["stopped", "failed"].contains(phase) }
}

struct AudioChunkDescriptor: Codable, Equatable {
    var sessionID: String
    var sequence: Int
    var startMs: Int64
    var endMs: Int64
    var size: Int
    var sha256: String
    var valid: Bool { UUID(uuidString: sessionID) != nil && sequence >= 0 && sequence < 20000 && startMs >= 0 && endMs > startMs && endMs - startMs <= 32000 && size > 0 && size <= 5_000_000 && sha256.count == 64 }
}

struct PhoneReadiness: Codable, Equatable {
    var ready: Bool
    var grantID: String
    var validUntil: Date
    var message: String
    var issuedAt: Date = Date()
    var canStart: Bool { ready && !grantID.isEmpty && validUntil > Date() }
}

struct PhoneMeetingProgress: Codable, Equatable {
    var sessionID: String
    var state: String
    var receivedChunks: Int
    var transcribedChunks: Int
    var message: String
    var summary: String?
    var validUntil: Date
    var grantID: String = ""
    var updatedAt: Date = Date()
    var receivedSHA256: [Int: String] = [:]
}

/// Durable receipt only; not transcription, cloud upload, or business completion.
struct PhoneAudioReceipt: Codable {
    var sessionID: String
    var grantID: String
    var receivedSHA256: [Int: String]
    var issuedAt: Date = Date()
}

enum BusinessFiles {
    static var root: URL {
        let url = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("OopsBusiness", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        var excluded = url; var values = URLResourceValues(); values.isExcludedFromBackup = true
        try? excluded.setResourceValues(values)
        return url
    }
    static func session(_ id: String) throws -> URL {
        guard UUID(uuidString: id) != nil else { throw BusinessError.message("会话编号无效") }
        let url = root.appendingPathComponent(id, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
    static func write(_ data: Data, to url: URL) throws {
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}

enum BusinessError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}
