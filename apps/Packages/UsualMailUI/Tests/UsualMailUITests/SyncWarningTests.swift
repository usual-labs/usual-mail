import Foundation
import Testing
import UsualMailKit

@testable import UsualMailUI

/// The warning for an inbox that stopped syncing (the owner's words of 2026-11-25): which inboxes warn, which lists
/// show the notice, what it says and does, where its button goes, and the iPhone switcher's words for it.
@MainActor
struct SyncWarningTests {
    /// The sample's inboxes: Northwind Studio (Gmail) and Harbor & Pine up to date, Personal (IMAP) needing attention.
    let sample = SampleData.bundled.inboxes

    private func inbox(_ id: String) throws -> Inbox {
        try #require(sample.first { $0.id == id })
    }

    /// The sample's inboxes with `id` in `status`, saying `detail`.
    private func inboxes(_ id: String, _ status: InboxStatus, detail: String? = nil) -> [Inbox] {
        sample.map { inbox in
            guard inbox.id == id else { return inbox }
            var changed = inbox
            changed.status = status
            changed.statusDetail = detail
            return changed
        }
    }

    @Test func onlyAnInboxThatNeedsAttentionWarns() {
        let statuses: [InboxStatus] = [.connecting, .ok, .needsAttention, .paused, .unknown("later")]
        let warned = statuses.filter { status in
            inboxes("inb_northwind", status).contains { $0.id == "inb_northwind" && SyncWarning.stopped($0) }
        }
        #expect(warned == [.needsAttention])
        #expect(sample.filter(SyncWarning.stopped).map(\.id) == ["inb_personal"])
    }

    @Test func theNoticeShowsOnEveryListWithTheInboxsMail() throws {
        // The mail stack on every inbox, on each of its pages.
        var nav = Navigation()
        for page: Place in [.tab(.home), .tab(.reads), .tab(.receipts), .tab(.notifications), .screening] {
            nav.mailPlace = page
            #expect(SyncWarning.shown(nav: nav, inboxes: sample).map(\.id) == ["inb_personal"], "\(page)")
        }
        // On its own inbox, and not on another one.
        nav.choose(profile: "inb_personal")
        #expect(SyncWarning.shown(nav: nav, inboxes: sample).map(\.id) == ["inb_personal"])
        nav.choose(profile: "inb_northwind")
        #expect(SyncWarning.shown(nav: nav, inboxes: sample).isEmpty)
        // To reply, Pinned, Snoozed and the Inbox page take every inbox, whatever the mail stack's profile.
        for page: Place in [.toReply, .pinned, .snoozed, .inbox] {
            nav.press(page)
            #expect(SyncWarning.shown(nav: nav, inboxes: sample).map(\.id) == ["inb_personal"], "\(page)")
        }
    }

    @Test func noNoticeOnSettingsSearchOrAnOpenMail() {
        var nav = Navigation()
        nav.open("thr_any")
        #expect(SyncWarning.shown(nav: nav, inboxes: sample).isEmpty)
        nav.back()
        nav.openSearch()
        #expect(SyncWarning.shown(nav: nav, inboxes: sample).isEmpty)
        nav.press(.settings)
        #expect(SyncWarning.shown(nav: nav, inboxes: sample).isEmpty)
        // Paused or connecting: nothing anywhere.
        let home = Navigation()
        #expect(SyncWarning.shown(nav: home, inboxes: inboxes("inb_personal", .paused)).isEmpty)
        #expect(SyncWarning.shown(nav: home, inboxes: inboxes("inb_personal", .connecting)).isEmpty)
    }

