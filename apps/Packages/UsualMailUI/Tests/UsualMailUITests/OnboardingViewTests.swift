import Foundation
import Testing
import UsualMailKit

@testable import UsualMailUI

/// The first run's screens: their words are the owner's approved copy of 2026-11-17, the carousel's picture is bundled,
/// and the welcome keeps usual.dev's margins.
@MainActor
struct OnboardingViewTests {
    @Test func everySlideHasItsClipBundledForEachApp() throws {
        // The Mac's clips show the Mac app, the iPhone's the iPhone app; each app plays its own.
        #expect(TourClip.all == TourClip.mac)
        for clips in [TourClip.mac, TourClip.phone] {
            #expect(clips.count == Onboarding.slides.count, "one clip a slide")
            for clip in clips {
                let url = try #require(clip.url, "\(clip.resource).mp4 in the package's resources")
                let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                #expect(size > 50_000 && size < 1_000_000, "\(clip.resource): \(size) bytes")
                #expect(clip.still > 0)
            }
        }
        let names = (TourClip.mac + TourClip.phone).map(\.resource)
        #expect(Set(names).count == names.count)
        #expect(TourClip.mac.allSatisfy { $0.resource.hasPrefix("tour-mac-") })
        #expect(TourClip.phone.allSatisfy { $0.resource.hasPrefix("tour-phone-") })
    }

    @Test func theWelcomeIsManifestoD() {
        #expect(
            WelcomeStep.manifesto
                == "Email was made for letters. Today most of it isn't: receipts, newsletters, alerts and codes, all in "
                + "one long list, in the order they arrived, beside the few people who actually need you. We think an "
                + "inbox is for people. Everything else should be read for you, put where it belongs, and told to you "
                + "in a line. And because it's your mail, it should run on your own server, with your own AI, in the "
                + "open. The usual, done well.")
    }

    @Test func theStepsSayTheApprovedWords() {
        #expect(
            GmailStep.words
                == "Sign in with Google and allow Usual Mail to read, sort and label your mail. Your server keeps the "
                + "access; your password stays with Google.")
        // Corrected on 2026-11-17 against docs/google-setup.md: there is no "Advanced" step at Google.
        #expect(GmailStep.headsUp.first?.hasPrefix("Google will warn that it hasn't verified the app.") == true)
        #expect(!GmailStep.headsUp.joined().contains("Advanced"))
        #expect(GmailStep.testUser == "Another address must first be listed as a test user in your Google client.")
        #expect(
            ServerStep.help
                == "Get a code with usual-mail pair on your server, or from the file owner-pairing-code in its data "
                + "folder. On Cloudflare, the first code is in the Worker's Data Studio, table owner_pairing_code; "
                + "later ones come from the dashboard's Devices and agents page. A code works once.")
        #expect(AiKeyStep.words.hasSuffix("The key stays on your server; no app or device sees it again."))
        #expect(HistoryStep.title == "How much old mail?")
        #expect(
            HistoryStep.words
                == "New mail comes in as it arrives. Usual Mail also brings in some of the mail you already have, and "
                + "the AI sorts and summarizes all of it; each message costs a little on your Vercel account.")
    }

    @Test func noWordsSpeakOfAnAISwitchPerInbox() {
        let all =
            [WelcomeStep.manifesto, GmailStep.words, GmailStep.testUser, AiKeyStep.words, HistoryStep.words]
            + GmailStep.headsUp
        for words in all {
            #expect(!words.contains("turn it on") && !words.contains("stays off"))
        }
    }

    @Test func theWelcomeKeepsUsualDevsMargins() {
        #expect(PairingLayout.margin(for: CGSize(width: 1512, height: 982)) == CGSize(width: 80, height: 80))
        #expect(abs(PairingLayout.margin(for: CGSize(width: 820, height: 560)).width - 49.2) < 0.001)
        // Clear of the window's buttons at the top, however narrow.
        #expect(PairingLayout.margin(for: CGSize(width: 300, height: 560)) == CGSize(width: 24, height: 52))
    }
}
