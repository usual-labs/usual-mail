import Foundation

/// What the server tells connected apps as things change (`core/src/events.ts`).
public enum MailEvent: Codable, Hashable, Sendable {
    case inboxChanged(Inbox)
    case inboxRemoved(inboxId: String)
    case threadChanged(MailThread)
    case threadRemoved(threadId: String, inboxId: String)
    case actionRecorded(ActionRecord)
    case draftChanged(Draft)
    case draftRemoved(draftId: String, inboxId: String)
    /// A rule was made, changed, turned on or off, or sorted new mail (`hits`): at most one per rule for a batch of
    /// new mail.
    case ruleChanged(Rule)
    case ruleRemoved(ruleId: String, inboxId: String)
    /// How many threads now wait in an inbox's triage queue. It changes when the AI's state does.
    case triagePending(inboxId: String, count: Int)
    /// The counts changed: the latest, at most once a second, for the inboxes this device may see.
    case countsChanged(Counts)
    /// The AI's status changed: the latest, at most once a second.
    case aiStatusChanged(AiStatus)
    /// The AI's settings changed. Sent to people's devices only; never carries the key.
    case aiSettingsChanged(AiSettings)
    case briefReady(briefId: String)
    /// A sender became blocked or stopped being blocked, or mail from a blocked sender arrived. People's devices only.
    case senderChanged(SenderChange)
    /// Unsubscribing from a sender began or moved on (docs/contract.md, "Unsubscribing"). People's devices only.
    case unsubscribeChanged(Unsubscribe)
    /// A type a newer server sends. The app ignores it.
    case unknown(type: String)

    private enum Key: String, CodingKey {
        case type, inbox, inboxId, thread, threadId, record, draft, draftId, rule, ruleId, count, counts, status
        case settings, briefId, address, blocked, sender, unsubscribe
    }

    /// The `type` in the JSON, which is also the SSE `event:` name.
    public var type: String {
        switch self {
        case .inboxChanged: "inbox.changed"
        case .inboxRemoved: "inbox.removed"
        case .threadChanged: "thread.changed"
        case .threadRemoved: "thread.removed"
        case .actionRecorded: "action.recorded"
        case .draftChanged: "draft.changed"
        case .draftRemoved: "draft.removed"
        case .ruleChanged: "rule.changed"
        case .ruleRemoved: "rule.removed"
        case .triagePending: "triage.pending"
        case .countsChanged: "counts.changed"
        case .aiStatusChanged: "ai.status.changed"
        case .aiSettingsChanged: "ai.settings.changed"
        case .briefReady: "brief.ready"
        case .senderChanged: "sender.changed"
        case .unsubscribeChanged: "unsubscribe.changed"
        case .unknown(let type): type
        }
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "inbox.changed": self = .inboxChanged(try c.decode(Inbox.self, forKey: .inbox))
        case "inbox.removed": self = .inboxRemoved(inboxId: try c.decode(String.self, forKey: .inboxId))
        case "thread.changed": self = .threadChanged(try c.decode(MailThread.self, forKey: .thread))
        case "thread.removed":
            self = .threadRemoved(
                threadId: try c.decode(String.self, forKey: .threadId),
                inboxId: try c.decode(String.self, forKey: .inboxId))
        case "action.recorded": self = .actionRecorded(try c.decode(ActionRecord.self, forKey: .record))
        case "draft.changed": self = .draftChanged(try c.decode(Draft.self, forKey: .draft))
        case "draft.removed":
            self = .draftRemoved(
                draftId: try c.decode(String.self, forKey: .draftId),
                inboxId: try c.decode(String.self, forKey: .inboxId))
        case "rule.changed": self = .ruleChanged(try c.decode(Rule.self, forKey: .rule))
        case "rule.removed":
            self = .ruleRemoved(
                ruleId: try c.decode(String.self, forKey: .ruleId),
                inboxId: try c.decode(String.self, forKey: .inboxId))
        case "triage.pending":
            self = .triagePending(
                inboxId: try c.decode(String.self, forKey: .inboxId), count: try c.decode(Int.self, forKey: .count))
        case "counts.changed": self = .countsChanged(try c.decode(Counts.self, forKey: .counts))
        case "ai.status.changed": self = .aiStatusChanged(try c.decode(AiStatus.self, forKey: .status))
        case "ai.settings.changed": self = .aiSettingsChanged(try c.decode(AiSettings.self, forKey: .settings))
        case "brief.ready": self = .briefReady(briefId: try c.decode(String.self, forKey: .briefId))
        case "sender.changed":
            self = .senderChanged(
                SenderChange(
                    inboxId: try c.decode(String.self, forKey: .inboxId),
                    address: try c.decode(String.self, forKey: .address),
                    blocked: try c.decode(Bool.self, forKey: .blocked),
                    sender: try c.decodeIfPresent(BlockedSender.self, forKey: .sender)))
        case "unsubscribe.changed":
            self = .unsubscribeChanged(try c.decode(Unsubscribe.self, forKey: .unsubscribe))
        default: self = .unknown(type: type)
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: Key.self)
        try c.encode(type, forKey: .type)
        switch self {
        case .inboxChanged(let inbox): try c.encode(inbox, forKey: .inbox)
        case .inboxRemoved(let inboxId): try c.encode(inboxId, forKey: .inboxId)
        case .threadChanged(let thread): try c.encode(thread, forKey: .thread)
        case .threadRemoved(let threadId, let inboxId):
            try c.encode(threadId, forKey: .threadId)
            try c.encode(inboxId, forKey: .inboxId)
        case .actionRecorded(let record): try c.encode(record, forKey: .record)
        case .draftChanged(let draft): try c.encode(draft, forKey: .draft)
        case .draftRemoved(let draftId, let inboxId):
            try c.encode(draftId, forKey: .draftId)
            try c.encode(inboxId, forKey: .inboxId)
        case .ruleChanged(let rule): try c.encode(rule, forKey: .rule)
        case .ruleRemoved(let ruleId, let inboxId):
            try c.encode(ruleId, forKey: .ruleId)
            try c.encode(inboxId, forKey: .inboxId)
        case .triagePending(let inboxId, let count):
            try c.encode(inboxId, forKey: .inboxId)
            try c.encode(count, forKey: .count)
        case .countsChanged(let counts): try c.encode(counts, forKey: .counts)
        case .aiStatusChanged(let status): try c.encode(status, forKey: .status)
        case .aiSettingsChanged(let settings): try c.encode(settings, forKey: .settings)
        case .briefReady(let briefId): try c.encode(briefId, forKey: .briefId)
        case .senderChanged(let change):
            try c.encode(change.inboxId, forKey: .inboxId)
            try c.encode(change.address, forKey: .address)
            try c.encode(change.blocked, forKey: .blocked)
            try c.encodeIfPresent(change.sender, forKey: .sender)
        case .unsubscribeChanged(let unsubscribe): try c.encode(unsubscribe, forKey: .unsubscribe)
        case .unknown: break
        }
    }
}
