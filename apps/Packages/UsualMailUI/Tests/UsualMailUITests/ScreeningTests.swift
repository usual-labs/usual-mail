import Foundation
import Testing
import UsualMailKit

@testable import UsualMailUI

/// The screening page: one row per sender in an inbox, the newest on top and their older mail under it.
struct ScreeningTests {
    private func thread(_ id: String, inbox: String = "inb_northwind", sender: String?, minutesAgo: Double)
        -> MailThread
    {
        MailThread(
            id: id, inboxId: inbox, subject: id, snippet: "Words of \(id)",
            lastMessageAt: Date(timeIntervalSince1970: 1_800_000_000 - minutesAgo * 60), sender: sender,
            screened: true)
    }

    @Test func oneRowPerSenderInAnInboxNewestFirst() {
        let list = ScreeningList([
            thread("a1", sender: "maya@studio.example", minutesAgo: 1),
            thread("b1", sender: "tomas@brightfield.example", minutesAgo: 2),
            thread("a2", sender: "Maya@Studio.example", minutesAgo: 3),
            thread("a3", inbox: "inb_harbor", sender: "maya@studio.example", minutesAgo: 4),
            thread("x1", sender: nil, minutesAgo: 5),
            thread("a4", sender: "maya@studio.example", minutesAgo: 6),
        ])
        #expect(list.groups.map(\.latest.id) == ["a1", "b1", "a3", "x1"])
        #expect(list.groups[0].older.map(\.id) == ["a2", "a4"])
        // The same address in another inbox is another row; a thread without a sender stands alone.
        #expect(list.groups[2].older.isEmpty && list.groups[3].older.isEmpty)
    }

    @Test func theSamplesScreenedMail() async throws {
        let store = try await MailStore.sample()
        let list = await ScreeningList(store.lists, inbox: nil)
        #expect(list.groups.map(\.latest.id) == ["thr_5"])
    }

    @Test func words() {
        #expect(ScreeningList.title(count: 16) == "16 New Items")
        #expect(ScreeningList.title(count: 1) == "1 New Item")
        #expect(
            ScreeningList.who(Address(name: "Maya Kim", email: "maya@example.com")) == "Maya Kim (maya@example.com)")
        #expect(ScreeningList.who(Address(email: "maya@example.com")) == "maya@example.com")
        var mail = thread("a1", sender: "maya@studio.example", minutesAgo: 1)
        #expect(ScreeningList.about(mail) == "Words of a1")
        mail.summary = "Asks whether you sell to schools."
        #expect(ScreeningList.about(mail) == "Asks whether you sell to schools.")
        #expect(ActionWords.done(.allowSender) == "Let in.")
        #expect(ActionWords.done(.blockSender) == "Blocked.")
    }
}
