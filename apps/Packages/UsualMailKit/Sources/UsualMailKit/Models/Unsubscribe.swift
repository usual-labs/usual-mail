import Foundation

// Mirrors of `core/src/unsubscribe.ts` (docs/contract.md, "Unsubscribing"; the owner's request of 2026-11-27): a person
// asks the server to have a sender stop, the cheapest way the sender's mail offers (its one-click address, else an email
// to the address its List-Unsubscribe header names, else its unsubscribe page, opened by a browser agent when the person
// set one up, or handed to the person). The apps block the sender too (`block_sender`), so their mail stays out of
// sight whatever the sender does.

/// How the server asked (`UnsubscribeWay` in core).
public enum UnsubscribeWay: OpenEnum {
    /// A POST to the sender's one-click address (RFC 8058).
    case oneClick
    /// A message from the inbox to the address the header names.
    case email
    /// The unsubscribe page, opened by the person's browser agent.
    case browserAgent
    /// The unsubscribe page, for the person to open.
    case page
    case unknown(String)

    public static let known: [UnsubscribeWay] = [.oneClick, .email, .browserAgent, .page]

    public var rawValue: String {
        switch self {
        case .oneClick: "one_click"
        case .email: "email"
        case .browserAgent: "browser_agent"
        case .page: "page"
        case .unknown(let raw): raw
        }
    }
}

/// Where unsubscribing stands (`UnsubscribeState` in core).
public enum UnsubscribeState: OpenEnum {
    /// The server is asking; a browser agent can take a few minutes.
    case working
    /// The one-click address or the page said yes, or the email went out.
    case done
    /// What is left is a page the person opens (`Unsubscribe.page`).
    case needsPerson
    /// The mail offers no way, or none worked; `detail` says which.
    case failed
    case unknown(String)

    public static let known: [UnsubscribeState] = [.working, .done, .needsPerson, .failed]

    public var rawValue: String {
        switch self {
        case .working: "working"
        case .done: "done"
        case .needsPerson: "needs_person"
        case .failed: "failed"
        case .unknown(let raw): raw
        }
    }
}

/// One sender's unsubscribing in one inbox, the newest asked (`Unsubscribe` in core): the answer to
/// `POST /v1/threads/:id/unsubscribe`, an `unsubscribe.changed` event's, and a blocked sender's
/// (`BlockedSender.unsubscribe`). A person's device only.
public struct Unsubscribe: Codable, Hashable, Sendable, Versioned {
    public var inboxId: String
    /// The sender, lower case: the thread's `sender` when it was asked.
    public var address: String
    /// The thread it was asked from.
    public var threadId: String
    public var state: UnsubscribeState
    /// How it was asked, or is being asked. Nil while nothing has been tried, and when the mail offered no way.
    public var way: UnsubscribeWay?
    /// With `needsPerson`: the sender's unsubscribe page, as the server sent it. It comes from the sender's mail, so it
    /// is kept as text and opened only through `page`, and only when the person asks.
    public var url: String?
    /// What happened, in the server's words, shown as they are. Never a key, never the page's own words.
    public var detail: String?
    public var askedAt: Date
    public var updatedAt: Date
    /// Rises with every change, maybe by more than one. Of two copies, keep the higher.
    public var version: Int

    public init(
        inboxId: String, address: String, threadId: String, state: UnsubscribeState, way: UnsubscribeWay? = nil,
        url: String? = nil, detail: String? = nil, askedAt: Date, updatedAt: Date, version: Int = 1
    ) {
        self.inboxId = inboxId
        self.address = address
        self.threadId = threadId
        self.state = state
        self.way = way
        self.url = url
        self.detail = detail
        self.askedAt = askedAt
        self.updatedAt = updatedAt
        self.version = version
    }

    /// The sender it is about, as a blocked sender's row is keyed.
    public var key: SenderKey { SenderKey(inboxId: inboxId, address: address) }

    /// The page to open for `needsPerson`: `url` when it is an https address with a host, else nil, so nothing else
    /// the sender's mail named is ever opened.
    public var page: URL? {
        guard let url, let parsed = URL(string: url), parsed.scheme?.lowercased() == "https",
            parsed.host?.isEmpty == false
        else { return nil }
        return parsed
    }
}

/// A service that runs a browser agent for the server (`BrowserAgentService` in core).
public enum BrowserAgentService: OpenEnum {
    /// Browser Use (browser-use.com).
    case browserUse
    case unknown(String)

    public static let known: [BrowserAgentService] = [.browserUse]

    public var rawValue: String {
        switch self {
        case .browserUse: "browser_use"
        case .unknown(let raw): raw
        }
    }
}

/// Whether the browser agent's key works (`BrowserAgentState` in core).
public enum BrowserAgentState: OpenEnum {
    /// Its last request was answered.
    case working
    /// The service refused the key.
    case keyRefused
    /// The account has no credit or reached its limit.
    case outOfCredit
    /// The service couldn't be reached or failed, which usually passes by itself.
    case unavailable
    case unknown(String)

    public static let known: [BrowserAgentState] = [.working, .keyRefused, .outOfCredit, .unavailable]

    public var rawValue: String {
        switch self {
        case .working: "working"
        case .keyRefused: "key_refused"
        case .outOfCredit: "out_of_credit"
        case .unavailable: "unavailable"
        case .unknown(let raw): raw
        }
    }
}

/// The browser agent as the person set it up (`AiSettings.browserAgent`, `BrowserAgentSettings` in core), without the
/// key.
public struct BrowserAgentSettings: Codable, Hashable, Sendable {
    public var service: BrowserAgentService
    public var state: BrowserAgentState
    /// Why the state isn't `working`, in words a person can act on. Never the key or any part of it.
    public var detail: String?

    public init(service: BrowserAgentService, state: BrowserAgentState, detail: String? = nil) {
        self.service = service
        self.state = state
        self.detail = detail
    }
}

/// What a person gives to set the browser agent up (`BrowserAgentCredentials` in core). Sent once, in a request body;
/// never stored on the device, never logged.
public struct BrowserAgentCredentials: Encodable, Hashable, Sendable {
    public var service: BrowserAgentService
    public var apiKey: String

    public init(service: BrowserAgentService = .browserUse, apiKey: String) {
        self.service = service
        self.apiKey = apiKey
    }
}

/// What saving a browser agent's key means, to show before the key is sent, as the AI's disclosure is shown before its
/// key (core's `BROWSER_AGENT_DISCLOSURE`, copied word for word; `BrowserAgentDisclosureTests` checks it against
/// core/src/unsubscribe.ts). Saving the key is the person's yes to it.
public enum BrowserAgentDisclosure {
    public static let title = "What Browser Use is sent"
    public static let lines = [
        "Only when you unsubscribe from a sender whose mail offers nothing but an unsubscribe page, and only that once.",
        "The page's address, which the sender made and which may identify you, this inbox's address, in case the page asks for it, and a random number that marks the request.",
        "Browser Use opens the page in its own browser, with no sign-ins, and its AI presses the page's unsubscribe controls. Nothing else from your mail is sent.",
        "Each unsubscribe uses some of your Browser Use credit: at most US$0.10 of its AI, and a few minutes of its browser.",
    ]
}
