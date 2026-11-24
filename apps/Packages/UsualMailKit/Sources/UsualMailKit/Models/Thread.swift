import Foundation

/// Something the server counts changes of: an inbox, a thread, an action record, a draft, a rule, the counts, or the
/// AI's settings or status. Of two copies of the same thing, the higher `version` is the newer; it may rise by more
/// than one (docs/contract.md, "Words").
public protocol Versioned: Sendable {
    var version: Int { get }
}

/// A conversation. Called `Thread` in core; `MailThread` here because Foundation already has a `Thread`.
public struct MailThread: Codable, Hashable, Sendable, Identifiable, Versioned {
    public var id: String
    public var inboxId: String
    public var subject: String
    /// A short plain-text preview of the latest message. Shown while there is no `summary`.
    public var snippet: String
    public var participants: [Address]
    public var lastMessageAt: Date
    public var messageCount: Int
    public var unread: Bool
    public var hasAttachments: Bool
    /// What kind of mail it is. Exactly one; `.uncategorized` until someone decides.
    public var category: Category
    /// Who decided the category, or proposed one. Nil while nobody has.
    public var categorizedBy: CategorySource?
    /// Who decided the category, by name, so "why it's here" can say so: the AI with its model, the rule, the agent
    /// with its name, or the person's device. Nil while `categorizedBy` is nil or `mailbox`, and for a decision an
    /// older server made.
    public var categorizedByActor: Doer?
    /// The address screening, letting in and blocking are about: the sender of the thread's oldest message someone
    /// else sent, lower case. Nil for a thread of only the mailbox's own mail.
    public var sender: String?
    /// True while its sender hasn't been let in, whatever its category. A screened thread is in no list but the
    /// screening list and search.
    public var screened: Bool
    /// Done threads are in no list but search.
    public var done: Bool
    /// A thread on a stack is never done.
    public var stack: Stack?
    /// Hidden from Home until this time. It stays set after it passes, as the time the thread came back, and the thread
    /// then sorts by it.
    public var comeBackAt: Date?
    /// With `comeBackAt`: come back only if nobody has answered by then.
    public var comeBackIfNoReply: Bool?
    /// In the provider's trash. A trashed thread is in no list of threads, though Handled still carries it with its
    /// records. Only undoing the trash acts on it.
    public var trashed: Bool
    /// Rises with every change to the thread, maybe by more than one.
    public var version: Int
    public var need: Need?
    /// One line on why it is where it is, for example a rule's text or an agent's reason.
    public var reason: String?
    /// What the thread is about, in one or two plain lines without the sender's name, written by the server's AI.
    /// Plain text, never HTML. Nil until written, and never for a one-time code or an inbox whose AI processing is
    /// off: show the snippet then. On a receipt or an invoice it is `payment.what`, and absent without one.
    public var summary: String?
    /// For a receipt or an invoice once the server's AI has read it: who, how much, what for. Nil for every other
    /// category and until processed; it goes when the thread leaves those categories.
    public var payment: Payment?
    /// For a notification once the server's AI has read it: what happened, about what, and when. Nil for every other
    /// category and until processed; it goes when the thread leaves `notification`. `summary` stays a normal summary
    /// beside it. Encoded only when present.
    public var event: NotificationEvent?
    /// The picture to show for `sender` instead of initials (docs/contract-avatars.md): an organisation's own site
    /// icon, once its From domain is proved and the sender is let in. Nil means initials; never on a screened thread or
    /// a blocked sender. Its appearing, changing or going raises the thread's version, and so does a change to one of
    /// its messages' pictures. Encoded only when present.
    public var avatar: SenderPicture?

