import Foundation
import Testing
import UsualMailKit

@testable import UsualMailUI

/// Settings' Blocked tab: each row's words, the profile filter, the empty state, and no undo strip without a record.
@MainActor
struct BlockedTabTests {
    let sample = SampleData.bundled
    /// The sample's days, read in UTC so the test doesn't move with the Mac's time zone.
    let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .gmt
        return calendar
    }()

    private func sender(_ address: String) throws -> BlockedSender {
        try #require(sample.blockedSenders.first { $0.address == address })
    }

    @Test func whoBlockedThemAndWhen() throws {
        let brightBuy = try sender("deals@brightbuy.example")
        #expect(BlockedWords.blocked(brightBuy, now: sample.now, calendar: calendar) == "Blocked 12 Nov by you")
        // An agent, by its name, as "why it's here" names it.
        let linkboost = try sender("outreach@linkboost.example")
        #expect(BlockedWords.blocked(linkboost, now: sample.now, calendar: calendar) == "Blocked 13 Nov by Claude Code")
        // A rule by its own text; one the copy doesn't hold, as "a rule".
        var ruled = brightBuy
        ruled.blockedBy = .rule(ruleId: "rul_x")
        let rule = Rule(
            id: "rul_x", inboxId: "inb_personal", text: "Deals newsletters are blocked", match: RuleMatch(),
            then: [.blockSender], source: .person, createdBy: .person(deviceId: "dev_mac_1"), createdAt: sample.now)
        #expect(
            BlockedWords.blocked(ruled, rules: [rule], now: sample.now, calendar: calendar)
                == "Blocked 12 Nov by a rule: Deals newsletters are blocked")
        #expect(BlockedWords.blocked(ruled, now: sample.now, calendar: calendar) == "Blocked 12 Nov by a rule")
        // No record left of who did it; and a block from another year says the year.
        var unknown = brightBuy
        unknown.blockedBy = nil
        unknown.blockedAt = time("2025-03-04T10:00:00Z")
        #expect(BlockedWords.blocked(unknown, now: sample.now, calendar: calendar) == "Blocked 4 Mar 2025")
    }

    /// Under a sender the person unsubscribed from: how it goes, in one quiet line, by state and way.
    @Test func howUnsubscribingGoes() throws {
        var request = Unsubscribe(
            inboxId: "inb_personal", address: "deals@brightbuy.example", threadId: "thr_26", state: .working,
            askedAt: sample.now, updatedAt: sample.now)
        #expect(BlockedWords.unsubscribe(request) == "Unsubscribing…")
        request.state = .done
        let ways: [(UnsubscribeWay?, String)] = [
            (.oneClick, "Unsubscribed"), (.email, "Asked by email to stop"),
            (.browserAgent, "Unsubscribed by Browser Use"), (.page, "Unsubscribed"), (nil, "Unsubscribed"),
        ]
        for (way, words) in ways {
            request.way = way
            #expect(BlockedWords.unsubscribe(request) == words)
        }
        // Their page, left to the person, when it is one this app opens.
        request.state = .needsPerson
        request.way = .page
        request.url = "https://brightbuy.example/unsubscribe"
        #expect(BlockedWords.unsubscribe(request) == "Their page is left to open" && request.page != nil)
        request.url = "http://brightbuy.example/unsubscribe"
        #expect(BlockedWords.unsubscribe(request) == "Couldn't unsubscribe")
        // Failed: the server's words as they are.
        request.state = .failed
        request.detail = "Their mail offers no way to unsubscribe."
        #expect(BlockedWords.unsubscribe(request) == "Their mail offers no way to unsubscribe.")
        request.detail = " "
        #expect(BlockedWords.unsubscribe(request) == "Couldn't unsubscribe")
        // A state a newer server sends says nothing.
        request.state = .unknown("queued")
        #expect(BlockedWords.unsubscribe(request) == nil)
    }

    @Test func howManyMessagesSince() throws {
        #expect(BlockedWords.since(try sender("deals@brightbuy.example").messagesSinceBlocked) == "3 messages since")
        #expect(BlockedWords.since(try sender("outreach@linkboost.example").messagesSinceBlocked) == "1 message since")
        #expect(BlockedWords.since(try sender("sales@growthpipe.example").messagesSinceBlocked) == nil)
    }

    @Test func nameAddressAndTheInboxWhenEveryInboxShows() throws {
        let brightBuy = try sender("deals@brightbuy.example")
        #expect(BlockedWords.name(brightBuy) == "BrightBuy Deals")
        #expect(BlockedWords.address(brightBuy, inbox: "Personal") == "deals@brightbuy.example · Personal")
        #expect(BlockedWords.address(brightBuy, inbox: nil) == "deals@brightbuy.example")
        // No name: the address once, as the name.
        var nameless = brightBuy
        nameless.name = " "
        #expect(BlockedWords.name(nameless) == "deals@brightbuy.example")
        #expect(BlockedWords.address(nameless, inbox: nil).isEmpty)
        #expect(BlockedWords.address(nameless, inbox: "Personal") == "Personal")
    }

    @Test func theProfileFilterAndTheEmptyState() async throws {
        let store = try await MailStore.sample()
        let list = try #require(store.blockedSenders)
        #expect(list.items(in: nil).count == 3)
        #expect(list.items(in: "inb_northwind").map(BlockedWords.name) == ["Growthpipe"])
        #expect(list.items(in: "inb_unknown").isEmpty && BlockedWords.empty == "No blocked senders.")
    }

    @Test func theWordsUnderTheListSayWhatBlockingDoesAndPointToSearch() {
        let words = BlockedWords.explanation.joined(separator: " ")
        #expect(words.hasPrefix("Mail from a blocked sender arrives already done and never reaches Home or the AI."))
        #expect(words.contains("you can find them in search."))
        #expect(words.hasSuffix("Unblocking can be undone."))
    }

    @Test func theStripSaysUnblockedOnlyWhenThereIsARecord() {
        let record = ActionRecord(
            id: "act_allow", threadId: "thr_28", inboxId: "inb_harbor", action: .allowSender,
            actor: .person(deviceId: "dev_mac_1"), state: .applied, at: sample.now, undoable: true)
        let unblocked = RecentAction(action: .allowSender, records: [record], words: "Unblocked.")
        #expect((unblocked.words ?? ActionWords.done(unblocked.action)) == "Unblocked.")
        // Screening's let in keeps its own words.
        let letIn = RecentAction(action: .allowSender, records: [record])
        #expect((letIn.words ?? ActionWords.done(letIn.action)) == "Let in.")
    }
}

