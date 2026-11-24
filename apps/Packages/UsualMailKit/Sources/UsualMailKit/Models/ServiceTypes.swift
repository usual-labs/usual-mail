import Foundation

// Mirrors of the input and result types in `core/src/service.ts`, as the REST routes carry them.

/// `ListQuery` in core, sent as query parameters.
public struct ListQuery: Hashable, Sendable {
    public var inboxId: String?
    public var cursor: String?
    /// Default 50, at most 200.
    public var limit: Int?

    public init(inboxId: String? = nil, cursor: String? = nil, limit: Int? = nil) {
        self.inboxId = inboxId
        self.cursor = cursor
        self.limit = limit
    }
}

public struct ConnectInboxInput: Codable, Hashable, Sendable {
    public var name: String
    public var color: String
    public var provider: ProviderKind
    /// Provider-specific; see `ImapCredentials` and `GmailCredentials` in core's provider.ts.
    public var credentials: JSONValue
    public var trust: TrustLevel?
    /// Default: the next of person, building and briefcase in turn, by how many inboxes there are.
    public var icon: InboxIcon?

    public init(
        name: String, color: String, provider: ProviderKind, credentials: JSONValue, trust: TrustLevel? = nil,
        icon: InboxIcon? = nil
    ) {
        self.name = name
        self.color = color
        self.provider = provider
        self.credentials = credentials
        self.trust = trust
        self.icon = icon
    }
}

/// Fields left `nil` are not sent and stay as they are. Everything but `guide` is for a person only.
public struct InboxPatch: Codable, Hashable, Sendable {
    public var name: String?
    public var color: String?
    public var icon: InboxIcon?
    /// Moves the inbox to this place and renumbers the others, which raises their versions too (`inbox.changed` for
    /// each).
    public var position: Int?
    public var trust: TrustLevel?
    public var guide: String?
    public var agentAccess: Bool?
    public var paused: Bool?
    /// New credentials for the same mailbox, in the shape used to connect it (`InboxCredentials.json`). Person only.
    /// They replace the stored ones whole. The server checks them with the provider first; if that fails
    /// (`provider_error`, with the provider's words) or they are for another address (`invalid`), nothing in the patch
    /// changes. On success the inbox is `connecting` until its next good sync.
    public var credentials: JSONValue?

    public init(
        name: String? = nil, color: String? = nil, icon: InboxIcon? = nil, position: Int? = nil,
        trust: TrustLevel? = nil, guide: String? = nil, agentAccess: Bool? = nil, paused: Bool? = nil,
        credentials: JSONValue? = nil
    ) {
        self.name = name
        self.color = color
        self.icon = icon
        self.position = position
        self.trust = trust
        self.guide = guide
        self.agentAccess = agentAccess
        self.paused = paused
        self.credentials = credentials
    }
}

/// `PATCH /v1/rules/:id`. Fields left `nil` are not sent.
public struct RulePatch: Codable, Hashable, Sendable {
    public var text: String?
    public var match: RuleMatch?
    public var then: [ActionInput]?
    public var enabled: Bool?

    public init(text: String? = nil, match: RuleMatch? = nil, then: [ActionInput]? = nil, enabled: Bool? = nil) {
        self.text = text
        self.match = match
        self.then = then
        self.enabled = enabled
    }
}

public struct ActInput: Codable, Hashable, Sendable {
    public var threadIds: [String]
    public var action: ActionInput
    public var reason: String?

    public init(threadIds: [String], action: ActionInput, reason: String? = nil) {
        self.threadIds = threadIds
        self.action = action
        self.reason = reason
    }
}

/// What `act`, `undo`, `approve`, `reject` and `decide` answer.
public struct ActResult: Codable, Hashable, Sendable {
    /// One per thread the call changed or proposed to change. A thread it would not change has none.
    public var records: [ActionRecord]
    /// Every thread the call named, as it is now.
    public var threads: [MailThread]
    /// Present when a person's correction could become a rule.
    public var teach: TeachPrompt?

