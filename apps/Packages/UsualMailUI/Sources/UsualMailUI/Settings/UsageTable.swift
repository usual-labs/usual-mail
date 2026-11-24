import Foundation
import UsualMailKit

/// Tokens some requests reported, added up: `input` and `output` are nil when no request reported them, and `partial`
/// says the sum is a floor because some requests reported none.
struct UsageTokens: Equatable {
    var input: Int?
    var output: Int?
    var partial: Bool
}

/// A cost some requests reported, added up; `partial` says the sum is a floor because some requests' cost wasn't
/// reported (yet, or ever).
struct UsageCost: Equatable {
    var amount: Double
    var currency: String
    var partial: Bool
}

/// One line of the usage table: a job's rows added up across its models, or every row (the total, `job` nil).
struct UsageLine: Equatable {
    var job: AiJob?
    /// The job's models in the server's order; none for the total.
    var models: [String]
    var requests: Int
    var failed: Int
    /// Nil when no request reported any.
    var tokens: UsageTokens?
    /// Nil when no request's cost was reported.
    var cost: UsageCost?

    /// Adds the rows up. A sum is partial when any row is, or when some rows reported it and others didn't, so a
    /// total over a job with a cost and a job without says "at least" (the owner's server: summaries carry a cost,
    /// categorizing doesn't).
    init(job: AiJob?, rows: [AiUsageRow]) {
        self.job = job
        models = job == nil ? [] : rows.map(\.model).reduce(into: []) { if !$0.contains($1) { $0.append($1) } }
        requests = rows.reduce(0) { $0 + $1.requests }
        failed = rows.reduce(0) { $0 + $1.failed }

        let counted = rows.filter { $0.inputTokens != nil || $0.outputTokens != nil }
        let input = counted.compactMap(\.inputTokens)
        let output = counted.compactMap(\.outputTokens)
        tokens =
            counted.isEmpty
            ? nil
            : UsageTokens(
                input: input.isEmpty ? nil : input.reduce(0, +), output: output.isEmpty ? nil : output.reduce(0, +),
                partial: counted.count < rows.count || rows.contains(where: \.tokensPartial))

        let costs = rows.compactMap(\.cost)
        if let currency = costs.first?.currency {
            let same = costs.filter { $0.currency == currency }
            cost = UsageCost(
                amount: same.reduce(0) { $0 + $1.amount }, currency: currency,
                partial: same.count < rows.count || rows.contains(where: \.costPartial))
        } else {
            cost = nil
        }
    }
}

/// One period's usage as Settings shows it: a line per job (the contract's jobs first, in their order, then any a
/// newer server names), then the total. Empty when the period has no requests.
struct UsageTable: Equatable {
    var jobs: [UsageLine]
    var total: UsageLine?

    init(rows: [AiUsageRow]) {
        var order = AiJob.known.filter { job in rows.contains { $0.job == job } }
        for row in rows where !order.contains(row.job) { order.append(row.job) }
        jobs = order.map { job in UsageLine(job: job, rows: rows.filter { $0.job == job }) }
        total = rows.isEmpty ? nil : UsageLine(job: nil, rows: rows)
    }

    var isEmpty: Bool { jobs.isEmpty }
}

/// The usage section's words: what was counted, said as the server counted it, never as zero where nothing was
/// reported.
enum UsageWords {
    /// The period switch: "Today", "7 days", "30 days".
    static func title(_ period: AiUsagePeriod) -> String {
        switch period {
        case .today: "Today"
        case .last7Days: "7 days"
        case .last30Days: "30 days"
        }
    }

    /// In place of the table when the period has no requests.
    static func empty(_ period: AiUsagePeriod) -> String {
        switch period {
        case .today: "No AI requests today."
        case .last7Days: "No AI requests in the last 7 days."
        case .last30Days: "No AI requests in the last 30 days."
        }
    }

    /// "Categorize", "Summarize", "Total".
    static func name(_ line: UsageLine) -> String {
        line.job.map(AIWords.job) ?? "Total"
    }

    /// "14", or "11 (1 failed)" when some failed.
    static func requests(_ line: UsageLine) -> String {
        let count = number(line.requests)
        return line.failed > 0 ? "\(count) (\(number(line.failed)) failed)" : count
    }

    /// "6,300 / 42" in and out, "at least 24,800 / 610", or "not reported".
    static func tokens(_ tokens: UsageTokens?) -> String {
        guard let tokens else { return "not reported" }
        let pair = "\(tokens.input.map(number) ?? "–") / \(tokens.output.map(number) ?? "–")"
        return tokens.partial ? "at least \(pair)" : pair
    }

    /// "$0.0031", "at least $0.0031", or "not reported".
    static func cost(_ cost: UsageCost?) -> String {
        guard let cost else { return "not reported" }
        let amount = money(cost.amount, currency: cost.currency)
        return cost.partial ? "at least \(amount)" : amount
    }

    /// An amount with enough digits that a small one isn't rounded away: two decimals, more below a dollar so three
    /// significant digits show ($0.0031, $0.0263, $12.35). Dollars as "$", any other currency by its code.
    static func money(_ amount: Double, currency: String) -> String {
        var digits = 2
        if amount > 0 && amount < 1 {
            digits = min(max(2, 2 - Int(log10(amount).rounded(.down))), 8)
        }
        let style = FloatingPointFormatStyle<Double>.number.precision(.fractionLength(2...digits)).locale(english)
        let figure = amount.formatted(style)
        return currency == "USD" ? "$\(figure)" : "\(currency) \(figure)"
    }

    /// The footnote: "Kept since 20 Oct", in the time zone the periods were cut in; with the year when it isn't this
    /// one.
    static func since(_ date: Date, timeZone: TimeZone, now: Date = Date()) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let style = Date.FormatStyle(calendar: calendar, timeZone: timeZone).locale(english)
        let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: now)
        let day = date.formatted(sameYear ? style.day().month(.abbreviated) : style.day().month(.abbreviated).year())
        return "Kept since \(day)"
    }

    /// How often Settings asks for the usage again while the AI's status keeps changing.
    static let fetchEvery: TimeInterval = 5

    /// How long to wait before asking again: nothing the first time, else what is left of `fetchEvery`.
    static func wait(lastFetch: Date?, now: Date) -> TimeInterval {
        guard let lastFetch else { return 0 }
        return max(0, fetchEvery - now.timeIntervalSince(lastFetch))
    }

    /// "1,234", as dates and numbers read elsewhere in the app (en_GB).
    static func number(_ value: Int) -> String {
        value.formatted(.number.locale(english))
    }

    private static let english = Locale(identifier: "en_GB")
}
