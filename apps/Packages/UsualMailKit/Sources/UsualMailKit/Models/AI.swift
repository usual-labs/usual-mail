import Foundation

// Mirrors of `core/src/ai.ts`: the server's own AI, its settings and its status. What the AI may do and what leaves
// the server are in docs/contract-ai.md. The apps only show what the AI did; the key never reaches a device.

/// A job the server's AI does, each with its own model.
public enum AiJob: OpenEnum, CodingKeyRepresentable {
    /// Sets a thread's category.
    case categorize
    /// Writes a thread's summary.
    case summarize
    case unknown(String)

    public static let known: [AiJob] = [.categorize, .summarize]

    public var rawValue: String {
        switch self {
        case .categorize: "categorize"
        case .summarize: "summarize"
        case .unknown(let raw): raw
        }
    }
}

/// A service whose one key reaches several providers' models. Model ids are `provider/model`.
public enum AiGateway: OpenEnum {
    case vercel
    case unknown(String)

    public static let known: [AiGateway] = [.vercel]

    public var rawValue: String {
        switch self {
        case .vercel: "vercel"
        case .unknown(let raw): raw
        }
    }
}

/// A provider whose own key reaches only its own models. Model ids are the provider's own.
public enum AiProvider: OpenEnum {
    case openai, anthropic
    case unknown(String)

    public static let known: [AiProvider] = [.openai, .anthropic]

    public var rawValue: String {
        switch self {
        case .openai: "openai"
        case .anthropic: "anthropic"
        case .unknown(let raw): raw
        }
    }
}

/// Whether the AI works (`AiState` in core).
public enum AiState: OpenEnum {
    /// No credentials.
    case notSetUp
    /// The person paused it.
    case paused
    /// Its last request was answered.
    case working
    /// The service refused the key.
    case keyRefused
    /// The service doesn't know a job's model (`AiStatus.job` says which).
    case modelNotFound
    /// The account has no credit or reached its limit.
    case outOfCredit
    /// The service couldn't be reached or failed for a while, which usually passes by itself.
    case unavailable
    case unknown(String)

    public static let known: [AiState] = [
        .notSetUp, .paused, .working, .keyRefused, .modelNotFound, .outOfCredit, .unavailable,
    ]

    public var rawValue: String {
        switch self {
        case .notSetUp: "not_set_up"
        case .paused: "paused"
        case .working: "working"
        case .keyRefused: "key_refused"
        case .modelNotFound: "model_not_found"
        case .outOfCredit: "out_of_credit"
        case .unavailable: "unavailable"
        case .unknown(let raw): raw
        }
    }

    /// The states that are part of "what needs you" (docs/contract.md, "Lists"): the person has to fix the account.
    public var needsAPerson: Bool {
        self == .keyRefused || self == .modelNotFound || self == .outOfCredit
    }
}

/// How the server reaches models, without anything secret (`AiConnection` in core). A kind a newer server sends is
/// kept whole, as `InboxConnection` keeps one.
public enum AiConnection: Codable, Hashable, Sendable {
    /// A gateway's key, which reaches several providers' models.
    case gateway(AiGateway)
    /// A provider's own key.
    case direct(AiProvider)
    case unknown(kind: String, payload: JSONValue)

    private enum Key: String, CodingKey {
        case kind, gateway, provider
    }

    public var kind: String {
        switch self {
        case .gateway: "gateway"
        case .direct: "direct"
        case .unknown(let kind, _): kind
        }
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: Key.self)
        let kind = try container.decode(String.self, forKey: .kind)
        switch kind {
        case "gateway": self = .gateway(try container.decode(AiGateway.self, forKey: .gateway))
        case "direct": self = .direct(try container.decode(AiProvider.self, forKey: .provider))
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
        case .gateway(let gateway): try container.encode(gateway, forKey: .gateway)
        case .direct(let provider): try container.encode(provider, forKey: .provider)
        case .unknown: break
        }
    }
}

/// What a person gives to set the AI up: the connection plus the key (`AiCredentials` in core). Sent once, in a
/// request body; never stored on the device, never logged.
public struct AiCredentials: Encodable, Hashable, Sendable {
    public var connection: AiConnection
    public var apiKey: String

    public init(_ connection: AiConnection, apiKey: String) {
        self.connection = connection
        self.apiKey = apiKey
    }

    private enum Key: String, CodingKey {
        case apiKey
    }

    public func encode(to encoder: any Encoder) throws {
        try connection.encode(to: encoder)
        var container = encoder.container(keyedBy: Key.self)
        try container.encode(apiKey, forKey: .apiKey)
    }
}

/// One job's model.
public struct AiJobSetting: Codable, Hashable, Sendable {
    public var job: AiJob
    /// The model the person chose, as the service names it, or nil for the server's default. Sent as `null`.
    public var model: String?
    /// The model the server uses when `model` is nil, for the current connection. Empty while no connection is set.
    public var defaultModel: String

    public init(job: AiJob, model: String? = nil, defaultModel: String) {
        self.job = job
        self.model = model
        self.defaultModel = defaultModel
    }

    /// The model the job runs on: the chosen one, or the server's default.
    public var effectiveModel: String { model ?? defaultModel }

