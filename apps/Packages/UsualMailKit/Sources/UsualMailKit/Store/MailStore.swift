import Foundation
import Observation

/// Whether the live connection to the server is up.
public enum ConnectionState: Hashable, Sendable {
    case connecting
    case live
    case offline(String)
}

/// Something that went wrong that the person should hear about.
public struct Problem: Identifiable, Hashable, Sendable {
    public let id = UUID()
    public let message: String

    public init(message: String) {
        self.message = message
    }
}

/// The person's last own action, which Undo reverses.
public struct RecentAction: Hashable, Sendable {
    public var action: ActionInput
    public var records: [ActionRecord]
    /// What the undo strip says, when the action's own words don't fit ("Unblocked." for letting a sender in from
    /// Settings' Blocked tab).
    public var words: String?

    public init(action: ActionInput, records: [ActionRecord], words: String? = nil) {
        self.action = action
        self.records = records
        self.words = words
    }
}

/// The state the interface shows, for one paired server.
///
/// It reads the on-device copy first, so the app opens instantly and works offline, then refreshes from the
/// server and follows its events. Actions show at once, take the threads the server answers with, and are
/// undone on screen if the server refuses them. Of two copies of an inbox, a thread, a record, a draft, a rule, the
/// counts or the AI's status or settings, the one with the higher version wins, wherever it came from. Everything runs on the main actor; the disk and the network
/// are awaited.
@MainActor
@Observable
public final class MailStore {
    public internal(set) var lists = MailLists.empty
    public internal(set) var openThreadID: String?
    /// The open thread with its messages, from the copy, then from the server.
    public internal(set) var openThread: ThreadDetail?
    /// A question to turn the person's correction into a rule.
    public internal(set) var teachPrompt: TeachPrompt?
    public internal(set) var lastAction: RecentAction?
    public internal(set) var connection = ConnectionState.connecting
    public internal(set) var problem: Problem?
    /// How many threads wait in each inbox's triage queue, from `triage.pending` events.
    public internal(set) var triagePending: [String: Int] = [:]
    /// How many threads each list holds, per inbox and in all, as the server counts them: from the refresh and
    /// `counts.changed`, the higher version kept, and from the copy on disk while offline. Tab badges and Home's New
    /// count come from here; nil until the server has answered once.
    public internal(set) var counts: Counts?
    /// Whether the server's AI works, and how much it still has to do: from the refresh and `ai.status.changed`, the
    /// higher version kept, and from the copy on disk while offline.
    public internal(set) var aiStatus: AiStatus?
    /// The AI's settings, without the key. Only a person's device gets them; nil until fetched, and a refusal leaves
    /// them as they were.
    public internal(set) var aiSettings: AiSettings?
    /// How many days back a new inbox's first sync reaches, the one setting for old mail: from the refresh,
    /// `loadFirstSyncWindow()` and `updateFirstSync(days:)`. Only a person's device gets it; nil until fetched. Not
    /// kept on disk.
    public internal(set) var firstSyncWindow: FirstSyncWindow?
    /// What the server's AI used of the person's account, cut in this Mac's time zone: from `loadAiUsage()`, which
    /// Settings calls. Only a person's device gets it; nil until fetched, so nothing is ever shown as zero. Not kept
    /// on disk.
    public internal(set) var aiUsage: AiUsage?
    /// The blocked senders in every inbox, newest block first: from `loadBlockedSenders()`, which Settings' Blocked tab
    /// calls, and `sender.changed`; loaded again on reconnecting once loaded. Only a person's device gets them; nil
    /// until fetched. Not kept on disk.
    public internal(set) var blockedSenders: BlockedSenderList?
    /// What the server says it is (`/v1/info`): its version and API version, for Settings' About tab. Nil until
    /// `loadServerInfo()` hears from it. Not kept on disk.
    public internal(set) var serverInfo: ServerInfo?
    /// True for the sample (`MailStore.sample`), which has no server behind it.
    public internal(set) var isSample = false
    public internal(set) var isRefreshing = false
    public internal(set) var hasLoadedFromDisk = false

