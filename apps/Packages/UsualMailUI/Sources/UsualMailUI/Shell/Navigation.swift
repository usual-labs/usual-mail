/// A sidebar destination, each its own stack (owner's words of 2026-11-20: "the stuff from sidebar will each be their
/// own stack"): the mail stack, entered by choosing a profile in the switcher, with the four tabs and Screening; To
/// reply, Pinned, Snoozed, the Inbox page and Settings, each entered by its rail button. Search isn't one: it opens
/// over whichever shows.
enum Destination: CaseIterable, Hashable, Sendable {
    case mail
    case toReply
    case pinned
    case snoozed
    case inbox
    case settings
}

extension Place {
    /// The stack this place is in: the tabs and Screening the mail stack's, each other rail place its own; nil for
    /// search, which opens over any stack.
    var destination: Destination? {
        switch self {
        case .tab, .screening: .mail
        case .toReply: .toReply
        case .pinned: .pinned
        case .snoozed: .snoozed
        case .inbox: .inbox
        case .settings: .settings
        case .search: nil
        }
    }
}

/// Where the window is (the coordinator's spec of 2026-11-20, from the owner's words of that day): which stack shows,
/// what each stack holds, and search over it. Each stack keeps its state while the app runs, so coming back to one
/// finds it as it was left: the mail stack its profile, its page (a tab or Screening) and its open mail; To reply,
/// Pinned, Snoozed and the Inbox page their open mail; Settings its tab. No stack has a way back to another: their rail
/// buttons and the switcher are the way between them. Search is the one exception: it opens over any stack, leaving
/// that stack as it was, and its capsule goes back to it ("← Pinned").
struct Navigation: Equatable, Sendable {
    /// The stack showing, under search too.
    private(set) var destination: Destination
    /// The mail stack's page: one of the tabs, or Screening. Choosing another closes the mail open there; it can be
    /// nothing outside the mail stack.
    var mailPlace: Place = .tab(.home) {
        didSet {
            guard mailPlace != oldValue else { return }
            guard mailPlace.destination == .mail else {
                mailPlace = oldValue
                return
            }
            openMail[.mail] = nil
        }
    }
    /// The mail stack's profile: one inbox, or nil for every inbox. It scopes only the mail stack (`activeProfile`).
    private(set) var profile: String?
    /// Settings' tab: Accounts at first, then the last one chosen, while the app runs. Another tab drops
    /// `accountsSignIn`.
    var settingsTab = SettingsTab.accounts {
        didSet { if settingsTab != oldValue { accountsSignIn = nil } }
    }
    /// The Gmail inbox Settings' Accounts tab signs in with Google again as it opens: the sync notice's "Sign in again"
    /// (`SyncNotice`). Going anywhere else drops it, so coming back to Accounts later starts nothing.
    private(set) var accountsSignIn: String?
    /// The mail open in each stack. Settings holds none.
    private var openMail: [Destination: String] = [:]
    /// Search, while it shows over the stack.
    private(set) var search: SearchOver?

    /// Search over a stack: the mail read from its results, if one is.
    struct SearchOver: Equatable, Sendable {
        var reading: String?
    }

    /// Opens at `place` (search over the mail stack's Home), with `reading` open in it and the mail stack on `profile`.
    init(place: Place = .tab(.home), reading: String? = nil, profile: String? = nil) {
        self.profile = profile
        if let destination = place.destination {
            self.destination = destination
            if destination == .mail { mailPlace = place }
        } else {
            destination = .mail
            search = SearchOver()
        }
        if let reading { open(reading) }
    }

    // MARK: What shows

    /// The place the card shows: search while it is open, else the stack's own page.
    var place: Place { search == nil ? stackPlace : .search }

    /// The stack's own page, under search too.
    var stackPlace: Place {
        switch destination {
        case .mail: mailPlace
        case .toReply: .toReply
        case .pinned: .pinned
        case .snoozed: .snoozed
        case .inbox: .inbox
        case .settings: .settings
        }
    }

    /// The thread open in the card: search's, while it shows, else the stack's.
    var reading: String? {
        if let search { return search.reading }
        return openMail[destination]
    }

