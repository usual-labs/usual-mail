import Foundation
import Testing

@testable import UsualMailKit

/// A sender's picture as threads and messages carry it (core's `Avatar`, docs/contract-avatars.md): decoded, encoded
/// back as the server wrote it, its id taken only from the server's own route, and the route that serves it.
struct SenderPictureTests {
    private func threadJSON(avatar: String?) -> String {
        let field = avatar.map { #","avatar":\#($0)"# } ?? ""
        return #"""
            {"id":"thr_x","inboxId":"inb_northwind","subject":"Issue 112","snippet":"Shipping small",
             "participants":[{"name":"The Weekly Build","email":"issue@weeklybuild.example"}],
             "lastMessageAt":"2026-11-18T09:00:00Z","messageCount":1,"unread":true,"hasAttachments":false,
             "category":"newsletter","sender":"issue@weeklybuild.example","screened":false,"done":false,
             "trashed":false,"version":3\#(field)}
            """#
    }

    private func messageJSON(avatar: String?) -> String {
        let field = avatar.map { #","avatar":\#($0)"# } ?? ""
        return #"""
            {"id":"msg_1","threadId":"thr_x","inboxId":"inb_northwind","from":{"email":"issue@weeklybuild.example"},
             "to":[],"cc":[],"bcc":[],"date":"2026-11-18T09:00:00Z","subject":"Issue 112","text":"Hi",
             "attachments":[],"unread":true,"outgoing":false\#(field)}
            """#
    }

    private static let id = "5b0e7c1f3a9d4e2b8c6f1a0d9e7b3c21"

    private func pictureJSON(_ path: String, fit: String = "fill") -> String {
        #"{"picture":"\#(path)","fit":"\#(fit)","size":180}"#
    }

    private func decodedThread(_ text: String) throws -> MailThread {
        try MailJSON.decoder().decode(MailThread.self, from: Data(text.utf8))
    }

    private func decodedMessage(_ text: String) throws -> Message {
        try MailJSON.decoder().decode(Message.self, from: Data(text.utf8))
    }

    @Test func absentMeansInitialsAndIsNotWritten() throws {
        let thread = try decodedThread(threadJSON(avatar: nil))
        #expect(thread.avatar == nil)
        #expect(try encodedJSON(thread)["avatar"] == nil)
        let message = try decodedMessage(messageJSON(avatar: nil))
        #expect(message.avatar == nil)
        #expect(try encodedJSON(message)["avatar"] == nil)
        // `null` reads as absent too.
        #expect(try decodedThread(threadJSON(avatar: "null")).avatar == nil)
    }

    @Test func bothFitsComeThroughAndGoBackAsWritten() throws {
        let filled = try decodedThread(threadJSON(avatar: pictureJSON("/v1/avatars/\(Self.id)")))
        #expect(filled.avatar == SenderPicture(picture: "/v1/avatars/\(Self.id)", fit: .fill, size: 180))
        #expect(filled.avatar?.id == Self.id)
        #expect(filled.avatar?.fit.fillsTheCircle == true)
        #expect(try encodedJSON(filled)["avatar"] == json(pictureJSON("/v1/avatars/\(Self.id)")))

        let inset = try decodedMessage(messageJSON(avatar: pictureJSON("/v1/avatars/\(Self.id)", fit: "inset")))
        #expect(inset.avatar?.fit == .inset)
        #expect(inset.avatar?.fit.fillsTheCircle == false)
        #expect(try encodedJSON(inset)["avatar"] == json(pictureJSON("/v1/avatars/\(Self.id)", fit: "inset")))
    }

    @Test func anUnknownFitActsAsInsetAndIsKept() throws {
        let thread = try decodedThread(threadJSON(avatar: pictureJSON("/v1/avatars/\(Self.id)", fit: "squircle")))
        #expect(thread.avatar?.fit == .unknown("squircle"))
        #expect(thread.avatar?.fit.isKnown == false)
        #expect(thread.avatar?.fit.fillsTheCircle == false)
        #expect(thread.avatar?.id == Self.id)
        #expect(try encodedJSON(thread)["avatar"]?["fit"] == "squircle")
        #expect(SenderPictureFit.known == [.fill, .inset])
    }

    static let notTheRoute = [
        "https://brand.example/v1/avatars/5b0e7c1f3a9d4e2b8c6f1a0d9e7b3c21",
        "//brand.example/v1/avatars/5b0e7c1f3a9d4e2b8c6f1a0d9e7b3c21",
        "v1/avatars/5b0e7c1f3a9d4e2b8c6f1a0d9e7b3c21",
        "/v1/avatars/5B0E7C1F3A9D4E2B8C6F1A0D9E7B3C21",
        "/v1/avatars/5b0e7c1f3a9d4e2b8c6f1a0d9e7b3c2",
        "/v1/avatars/5b0e7c1f3a9d4e2b8c6f1a0d9e7b3c210",
        "/v1/avatars/5b0e7c1f3a9d4e2b8c6f1a0d9e7b3c21?size=64",
        "/v1/avatars/5b0e7c1f3a9d4e2b8c6f1a0d9e7b3c21/",
        "/v1/avatars/../messages/5b0e7c1f3a9d4e2b8c6f1a0d9e7b3",
        "/v1/avatars/5b0e7c1f3a9d4e2b8c6f1a0d9e7b3c2g",
        "/v1/messages/msg_1/pictures/5b0e7c1f3a9d4e2b8c6f1a0d9e7b3c21",
        "/v1/avatars/",
        "",
    ]

    @Test(arguments: notTheRoute)
    func aPathThatIsNotTheRouteHasNoID(_ path: String) throws {
        let thread = try decodedThread(threadJSON(avatar: pictureJSON(path)))
        // Kept as written, so the copy matches the server's, but never loaded: initials show.
        #expect(thread.avatar?.picture == path)
        #expect(thread.avatar?.id == nil)
        #expect(try encodedJSON(thread)["avatar"] == json(pictureJSON(path)))
    }

    @Test func theSamplesPictures() throws {
        let sample = SampleData.bundled
        func avatar(_ id: String) -> SenderPicture? { sample.threads.first { $0.id == id }?.avatar }
        #expect(avatar("thr_4")?.fit == .fill && avatar("thr_4")?.id == Self.id)
        #expect(avatar("thr_8")?.fit == .inset && avatar("thr_8")?.size == 64)
        #expect(avatar("thr_11")?.fit == .fill)
        #expect(sample.threads.filter { $0.avatar != nil }.map(\.id).sorted() == ["thr_11", "thr_4", "thr_8"])
        // Each one's incoming message carries the same picture; screened threads and the inbox's own mail none.
        for threadId in ["thr_4", "thr_8", "thr_11"] {
            let incoming = sample.messages.filter { $0.threadId == threadId && !$0.outgoing }
            #expect(incoming.map(\.avatar) == incoming.map { _ in avatar(threadId) })
        }
        #expect(sample.threads.allSatisfy { !$0.screened || $0.avatar == nil })
        #expect(sample.messages.allSatisfy { !$0.outgoing || $0.avatar == nil })
    }

    @Test func aPictureComesFromItsRouteWithThePersonsToken() async throws {
        let bytes = Data([0x89, 0x50, 0x4E, 0x47])
        let transport = StubTransport { _ in
            StubReply(status: 200, body: bytes, headers: ["Content-Type": "image/png"])
        }
        let client = APIClient(server: testServer, token: "tok_1", transport: transport)
        let picture = try await client.avatar(id: Self.id)
        #expect(picture == AttachmentData(data: bytes, mimeType: "image/png"))
        let request = try #require(transport.lastRequest)
        #expect(request.httpMethod == "GET")
        #expect(request.pathAndQuery == "/v1/avatars/\(Self.id)")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer tok_1")
    }

    @Test func aGonePictureIsNotFoundAndOfflineIsNot() async throws {
        let gone = APIClient(
            server: testServer, token: "tok_1", transport: StubTransport { _ in .error("not_found", "No", status: 404) }
        )
        await #expect(throws: APIError.server(code: .notFound, message: "No", status: 404)) {
            try await gone.avatar(id: Self.id)
        }
        let offline = APIClient(
            server: testServer, token: "tok_1",
            transport: StubTransport { _ in throw URLError(.notConnectedToInternet) })
        do {
            _ = try await offline.avatar(id: Self.id)
            Issue.record("An offline device got a picture")
        } catch let error as APIError {
            #expect(error.isOffline)
            #expect(!SenderPictures.isGone(error))
        }
        #expect(SenderPictures.isGone(APIError.server(code: .notFound, message: "No", status: 404)))
    }
}