    @ObservationIgnored let client: APIClient
    @ObservationIgnored let local: LocalStore
    @ObservationIgnored private let events: EventStream?
    @ObservationIgnored let clock: @Sendable () -> Date
    /// Sender pictures, loaded through this store's server with its token and kept on the device by id.
    @ObservationIgnored public let senderPictures: SenderPictures
    /// Called when the server refuses this device's token.
    @ObservationIgnored public var onUnauthorized: (@MainActor () -> Void)?

    @ObservationIgnored var pendingThreads = PendingChanges<MailThread>()
    @ObservationIgnored var pendingRecords = PendingChanges<ActionRecord>()
    /// Where each of the person's own actions found its thread, so undo can show it back at once.
    @ObservationIgnored var undoSnapshots: [String: ThreadPlacement] = [:]
    /// Threads `markRead(opening:)` is marking read, which opening one of them doesn't mark again.
    @ObservationIgnored var readsOnTheirWay: Set<String> = []
    /// The rows unblocking took away, by the record that unblocked them, so undoing it shows the row again at once.
    @ObservationIgnored var unblockedRows: [String: BlockedSender] = [:]
    /// `sender.changed` and `unsubscribe.changed` events that came while the blocked senders were being fetched, to
    /// apply on top of the answer; nil while no fetch is under way.
    @ObservationIgnored var senderChangesWhileLoading: [BlockedSenderChange]?
    @ObservationIgnored let watch = RefreshWatch()
    @ObservationIgnored private var refreshAgain = false
    @ObservationIgnored private var comeBackTimer: Task<Void, Never>?
    /// Whether Handled shows silent records; `lists.includesSilent` says what the lists hold.
    @ObservationIgnored private var showsSilent = false

    /// - Parameter senderPictures: where sender pictures come from; by default through `client`, kept in the app's
    ///   caches folder (`SenderPictures.defaultDirectory`).
    public init(
        client: APIClient, local: LocalStore, events: EventStream? = nil,
        clock: @escaping @Sendable () -> Date = { Date() }, senderPictures: SenderPictures? = nil
    ) {
        self.client = client
        self.local = local
        self.events = events
        self.clock = clock
        self.senderPictures = senderPictures ?? SenderPictures(client: client)
    }

    /// The server this store talks to, for building links to its attachment route.
    public var apiClient: APIClient { client }

    /// The store's "now": the Mac's clock, or the sample's moment in the sample mode, which shows the sample at its
    /// own times. The screens that say "today" read it, so the sample's notifications fall where the sample means.
    public var now: Date { clock() }

    /// Shows the copy on disk, refreshes from the server and follows its events until the calling task is
    /// cancelled. Without an event stream it refreshes once.
    public func start() async {
        if !hasLoadedFromDisk { await loadFromDisk() }
        guard let events else {
            await refresh()
            return
        }
        Task { await refresh() }
        for await update in events.updates() {
            switch update {
            case .connected:
                connection = .live
                // Changes made while the stream was down aren't replayed, so reload; and the server may be a newer one
                // (what it can do, as unsubscribing, goes by its version).
                Task { await refresh() }
                Task { await loadServerInfo() }
                if blockedSenders != nil { Task { await loadBlockedSenders() } }
            case .event(let event):
                await receive(event)
            case .disconnected(let reason, _):
                connection = .offline(reason)
            case .unauthorized:
                connection = .offline("This device isn't signed in to the server any more.")
                onUnauthorized?()
                return
            }
        }
    }

    public func loadFromDisk() async {
        await reloadLists()
        hasLoadedFromDisk = true
    }

