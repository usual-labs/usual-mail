import Foundation

/// The first run, from the welcome to Home (docs/agents/apps-onboarding.md): its steps, whether a paired Mac still
/// needs them, where they resume, and the words that come from no server.
///
/// Before pairing: the welcome, where Usual Mail runs, and connecting to the server (`AppSession.pair`). After pairing,
/// in place of the mail window: how much old mail a new inbox brings in, Gmail, the AI key, and what to expect while the
/// mail comes in.
public enum Onboarding {
    public enum Step: String, CaseIterable, Comparable, Sendable {
        /// The wordmark and the manifesto.
        case welcome
        /// Your own server, or Usual hosted (not built).
        case whereToRun
        /// The server's address and a pairing code.
        case server
        /// How much old mail an inbox's first sync brings in (the server's first-sync window). Only before the first
        /// inbox, since the window applies to inboxes connected from then on.
        case history
        /// Signing in with Google, as often as there are Gmail inboxes to connect.
        case gmail
        /// A Vercel AI Gateway key, after what leaves the server.
        case aiKey
        /// What Usual Mail does, while the first mail is sorted.
        case whileWaiting

        public static func < (lhs: Step, rhs: Step) -> Bool {
            lhs.index < rhs.index
        }

        private var index: Int { Self.allCases.firstIndex(of: self) ?? 0 }

        /// The steps shown before the Mac is paired.
        public var isBeforePairing: Bool { self <= .server }

        /// The step after this one; nil after the last. Pairing comes between `server` and `history`.
        public var next: Step? {
            index + 1 < Self.allCases.count ? Self.allCases[index + 1] : nil
        }

        /// The step before this one, within the same side of pairing.
        public var previous: Step? {
            guard index > 0 else { return nil }
            let step = Self.allCases[index - 1]
            return step.isBeforePairing == isBeforePairing ? step : nil
        }
    }

    // MARK: Whether it shows

    /// Whether the paired window shows the first run instead of the mail: once the store has heard from the server
    /// (`counts`, which comes in the same refresh as the AI settings), while the server has no inbox, while it has no
    /// AI key (once its settings are known), or while this Mac started the first run with this server and hasn't
    /// reached "Go to Home". A second Mac pairing with a server that is set up goes straight to Home.
    @MainActor
    public static func isNeeded(_ store: MailStore) -> Bool {
        isNeeded(store, progress: .shared)
    }

    @MainActor
    public static func isNeeded(_ store: MailStore, progress: OnboardingProgress) -> Bool {
        guard store.counts != nil else { return false }
        if store.lists.inboxes.isEmpty { return true }
        if store.aiSettings?.credentialsSet == false { return true }
        return progress.step(for: store.apiClient.server) != nil
    }

    /// Where the steps after pairing begin, or resume after a quit, for this store and this Mac.
    @MainActor
    public static func resume(_ store: MailStore, progress: OnboardingProgress) -> Step {
        resume(
            saved: progress.step(for: store.apiClient.server), hasInbox: !store.lists.inboxes.isEmpty,
            keySet: store.aiSettings?.credentialsSet, aiState: store.aiStatus?.state)
    }

    /// The step that follows `step` after pairing, for this store: the next one, unless a need isn't met (no inbox, no
    /// key), the history step is behind an inbox already there, or a key already works (the key step is passed by).
    @MainActor
    public static func step(after step: Step, in store: MailStore) -> Step {
        resume(
            saved: step.next ?? step, hasInbox: !store.lists.inboxes.isEmpty,
            keySet: store.aiSettings?.credentialsSet, aiState: store.aiStatus?.state)
    }

    /// Where the steps after pairing begin: the step this Mac reached (`saved`), but never past one whose need isn't
    /// met (an inbox, then a key). Without an inbox: how much old mail, unless this Mac had already passed it. With
    /// one, never the history step, which only shapes inboxes still to come. Without a step saved, at the first need
    /// not met. A key that works moves on from the key step by itself.
    public static func resume(saved: Step?, hasInbox: Bool, keySet: Bool?, aiState: AiState?) -> Step {
        let saved = saved.flatMap { $0.isBeforePairing ? nil : $0 }
        guard hasInbox else { return saved == nil || saved == .history ? .history : .gmail }
        var step = max(saved ?? (keySet == false ? .aiKey : .whileWaiting), .gmail)
        if keySet == false { step = min(step, .aiKey) }
        if step == .aiKey, keySet == true, let aiState, keyCheck(AiStatus(state: aiState)) == .works {
            return .whileWaiting
        }
        return step
    }

