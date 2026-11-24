import Foundation

// Mirrors of `core/src/google-client.ts` and `core/src/google-setup.ts`: the host's Google client as a person's device
// sees it, the guided set-up the server serves (`GET /v1/google/setup`), and what the server answers once a device gave
// it the client (`PUT /v1/google/client`). The secret never comes back; the file goes to the server as it is.

/// Where the server's Google client comes from. `environment`: the host's settings where the server starts, which win;
/// `saved`: the client the host or a person's device saved; `none`: no client the server can use.
public enum GoogleClientSource: OpenEnum {
    case environment, saved, none
    case unknown(String)

    public static let known: [GoogleClientSource] = [.environment, .saved, .none]

    public var rawValue: String {
        switch self {
        case .environment: "environment"
        case .saved: "saved"
        case .none: "none"
        case .unknown(let raw): raw
        }
    }
}

/// The server's Google client, never its secret.
public struct GoogleClientState: Codable, Hashable, Sendable {
    public var source: GoogleClientSource
    /// The client's id, as an inbox's connection shows it. Absent while there is none.
    public var clientId: String?
    /// True when a person's device may give the server a client now.
    public var changeable: Bool
    /// While `changeable` is false: why, in the server's words.
    public var reason: String?
    /// What to know before giving a client, in the server's words: a saved client file it doesn't use, or inboxes
    /// connected under a client it doesn't have now (so giving one asks before replacing). Absent from older servers.
    public var note: String?

    public init(
        source: GoogleClientSource, clientId: String? = nil, changeable: Bool, reason: String? = nil,
        note: String? = nil
    ) {
        self.source = source
        self.clientId = clientId
        self.changeable = changeable
        self.reason = reason
        self.note = note
    }
}

/// One of the steps at Google Cloud's console, by what it is for.
public enum GoogleSetupStepId: OpenEnum {
    case project, gmailApi, branding, audience, scope, client, download
    case unknown(String)

    public static let known: [GoogleSetupStepId] = [
        .project, .gmailApi, .branding, .audience, .scope, .client, .download,
    ]

    public var rawValue: String {
        switch self {
        case .project: "project"
        case .gmailApi: "gmail_api"
        case .branding: "branding"
        case .audience: "audience"
        case .scope: "scope"
        case .client: "client"
        case .download: "download"
        case .unknown(let raw): raw
        }
    }
}

/// A value to copy into a console page, with what it is ("Project name", "Authorized redirect URI").
public struct GoogleSetupValue: Codable, Hashable, Sendable {
    public var label: String
    public var value: String

    public init(label: String, value: String) {
        self.label = label
        self.value = value
    }
}

/// One step at Google Cloud's console: what to do, the page to open, and values to copy there.
public struct GoogleSetupStep: Codable, Hashable, Sendable {
    public var id: GoogleSetupStepId
    public var title: String
    /// One or two sentences, each its own line.
    public var lines: [String]
    /// The console page to open.
    public var url: String
    public var copy: [GoogleSetupValue]?

    public init(
        id: GoogleSetupStepId, title: String, lines: [String], url: String, copy: [GoogleSetupValue]? = nil
    ) {
        self.id = id
        self.title = title
        self.lines = lines
        self.url = url
        self.copy = copy
    }
}

/// The guided set-up of the server's Google client (`GET /v1/google/setup`, person only).
public struct GoogleSetup: Codable, Hashable, Sendable {
    /// Google sign-in as `GET /v1/info` says it.
    public var googleSignIn: GoogleSignInInfo
    public var client: GoogleClientState
    /// The prompt for the host's own browser agent, the server's redirect address filled in. Absent without an address.
    public var prompt: String?
    /// What to do with the prompt, in one paragraph.
    public var promptNote: String?
    /// The same set-up by hand. Absent without an address.
    public var steps: [GoogleSetupStep]?
    /// While the server doesn't know its own address: why, and what its host does. No app can fix it.
    public var noAddress: String?

    public init(
        googleSignIn: GoogleSignInInfo, client: GoogleClientState, prompt: String? = nil, promptNote: String? = nil,
        steps: [GoogleSetupStep]? = nil, noAddress: String? = nil
    ) {
        self.googleSignIn = googleSignIn
        self.client = client
        self.prompt = prompt
        self.promptNote = promptNote
        self.steps = steps
        self.noAddress = noAddress
    }
}

/// What the server answers once it saved the client a device gave (`PUT /v1/google/client`). Never the secret.
public struct GoogleClientSaved: Codable, Hashable, Sendable {
    public var clientId: String
    /// True when it replaced a client the server had.
    public var replaced: Bool
    /// Google sign-in after the change, as `GET /v1/info` says it.
    public var googleSignIn: GoogleSignInInfo
    /// When the file lists redirect addresses but not the server's: a hint, in the server's words.
    public var redirectHint: String?

    public init(clientId: String, replaced: Bool, googleSignIn: GoogleSignInInfo, redirectHint: String? = nil) {
        self.clientId = clientId
        self.replaced = replaced
        self.googleSignIn = googleSignIn
        self.redirectHint = redirectHint
    }
}
