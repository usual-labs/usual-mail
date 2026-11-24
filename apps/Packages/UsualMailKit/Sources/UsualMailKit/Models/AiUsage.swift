import Foundation

// Mirrors of `core/src/ai-usage.ts`: what the server's AI used of the person's AI account (docs/contract-ai.md,
// "Usage"), for a person's Settings. Only what the service reported is counted: where it reported no tokens or no
// cost, the number is nil and an interface says "not reported", never an estimate. Person only.

/// A cost the service reported: Vercel's AI Gateway's own figure for each generation, looked up after the request.
public struct AiUsageCost: Codable, Hashable, Sendable {
    public var amount: Double
    /// ISO 4217. The gateway reports US dollars (`USD`).
    public var currency: String

    public init(amount: Double, currency: String = "USD") {
        self.amount = amount
        self.currency = currency
    }
}

/// One job with one model over a period. A model changed in the middle of a period gives two rows; an interface adds
/// them up.
public struct AiUsageRow: Codable, Hashable, Sendable {
    public var job: AiJob
    public var model: String
    /// Requests the server made, failed ones included; at least 1.
    public var requests: Int
    /// Of `requests`, those the service refused or couldn't answer.
    public var failed: Int
    /// Summed over the requests whose service reported them; nil when none did.
    public var inputTokens: Int?
    public var outputTokens: Int?
    /// True when some requests reported tokens and others didn't, so the numbers are a floor ("at least").
    public var tokensPartial: Bool
    /// Summed over the requests whose cost the gateway reported (looked up a while after each request); nil when none
    /// did. A provider's own key reports none.
    public var cost: AiUsageCost?
    /// True when some requests' cost was reported and others' not: "at least".
    public var costPartial: Bool

    public init(
        job: AiJob, model: String, requests: Int, failed: Int = 0, inputTokens: Int? = nil, outputTokens: Int? = nil,
        tokensPartial: Bool = false, cost: AiUsageCost? = nil, costPartial: Bool = false
    ) {
        self.job = job
        self.model = model
        self.requests = requests
        self.failed = failed
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.tokensPartial = tokensPartial
        self.cost = cost
        self.costPartial = costPartial
    }

    private enum CodingKeys: String, CodingKey {
        case job, model, requests, failed, inputTokens, outputTokens, tokensPartial, cost, costPartial
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(job, forKey: .job)
        try container.encode(model, forKey: .model)
        try container.encode(requests, forKey: .requests)
        try container.encode(failed, forKey: .failed)
        // `null` when not reported, as core writes it.
        try container.encode(inputTokens, forKey: .inputTokens)
        try container.encode(outputTokens, forKey: .outputTokens)
        try container.encode(tokensPartial, forKey: .tokensPartial)
        try container.encode(cost, forKey: .cost)
        try container.encode(costPartial, forKey: .costPartial)
    }
}

/// One of the periods the usage is cut into, in the time zone asked for.
public enum AiUsagePeriod: String, CaseIterable, Hashable, Sendable {
    /// From the last midnight.
    case today
    /// From midnight six days before today's.
    case last7Days
    /// From midnight 29 days before today's.
    case last30Days
}

/// `GET /v1/ai/usage?tz=<IANA time zone>`: today, the last 7 and the last 30 days, by job and model.
public struct AiUsage: Codable, Hashable, Sendable {
    /// Each a list of rows in `AiJob.known` order, then by model, only rows with requests.
    public struct Periods: Codable, Hashable, Sendable {
        public var today: [AiUsageRow]
        public var last7Days: [AiUsageRow]
        public var last30Days: [AiUsageRow]

        public init(today: [AiUsageRow] = [], last7Days: [AiUsageRow] = [], last30Days: [AiUsageRow] = []) {
            self.today = today
            self.last7Days = last7Days
            self.last30Days = last30Days
        }
    }

    /// When the server began keeping usage: nothing before it is counted.
    public var since: Date
    /// The time zone the periods were cut in, as asked, or `UTC`.
    public var timeZone: String
    public var periods: Periods

    public init(since: Date, timeZone: String, periods: Periods) {
        self.since = since
        self.timeZone = timeZone
        self.periods = periods
    }

    /// The rows of one period.
    public func rows(in period: AiUsagePeriod) -> [AiUsageRow] {
        switch period {
        case .today: periods.today
        case .last7Days: periods.last7Days
        case .last30Days: periods.last30Days
        }
    }
}