    // MARK: The AI key

    /// How the server's test of a saved key went.
    public enum KeyCheck: Hashable, Sendable {
        /// It works (or the person paused the AI elsewhere, which stops the test from saying): on to the next step.
        case works
        /// It doesn't, in words a person can act on.
        case problem(String)
    }

    /// The approved words for each way a key can fail; a model the service doesn't know is said in the server's own
    /// words, which name the job and the model.
    public static func keyCheck(_ status: AiStatus) -> KeyCheck {
        let detail = given(status.detail)
        switch status.state {
        case .working, .paused:
            return .works
        case .keyRefused:
            return .problem("Vercel didn't accept this key. Check that you copied all of it, or make a new one.")
        case .outOfCredit:
            return .problem("Your Vercel account is out of credit. Add some, then test again.")
        case .unavailable:
            return .problem("Your server couldn't reach Vercel. Check its internet connection and try again.")
        case .modelNotFound:
            let job = status.job == .summarize ? "summaries" : "sorting"
            return .problem(detail ?? "Vercel doesn't know the model chosen for \(job).")
        case .notSetUp:
            return .problem(detail ?? "Your server didn't keep the key. Save it again.")
        case .unknown:
            return .problem(detail ?? "Your server couldn't say whether the key works. Test it again.")
        }
    }

    // MARK: How much old mail

    /// One answer to "How much old mail?": how many days back a new inbox's first sync reaches.
    public struct HistoryChoice: Hashable, Sendable, Identifiable {
        public var days: Int
        public var words: String
        public var recommended: Bool
        public var id: Int { days }
    }

    /// The window the first run suggests.
    public static let recommendedFirstSyncDays = 7
    /// The days the first run offers.
    static let firstSyncOffer = [7, 30]

    /// The last 7 days (recommended) and the last 30 days, and the server's own days when they are neither, so a
    /// window set elsewhere isn't changed without the person choosing to. Shortest first.
    public static func firstSyncChoices(current: Int?) -> [HistoryChoice] {
        var days = firstSyncOffer
        if let current, current > 0, !days.contains(current) { days.append(current) }
        return days.sorted().map { days in
            let recommended = days == recommendedFirstSyncDays
            let words = "The last \(dayWords(days))"
            return HistoryChoice(
                days: days, words: recommended ? "\(words) (recommended)" : words, recommended: recommended)
        }
    }

    /// The choice shown as picked: the server's own days, or the recommended ones when it didn't say.
    public static func firstSyncSelection(current: Int?) -> Int {
        guard let current, current > 0 else { return recommendedFirstSyncDays }
        return current
    }

    /// The days to send for `chosen`, or nil when nothing should be sent: the server didn't say its window, can't
    /// change it from here, or already has those days.
    public static func firstSyncChange(chosen: Int, current: Int?, changeable: Bool?) -> Int? {
        guard let current, changeable == true, chosen != current else { return nil }
        return chosen
    }

    /// Under the choices when the server's window is set where it runs.
    public static func firstSyncFixedWords(days: Int) -> String {
        "Your server is set to bring in the last \(dayWords(days)), and that can't be changed from here."
    }

    /// Under the title when the server didn't say its window.
    public static let firstSyncUnknownWords =
        "Your server didn't say how much old mail it brings in. Continue to use its own setting."

    /// "day" for 1, "7 days" otherwise.
    private static func dayWords(_ days: Int) -> String {
        days == 1 ? "day" : "\(days) days"
    }

    // MARK: While the mail comes in

    /// One slide of the carousel.
    public struct Slide: Hashable, Sendable {
        public var title: String
        public var line: String
    }