    private enum Key: String, CodingKey {
        case job, model, defaultModel
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: Key.self)
        try container.encode(job, forKey: .job)
        try container.encode(model, forKey: .model)  // `null` for the default, as core writes it
        try container.encode(defaultModel, forKey: .defaultModel)
    }
}

/// The server's AI as the person set it up (`AiSettings` in core). Only a person's device gets it; it never carries
/// the key, only whether credentials are set. There is no history setting (removed 2026-11-18): the AI works through
/// all synced mail that isn't done, and the first sync's window (`FirstSyncWindow`) decides how far back that goes.
public struct AiSettings: Codable, Hashable, Sendable, Versioned {
    /// How models are reached. Absent until a person sets credentials.
    public var connection: AiConnection?
    /// Whether credentials are stored on the server.
    public var credentialsSet: Bool
    /// One per job, in the order of `AiJob.known`.
    public var jobs: [AiJobSetting]
    /// True while the person paused the AI: nothing is sent to the service, for any inbox.
    public var paused: Bool
    /// The browser agent that opens a sender's unsubscribe page when nothing cheaper works (docs/contract.md,
    /// "Unsubscribing"), without its key; nil while none is set up. Apart from the AI's key: pausing the AI doesn't
    /// stop it, and it never reads mail.
    public var browserAgent: BrowserAgentSettings?
    /// Rises with every change, maybe by more than one. Of two copies, keep the higher.
    public var version: Int

    public init(
        connection: AiConnection? = nil, credentialsSet: Bool = false, jobs: [AiJobSetting] = [],
        paused: Bool = false, browserAgent: BrowserAgentSettings? = nil, version: Int = 1
    ) {
        self.connection = connection
        self.credentialsSet = credentialsSet
        self.jobs = jobs
        self.paused = paused
        self.browserAgent = browserAgent
        self.version = version
    }

    /// The setting for one job, if the server lists it.
    public func job(_ job: AiJob) -> AiJobSetting? {
        jobs.first { $0.job == job }
    }
}

/// A change to the AI's settings (`AiSettingsPatch` in core). Person only. Fields left nil are not sent.
public struct AiSettingsPatch: Encodable, Hashable, Sendable {
    /// New credentials, or their removal.
    public enum CredentialsChange: Hashable, Sendable {
        /// Replaces the stored ones whole. The server stores them, then tests them at once.
        case set(AiCredentials)
        /// Sent as `null`: removes them, which turns AI processing off for every inbox.
        case remove
    }

    /// A browser agent's key, or its removal (docs/contract.md, "Unsubscribing").
    public enum BrowserAgentChange: Hashable, Sendable {
        /// Replaces a stored key whole. Saving it is the person's yes to `BrowserAgentDisclosure`, shown first; the
        /// server stores it, tests it with a request that starts nothing, and answers after that test.
        case set(BrowserAgentCredentials)
        /// Sent as `null`: removes it, so a sender's page is left for the person to open.
        case remove
    }

    public var credentials: CredentialsChange?
    /// A model id per job, or nil for the server's default (sent as `null`). Jobs left out keep their model.
    public var models: [AiJob: String?]?
    public var paused: Bool?
    public var browserAgent: BrowserAgentChange?

    public init(
        credentials: CredentialsChange? = nil, models: [AiJob: String?]? = nil, paused: Bool? = nil,
        browserAgent: BrowserAgentChange? = nil
    ) {
        self.credentials = credentials
        self.models = models
        self.paused = paused
        self.browserAgent = browserAgent
    }

    /// The keys in it, to keep out of anything shown again.
    public var secrets: [String] {
        var keys: [String] = []
        if case .set(let credentials) = credentials { keys.append(credentials.apiKey) }
        if case .set(let agent) = browserAgent { keys.append(agent.apiKey) }
        return keys
    }

    private enum Key: String, CodingKey {
        case credentials, models, paused, browserAgent
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: Key.self)
        switch credentials {
        case .set(let value): try container.encode(value, forKey: .credentials)
        case .remove: try container.encodeNil(forKey: .credentials)
        case nil: break
        }
        try container.encodeIfPresent(models, forKey: .models)
        try container.encodeIfPresent(paused, forKey: .paused)
        switch browserAgent {
        case .set(let value): try container.encode(value, forKey: .browserAgent)
        case .remove: try container.encodeNil(forKey: .browserAgent)
        case nil: break
        }
    }
}

/// Whether the server's AI works, so an interface can say why there are no summaries (`AiStatus` in core). Anyone
/// may read it.
public struct AiStatus: Codable, Hashable, Sendable, Versioned {
    public var state: AiState
    /// Why the state isn't `working`, in words a person can act on.
    public var detail: String?
    /// With `modelNotFound`: the job whose model the service doesn't know.
    public var job: AiJob?
    /// When the server last processed a thread with the AI.
    public var lastRunAt: Date?
    /// How many threads the AI still has to process, counted whatever the state: every synced thread that isn't done
    /// or trashed and needs a category or a summary, however old.
    public var pending: Int
    /// Rises with every change, maybe by more than one. Of two copies, keep the higher.
    public var version: Int

    public init(
        state: AiState, detail: String? = nil, job: AiJob? = nil, lastRunAt: Date? = nil, pending: Int = 0,
        version: Int = 1
    ) {
        self.state = state
        self.detail = detail
        self.job = job
        self.lastRunAt = lastRunAt
        self.pending = pending
        self.version = version
    }
}
