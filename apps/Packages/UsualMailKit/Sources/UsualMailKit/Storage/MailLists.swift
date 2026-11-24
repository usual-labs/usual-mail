import Foundation

/// What the interface shows, read from the on-device copy in one go. Each list holds every inbox; the
/// `…(inbox:)` methods narrow it to one. The lists are docs/contract.md's ("Lists"): no list of threads holds a trashed
/// thread, and none but the screening list holds a screened one.
public struct MailLists: Hashable, Sendable {
    /// By `position`.
    public var inboxes: [Inbox]
    /// Conversation and uncategorized threads that are let in, not done, on no stack and not waiting, by the later of
    /// the last message and a come-back time that has passed. Notifications have their own tab.
    public var home: [MailThread]
    /// Each category's threads that are let in and not done, stacked and waiting ones included. A category this app
    /// doesn't know lists under `.uncategorized`.
    public var categories: [Category: [MailThread]]
    /// Threads on each stack that are let in.
    public var stacks: [Stack: [MailThread]]
    /// Threads whose come-back time is ahead, not done and let in, soonest first.
    public var waiting: [MailThread]
    /// Screened threads that aren't done.
    public var screening: [MailThread]
    /// What rules, agents and the server's AI did or propose (proposed and applied), newest first. Silent records,
    /// the AI's among them, are in it only when `includesSilent`.
    public var handled: [HandledItem]
    /// Whether `handled` holds silent records too.
    public var includesSilent: Bool
    /// How many silent records there are among proposed and applied ones, shown or not.
    public var silentCount: Int
    /// Records that need a look: those that failed or carry an error or a note, from every state and whoever made
    /// them, the person's own refused changes included, newest first (Handled with `attentionOnly`). Never silent. A
    /// record here may also be in `handled`.
    public var attention: [HandledItem]
    /// Drafts and failed sends, newest first.
    public var drafts: [Draft]
    /// Each inbox's rules, oldest first, by inbox id.
    public var rules: [String: [Rule]]
    /// The newest brief on the device.
    public var brief: Brief?

    public init(
        inboxes: [Inbox] = [], home: [MailThread] = [], categories: [Category: [MailThread]] = [:],
        stacks: [Stack: [MailThread]] = [:], waiting: [MailThread] = [], screening: [MailThread] = [],
        handled: [HandledItem] = [], includesSilent: Bool = false, silentCount: Int = 0, attention: [HandledItem] = [],
        drafts: [Draft] = [], rules: [String: [Rule]] = [:], brief: Brief? = nil
    ) {
        self.inboxes = inboxes
        self.home = home
        self.categories = categories
        self.stacks = stacks
        self.waiting = waiting
        self.screening = screening
        self.handled = handled
        self.includesSilent = includesSilent
        self.silentCount = silentCount
        self.attention = attention
        self.drafts = drafts
        self.rules = rules
        self.brief = brief
    }

    public static let empty = MailLists()

    /// Every thread the lists hold, once each.
    public var everyThread: [MailThread] {
        var seen = Set<String>()
        var all: [MailThread] = []
        let lists = [home, waiting, screening] + Array(categories.values) + Array(stacks.values)
        for thread in lists.joined() where seen.insert(thread.id).inserted {
            all.append(thread)
        }
        return all
    }

    public func inbox(id: String) -> Inbox? {
        inboxes.first { $0.id == id }
    }

    /// Home in one inbox, or all when `inboxId` is nil.
    public func home(inbox inboxId: String?) -> [MailThread] {
        home.filter { inboxId == nil || $0.inboxId == inboxId }
    }

    /// A category's list in one inbox or all. A category this app doesn't know gives the uncategorized list.
    public func threads(in category: Category, inbox inboxId: String?) -> [MailThread] {
        (categories[category.listed] ?? []).filter { inboxId == nil || $0.inboxId == inboxId }
    }

    public func threads(on stack: Stack, inbox inboxId: String?) -> [MailThread] {
        (stacks[stack] ?? []).filter { inboxId == nil || $0.inboxId == inboxId }
    }

    /// Waiting in one inbox or all, soonest first.
    public func waiting(inbox inboxId: String?) -> [MailThread] {
        waiting.filter { inboxId == nil || $0.inboxId == inboxId }
    }

    /// The screening list in one inbox or all.
    public func screening(inbox inboxId: String?) -> [MailThread] {
        screening.filter { inboxId == nil || $0.inboxId == inboxId }
    }

    public func handled(inbox inboxId: String?) -> [HandledItem] {
        handled.filter { inboxId == nil || $0.record.inboxId == inboxId }
    }

    /// Records that need a look, in one inbox or all.
    public func attention(inbox inboxId: String?) -> [HandledItem] {
        attention.filter { inboxId == nil || $0.record.inboxId == inboxId }
    }

    /// Proposals waiting for a yes or no. A proposal is never silent.
    public func proposals(inbox inboxId: String?) -> [HandledItem] {
        handled(inbox: inboxId).filter { $0.record.state == .proposed }
    }