    public static let slides: [Slide] = [
        Slide(
            title: "Home is what needs you.",
            line: "Conversations that need you. What you haven't seen sits on top."),
        Slide(
            title: "A line on every message.",
            line: "Each one comes with what it's about, so you rarely need to open it."),
        Slide(title: "Feed.", line: "Newsletters, gathered to read through when you have time."),
        Slide(title: "Receipts.", line: "Invoices and what you paid for, out of the way and easy to find."),
        Slide(
            title: "Notifications.",
            line: "Deliveries, bookings and alerts, in order of when they happen: today, coming up, earlier."),
        Slide(
            title: "Reply later, pin, snooze.",
            line: "Put mail aside to answer, keep it at hand, or bring it back when it matters."),
        Slide(title: "Screening.", line: "First mail from someone new waits here until you let them in."),
        Slide(title: "Your whole inbox.", line: "Everything as Gmail has it, newest first, one press away."),
        Slide(title: "Your inboxes.", line: "Switch between them on the left, or see them all at once."),
    ]

    /// The line under the carousel. The server counts only what is left (`pending`), not a total, and counts 0 until
    /// an inbox's first sync has listed its mail, so "All sorted" waits until no inbox is still fetching; meanwhile it
    /// says how far the first syncs have got, those with a count ("Fetching your mail · 120 of 340").
    public static func progressWords(status: AiStatus?, inboxes: [Inbox]) -> String {
        guard let status else { return "Sorting your mail" }
        switch status.state {
        case .keyRefused, .outOfCredit, .unavailable, .modelNotFound:
            if case .problem(let words) = keyCheck(status) { return words }
        case .paused:
            return "Sorting is paused on your server."
        case .notSetUp:
            return "Sorting starts once your AI key is saved."
        case .working, .unknown:
            break
        }
        if status.pending > 0 { return "Sorting your mail · \(status.pending) left" }
        let fetching = inboxes.filter(\.isFetching)
        if !fetching.isEmpty { return FirstSyncProgress.sum(fetching)?.words ?? FirstSyncProgress.fetchingWords }
        if !inboxes.isEmpty, inboxes.allSatisfy({ $0.status == .ok }) { return "All sorted" }
        return "Sorting your mail"
    }

    // MARK: Gmail

    /// A connected inbox's row: "{address} · Connected, fetching mail", with how far its first sync has got once the
    /// server says ("· 120 of 340"), or the server's words when it needs the person.
    public static func inboxWords(_ inbox: Inbox) -> String {
        let state: String
        switch inbox.status {
        case .needsAttention:
            state = given(inbox.statusDetail) ?? "Needs you"
        case .paused:
            state = "Paused"
        default:
            state = inbox.fetching.map { "Connected, fetching mail · \($0.count)" } ?? "Connected, fetching mail"
        }
        return "\(inbox.address) · \(state)"
    }

    // MARK: Links

    /// Where the repository's documentation is read: its `docs` folder on the main branch, under the source code's
    /// address (`ProjectLinks.sourceCode`). Nil while the repository isn't public (`ProjectLinks.isPublished`), so the
    /// app hides its links to the guides rather than point at a page that can't be opened.
    public static var publishedDocs: URL? { docs(in: ProjectLinks.sourceCode) }

    /// The guides the first run links to, in the repository's `docs` folder.
    public enum Guide: String, Sendable {
        /// "Don't have a server yet? Set one up": from nothing to a paired app.
        case selfHosting = "self-hosting.md"
        /// The host's guide to giving the server its Google client.
        case googleSetup = "google-setup.md"
    }

    /// "Don't have a server yet? Set one up".
    public static var selfHostingGuide: URL? { guide(.selfHosting, in: publishedDocs) }

    /// The Google client's guide, under the words for a server without one.
    public static var googleSetupGuide: URL? { guide(.googleSetup, in: publishedDocs) }

    /// The `docs` folder of the repository at `sourceCode`, or nil without one.
    static func docs(in sourceCode: URL?) -> URL? {
        sourceCode?.appending(path: "blob/main/docs")
    }

    /// A guide in the `docs` folder at `docs`, or nil without one.
    static func guide(_ guide: Guide, in docs: URL?) -> URL? {
        docs?.appending(path: guide.rawValue)
    }

    /// "Get a key from Vercel": the AI Gateway's API keys in the person's Vercel dashboard, the address Vercel's own
    /// documentation gives (vercel.com/docs/ai-gateway/authentication-and-byok, read 2026-11-17).
    public static let vercelKeys = URL(
        string: "https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai-gateway%2Fapi-keys&title=AI+Gateway+API+Keys")

    /// The server's words, unless it sent none.
    private static func given(_ words: String?) -> String? {
        guard let words = words?.trimmingCharacters(in: .whitespacesAndNewlines), !words.isEmpty else { return nil }
        return words
    }
}