/// Settings' About tab: the source link waits for the repository to be public; the versions' words.
struct AboutTabTests {
    @Test func theSourceLinkShowsOnlyOncePublished() {
        #expect(AboutWords.links(published: ProjectLinks.isPublished).map(\.title) == ["Website"])
        #expect(AboutWords.links(published: false).map(\.url.absoluteString) == ["https://mail.usual.dev"])
        let published = AboutWords.links(published: true)
        #expect(published.map(\.title) == ["Website", "Source code"])
        #expect(published.last?.shown == "github.com/usual-labs/usual-mail")
    }

    @Test func theVersionsWords() {
        let server = ServerInfo(name: "usual-mail", version: "0.4.2", apiVersion: 1)
        func words(_ lines: [AboutWords.Line]) -> [String] { lines.map { "\($0.label): \($0.value)" } }
        #expect(
            words(AboutWords.versions(appVersion: "0.1.0", build: "7", server: server, sample: false))
                == ["App: 0.1.0 (7)", "Server: 0.4.2", "API: Version 1"])
        #expect(
            words(AboutWords.versions(appVersion: "0.1.0", build: "0.1.0", server: nil, sample: false))
                == ["App: 0.1.0", "Server: Not heard from yet"])
        #expect(
            words(AboutWords.versions(appVersion: nil, build: nil, server: nil, sample: true))
                == ["App: Not known", "Server: Sample data, no server"])
    }

    @Test func theManifestoIsOnboardingsOwn() {
        #expect(WelcomeStep.manifesto.hasPrefix("Email was made for letters."))
    }
}

private func time(_ text: String) -> Date {
    MailJSON.parseTime(text)!
}