    @Test func oneInboxSaysWhyInTheServersWordsAndHowToFixIt() throws {
        // The sample's IMAP inbox: the server's words, and its dashboard page, which takes new details; the apps
        // don't.
        let personal = try #require(SyncNotice.notice(for: [inbox("inb_personal")]))
        #expect(personal.title == "Personal stopped syncing.")
        #expect(personal.detail == "The IMAP server at imap.home.example refused the user name or password.")
        #expect(personal.action == .dashboard(inboxId: "inb_personal"))
        #expect(personal.action.title == "Reconnect on the dashboard")
        // A Gmail inbox signs in with Google again.
        let words = "Google no longer accepts this inbox's sign-in."
        let gmail = try #require(
            SyncNotice.notice(
                for: inboxes("inb_northwind", .needsAttention, detail: " \(words)\n").filter {
                    $0.id == "inb_northwind"
                }))
        #expect(gmail.title == "Northwind Studio stopped syncing.")
        #expect(gmail.detail == words)
        #expect(gmail.action == .signIn(inboxId: "inb_northwind"))
        #expect(gmail.action.title == "Sign in again")
        // Without the server's words, what it means.
        let silent = try #require(
            SyncNotice.notice(
                for: inboxes("inb_northwind", .needsAttention, detail: " ").filter { $0.id == "inb_northwind" }))
        #expect(silent.detail == "New mail from it won't arrive here until it's reconnected.")
        #expect(SyncNotice.notice(for: []) == nil)
    }

    @Test func severalInboxesAreNamedOrCountedAndSentToAccounts() throws {
        var stopped = sample
        for index in stopped.indices { stopped[index].status = .needsAttention }
        let two = try #require(
            SyncNotice.notice(for: ["inb_northwind", "inb_harbor"].compactMap { id in stopped.first { $0.id == id } }))
        #expect(two.title == "Northwind Studio and Harbor & Pine stopped syncing.")
        #expect(two.detail == "New mail from them won't arrive here until they're reconnected.")
        #expect(two.action == .openAccounts)
        let three = try #require(SyncNotice.notice(for: stopped))
        #expect(three.title == "3 inboxes stopped syncing.")
        #expect(three.action == .openAccounts)
    }

    @Test func theButtonOpensAccountsSigningTheInboxInOnce() {
        var nav = Navigation()
        nav.fixSync(.signIn(inboxId: "inb_northwind"))
        #expect(nav.place == .settings && nav.settingsTab == .accounts)
        #expect(nav.accountsSignIn == "inb_northwind")
        // Another tab, another stack, search or a profile drops it, so Accounts later starts nothing.
        nav.settingsTab = .ai
        #expect(nav.accountsSignIn == nil)
        for leave: (inout Navigation) -> Void in [
            { $0.press(.toReply) }, { $0.openSearch() }, { $0.choose(profile: nil) }, { $0.press(.settings) },
        ] {
            nav.fixSync(.signIn(inboxId: "inb_northwind"))
            leave(&nav)
            #expect(nav.accountsSignIn == nil)
        }
        // The dashboard opens in the browser: the window stays where it is.
        nav.press(.inbox)
        let before = nav
        nav.fixSync(.dashboard(inboxId: "inb_personal"))
        #expect(nav == before)
        // Accounts alone: the tab, nothing signing in.
        nav.settingsTab = .about
        nav.fixSync(.openAccounts)
        #expect(nav.place == .settings && nav.settingsTab == .accounts && nav.accountsSignIn == nil)
    }

    @Test func theIPhonesMenuSaysSoUnderTheNameAndOnItsCapsule() {
        #expect(
            PhoneSwitch.menuSubtitle(name: "Personal", address: "me@home.example", stopped: true) == "Stopped syncing")
        #expect(
            PhoneSwitch.menuSubtitle(name: "Personal", address: "me@home.example", stopped: false) == "me@home.example")
        #expect(PhoneSwitch.menuSubtitle(name: "me@home.example", address: "me@home.example", stopped: false) == nil)
        #expect(PhoneSwitch.menuSubtitle(name: "Personal", address: nil, stopped: false) == nil)
        // On one line in the menu.
        #expect(PhoneSwitch.menuTitle(SyncWarning.words) == SyncWarning.words)
        // The capsule's words, which its triangle shows.
        #expect(PhoneSwitch.warning(inboxes: sample) == "Personal stopped syncing")
        #expect(PhoneSwitch.warning(inboxes: inboxes("inb_personal", .ok)) == nil)
        var stopped = sample
        for index in stopped.indices { stopped[index].status = .needsAttention }
        #expect(PhoneSwitch.warning(inboxes: stopped) == "3 inboxes stopped syncing")
    }
}