    /// The profile that scopes what shows: the mail stack's, there and on search over it. Elsewhere none, so To reply,
    /// Pinned, Snoozed, the Inbox page, Settings and search over them take every inbox.
    var activeProfile: String? { destination == .mail ? profile : nil }

    /// What the switcher marks: the mail stack's profile while the mail stack shows, nothing otherwise.
    var profileMark: ProfileMark { ProfileMark(profile: profile, active: destination == .mail) }

    /// The tabs and the screening capsule show only on the mail stack, not under search.
    var showsTabs: Bool { search == nil && destination == .mail }

    /// The card is wider on the Inbox page and on search, with a mail open from them too (`MailLayout(size:wide:)`).
    var wide: Bool { search != nil || destination == .inbox }

    /// Search's capsule: the name of where the person was ("← Receipts", "← Pinned").
    var searchReturnTitle: String { stackPlace.title }

    // MARK: Moving

    /// A rail button: its stack as it was left, or search (`openSearch`). The stack showing, pressed again, stays as it
    /// is; pressed from search over it, it leaves search.
    mutating func press(_ target: Place) {
        if let destination = target.destination {
            go(to: destination)
        } else {
            openSearch()
        }
    }

    /// Goes to a stack as it was left, leaving search.
    mutating func go(to destination: Destination) {
        search = nil
        accountsSignIn = nil
        self.destination = destination
    }

    /// A profile in the switcher: the mail stack on it, at the page it last had. Another profile closes the mail open
    /// there; search stays, now in that profile, back at its results when its scope changed.
    mutating func choose(profile id: String?) {
        let scope = activeProfile
        accountsSignIn = nil
        if id != profile {
            profile = id
            openMail[.mail] = nil
        }
        destination = .mail
        if activeProfile != scope { search?.reading = nil }
    }

    /// ⌘K and the magnifier: search over the stack, at its results; from a mail read from them, back to them.
    mutating func openSearch() {
        accountsSignIn = nil
        if search == nil {
            search = SearchOver()
        } else {
            search?.reading = nil
        }
    }

    /// Search's capsule, and its Esc once the field is clear: the stack exactly as it was.
    mutating func leaveSearch() {
        search = nil
    }

    /// Settings on one of its tabs, as from search's offer to set up the AI.
    mutating func openSettings(_ tab: SettingsTab) {
        settingsTab = tab
        go(to: .settings)
    }

    /// Settings' Accounts tab, from the notice on an inbox that stopped syncing; with `signingIn`, that Gmail inbox
    /// signing in with Google again at once.
    mutating func openAccounts(signingIn inboxId: String? = nil) {
        openSettings(.accounts)
        accountsSignIn = inboxId
    }

    /// The sync notice's button (`SyncNotice.Action`). The dashboard opens in the browser (`Pages`), leaving the
    /// window where it is.
    mutating func fixSync(_ action: SyncNotice.Action) {
        switch action {
        case .signIn(let inboxId): openAccounts(signingIn: inboxId)
        case .openAccounts: openAccounts()
        case .dashboard: break
        }
    }

    /// Opens a thread in the card: in search, or in the stack. Settings has no mail.
    mutating func open(_ threadID: String) {
        if search != nil {
            search?.reading = threadID
        } else if destination != .settings {
            openMail[destination] = threadID
        }
    }

    /// The mail page's back, Esc and search's capsule: closes the open mail, back to the list it came from; else on
    /// search, leaves it. Nothing otherwise: a stack has no way back.
    mutating func back() {
        if search?.reading != nil {
            search?.reading = nil
        } else if search != nil {
            search = nil
        } else {
            openMail[destination] = nil
        }
    }
}

/// What the profile switcher marks (`Navigation.profileMark`): the mail stack's profile, the circle for every inbox
/// when that is nil, while the mail stack shows; elsewhere nothing, no inbox and not every inbox.
struct ProfileMark: Equatable, Sendable {
    let profile: String?
    let active: Bool

    /// Whether the profile `id` (nil: every inbox) is marked.
    func marks(_ id: String?) -> Bool {
        active && profile == id
    }
}
