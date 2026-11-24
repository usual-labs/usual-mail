import Foundation
import Testing

@testable import UsualMailKit

/// Pictures from the web through the server (docs/contract-pictures.md): what a message says was done with them, and
/// the picture route.
struct RemotePicturesTests {
    private func message(remotePictures: String?) -> String {
        let field = remotePictures.map { #","remotePictures":\#($0)"# } ?? ""
        return #"""
            {"id":"msg_1","threadId":"thr_1","inboxId":"inb_northwind","from":{"email":"news@shop.example"},
             "to":[],"cc":[],"bcc":[],"date":"2026-11-18T09:00:00Z","subject":"Sale","html":"<p>Hi</p>",
             "attachments":[],"unread":true,"outgoing":false\#(field)}
            """#
    }

    private func decoded(_ text: String) throws -> Message {
        try MailJSON.decoder().decode(Message.self, from: Data(text.utf8))
    }

    @Test func aMessageSaysWhatWasDoneWithItsPictures() throws {
        let screened = #"{"shown":0,"trackersRemoved":2,"trackers":["HubSpot","Mailchimp"],"heldBack":"screened"}"#
        let held = try decoded(message(remotePictures: screened))
        #expect(
            held.remotePictures
                == RemotePictures(
                    shown: 0, trackersRemoved: 2, trackers: ["HubSpot", "Mailchimp"], heldBack: .screened))
        #expect(try encodedJSON(held)["remotePictures"] == json(screened))

        let shown = try decoded(message(remotePictures: #"{"shown":3,"trackersRemoved":0,"trackers":[]}"#))
        #expect(shown.remotePictures == RemotePictures(shown: 3))
        #expect(try encodedJSON(shown)["remotePictures"] == json(#"{"shown":3,"trackersRemoved":0,"trackers":[]}"#))

        let blocked = try decoded(
            message(remotePictures: #"{"shown":0,"trackersRemoved":0,"trackers":[],"heldBack":"blocked"}"#))
        #expect(blocked.remotePictures?.heldBack == .blocked)
    }

    @Test func anUnknownReasonForHoldingBackIsKept() throws {
        let mail = try decoded(
            message(remotePictures: #"{"shown":0,"trackersRemoved":0,"trackers":[],"heldBack":"quarantined"}"#))
        #expect(mail.remotePictures?.heldBack == .unknown("quarantined"))
        #expect(mail.remotePictures?.heldBack?.isKnown == false)
        #expect(try encodedJSON(mail)["remotePictures"]?["heldBack"] == "quarantined")
        #expect(PicturesHeldBack.known == [.screened, .blocked])
    }

    @Test func aMessageThatTakesNothingFromTheWebHasNone() throws {
        let mail = try decoded(message(remotePictures: nil))
        #expect(mail.remotePictures == nil)
        // Encoded only when present, so a stored or re-encoded message stays as the server sent it.
        #expect(try encodedJSON(mail)["remotePictures"] == nil)
    }

    @Test func htmlTooLargeToShowIsSaid() throws {
        // As the server sends it: no `html`, its text standing for it.
        let tooLarge = try decoded(
            message(remotePictures: nil).replacingOccurrences(
                of: #""html":"<p>Hi</p>""#, with: #""text":"Hi","htmlTooLarge":true"#))
        #expect(tooLarge.htmlTooLarge && tooLarge.html == nil && tooLarge.text == "Hi")
        #expect(try encodedJSON(tooLarge)["htmlTooLarge"] == true)
        // Absent means false, and false isn't written, so a message encodes back as the server sent it.
        var shown = try decoded(message(remotePictures: nil))
        #expect(!shown.htmlTooLarge)
        #expect(try encodedJSON(shown)["htmlTooLarge"] == nil)
        shown.htmlTooLarge = true
        shown.htmlTooLarge = false
        #expect(try encodedJSON(shown)["htmlTooLarge"] == nil)
        let made = Message(
            id: "m", threadId: "t", inboxId: "i", from: Address(email: "a@b.example"), date: .now, subject: "s",
            htmlTooLarge: true)
        #expect(made.htmlTooLarge)
    }

    @Test func aPictureComesBackAsBytesWithItsType() async throws {
        let bytes = Data([0x52, 0x49, 0x46, 0x46])
        let transport = StubTransport { _ in
            StubReply(status: 200, body: bytes, headers: ["Content-Type": "image/webp"])
        }
        let client = APIClient(server: testServer, token: "tok_1", transport: transport)
        let picture = try await client.picture(messageId: "msg/1", pictureId: "AbCdEfGhIjKlMnOpQrSt_-")
        #expect(picture == AttachmentData(data: bytes, mimeType: "image/webp"))
        let request = try #require(transport.lastRequest)
        #expect(request.httpMethod == "GET")
        #expect(request.pathAndQuery == "/v1/messages/msg%2F1/pictures/AbCdEfGhIjKlMnOpQrSt_-")
        #expect(request.value(forHTTPHeaderField: "Accept") == "*/*")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer tok_1")
    }

    static let refusals: [(String, String, Int, ErrorCode)] = [
        ("not_found", "No such picture", 404, .notFound),
        // 502 is only a site that failed; a picture the server refuses comes blank, as a 200 GIF.
        ("provider_error", "The picture couldn't be loaded: its site answered 404", 502, .providerError),
        ("needs_person", "Only a person's device can load pictures", 403, .needsPerson),
    ]

    @Test(arguments: refusals)
    func aPictureThatCantBeHadIsAnError(_ code: String, _ words: String, _ status: Int, _ expected: ErrorCode)
        async throws
    {
        let transport = StubTransport { _ in .error(code, words, status: status) }
        let client = APIClient(server: testServer, token: "tok_1", transport: transport)
        await #expect(throws: APIError.server(code: expected, message: words, status: status)) {
            try await client.picture(messageId: "msg_1", pictureId: "AbCdEfGhIjKlMnOpQrSt_-")
        }
    }
}
