import Foundation
import Testing
import UsualMailKit

@testable import UsualMailUI

/// Settings' tabs, alone at the right of its top row (Settings a stack of its own, owner's words of 2026-11-20): their
/// order, the tab remembered while the app runs, names or icons by the card's width; and the pieces moved into Accounts
/// and AI.
@MainActor
struct SettingsTabsTests {
    @Test func fiveTabsInTheirOrderAndNoBackCapsule() {
        #expect(SettingsTab.allCases.map(\.title) == ["Accounts", "AI", "Appearance", "Blocked", "About"])
        #expect(
            TopBar.items(place: .settings, reading: false)
                == [
                    .gap, .settings(.accounts), .settings(.ai), .settings(.appearance), .settings(.blocked),
                    .settings(.about),
                ])
        // Each has its own icon from the free set, in this package's catalog (`AssetTests` checks they're bundled).
        #expect(Set(SettingsTab.allCases.map(\.icon)).count == 5)
        #expect(
            SettingsTab.allCases.map(\.icon.rawValue) == [
                "user-account", "ai-magic", "paint-board", "user-block-01", "information-circle",
            ])
    }

    @Test func theLastTabIsRememberedWhileTheAppRuns() {
        var nav = Navigation()
        #expect(nav.settingsTab == .accounts)
        nav.press(.settings)
        nav.settingsTab = .blocked
        // Away and back, by the switcher and by the rail: still Blocked.
        nav.choose(profile: nil)
        #expect(nav.place == .tab(.home))
        nav.press(.inbox)
        nav.press(.settings)
        #expect(nav.place == .settings && nav.settingsTab == .blocked)
        // A new launch starts again at Accounts: nothing is kept on disk.
        #expect(Navigation(place: .settings).settingsTab == .accounts)
    }

    @Test func namesWhenTheCardHasRoomIconsInTheSmallestWindow() {
        let smallest = MailLayout(size: CGSize(width: 820, height: 560))
        let design = MailLayout(size: CGSize(width: 1512, height: 982))
        #expect(!SettingsTab.showsNames(cardWidth: smallest.center))
        #expect(SettingsTab.showsNames(cardWidth: design.center))
        // The card reaches the design's width at about 840 wide.
        #expect(SettingsTab.showsNames(cardWidth: MailLayout(size: CGSize(width: 840, height: 600)).center))
        #expect(!SettingsTab.showsNames(cardWidth: MailLayout(size: CGSize(width: 830, height: 600)).center))
    }

    @Test func accountsKeepsTheInboxWordsAndAITheStateWords() throws {
        let sample = SampleData.bundled
        let inbox = try #require(sample.inboxes.first)
        var needsYou = inbox
        needsYou.status = .needsAttention
        #expect(InboxWords.status(needsYou) == "Needs you")
        // While its first sync runs, how far it has got, in core's words.
        var fetching = inbox
        fetching.status = .connecting
        #expect(InboxWords.status(fetching) == "Connecting…")
        fetching.firstSync = FirstSyncProgress(fetched: 120, total: 340)
        #expect(InboxWords.status(fetching) == "Fetching your mail · 120 of 340")
        fetching.status = .paused
        #expect(InboxWords.status(fetching) == "Paused")
        #expect(SettingsView.aiWords(sample.aiStatus).hasPrefix("Working."))
        var paused = sample.aiStatus
        paused.state = .paused
        paused.pending = 0
        #expect(SettingsView.aiWords(paused) == "AI is paused on your server, so there are no new summaries.")
    }
}
