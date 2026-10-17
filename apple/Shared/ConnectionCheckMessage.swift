import Foundation

/// A closed, development-only protocol. No user text, commands or business data.
struct ConnectionCheckMessage: Equatable {
    enum Kind: String { case ping, pong }
    static let pingText = "Oops development connection check"
    static let pongText = "Oops development connection check acknowledged"
    let kind: Kind
    let requestID: UUID

    var dictionary: [String: Any] {
        ["protocol": "oops.connection-check", "version": 1,
         "kind": kind.rawValue, "requestID": requestID.uuidString,
         "text": kind == .ping ? Self.pingText : Self.pongText]
    }

    init(kind: Kind, requestID: UUID) {
        self.kind = kind
        self.requestID = requestID
    }

    init?(dictionary: [String: Any]) {
        guard Set(dictionary.keys) == ["protocol", "version", "kind", "requestID", "text"],
              dictionary["protocol"] as? String == "oops.connection-check",
              dictionary["version"] as? Int == 1,
              let rawKind = dictionary["kind"] as? String,
              let kind = Kind(rawValue: rawKind),
              let rawID = dictionary["requestID"] as? String,
              let requestID = UUID(uuidString: rawID),
              dictionary["text"] as? String == (kind == .ping ? Self.pingText : Self.pongText)
        else { return nil }
        self.init(kind: kind, requestID: requestID)
    }

    var reply: ConnectionCheckMessage? {
        kind == .ping ? .init(kind: .pong, requestID: requestID) : nil
    }
}

/// Exactly one foreground request; finishing/timeout clears it, with no queue.
struct PendingConnectionCheck {
    private(set) var requestID: UUID?

    mutating func begin(id: UUID) -> ConnectionCheckMessage? {
        guard requestID == nil else { return nil }
        requestID = id
        return .init(kind: .ping, requestID: id)
    }

    mutating func accept(_ reply: ConnectionCheckMessage) -> Bool {
        guard reply.kind == .pong, requestID == reply.requestID else { return false }
        requestID = nil
        return true
    }

    @discardableResult
    mutating func finish(id: UUID) -> Bool {
        guard requestID == id else { return false }
        requestID = nil
        return true
    }
}
