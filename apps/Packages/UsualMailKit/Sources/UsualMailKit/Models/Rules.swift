import Foundation

/// A rule matches a message when every field that is set matches.
public struct RuleMatch: Codable, Hashable, Sendable {
    /// Exact sender address, lower case.
    public var from: String?
    /// Sender's domain, lower case, without "@".
    public var domain: String?
    /// The List-Id header's value.
    public var listId: String?
    /// Case-insensitive.
    public var subjectContains: String?
    /// The address the mail was sent to, for aliases.
    public var to: String?
    /// True matches mail a machine sent.
    public var automated: Bool?

    public init(
        from: String? = nil, domain: String? = nil, listId: String? = nil, subjectContains: String? = nil,
        to: String? = nil, automated: Bool? = nil
    ) {
        self.from = from
        self.domain = domain
        self.listId = listId
        self.subjectContains = subjectContains
        self.to = to
        self.automated = automated
    }
}

public struct Rule: Codable, Hashable, Sendable, Identifiable, Versioned {
    public var id: String
    public var inboxId: String
    /// Plain language, shown as written.
    public var text: String
    public var match: RuleMatch
    /// Applied in order to a matching new thread.
    public var then: [ActionInput]
    public var source: RuleSource
    /// An agent's rule starts off. Only a person turns a rule on.
    public var enabled: Bool
    /// How many threads it has sorted.
    public var hits: Int
    /// Who made it: the person's device (also by answering a teach prompt) or the agent, by name. A rule from before
    /// rules recorded their maker says `system`. A person changing an agent's rule doesn't change it.
    public var createdBy: Doer
    public var createdAt: Date
    /// Rises with every change to the rule, its `hits` included, maybe by more than one. Of two copies, keep the
    /// higher.
    public var version: Int

    public init(
        id: String, inboxId: String, text: String, match: RuleMatch, then: [ActionInput], source: RuleSource,
        enabled: Bool = true, hits: Int = 0, createdBy: Doer, createdAt: Date, version: Int = 1
    ) {
        self.id = id
        self.inboxId = inboxId
        self.text = text
        self.match = match
        self.then = then
        self.source = source
        self.enabled = enabled
        self.hits = hits
        self.createdBy = createdBy
        self.createdAt = createdAt
        self.version = version
    }
}

/// `RuleDraft` in core: the parts of a rule a caller writes.
public struct RuleDraft: Codable, Hashable, Sendable {
    public var inboxId: String
    public var text: String
    public var match: RuleMatch
    public var then: [ActionInput]

    public init(inboxId: String, text: String, match: RuleMatch, then: [ActionInput]) {
        self.inboxId = inboxId
        self.text = text
        self.match = match
        self.then = then
    }
}

/// Asked after a person corrects something.
public struct TeachPrompt: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var question: String
    public var rule: RuleDraft
    public var fromActionId: String
    public var expiresAt: Date

    public init(id: String, question: String, rule: RuleDraft, fromActionId: String, expiresAt: Date) {
        self.id = id
        self.question = question
        self.rule = rule
        self.fromActionId = fromActionId
        self.expiresAt = expiresAt
    }
}

/// A thread whose category nobody has decided and the server's AI won't, with what an agent needs to decide.
public struct TriageItem: Codable, Hashable, Sendable {
    public var thread: MailThread
    /// The newest message, with its text.
    public var latest: Message
}

public struct TriageDecision: Codable, Hashable, Sendable {
    public var threadId: String
    /// Any category but `.uncategorized`: nobody decides that.
    public var category: Category
    /// True when the person need not see it in Home.
    public var done: Bool?
    public var need: Need?
    /// Required: one line a person can read.
    public var reason: String

    public init(threadId: String, category: Category, done: Bool? = nil, need: Need? = nil, reason: String) {
        self.threadId = threadId
        self.category = category
        self.done = done
        self.need = need
        self.reason = reason
    }
}

public struct BriefHighlight: Codable, Hashable, Sendable {
    public var threadId: String
    /// The thread's subject when the brief was written. The server fills it in, so it shows even when this device
    /// doesn't have the thread.
    public var subject: String
    /// One sentence.
    public var line: String

    public init(threadId: String, subject: String, line: String) {
        self.threadId = threadId
        self.subject = subject
        self.line = line
    }
}

public struct BriefSection: Codable, Hashable, Sendable {
    public var inboxId: String
    public var summary: String?
    /// How many threads rules and agents handled in the period, by where they are now: keyed by category (as the
    /// contract spells it, `unknown` included), plus `done` and `trash`. Absent keys are 0. The AI's records, being
    /// silent, never count.
    public var counts: [String: Int]
    public var highlights: [BriefHighlight]

    public init(inboxId: String, summary: String? = nil, counts: [String: Int] = [:], highlights: [BriefHighlight] = [])
    {
        self.inboxId = inboxId
        self.summary = summary
        self.counts = counts
        self.highlights = highlights
    }

    /// Threads handled in the period that are now in `category`.
    public func count(in category: Category) -> Int {
        counts[category.rawValue] ?? 0
    }

    /// Threads handled in the period that are now done.
    public var doneCount: Int { counts["done"] ?? 0 }

    /// Threads handled in the period that are now in the trash, counted only there.
    public var trashCount: Int { counts["trash"] ?? 0 }
}

/// A readable account of what happened across inboxes between two times.
public struct Brief: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var createdAt: Date
    public var from: Date
    public var to: Date
    public var sections: [BriefSection]
    public var writtenBy: Doer
}