    /// An inbox's rules, oldest first.
    public func rules(inbox inboxId: String) -> [Rule] {
        rules[inboxId] ?? []
    }

    /// A thread any list holds, for showing a brief's highlight or a draft's thread. Every thread that isn't done is
    /// in a category's list or the screening list; a done or trashed one only through Handled.
    public func thread(id: String) -> MailThread? {
        categories.values.joined().first { $0.id == id } ?? screening.first { $0.id == id }
            ?? stacks.values.joined().first { $0.id == id } ?? handled.first { $0.thread.id == id }?.thread
            ?? attention.first { $0.thread.id == id }?.thread
    }
}

/// The server's counts and its AI's status and settings, as the copy on the device holds them.
public struct ServerStatus: Hashable, Sendable {
    public var counts: Counts?
    public var aiStatus: AiStatus?
    /// Only a person's device gets them; they never hold the key.
    public var aiSettings: AiSettings?

    public init(counts: Counts? = nil, aiStatus: AiStatus? = nil, aiSettings: AiSettings? = nil) {
        self.counts = counts
        self.aiStatus = aiStatus
        self.aiSettings = aiSettings
    }
}

/// What a refresh fetched from the server, for `LocalWriter.reconcile`. A list marked complete was fetched to its
/// last page, so anything stored locally that it lacks is gone or changed on the server.
public struct ServerSnapshot: Sendable {
    public var inboxes: [Inbox]
    /// Every thread that isn't done: each category's list and the screening list.
    public var openThreads: [MailThread]
    public var openThreadsComplete: Bool
    /// Home, the stacks and waiting: threads the category lists mostly hold already, fetched as the server lists them.
    public var listedThreads: [MailThread]
    /// The newest Handled rows (proposed and applied), silent ones included: the copy filters them itself.
    public var handled: [HandledItem]
    /// Every proposal waiting for an answer.
    public var proposals: [HandledItem]
    public var proposalsComplete: Bool
    /// The newest records that need a look (Handled with `attentionOnly`), from every state.
    public var attention: [HandledItem]
    /// Drafts and failed sends.
    public var drafts: [Draft]
    public var draftsComplete: Bool
    /// Rules by inbox id. An inbox missing here keeps the rules stored for it.
    public var rules: [String: [Rule]]
    /// The latest brief, when `briefFetched`; nil then means the server has none.
    public var brief: Brief?
    public var briefFetched: Bool
    /// Nil when not fetched: the stored copy stays.
    public var counts: Counts?
    public var aiStatus: AiStatus?
    /// Nil when not fetched or refused (only a person's device gets them).
    public var aiSettings: AiSettings?
    /// The first sync's window, for the store only (it isn't kept on disk). Nil when not fetched or refused.
    public var firstSyncWindow: FirstSyncWindow?

    public init(
        inboxes: [Inbox], openThreads: [MailThread] = [], openThreadsComplete: Bool = false,
        listedThreads: [MailThread] = [], handled: [HandledItem] = [], proposals: [HandledItem] = [],
        proposalsComplete: Bool = false, attention: [HandledItem] = [], drafts: [Draft] = [],
        draftsComplete: Bool = false, rules: [String: [Rule]] = [:], brief: Brief? = nil, briefFetched: Bool = false,
        counts: Counts? = nil, aiStatus: AiStatus? = nil, aiSettings: AiSettings? = nil,
        firstSyncWindow: FirstSyncWindow? = nil
    ) {
        self.inboxes = inboxes
        self.openThreads = openThreads
        self.openThreadsComplete = openThreadsComplete
        self.listedThreads = listedThreads
        self.handled = handled
        self.proposals = proposals
        self.proposalsComplete = proposalsComplete
        self.attention = attention
        self.drafts = drafts
        self.draftsComplete = draftsComplete
        self.rules = rules
        self.brief = brief
        self.briefFetched = briefFetched
        self.counts = counts
        self.aiStatus = aiStatus
        self.aiSettings = aiSettings
        self.firstSyncWindow = firstSyncWindow
    }

    /// Leaves out everything that belongs to an inbox not in `inboxes`.
    mutating func keepOnly(inboxes: Set<String>) {
        openThreads.removeAll { !inboxes.contains($0.inboxId) }
        listedThreads.removeAll { !inboxes.contains($0.inboxId) }
        handled.removeAll { !inboxes.contains($0.record.inboxId) }
        proposals.removeAll { !inboxes.contains($0.record.inboxId) }
        attention.removeAll { !inboxes.contains($0.record.inboxId) }
        drafts.removeAll { !inboxes.contains($0.inboxId) }
        rules = rules.filter { inboxes.contains($0.key) }
        counts = counts?.keepingOnly(inboxes: inboxes)
    }

    /// Every thread in the snapshot, each once: of two copies, the higher version.
    var allThreads: [MailThread] {
        var byID: [String: MailThread] = [:]
        let rows = handled + proposals + attention
        for thread in rows.map(\.thread) + listedThreads + openThreads {
            if let stored = byID[thread.id], stored.version > thread.version { continue }
            byID[thread.id] = thread
        }
        return Array(byID.values)
    }
}
