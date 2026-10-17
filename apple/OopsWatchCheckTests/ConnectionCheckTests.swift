import XCTest
@testable import OopsWatchCheck

final class ConnectionCheckTests: XCTestCase {
    func testFixedPingProducesReplyWithExactRequestID() throws {
        let id = UUID()
        let decoded = try XCTUnwrap(ConnectionCheckMessage(dictionary: ConnectionCheckMessage(kind: .ping, requestID: id).dictionary))
        XCTAssertEqual(decoded.reply, ConnectionCheckMessage(kind: .pong, requestID: id))
        XCTAssertNil(decoded.reply?.reply)
    }

    func testUnrecognizedTextOrAdditionalCommandIsRejected() {
        var data = ConnectionCheckMessage(kind: .ping, requestID: UUID()).dictionary
        data["text"] = "start recording"
        XCTAssertNil(ConnectionCheckMessage(dictionary: data))
        data["text"] = ConnectionCheckMessage.pingText
        data["command"] = "start"
        XCTAssertNil(ConnectionCheckMessage(dictionary: data))
        data.removeValue(forKey: "command")
        data["version"] = 2
        XCTAssertNil(ConnectionCheckMessage(dictionary: data))
    }

    func testUnrelatedReplyCannotCompletePendingRequest() {
        var pending = PendingConnectionCheck()
        let id = UUID()
        XCTAssertNotNil(pending.begin(id: id))
        XCTAssertNil(pending.begin(id: UUID()))
        XCTAssertFalse(pending.accept(.init(kind: .pong, requestID: UUID())))
        XCTAssertFalse(pending.accept(.init(kind: .ping, requestID: id)))
        XCTAssertEqual(pending.requestID, id)
        XCTAssertTrue(pending.accept(.init(kind: .pong, requestID: id)))
        XCTAssertNil(pending.requestID)
    }

    func testFinishedRequestRejectsLateReplyAndDoesNotReappear() {
        var pending = PendingConnectionCheck()
        let id = UUID()
        _ = pending.begin(id: id)
        XCTAssertFalse(pending.finish(id: UUID()))
        XCTAssertTrue(pending.finish(id: id))
        XCTAssertFalse(pending.accept(.init(kind: .pong, requestID: id)))
        let nextID = UUID()
        XCTAssertNotNil(pending.begin(id: nextID))
        XCTAssertFalse(pending.accept(.init(kind: .pong, requestID: id)))
        XCTAssertEqual(pending.requestID, nextID)
    }
}
