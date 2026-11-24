import Foundation

// Mirrors of `core/src/first-sync.ts`: how many days of mail a new inbox's first sync takes (docs/contract-sync.md,
// "Sync"). It is the one setting for old mail: the server's AI works through all synced mail that isn't done, so this
// window decides how much older mail it processes. Person only. And how far a first sync has got (`Inbox.firstSync`),
// with core's words for it.

/// Where the server took the first sync's window from (`FirstSyncSource` in core).
public enum FirstSyncSetter: OpenEnum {
    /// `USUAL_MAIL_SYNC_DAYS` where the server starts, which only its host changes.
    case environment
    /// The server's settings file, which `usual-mail init`, `usual-mail sync-days` and a person's change write.
    case settings
    /// Neither, so the server's default of 30 days (`"default"` on the wire).
    case serverDefault
    case unknown(String)

    public static let known: [FirstSyncSetter] = [.environment, .settings, .serverDefault]

    public var rawValue: String {
        switch self {
        case .environment: "environment"
        case .settings: "settings"
        case .serverDefault: "default"
        case .unknown(let raw): raw
        }
    }
}

/// How many days back a new inbox's first sync reaches (`GET /v1/first-sync`). A window counts back from when each
/// inbox was connected; a smaller one also narrows a first sync in progress, a larger one applies only to inboxes
/// connected afterwards.
public struct FirstSyncWindow: Codable, Hashable, Sendable {
    /// The most days a window may be; the fewest is 1.
    public static let maxDays = 36_500
    /// What a server takes when neither its host nor a person set it.
    public static let defaultDays = 30

    /// 1 to `maxDays`.
    public var days: Int
    public var setBy: FirstSyncSetter
    /// Whether a person may change it: false while the host's environment sets it, and where the host keeps no
    /// settings (demo mode). The server answers `conflict` to a change then.
    public var changeable: Bool

    public init(days: Int, setBy: FirstSyncSetter, changeable: Bool) {
        self.days = days
        self.setBy = setBy
        self.changeable = changeable
    }
}

/// A new first-sync window (`PATCH /v1/first-sync`). The server answers `invalid` outside 1 to
/// `FirstSyncWindow.maxDays` days, and `conflict` when the window isn't changeable.
public struct FirstSyncWindowPatch: Encodable, Hashable, Sendable {
    public var days: Int

    public init(days: Int) {
        self.days = days
    }
}

/// How far an inbox's first sync has got (`FirstSyncProgress` in core; docs/contract-sync.md, "How far a first sync has
/// got"; the owner's decision of 2026-11-23): `fetched` of the `total` messages its window holds, as the provider counts
/// them. The server sends it as `Inbox.firstSync` once the first sync has run two seconds, then at most every two
/// seconds, and drops it once the first sync is done.
public struct FirstSyncProgress: Codable, Hashable, Sendable {
    /// What every interface calls a first sync that has said how far it got (core's `FIRST_SYNC_FETCHING`).
    public static let fetchingWords = "Fetching your mail"

    /// Messages of the window fetched so far.
    public var fetched: Int
    /// Messages the window holds, fetched and still to fetch: never below `fetched`. It falls when the window is made
    /// smaller while the first sync runs.
    public var total: Int

    public init(fetched: Int, total: Int) {
        self.fetched = fetched
        self.total = total
    }

    /// "120 of 340"; "1,200 of 3,400" (core's `firstSyncCount`).
    public var count: String { "\(Self.grouped(fetched)) of \(Self.grouped(total))" }

    /// "Fetching your mail · 120 of 340" (core's `firstSyncWords`).
    public var words: String { "\(Self.fetchingWords) · \(count)" }

    /// The count of several inboxes' first syncs together: those that have said one (`Inbox.fetching`), so an inbox
    /// connecting without a count yet (just connected, resumed or signed in again) doesn't hide the others'. Nil when
    /// none has.
    public static func sum(_ inboxes: [Inbox]) -> FirstSyncProgress? {
        let counts = inboxes.compactMap(\.fetching)
        guard !counts.isEmpty else { return nil }
        return FirstSyncProgress(fetched: counts.map(\.fetched).reduce(0, +), total: counts.map(\.total).reduce(0, +))
    }

    /// 3400 as "3,400", the same on every Mac, as core writes it.
    private static func grouped(_ value: Int) -> String {
        let digits = Array(String(max(0, value)))
        var out = ""
        for (index, digit) in digits.enumerated() {
            if index > 0, (digits.count - index) % 3 == 0 { out.append(",") }
            out.append(digit)
        }
        return out
    }
}