    public init(records: [ActionRecord], threads: [MailThread] = [], teach: TeachPrompt? = nil) {
        self.records = records
        self.threads = threads
        self.teach = teach
    }
}

/// One row of Handled: what was done, and to which thread.
public struct HandledItem: Codable, Hashable, Sendable, Identifiable {
    public var record: ActionRecord
    public var thread: MailThread

    public var id: String { record.id }

    public init(record: ActionRecord, thread: MailThread) {
        self.record = record
        self.thread = thread
    }
}

/// Handled's query: what rules, agents and the server's AI did or propose.
public struct HandledQuery: Hashable, Sendable {
    public var list: ListQuery
    /// Default on the server: proposed and applied; with `attentionOnly`, every state.
    public var states: [ActionState]?
    /// Also list silent records. A record that failed or carries a note is never silent, so it is listed either way.
    public var includeSilent: Bool
    /// Only records that need a person's look: those that failed, or carry an `error` or a `note`, from every state
    /// unless `states` is given.
    public var attentionOnly: Bool

    public init(
        list: ListQuery = ListQuery(), states: [ActionState]? = nil, includeSilent: Bool = false,
        attentionOnly: Bool = false
    ) {
        self.list = list
        self.states = states
        self.includeSilent = includeSilent
        self.attentionOnly = attentionOnly
    }
}

public struct DraftInput: Codable, Hashable, Sendable {
    /// Set to change an existing draft.
    public var id: String?
    public var inboxId: String
    public var threadId: String?
    public var inReplyToMessageId: String?
    public var to: [Address]
    public var cc: [Address]?
    public var bcc: [Address]?
    public var subject: String
    public var body: String

    public init(
        id: String? = nil, inboxId: String, threadId: String? = nil, inReplyToMessageId: String? = nil,
        to: [Address], cc: [Address]? = nil, bcc: [Address]? = nil, subject: String, body: String
    ) {
        self.id = id
        self.inboxId = inboxId
        self.threadId = threadId
        self.inReplyToMessageId = inReplyToMessageId
        self.to = to
        self.cc = cc
        self.bcc = bcc
        self.subject = subject
        self.body = body
    }
}

public struct BriefInput: Codable, Hashable, Sendable {
    /// A highlight as the caller writes it: a thread and a line. The server adds the subject.
    public struct Highlight: Codable, Hashable, Sendable {
        public var threadId: String
        public var line: String

        public init(threadId: String, line: String) {
            self.threadId = threadId
            self.line = line
        }
    }

    public struct Section: Codable, Hashable, Sendable {
        public var inboxId: String
        public var summary: String?
        public var highlights: [Highlight]

        public init(inboxId: String, summary: String? = nil, highlights: [Highlight]) {
            self.inboxId = inboxId
            self.summary = summary
            self.highlights = highlights
        }
    }

    public var from: Date
    public var to: Date
    public var sections: [Section]

    public init(from: Date, to: Date, sections: [Section]) {
        self.from = from
        self.to = to
        self.sections = sections
    }
}

public struct PairingCodeInput: Codable, Hashable, Sendable {
    public var kind: DeviceKind
    /// Agents only.
    public var inboxIds: [String]?

    public init(kind: DeviceKind, inboxIds: [String]? = nil) {
        self.kind = kind
        self.inboxIds = inboxIds
    }
}

public struct PairingCode: Codable, Hashable, Sendable {
    /// Short, typed by a person. Works once.
    public var code: String
    public var expiresAt: Date
}

public struct PairInput: Codable, Hashable, Sendable {
    public var code: String
    /// What the person will see in the device list.
    public var name: String

    public init(code: String, name: String) {
        self.code = code
        self.name = name
    }
}

public struct PairResult: Codable, Hashable, Sendable {
    /// Shown once. Sent afterwards as `Authorization: Bearer <token>`.
    public var token: String
    public var device: Device
}

/// An attachment's bytes as `GET /v1/messages/:id/attachments/:attachmentId` returns them.
public struct AttachmentData: Hashable, Sendable {
    public var data: Data
    public var mimeType: String?
}
