import Foundation
import UsualMailKit

/// What the sync notice's button does (`SyncNotice.Action`), out of the view so it is tested: the dashboard in the
/// browser, Try again as a request to the server, the rest by moving the window (`Navigation.fixSync`).
@MainActor
struct SyncNoticeDispatch {
    var openURL: @MainActor (URL) -> Void
    var dashboardURL: @MainActor (String) -> URL
    /// `POST /v1/inboxes/:id/sync`.
    var syncInbox: @MainActor (String) async throws -> Void
    var navigate: @MainActor (SyncNotice.Action) -> Void

    /// How asking the server went: only Try again asks it anything.
    enum Asked: Equatable {
        /// The server took the request (it queues a sync; the answer says nothing of how the sync goes).
        case asked
        /// It couldn't be asked, in words a person can act on.
        case refused(String)
    }

    /// Does `action`; nil for the steps that ask the server nothing.
    func run(_ action: SyncNotice.Action) async -> Asked? {
        switch action {
        case .dashboard(let inboxId):
            openURL(dashboardURL(inboxId))
            return nil
        case .tryAgain(let inboxId):
            do {
                try await syncInbox(inboxId)
                return .asked
            } catch {
                return .refused(SyncRetry.refusal(error))
            }
        case .signIn, .openAccounts:
            navigate(action)
            return nil
        }
    }
}

/// What of an inbox shows whether asking it to sync did anything: its status, its words and its last good sync.
struct SyncSnapshot: Equatable {
    let status: InboxStatus
    let statusDetail: String?
    let lastSyncedAt: Date?

    init(_ inbox: Inbox) {
        status = inbox.status
        statusDetail = inbox.statusDetail
        lastSyncedAt = inbox.lastSyncedAt
    }
}

/// Try again on the notice, as it goes (the review of 2026-11-25). The server only queues a sync, so a good answer can
/// only say it asked: the button stays busy until the inbox changes (`SyncSnapshot`) or `waitLimit` passes, and the
/// notice goes by itself once a sync is good. A change while the request is on its way counts too: the wait is over
/// once the server answers (the final review of 2026-11-25). A refusal says why, in the refusal's red. Each line is
/// also said to VoiceOver (`SyncNoticeView`).
struct SyncRetry: Equatable {
    enum Phase: Equatable {
        case idle
        /// The request is on its way: the inbox as it was when pressed (`from`), and as it is now (`now`).
        case asking(from: SyncSnapshot?, now: SyncSnapshot?)
        /// The server took it at `since`, the inbox then `from`.
        case waiting(since: Date, from: SyncSnapshot?)
        case refused(String)
    }

    private(set) var phase: Phase = .idle

    /// How long the button waits for the inbox to change once the server took the request.
    static let waitLimit: TimeInterval = 30
    static let askedWords = "Asked your server to sync."

    /// Whether the button shows it working (and takes no press).
    var busy: Bool {
        switch phase {
        case .asking, .waiting: true
        case .idle, .refused: false
        }
    }

    /// The line under the words: what asking did, or why it couldn't.
    var line: String? {
        switch phase {
        case .waiting: Self.askedWords
        case .refused(let words): words
        case .idle, .asking: nil
        }
    }

    var refused: Bool {
        if case .refused = phase { true } else { false }
    }

    /// The button was pressed, the inbox then `inbox` (nil for a step that asks the server nothing).
    mutating func began(inbox: SyncSnapshot?) {
        phase = .asking(from: inbox, now: inbox)
    }

    /// The step returned: `asked` for Try again, nil for a step that asks the server nothing. Asked, it waits for the
    /// inbox to change, unless it already did while the request was on its way.
    mutating func answered(_ asked: SyncNoticeDispatch.Asked?, at now: Date) {
        switch asked {
        case .asked?:
            guard case .asking(let from, let seen) = phase, seen == from else {
                phase = .idle
                return
            }
            phase = .waiting(since: now, from: from)
        case .refused(let words)?: phase = .refused(words)
        case nil: phase = .idle
        }
    }

    /// The inbox as it is now, at `now`: kept while asking; waiting ends once it changed or `waitLimit` passed.
    mutating func saw(_ inbox: SyncSnapshot?, at now: Date) {
        switch phase {
        case .asking(let from, _):
            phase = .asking(from: from, now: inbox)
        case .waiting(let since, let from):
            if inbox != from || now.timeIntervalSince(since) >= Self.waitLimit { phase = .idle }
        case .idle, .refused:
            break
        }
    }

    /// Why the server couldn't be asked: its own words, or the app's for an unreachable server.
    static func refusal(_ error: Error) -> String {
        "Your server couldn't be asked to sync. \(error.localizedDescription)"
    }
}