    /// Fetches everything from the server and brings the copy in line. Events keep arriving meanwhile and are
    /// shown at once; versions keep the refresh from writing an older copy over them, and what changed while it
    /// fetched isn't removed for being missing from its lists (`RefreshWatch`). A refresh asked for while one runs
    /// makes it run again.
    public func refresh() async {
        if isRefreshing {
            refreshAgain = true
            return
        }
        isRefreshing = true
        repeat {
            refreshAgain = false
            watch.begin()
            let windowBefore = firstSyncWindow
            do {
                let snapshot = try await ServerFetch(client: client).snapshot()
                // A window saved while the refresh fetched is newer than the one it brings.
                if let window = snapshot.firstSyncWindow, firstSyncWindow == windowBefore, window != windowBefore {
                    firstSyncWindow = window
                }
                let shown = withPendingChanges(snapshot)
                let pending = RefreshKeep(threads: pendingThreads.ids, records: pendingRecords.ids)
                let watch = self.watch
                // A sent draft's note is kept for a day after it was sent; this covers a missed `draft.removed`.
                let sentCutoff = clock().addingTimeInterval(-Draft.sentNoteKept)
                try await local.write { writer in
                    var keep = watch.changed
                    keep.formUnion(pending)
                    try writer.reconcile(shown, keeping: keep)
                    try writer.dropSentDrafts(sentBefore: sentCutoff)
                }
                // The server answered, so an earlier failed request no longer says anything.
                if case .offline = connection { connection = .live }
            } catch {
                report(error, quietlyIfOffline: true)
            }
            watch.end()
        } while refreshAgain
        isRefreshing = false
        await reloadLists()
    }

    /// Opens a thread: the stored copy at once, then the server's. `nil` closes it. Opening an unread thread marks
    /// it read (not a trashed one, which takes no action but its undo); `markingRead: false` only looks.
    public func open(threadID: String?, markingRead: Bool = true) async {
        openThreadID = threadID
        guard let threadID else {
            openThread = nil
            return
        }
        if openThread?.thread.id != threadID {
            openThread = try? await local.detail(threadId: threadID)
        }
        var marked = false
        if markingRead, let shown = openThread?.thread, shown.id == threadID, Self.opensUnread(shown) {
            marked = true
            await markRead(threadID)
        }
        do {
            var detail = try await client.thread(id: threadID)
            detail.thread = pendingThreads.serverSent(detail.thread, for: threadID)
            let fetched = detail
            await write(RefreshKeep(threads: [threadID], drafts: Set(detail.drafts.map(\.id)))) {
                try $0.save(fetched)
            }
            await reloadLists()
            // A thread this device didn't have is marked once the server has said it is unread (the copy shown
            // now is the newest this device has).
            if markingRead, !marked, let shown = openThread?.thread, shown.id == threadID, Self.opensUnread(shown) {
                await markRead(threadID)
            }
        } catch {
            report(error, quietlyIfOffline: true)
        }
    }

    /// Whether opening this thread marks it read.
    static func opensUnread(_ thread: MailThread) -> Bool {
        thread.unread && !thread.trashed
    }

    public func dismissProblem() {
        problem = nil
    }

    /// Shows or hides silent records in Handled: what rules and agents applied alone, and cleanly, in an
    /// `act_silently` inbox, and what the server's AI decided. Hidden by default, as the contract says; a record that
    /// went wrong is never silent.
    public func showSilent(_ show: Bool) async {
        showsSilent = show
        await reloadLists()
    }

    /// Every rule an inbox has learned, from the copy.
    public func rules(inboxId: String) async -> [Rule] {
        (try? await local.rules(inboxId: inboxId)) ?? []
    }

    /// The applied, undoable record that put a thread in the trash, if the copy holds one: a trashed thread's way
    /// back.
    public func trashRecord(threadId: String) async -> ActionRecord? {
        let records = (try? await local.actions(threadId: threadId)) ?? []
        return records.first { $0.action == .trash && $0.state == .applied && $0.undoable }
    }

    // MARK: Shared helpers