    public init(
        id: String, inboxId: String, subject: String, snippet: String = "", participants: [Address] = [],
        lastMessageAt: Date, messageCount: Int = 1, unread: Bool = false, hasAttachments: Bool = false,
        category: Category = .uncategorized, categorizedBy: CategorySource? = nil, categorizedByActor: Doer? = nil,
        sender: String? = nil, screened: Bool = false,
        done: Bool = false, stack: Stack? = nil, comeBackAt: Date? = nil, comeBackIfNoReply: Bool? = nil,
        trashed: Bool = false, version: Int = 1, need: Need? = nil, reason: String? = nil, summary: String? = nil,
        payment: Payment? = nil, event: NotificationEvent? = nil, avatar: SenderPicture? = nil
    ) {
        self.id = id
        self.inboxId = inboxId
        self.subject = subject
        self.snippet = snippet
        self.participants = participants
        self.lastMessageAt = lastMessageAt
        self.messageCount = messageCount
        self.unread = unread
        self.hasAttachments = hasAttachments
        self.category = category
        self.categorizedBy = categorizedBy
        self.categorizedByActor = categorizedByActor
        self.sender = sender
        self.screened = screened
        self.done = done
        self.stack = stack
        self.comeBackAt = comeBackAt
        self.comeBackIfNoReply = comeBackIfNoReply
        self.trashed = trashed
        self.version = version
        self.need = need
        self.reason = reason
        self.summary = summary
        self.payment = payment
        self.event = event
        self.avatar = avatar
    }

    /// True while the thread waits to come back at `now`.
    public func isWaiting(at now: Date) -> Bool {
        guard let comeBackAt else { return false }
        return comeBackAt > now
    }
}

public struct AttachmentMeta: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var filename: String
    public var mimeType: String
    /// Bytes.
    public var size: Int
    /// True for pictures shown inside the message body.
    public var inline: Bool
    /// For an inline picture: the Content-ID its HTML refers to (as `cid:`), without angle brackets.
    public var contentId: String?

    public init(id: String, filename: String, mimeType: String, size: Int, inline: Bool, contentId: String? = nil) {
        self.id = id
        self.filename = filename
        self.mimeType = mimeType
        self.size = size
        self.inline = inline
        self.contentId = contentId
    }
}

public struct Message: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var threadId: String
    public var inboxId: String
    public var from: Address
    public var to: [Address]
    public var cc: [Address]
    public var bcc: [Address]
    public var date: Date
    public var subject: String
    public var text: String?
    /// Sanitized HTML: no scripts or forms, and nothing loaded from the web by itself. Each picture from the web it
    /// shows points at the server's picture route (`/v1/messages/<message id>/pictures/<picture id>`, relative to the
    /// server), which the app loads with its token; trackers are taken out and held-back pictures lose their address.
    /// Nil when nothing is left (a message of only trackers) or it was too long to show (`htmlTooLarge`): show `text`
    /// then.
    public var html: String?
    public var attachments: [AttachmentMeta]
    public var unread: Bool
    /// True when the inbox's own address sent it.
    public var outgoing: Bool
    /// The mailing list's id from the List-Id header, lower case. Rules match on it.
    public var listId: String?
    /// What the server did with the pictures its HTML takes from the web. Nil when it takes none, and from a server
    /// older than pictures through the server.
    public var remotePictures: RemotePictures?
    /// True when its HTML was longer than the server shows (1,000,000 characters): `html` is left out, and `text` is
    /// the message. Absent means false, and only true is written.
    public var htmlTooLarge: Bool {
        get { tooLarge == true }
        set { tooLarge = newValue ? true : nil }
    }
    private var tooLarge: Bool?
    /// The picture to show for `from` instead of initials, by `MailThread.avatar`'s rules applied to this message's own
    /// From. Nil means initials; never on the inbox's own mail. It comes with the thread's detail. Encoded only when
    /// present.
    public var avatar: SenderPicture?

    enum CodingKeys: String, CodingKey {
        case id, threadId, inboxId, from, to, cc, bcc, date, subject, text, html, attachments, unread, outgoing, listId
        case remotePictures, avatar
        case tooLarge = "htmlTooLarge"
    }

    public init(
        id: String, threadId: String, inboxId: String, from: Address, to: [Address] = [], cc: [Address] = [],
        bcc: [Address] = [], date: Date, subject: String, text: String? = nil, html: String? = nil,
        attachments: [AttachmentMeta] = [], unread: Bool = false, outgoing: Bool = false, listId: String? = nil,
        remotePictures: RemotePictures? = nil, htmlTooLarge: Bool = false, avatar: SenderPicture? = nil
    ) {
        self.id = id
        self.threadId = threadId
        self.inboxId = inboxId
        self.from = from
        self.to = to
        self.cc = cc
        self.bcc = bcc
        self.date = date
        self.subject = subject
        self.text = text
        self.html = html
        self.attachments = attachments
        self.unread = unread
        self.outgoing = outgoing
        self.listId = listId
        self.remotePictures = remotePictures
        self.tooLarge = htmlTooLarge ? true : nil
        self.avatar = avatar
    }

    /// The message as plain text: its text part, or its HTML with the tags taken out.
    public var plainText: String {
        if let text, !text.isEmpty { return text }
        guard let html else { return "" }
        return PlainText.fromHTML(html)
    }
}

