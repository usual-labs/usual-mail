import Foundation

/// Who did something. `Actor` in core; `Doer` here because Swift's concurrency already has an `Actor`.
public enum Doer: Codable, Hashable, Sendable {
    case person(deviceId: String)
    case rule(ruleId: String)
    case agent(agentId: String, name: String)
    /// The server's own AI, naming the job and the model that did it.
    case ai(job: AiJob, model: String)
    case system
    /// A kind a newer server sends. Kept whole so it encodes back unchanged.
    case unknown(kind: String, payload: JSONValue)

    private enum Key: String, CodingKey {
        case kind, deviceId, ruleId, agentId, name, job, model
    }

    public var kind: String {
        switch self {
        case .person: "person"
        case .rule: "rule"
        case .agent: "agent"
        case .ai: "ai"
        case .system: "system"
        case .unknown(let kind, _): kind
        }
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: Key.self)
        let kind = try container.decode(String.self, forKey: .kind)
        switch kind {
        case "person": self = .person(deviceId: try container.decode(String.self, forKey: .deviceId))
        case "rule": self = .rule(ruleId: try container.decode(String.self, forKey: .ruleId))
        case "agent":
            self = .agent(
                agentId: try container.decode(String.self, forKey: .agentId),
                name: try container.decode(String.self, forKey: .name))
        case "ai":
            self = .ai(
                job: try container.decode(AiJob.self, forKey: .job),
                model: try container.decode(String.self, forKey: .model))
        case "system": self = .system
        default: self = .unknown(kind: kind, payload: try JSONValue(from: decoder))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        if case .unknown(_, let payload) = self {
            try payload.encode(to: encoder)
            return
        }
        var container = encoder.container(keyedBy: Key.self)
        try container.encode(kind, forKey: .kind)
        switch self {
        case .person(let deviceId): try container.encode(deviceId, forKey: .deviceId)
        case .rule(let ruleId): try container.encode(ruleId, forKey: .ruleId)
        case .agent(let agentId, let name):
            try container.encode(agentId, forKey: .agentId)
            try container.encode(name, forKey: .name)
        case .ai(let job, let model):
            try container.encode(job, forKey: .job)
            try container.encode(model, forKey: .model)
        case .system, .unknown: break
        }
    }
}

/// Something that can be done to a thread.
public enum ActionInput: Codable, Hashable, Sendable {
    /// Sets the category and who decided it, and nothing else, except that a thread put in `otp` stops being screened
    /// and loses its summary. It lets no sender in. Nobody can choose `.uncategorized`.
    case categorize(Category)
    case done
    case notDone
    case read
    case unread
    case stack(Stack)
    case unstack
    case comeBack(at: Date, ifNoReply: Bool? = nil)
    case cancelComeBack
    /// Screening answer: this sender may reach the inbox.
    case allowSender
    /// Screening answer: never show this sender again.
    case blockSender
    case trash
    /// A kind a newer server sends. Kept whole so it encodes back unchanged.
    case unknown(kind: String, payload: JSONValue)

    private enum Key: String, CodingKey {
        case kind, category, stack, at, ifNoReply
    }

    /// The `kind` in the JSON, for example `come_back`.
    public var kind: String {
        switch self {
        case .categorize: "categorize"
        case .done: "done"
        case .notDone: "not_done"
        case .read: "read"
        case .unread: "unread"
        case .stack: "stack"
        case .unstack: "unstack"
        case .comeBack: "come_back"
        case .cancelComeBack: "cancel_come_back"
        case .allowSender: "allow_sender"
        case .blockSender: "block_sender"
        case .trash: "trash"
        case .unknown(let kind, _): kind
        }
    }

    /// Actions a rule or an agent may never apply alone (`NEEDS_PERSON` in core).
    public var needsPerson: Bool {
        switch self {
        case .trash, .blockSender: true
        default: false
        }
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: Key.self)
        let kind = try container.decode(String.self, forKey: .kind)
        switch kind {
        case "categorize": self = .categorize(try container.decode(Category.self, forKey: .category))
        case "done": self = .done
        case "not_done": self = .notDone
        case "read": self = .read
        case "unread": self = .unread
        case "stack": self = .stack(try container.decode(Stack.self, forKey: .stack))
        case "unstack": self = .unstack
        case "come_back":
            self = .comeBack(
                at: try container.decode(Date.self, forKey: .at),
                ifNoReply: try container.decodeIfPresent(Bool.self, forKey: .ifNoReply))
        case "cancel_come_back": self = .cancelComeBack
        case "allow_sender": self = .allowSender
        case "block_sender": self = .blockSender
        case "trash": self = .trash
        default: self = .unknown(kind: kind, payload: try JSONValue(from: decoder))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        if case .unknown(_, let payload) = self {
            try payload.encode(to: encoder)
            return
        }
        var container = encoder.container(keyedBy: Key.self)
        try container.encode(kind, forKey: .kind)
        switch self {
        case .categorize(let category): try container.encode(category, forKey: .category)
        case .stack(let stack): try container.encode(stack, forKey: .stack)
        case .comeBack(let at, let ifNoReply):
            try container.encode(at, forKey: .at)
            try container.encodeIfPresent(ifNoReply, forKey: .ifNoReply)
        default: break
        }
    }
}

