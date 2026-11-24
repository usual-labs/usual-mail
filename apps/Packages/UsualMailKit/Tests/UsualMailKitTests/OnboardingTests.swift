import Foundation
import Testing

@testable import UsualMailKit

/// The first run's order, where it resumes, and the words that come from no server (the owner's approved copy of
/// 2026-11-17, with the changes the onboarding notes list).
struct OnboardingStepTests {
    typealias Step = Onboarding.Step

    @Test func theStepsComeInTheAgreedOrder() {
        // How much old mail comes first after pairing (owner, 2026-11-18): it shapes only inboxes still to come.
        #expect(Step.allCases == [.welcome, .whereToRun, .server, .history, .gmail, .aiKey, .whileWaiting])
        #expect(Step.allCases.filter(\.isBeforePairing) == [.welcome, .whereToRun, .server])
        #expect(Step.welcome.next == .whereToRun && Step.whereToRun.next == .server && Step.server.next == .history)
        #expect(Step.history.next == .gmail && Step.gmail.next == .aiKey && Step.aiKey.next == .whileWaiting)
        #expect(Step.whileWaiting.next == nil)
        // Back stays on its side of pairing; the step before Gmail is now how much old mail.
        #expect(Step.server.previous == .whereToRun && Step.welcome.previous == nil && Step.history.previous == nil)
        #expect(Step.gmail.previous == .history)
    }

    @Test func aServerWithoutAnInboxStartsWithHowMuchOldMail() {
        #expect(Onboarding.resume(saved: nil, hasInbox: false, keySet: false, aiState: .notSetUp) == .history)
        #expect(Onboarding.resume(saved: .history, hasInbox: false, keySet: false, aiState: .notSetUp) == .history)
        // Past it, never past a missing inbox, whatever this Mac reached.
        #expect(Onboarding.resume(saved: .gmail, hasInbox: false, keySet: false, aiState: .notSetUp) == .gmail)
        #expect(Onboarding.resume(saved: .whileWaiting, hasInbox: false, keySet: true, aiState: .working) == .gmail)
    }

    @Test func anInboxPutsHowMuchOldMailBehind() {
        // The window only shapes inboxes connected later, so with one there it is never asked again.
        #expect(Onboarding.resume(saved: .history, hasInbox: true, keySet: true, aiState: .working) == .gmail)
        #expect(Onboarding.resume(saved: .history, hasInbox: true, keySet: false, aiState: .notSetUp) == .gmail)
        #expect(Onboarding.resume(saved: nil, hasInbox: true, keySet: nil, aiState: nil) != .history)
    }

    @Test func aServerWithoutAKeyStopsAtTheKey() {
        #expect(Onboarding.resume(saved: nil, hasInbox: true, keySet: false, aiState: .notSetUp) == .aiKey)
        #expect(Onboarding.resume(saved: .gmail, hasInbox: true, keySet: false, aiState: .notSetUp) == .gmail)
        #expect(Onboarding.resume(saved: .whileWaiting, hasInbox: true, keySet: false, aiState: nil) == .aiKey)
    }