/// A message being written. The drafts list holds `draft` and `failed` ones. A `sent` draft that carries a `note` is
/// kept for a day in its thread's drafts, so the note can be shown; one without a note isn't kept, and
/// `draft.removed` follows its `draft.changed`. An agent may change or delete only a draft an agent wrote; a person,
/// any.
public struct Draft: Codable, Hashable, Sendable, Identifiable, Versioned {
    public var id: String
    public var inboxId: String
    /// Set for a reply.
    public var threadId: String?
    public var inReplyToMessageId: String?
    public var to: [Address]
    public var cc: [Address]
    public var bcc: [Address]
    public var subject: String
    /// Plain text.
    public var body: String
    public var createdBy: Doer
    public var state: DraftState
    public var updatedAt: Date
    /// Why sending failed.
    public var error: String?
    /// Something a person should know about a send that worked, for example that no copy was saved to Sent.
    public var note: String?
    /// Rises with every change to the draft, maybe by more than one.
    public var version: Int

    public init(
        id: String, inboxId: String, threadId: String? = nil, inReplyToMessageId: String? = nil,
        to: [Address] = [], cc: [Address] = [], bcc: [Address] = [], subject: String, body: String,
        createdBy: Doer, state: DraftState = .draft, updatedAt: Date, error: String? = nil, note: String? = nil,
        version: Int = 1
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
        self.createdBy = createdBy
        self.state = state
        self.updatedAt = updatedAt
        self.error = error
        self.note = note
        self.version = version
    }

    /// Whether the server keeps it at all: every draft but a sent one without a note.
    public var isKept: Bool { state != .sent || note != nil }

    /// How long a sent draft with a note is kept after it was sent (its `updatedAt`): a day.
    public static let sentNoteKept: TimeInterval = 86_400
}

public struct ThreadDetail: Codable, Hashable, Sendable {
    public var thread: MailThread
    /// Oldest first.
    public var messages: [Message]
    /// The thread's drafts in state `draft`, `sending` or `failed`, and sent ones with a note for a day. Oldest
    /// first.
    public var drafts: [Draft]

    public init(thread: MailThread, messages: [Message], drafts: [Draft]) {
        self.thread = thread
        self.messages = messages
        self.drafts = drafts
    }
}

/// Turns sanitized HTML into readable text, for messages that have no text part.
enum PlainText {
    static func fromHTML(_ html: String) -> String {
        var text = html
        // Block ends become line breaks before the tags go.
        for pattern in ["<br\\s*/?>", "</p>", "</div>", "</h[1-6]>", "</li>", "</tr>"] {
            text = text.replacingOccurrences(
                of: pattern, with: "\n", options: [.regularExpression, .caseInsensitive])
        }
        for pattern in ["<(style|script)[^>]*>[\\s\\S]*?</\\1>", "<[^>]+>"] {
            text = text.replacingOccurrences(of: pattern, with: "", options: [.regularExpression, .caseInsensitive])
        }
        let entities = ["&nbsp;": " ", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'", "&apos;": "'"]
        for (entity, character) in entities {
            text = text.replacingOccurrences(of: entity, with: character)
        }
        text = text.replacingOccurrences(of: "&amp;", with: "&")
        text = text.replacingOccurrences(of: "\n{3,}", with: "\n\n", options: .regularExpression)
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
