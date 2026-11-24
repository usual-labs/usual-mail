import Foundation
import Testing

@testable import UsualMailKit

struct AddressListTests {
    @Test func readsWhatAPersonTypes() {
        let parsed = Address.parseList(
            #"Dana Whitfield <Dana@Lumen.example>, marek@northwind.example; "Olsen, Marek" <marek@olsen.example>,,"#)
        #expect(
            parsed.addresses == [
                Address(name: "Dana Whitfield", email: "dana@lumen.example"),
                Address(email: "marek@northwind.example"),
                Address(name: "Olsen, Marek", email: "marek@olsen.example"),
            ])
        #expect(parsed.invalid.isEmpty)
        #expect(Address.parseList("   ").addresses.isEmpty)
    }

    @Test func entriesThatArentAddressesComeBackAsTyped() {
        let parsed = Address.parseList("dana, a@b, x@y.example, <nope>, two words@x.example")
        #expect(parsed.addresses == [Address(email: "x@y.example")])
        #expect(parsed.invalid == ["dana", "a@b", "<nope>", "two words@x.example"])
    }

    @Test func formattingRoundTrips() {
        let list = [
            Address(name: "Dana Whitfield", email: "dana@lumen.example"), Address(email: "a@b.example"),
            Address(name: "Olsen, Marek", email: "marek@olsen.example"),
        ]
        let text = Address.format(list)
        #expect(text == #"Dana Whitfield <dana@lumen.example>, a@b.example, "Olsen, Marek" <marek@olsen.example>"#)
        #expect(Address.parseList(text).addresses == list)
    }
}

struct ReplyDraftTests {
    let sample = SampleData.bundled

    @Test func aReplyAnswersTheNewestMessageFromSomeoneElse() throws {
        let detail = try #require(sample.detail(threadId: "thr_7"))  // Lotte answered the inbox's question
        let reply = DraftInput.reply(to: detail)
        #expect(reply.inboxId == "inb_harbor" && reply.threadId == "thr_7")
        #expect(reply.inReplyToMessageId == "msg_7b")
        #expect(reply.to.map(\.email) == ["lotte@brandtphoto.example"])
        #expect(reply.subject == "Re: Photos from the harbour shoot")
        #expect(reply.id == nil && reply.body.isEmpty)
    }

    @Test func whenTheInboxWroteLastWithNoAnswerItFollowsUp() throws {
        var detail = try #require(sample.detail(threadId: "thr_9"))
        detail.messages.removeFirst()  // only the inbox's own message is left
        let reply = DraftInput.reply(to: detail)
        #expect(reply.to.map(\.email) == ["office@quayproperties.example"])
        #expect(reply.inReplyToMessageId == "msg_9b")
        #expect(reply.subject == "Re: Lease renewal")  // not "Re: Re:"
    }

    @Test func replyAllAnswersEveryoneButTheInboxItself() throws {
        var detail = try #require(sample.detail(threadId: "thr_1"))
        let dana = Address(name: "Dana Whitfield", email: "dana@lumen.example")
        let priya = Address(name: "Priya Shah", email: "priya@lumen.example")
        let marek = Address(name: "Marek Olsen", email: "marek@northwind.example")
        let own = Address(name: "Northwind Studio", email: "Hello@Northwind.example")
        detail.messages[1].to = [own, priya]
        detail.messages[1].cc = [marek, priya, Address(email: "hello@northwind.example")]
        let all = DraftInput.replyAll(to: detail, ownAddress: "hello@northwind.example")
        #expect(all.to == [dana, priya])
        #expect(all.cc == [marek])  // Priya is already in To; the inbox never writes to itself
        #expect(all.inboxId == "inb_northwind" && all.threadId == "thr_1" && all.inReplyToMessageId == "msg_1b")
        #expect(all.subject == "Re: Contract renewal for 2027" && all.bcc == nil)

        // With nobody else on it, reply-all is a reply.
        let plain = try #require(sample.detail(threadId: "thr_7"))
        let one = DraftInput.replyAll(to: plain, ownAddress: "founder@harborpine.example")
        #expect(one.to.map(\.email) == ["lotte@brandtphoto.example"] && one.cc == nil)
    }

    @Test func replyAllWhenTheInboxWroteLastGoesToItsRecipients() throws {
        var detail = try #require(sample.detail(threadId: "thr_9"))
        detail.messages.removeFirst()  // only the inbox's own message is left
        detail.messages[0].cc = [Address(email: "lawyer@quayproperties.example")]
        let all = DraftInput.replyAll(to: detail, ownAddress: "founder@harborpine.example")
        #expect(all.to.map(\.email) == ["office@quayproperties.example"])
        #expect(all.cc?.map(\.email) == ["lawyer@quayproperties.example"])
    }

    @Test func editingADraftKeepsItsId() {
        let input = DraftInput(editing: sample.drafts[0])
        #expect(input.id == "drf_1" && input.inReplyToMessageId == "msg_1b" && input.body == sample.drafts[0].body)
    }
}

@MainActor
struct AttachmentFileTests {
    @Test func anAttachmentIsFetchedIntoAFileNamedAfterIt() async throws {
        let server = SampleServer()
        let store = try await makeStore(server)
        let message = try #require(SampleData.bundled.messages.first { $0.id == "msg_6a" })
        let url = try #require(await store.file(for: message.attachments[0], in: message))
        defer { try? FileManager.default.removeItem(at: url) }
        #expect(url.lastPathComponent == "Invoice-2026-118.pdf")
        #expect(url.path.hasPrefix(MailStore.attachmentFolder.path))
        #expect(try String(contentsOf: url, encoding: .utf8) == "bytes of Invoice-2026-118.pdf")
        #expect(server.requests.last?.pathAndQuery == "/v1/messages/msg_6a/attachments/att_6")
    }

    @Test func fileNamesStayInsideTheirFolder() {
        #expect(MailStore.safeName("../../etc/passwd", fallback: "x") == "_.._etc_passwd")
        #expect(MailStore.safeName("...", fallback: "attachment") == "attachment")
        #expect(MailStore.safeName("a:b\\c.pdf", fallback: "x") == "a_b_c.pdf")
    }
}
