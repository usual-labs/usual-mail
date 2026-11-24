import Foundation
import Testing
import UsualMailKit

@testable import UsualMailUI

/// Who a row names beside a sender picture (`HomeWords.shownSender`, docs/contract-avatars.md): with a picture, the
/// thread's own sender address gives both the picture and the name, so a logo never sits beside someone else's name;
/// without one, today's rule. Message lines show each message's own picture, never on the person's own mail.
struct ShownSenderTests {
    let sample = SampleData.bundled
    let picture = SenderPicture(
        picture: "/v1/avatars/8e3f6a1d0c9b2e7f4a5d8c1b3e6f9a02", fit: .fill, size: 192)
    /// The sample's personal inbox, me@home.example.
    let inbox = SampleData.bundled.inboxes.first { $0.id == "inb_personal" }

    /// A notice from a shop, written to the person by a friend who forwarded it first: the friend is the first
    /// participant, the shop the thread's sender.
    private func thread(avatar: SenderPicture?, participants: [Address]? = nil, screened: Bool = false) -> MailThread {
        MailThread(
            id: "thr_x", inboxId: "inb_personal", subject: "Your order has shipped", snippet: "On its way",
            participants: participants ?? [
                Address(name: "Maya Kim", email: "maya@studio.example"),
                Address(name: "Fernhill Books", email: "Orders@Fernhill.example"),
                Address(name: "Me", email: "me@home.example"),
            ], lastMessageAt: .now, category: .notification, sender: "orders@fernhill.example", screened: screened,
            summary: "Two books are on their way.", avatar: avatar)
    }

    @Test func withAPictureTheNameComesFromTheThreadsSender() {
        let shown = HomeWords.shownSender(of: thread(avatar: picture), inbox: inbox)
        #expect(shown.name == "Fernhill Books")
        #expect(shown.address?.email == "Orders@Fernhill.example")
        #expect(shown.key == "orders@fernhill.example")
        #expect(shown.avatar == picture)
        // The row's line and the Feed's header say the same name.
        let line = HomeWords.line(for: thread(avatar: picture), inbox: inbox)
        #expect(line == "Fernhill Books - Two books are on their way.")
        #expect(FeedWords.sender(of: thread(avatar: picture), inbox: inbox) == "Fernhill Books")
    }

    @Test func withAPictureAndNoSuchParticipantTheAddressIsShown() {
        let lone = thread(avatar: picture, participants: [Address(name: "Maya Kim", email: "maya@studio.example")])
        let shown = HomeWords.shownSender(of: lone, inbox: inbox)
        #expect(shown.name == "orders@fernhill.example")
        #expect(shown.key == "orders@fernhill.example")
        #expect(shown.avatar == picture)
        // Its initials, should the picture not come, are read from the local part.
        #expect(Avatar.initials(shown.name ?? "") == "O")
    }

    @Test func withoutAPictureTheFirstParticipantWhoIsNotTheInbox() {
        let plain = thread(avatar: nil)
        let shown = HomeWords.shownSender(of: plain, inbox: inbox)
        #expect(shown.name == "Maya Kim")
        #expect(shown.key == "maya@studio.example")
        #expect(shown.avatar == nil)
        #expect(shown.address == HomeWords.sender(of: plain, inbox: inbox))
        #expect(HomeWords.line(for: plain, inbox: inbox) == "Maya Kim - Two books are on their way.")
        // A thread that names nobody.
        let nobody = MailThread(id: "thr_y", inboxId: "inb_1", subject: "Hi", lastMessageAt: .now)
        #expect(HomeWords.shownSender(of: nobody, inbox: inbox) == ShownSender(address: nil, key: "hi"))
    }

    @Test func aScreenedThreadShowsNoPicture() {
        // The server never sends one for a screened thread; if one came, it is ignored, with today's rule.
        let screened = HomeWords.shownSender(of: thread(avatar: picture, screened: true), inbox: inbox)
        #expect(screened.avatar == nil)
        #expect(screened.name == "Maya Kim")
    }

    @Test func aPictureWithoutASenderAddressIsIgnored() {
        var odd = thread(avatar: picture)
        odd.sender = nil
        #expect(HomeWords.shownSender(of: odd, inbox: inbox).avatar == nil)
        #expect(HomeWords.shownSender(of: odd, inbox: inbox).name == "Maya Kim")
    }

    @Test func theSamplesPicturesSitBesideTheirOwnSenders() throws {
        for id in ["thr_4", "thr_8", "thr_11"] {
            let thread = try #require(sample.threads.first { $0.id == id })
            let inbox = sample.inboxes.first { $0.id == thread.inboxId }
            let shown = HomeWords.shownSender(of: thread, inbox: inbox)
            #expect(shown.avatar == thread.avatar && shown.avatar != nil)
            #expect(shown.address?.email.lowercased() == thread.sender)
        }
    }

    @Test func messageLinesShowTheirOwnPictureAndYouShowsInitials() throws {
        let incoming = Message(
            id: "msg_1", threadId: "thr_x", inboxId: "inb_1",
            from: Address(name: "Fernhill Books", email: "orders@fernhill.example"), date: .now, subject: "Shipped",
            avatar: picture)
        #expect(MailPage.picture(of: incoming) == picture)
        var own = incoming
        own.from = Address(name: "Me", email: "me@home.example")
        own.outgoing = true
        #expect(MailPage.picture(of: own) == nil)
        // The sample's messages: the newsletter's own picture on its message.
        let detail = try #require(sample.detail(threadId: "thr_8"))
        let latest = try #require(MailPage.latestIncoming(detail))
        #expect(MailPage.picture(of: latest) == detail.thread.avatar)
    }
}