    @Test func aQuitResumesWhereThisMacLeftOff() {
        #expect(Onboarding.resume(saved: .gmail, hasInbox: true, keySet: true, aiState: .working) == .gmail)
        #expect(
            Onboarding.resume(saved: .whileWaiting, hasInbox: true, keySet: true, aiState: .working) == .whileWaiting)
        // A saved key that works moves past the key step; one the service refused stays there to be fixed.
        #expect(Onboarding.resume(saved: .aiKey, hasInbox: true, keySet: true, aiState: .working) == .whileWaiting)
        #expect(Onboarding.resume(saved: .aiKey, hasInbox: true, keySet: true, aiState: .keyRefused) == .aiKey)
        #expect(Onboarding.resume(saved: .aiKey, hasInbox: true, keySet: true, aiState: .outOfCredit) == .aiKey)
        // Settings not known: the step reached stands.
        #expect(Onboarding.resume(saved: .aiKey, hasInbox: true, keySet: nil, aiState: nil) == .aiKey)
        // A step before pairing isn't a place to resume after it.
        #expect(Onboarding.resume(saved: .server, hasInbox: false, keySet: false, aiState: .notSetUp) == .history)
        #expect(Onboarding.resume(saved: .server, hasInbox: true, keySet: false, aiState: .notSetUp) == .aiKey)
    }

    @Test func eachKeyStateInTheApprovedWords() {
        #expect(Onboarding.keyCheck(AiStatus(state: .working)) == .works)
        // Paused elsewhere by the person: the key is saved, and the test can't say more.
        #expect(Onboarding.keyCheck(AiStatus(state: .paused)) == .works)
        #expect(
            Onboarding.keyCheck(AiStatus(state: .keyRefused, detail: "401 from the gateway"))
                == .problem("Vercel didn't accept this key. Check that you copied all of it, or make a new one."))
        #expect(
            Onboarding.keyCheck(AiStatus(state: .outOfCredit))
                == .problem("Your Vercel account is out of credit. Add some, then test again."))
        #expect(
            Onboarding.keyCheck(AiStatus(state: .unavailable))
                == .problem("Your server couldn't reach Vercel. Check its internet connection and try again."))
        // The server's words name the job and the model.
        let detail = "On Vercel's AI Gateway, categorizing needs a decision model; example/text-1 is a language model."
        #expect(
            Onboarding.keyCheck(AiStatus(state: .modelNotFound, detail: detail, job: .categorize)) == .problem(detail))
        #expect(
            Onboarding.keyCheck(AiStatus(state: .modelNotFound, detail: "  ", job: .summarize))
                == .problem("Vercel doesn't know the model chosen for summaries."))
        #expect(
            Onboarding.keyCheck(AiStatus(state: .unknown("later"), detail: "Newer words.")) == .problem("Newer words."))
    }

    @Test func howMuchOldMailOffersTheAgreedChoices() {
        let choices = Onboarding.firstSyncChoices(current: 7)
        #expect(choices.map(\.days) == [7, 30])
        #expect(choices.map(\.words) == ["The last 7 days (recommended)", "The last 30 days"])
        #expect(choices.map(\.recommended) == [true, false])
        #expect(Onboarding.firstSyncChoices(current: 30).map(\.days) == [7, 30])
        #expect(Onboarding.firstSyncChoices(current: nil).map(\.days) == [7, 30])
    }

    @Test func aWindowSetElsewhereIsOfferedSoItIsntChangedSilently() {
        #expect(
            Onboarding.firstSyncChoices(current: 90).map(\.words) == [
                "The last 7 days (recommended)", "The last 30 days", "The last 90 days",
            ])
        #expect(
            Onboarding.firstSyncChoices(current: 1).map(\.words) == [
                "The last day", "The last 7 days (recommended)", "The last 30 days",
            ])
        #expect(Onboarding.firstSyncChoices(current: 14).map(\.days) == [7, 14, 30])
    }

    @Test func theServersOwnDaysArePicked() {
        #expect(Onboarding.firstSyncSelection(current: 30) == 30)
        #expect(Onboarding.firstSyncSelection(current: 90) == 90)
        #expect(Onboarding.firstSyncSelection(current: nil) == 7)
    }

    @Test func nothingIsSentUnlessTheChoiceChangesAWindowThatCanChange() {
        #expect(Onboarding.firstSyncChange(chosen: 30, current: 7, changeable: true) == 30)
        // Unchanged: no request.
        #expect(Onboarding.firstSyncChange(chosen: 7, current: 7, changeable: true) == nil)
        // Set where the server runs: no request.
        #expect(Onboarding.firstSyncChange(chosen: 30, current: 7, changeable: false) == nil)
        // The server didn't say: no request, its own setting stands.
        #expect(Onboarding.firstSyncChange(chosen: 30, current: nil, changeable: nil) == nil)
    }

    @Test func aWindowThatCantChangeIsSaidInWords() {
        #expect(
            Onboarding.firstSyncFixedWords(days: 90)
                == "Your server is set to bring in the last 90 days, and that can't be changed from here.")
        #expect(
            Onboarding.firstSyncFixedWords(days: 1)
                == "Your server is set to bring in the last day, and that can't be changed from here.")
        #expect(
            Onboarding.firstSyncUnknownWords
                == "Your server didn't say how much old mail it brings in. Continue to use its own setting.")
    }

    @Test func theCarouselHasTheNineSlides() {
        #expect(Onboarding.slides.count == 9)
        #expect(
            Onboarding.slides.map(\.title) == [
                "Home is what needs you.", "A line on every message.", "Feed.", "Receipts.", "Notifications.",
                "Reply later, pin, snooze.", "Screening.", "Your whole inbox.", "Your inboxes.",
            ])
        #expect(Onboarding.slides[3].line == "Invoices and what you paid for, out of the way and easy to find.")
        // The two the owner added on 2026-11-20.
        #expect(
            Onboarding.slides[4].line
                == "Deliveries, bookings and alerts, in order of when they happen: today, coming up, earlier.")
        #expect(Onboarding.slides[7].line == "Everything as Gmail has it, newest first, one press away.")
    }

    private func inboxes(_ statuses: InboxStatus...) -> [Inbox] {
        zip(SampleData.bundled.inboxes, statuses).map { inbox, status in
            var inbox = inbox
            inbox.status = status
            return inbox
        }
    }

    @Test func theProgressLineSaysOnlyWhatTheServerKnows() {
        let synced = inboxes(.ok, .ok)
        #expect(Onboarding.progressWords(status: nil, inboxes: synced) == "Sorting your mail")
        #expect(
            Onboarding.progressWords(status: AiStatus(state: .working, pending: 12), inboxes: synced)
                == "Sorting your mail · 12 left")
        #expect(
            Onboarding.progressWords(status: AiStatus(state: .working, pending: 0), inboxes: synced) == "All sorted")
    }

    @Test func nothingIsAllSortedWhileAFirstSyncRuns() {
        // The server counts 0 until a first sync has listed its mail.
        let fetching = inboxes(.ok, .connecting)
        #expect(
            Onboarding.progressWords(status: AiStatus(state: .working, pending: 0), inboxes: fetching)
                == "Fetching your mail")
        #expect(
            Onboarding.progressWords(status: AiStatus(state: .working, pending: 3), inboxes: fetching)
                == "Sorting your mail · 3 left")
        // An inbox whose sync failed doesn't count as sorted either.
        #expect(
            Onboarding.progressWords(
                status: AiStatus(state: .working, pending: 0), inboxes: inboxes(.ok, .needsAttention))
                == "Sorting your mail")
        #expect(
            Onboarding.progressWords(status: AiStatus(state: .working, pending: 0), inboxes: []) == "Sorting your mail")
    }

    @Test func aStuckAISaysWhyUnderTheCarousel() {
        let synced = inboxes(.ok)
        #expect(
            Onboarding.progressWords(status: AiStatus(state: .outOfCredit, pending: 40), inboxes: synced)
                == "Your Vercel account is out of credit. Add some, then test again.")
        #expect(
            Onboarding.progressWords(status: AiStatus(state: .paused, pending: 40), inboxes: synced)
                == "Sorting is paused on your server.")
    }

    @Test func eachConnectedInboxIsARow() {
        let rows = inboxes(.connecting, .needsAttention, .paused)
        #expect(Onboarding.inboxWords(rows[0]) == "\(rows[0].address) · Connected, fetching mail")
        #expect(rows[0].address.hasSuffix(".example"))
        var attention = rows[1]
        attention.statusDetail = "Google no longer accepts this inbox's sign-in."
        #expect(
            Onboarding.inboxWords(attention) == "\(attention.address) · Google no longer accepts this inbox's sign-in.")
        attention.statusDetail = nil
        #expect(Onboarding.inboxWords(attention) == "\(attention.address) · Needs you")
        #expect(Onboarding.inboxWords(rows[2]) == "\(rows[2].address) · Paused")
    }

    @Test func theGuidesWaitForAPublicAddress() throws {
        // No guessed address: the links stay hidden until the repository is published.
        #expect(!ProjectLinks.isPublished && Onboarding.publishedDocs == nil)
        #expect(Onboarding.selfHostingGuide == nil && Onboarding.googleSetupGuide == nil)
        // Once it is, they point at the guides in its docs folder (the switch itself isn't flipped here).
        let docs = Onboarding.docs(in: ProjectLinks.sourceCode(published: true))
        #expect(docs?.absoluteString == "https://github.com/usual-labs/usual-mail/blob/main/docs")
        #expect(
            Onboarding.guide(.selfHosting, in: docs)?.absoluteString
                == "https://github.com/usual-labs/usual-mail/blob/main/docs/self-hosting.md")
        #expect(
            Onboarding.guide(.googleSetup, in: docs)?.absoluteString
                == "https://github.com/usual-labs/usual-mail/blob/main/docs/google-setup.md")
        #expect(Onboarding.docs(in: ProjectLinks.sourceCode(published: false)) == nil)
        let keys = try #require(Onboarding.vercelKeys)
        #expect(keys.scheme == "https" && keys.host == "vercel.com")
    }
}