    /// Reads the lists, the counts, the AI's status and settings and the open thread from the copy again.
    func reloadLists() async {
        do {
            lists = try await local.lists(at: clock(), includeSilent: showsSilent)
            let status = try await local.status()
            if counts != status.counts { counts = status.counts }
            if aiStatus != status.aiStatus { aiStatus = status.aiStatus }
            if aiSettings != status.aiSettings { aiSettings = status.aiSettings }
            if let openThreadID, let detail = try await local.detail(threadId: openThreadID) {
                openThread = detail
            }
        } catch {
            report(error)
        }
        scheduleComeBack()
    }

    /// Writes to the copy, noting the ids for a refresh that may be fetching.
    func write(_ ids: RefreshKeep, _ updates: @escaping @Sendable (LocalWriter) throws -> Void) async {
        watch.note(ids)
        do {
            try await local.write(updates)
        } catch {
            report(error)
        }
    }

    func save(threads: [MailThread] = [], actions: [ActionRecord] = []) async {
        guard !threads.isEmpty || !actions.isEmpty else { return }
        await write(RefreshKeep(threads: Set(threads.map(\.id)), records: Set(actions.map(\.id)))) { writer in
            try writer.upsert(threads: threads)
            try writer.upsert(actions: actions)
        }
    }

    /// The thread as stored, which is the newest copy this device has, or as a list shows it.
    func currentThread(id: String) async -> MailThread? {
        if let stored = try? await local.thread(id: id) { return stored }
        if openThread?.thread.id == id { return openThread?.thread }
        return lists.thread(id: id)
    }

    func report(_ error: any Error, quietlyIfOffline: Bool = false) {
        if error is CancellationError { return }
        if let apiError = error as? APIError {
            if apiError.code == .unauthorized {
                onUnauthorized?()
                return
            }
            if apiError.isOffline {
                connection = .offline(apiError.message)
                if quietlyIfOffline { return }
            }
        }
        problem = Problem(message: (error as? APIError)?.message ?? error.localizedDescription)
    }

    /// Reports an error; a `conflict` for an inbox the copy holds as paused is said in words.
    func report(_ error: any Error, inboxId: String?, ifPaused refusal: PausedRefusal) {
        if (error as? APIError)?.code == .conflict, let inbox = inboxId.flatMap(lists.inbox(id:)), inbox.isPaused {
            problem = Problem(message: inbox.pausedWords(refusal))
            return
        }
        report(error)
    }

    /// The snapshot with this device's unconfirmed changes on top.
    private func withPendingChanges(_ snapshot: ServerSnapshot) -> ServerSnapshot {
        var snapshot = snapshot
        let thread = { (value: MailThread) in self.pendingThreads.serverSent(value, for: value.id) }
        let record = { (value: ActionRecord) in self.pendingRecords.serverSent(value, for: value.id) }
        snapshot.openThreads = snapshot.openThreads.map(thread)
        snapshot.listedThreads = snapshot.listedThreads.map(thread)
        snapshot.handled = snapshot.handled.map { HandledItem(record: record($0.record), thread: thread($0.thread)) }
        snapshot.proposals = snapshot.proposals.map {
            HandledItem(record: record($0.record), thread: thread($0.thread))
        }
        snapshot.attention = snapshot.attention.map {
            HandledItem(record: record($0.record), thread: thread($0.thread))
        }
        return snapshot
    }

    /// Reloads the lists when the next thread is due to come back into Home.
    private func scheduleComeBack() {
        comeBackTimer?.cancel()
        let now = clock()
        let next = lists.waiting.compactMap(\.comeBackAt).filter { $0 > now }.min()
        guard let next else { return }
        comeBackTimer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(next.timeIntervalSince(now)))
            guard !Task.isCancelled else { return }
            await self?.reloadLists()
        }
    }
}

extension APIError {
    /// The description shown to a person.
    var message: String { localizedDescription }
}