/// One entry in an inbox's history. Handled is a list of these.
public struct ActionRecord: Codable, Hashable, Sendable, Identifiable, Versioned {
    public var id: String
    public var threadId: String
    public var inboxId: String
    public var action: ActionInput
    public var actor: Doer
    /// One line a person can read.
    public var reason: String?
    public var state: ActionState
    public var at: Date
    public var undoneAt: Date?
    /// False once it can no longer be reversed.
    public var undoable: Bool
    /// True when a rule or an agent applied it alone, and cleanly, in an `act_silently` inbox, or the server's AI
    /// applied it (always, unless something went wrong). The server sets it, and turns it false for good when the
    /// provider refuses the record or its undo or adds a note. Handled leaves silent records out unless the person
    /// asks for them.
    public var silent: Bool
    /// Why it failed, or why an undo of it was refused.
    public var error: String?
    /// Something a person should know about a write-back that worked, for example "This server can't keep stacks".
    public var note: String?
    /// Rises with every change to the record, maybe by more than one.
    public var version: Int

    public init(
        id: String, threadId: String, inboxId: String, action: ActionInput, actor: Doer, reason: String? = nil,
        state: ActionState, at: Date, undoneAt: Date? = nil, undoable: Bool, silent: Bool = false,
        error: String? = nil, note: String? = nil, version: Int = 1
    ) {
        self.id = id
        self.threadId = threadId
        self.inboxId = inboxId
        self.action = action
        self.actor = actor
        self.reason = reason
        self.state = state
        self.at = at
        self.undoneAt = undoneAt
        self.undoable = undoable
        self.silent = silent
        self.error = error
        self.note = note
        self.version = version
    }

    /// Whether it needs a person's look, as Handled with `attentionOnly` picks them: it failed, or carries an `error`
    /// or a `note`. Such a record is never silent.
    public var needsALook: Bool { state == .failed || error != nil || note != nil }
}

/// The part of a thread that actions change and undo puts back: category, screened, done, stack, come-back time,
/// unread and trashed (docs/contract.md, "Actions and undo").
public struct ThreadPlacement: Hashable, Sendable {
    public var category: Category
    public var screened: Bool
    public var done: Bool
    public var stack: Stack?
    public var comeBackAt: Date?
    public var comeBackIfNoReply: Bool?
    public var unread: Bool
    public var trashed: Bool

    /// What the thread is expected to look like once the server has applied `action`, as the contract describes
    /// each action. The app shows this straight away; the server's own copy of the thread replaces it.
    ///
    /// `allow_sender` lets in every screened thread of the sender; this guess changes only the named thread, and the
    /// others follow as their `thread.changed` events arrive.
    public func applying(_ action: ActionInput) -> ThreadPlacement {
        var next = self
        switch action {
        case .categorize(let category):
            next.category = category
            // One-time codes are never screened (the sender still isn't let in).
            if category == .otp { next.screened = false }
        case .done, .blockSender:
            next.done = true
            next.stack = nil
            next.comeBackAt = nil
            next.comeBackIfNoReply = nil
        case .notDone: next.done = false
        case .read: next.unread = false
        case .unread: next.unread = true
        case .stack(let stack):
            next.stack = stack
            next.done = false
        case .unstack: next.stack = nil
        case .comeBack(let at, let ifNoReply):
            next.comeBackAt = at
            next.comeBackIfNoReply = ifNoReply
            next.done = false
        case .cancelComeBack:
            next.comeBackAt = nil
            next.comeBackIfNoReply = nil
        case .allowSender: next.screened = false
        case .trash: next.trashed = true
        case .unknown: break
        }
        return next
    }
}

extension MailThread {
    public var placement: ThreadPlacement {
        get {
            ThreadPlacement(
                category: category, screened: screened, done: done, stack: stack, comeBackAt: comeBackAt,
                comeBackIfNoReply: comeBackIfNoReply, unread: unread, trashed: trashed)
        }
        set {
            category = newValue.category
            screened = newValue.screened
            done = newValue.done
            stack = newValue.stack
            comeBackAt = newValue.comeBackAt
            comeBackIfNoReply = newValue.comeBackIfNoReply
            unread = newValue.unread
            trashed = newValue.trashed
        }
    }

    /// The thread once `action` is applied by `source`: its placement as `ThreadPlacement.applying` says, and for
    /// `categorize` who decided it (the person's own action unless said otherwise). A thread put in `otp` loses its
    /// summary, since one-time codes are never summarized. A thread put in another category loses its payment details
    /// and its notification event, as the server takes them away, so an invoice turned receipt never shows its amount
    /// as paid, and a notification turned conversation never keeps its event.
    public func applying(_ action: ActionInput, by source: CategorySource? = .person) -> MailThread {
        var next = self
        next.placement = placement.applying(action)
        if case .categorize(let category) = action {
            next.categorizedBy = source
            // Who exactly decided comes back with the server's copy.
            next.categorizedByActor = nil
            if category == .otp { next.summary = nil }
            if category != self.category {
                next.payment = nil
                next.event = nil
            }
        }
        return next
    }
}
