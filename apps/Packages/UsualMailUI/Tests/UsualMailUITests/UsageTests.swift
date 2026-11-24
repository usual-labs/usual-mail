import Foundation
import Testing
import UsualMailKit

@testable import UsualMailUI

/// Settings' "AI usage": one table per period, a job's models added up, and words that never claim more than the
/// server counted ("not reported", "at least").
struct UsageTests {
    let usage = SampleData.bundled.aiUsage

    private func row(
        _ job: AiJob, _ model: String = "m", requests: Int = 1, failed: Int = 0, tokens: (Int, Int)? = nil,
        tokensPartial: Bool = false, cost: Double? = nil, costPartial: Bool = false
    ) -> AiUsageRow {
        AiUsageRow(
            job: job, model: model, requests: requests, failed: failed, inputTokens: tokens?.0,
            outputTokens: tokens?.1, tokensPartial: tokensPartial, cost: cost.map { AiUsageCost(amount: $0) },
            costPartial: costPartial)
    }

    /// Each line as "name · requests · tokens · cost".
    private func words(_ table: UsageTable) -> [String] {
        (table.jobs + [table.total].compactMap(\.self)).map { line in
            [
                UsageWords.name(line), UsageWords.requests(line), UsageWords.tokens(line.tokens),
                UsageWords.cost(line.cost),
            ]
            .joined(separator: " · ")
        }
    }

    @Test func todayInTheSample() {
        let table = UsageTable(rows: usage.rows(in: .today))
        #expect(
            words(table) == [
                "Categorize · 14 · 6,300 / 42 · not reported",
                "Summarize · 11 (1 failed) · at least 24,800 / 610 · at least $0.0031",
                "Total · 25 (1 failed) · at least 31,100 / 652 · at least $0.0031",
            ])
        #expect(table.jobs.map(\.models) == [["example/decision-1"], ["example/text-small-2"]])
        #expect(table.total?.models == [])
    }

    @Test func aJobsModelsAreAddedUp() throws {
        let table = UsageTable(rows: usage.rows(in: .last7Days))
        let summarize = try #require(table.jobs.last)
        #expect(summarize.job == .summarize && summarize.models == ["example/text-small-1", "example/text-small-2"])
        #expect(summarize.requests == 92 && summarize.failed == 1)
        #expect(
            words(table) == [
                "Categorize · 96 (2 failed) · at least 43,200 / 288 · not reported",
                "Summarize · 92 (1 failed) · at least 205,000 / 5,300 · at least $0.0263",
                "Total · 188 (3 failed) · at least 248,200 / 5,588 · at least $0.0263",
            ])
        // Two models, each reported in full: the sum is exact.
        let whole = UsageTable(rows: [
            row(.summarize, "a", requests: 2, tokens: (10, 1), cost: 0.25),
            row(.summarize, "b", requests: 3, tokens: (20, 2), cost: 0.5),
        ])
        #expect(words(whole) == ["Summarize · 5 · 30 / 3 · $0.75", "Total · 5 · 30 / 3 · $0.75"])
    }

    @Test func theTotalStaysHonestWhenJobsDiffer() {
        // Summaries carry a cost, sorting doesn't: the total is a floor.
        let mixed = UsageTable(rows: [
            row(.categorize, requests: 4, tokens: (100, 1)),
            row(.summarize, requests: 2, tokens: (200, 2), cost: 0.5),
        ])
        #expect(UsageWords.cost(mixed.total?.cost) == "at least $0.50")
        #expect(UsageWords.tokens(mixed.total?.tokens) == "300 / 3")
        // Tokens follow the same rule.
        let someTokens = UsageTable(rows: [row(.categorize, requests: 4), row(.summarize, tokens: (200, 2))])
        #expect(UsageWords.tokens(someTokens.jobs.first?.tokens) == "not reported")
        #expect(UsageWords.tokens(someTokens.total?.tokens) == "at least 200 / 2")
        // A partial row makes its sums partial, even where every row reported something.
        let partial = UsageTable(rows: [
            row(.categorize, cost: 0.1), row(.summarize, cost: 0.2, costPartial: true),
        ])
        #expect(UsageWords.cost(partial.jobs.first?.cost) == "$0.10")
        #expect(UsageWords.cost(partial.total?.cost) == "at least $0.30")
        // Nothing reported anywhere is said so, never as zero.
        let none = UsageTable(rows: [row(.categorize, requests: 3), row(.summarize, requests: 2, failed: 2)])
        #expect(UsageWords.cost(none.total?.cost) == "not reported")
        #expect(UsageWords.tokens(none.total?.tokens) == "not reported")
    }

    @Test func failedRequestsShowOnlyWhenThereAreSome() {
        let table = UsageTable(rows: [row(.categorize, requests: 1200, failed: 12), row(.summarize, requests: 3)])
        #expect(table.jobs.map(UsageWords.requests) == ["1,200 (12 failed)", "3"])
        #expect(table.total.map(UsageWords.requests) == "1,203 (12 failed)")
    }

    @Test func jobsComeInTheContractsOrder() {
        let table = UsageTable(rows: [
            row(.unknown("extract")), row(.summarize), row(.categorize, "x"), row(.categorize, "y"),
        ])
        #expect(table.jobs.map(UsageWords.name) == ["Categorize", "Summarize", "Extract"])
        #expect(table.jobs.first?.models == ["x", "y"])
    }

    @Test func anEmptyPeriodSaysSoInsteadOfZeros() {
        let table = UsageTable(rows: [])
        #expect(table.isEmpty && table.jobs.isEmpty && table.total == nil)
        #expect(UsageWords.empty(.today) == "No AI requests today.")
        #expect(UsageWords.empty(.last7Days) == "No AI requests in the last 7 days.")
        #expect(UsageWords.empty(.last30Days) == "No AI requests in the last 30 days.")
        #expect(AiUsagePeriod.allCases.map(UsageWords.title) == ["Today", "7 days", "30 days"])
    }

    @Test func smallAmountsKeepTheirDigits() {
        #expect(UsageWords.money(0.0031, currency: "USD") == "$0.0031")
        #expect(UsageWords.money(0.0112 + 0.0151, currency: "USD") == "$0.0263")
        #expect(UsageWords.money(0.5, currency: "USD") == "$0.50")
        #expect(UsageWords.money(12.3456, currency: "USD") == "$12.35")
        #expect(UsageWords.money(1234.5, currency: "USD") == "$1,234.50")
        #expect(UsageWords.money(0, currency: "USD") == "$0.00")
        #expect(UsageWords.money(0.5, currency: "EUR") == "EUR 0.50")
    }

    @Test func theFootnoteSaysSinceWhenInThePersonsTimeZone() throws {
        let berlin = try #require(TimeZone(identifier: "Europe/Berlin"))
        let utc = try #require(TimeZone(identifier: "UTC"))
        let now = time("2026-11-18T10:00:00Z")
        #expect(UsageWords.since(usage.since, timeZone: berlin, now: now) == "Kept since 20 Oct")
        let lateEvening = time("2026-10-19T23:30:00Z")
        #expect(UsageWords.since(lateEvening, timeZone: berlin, now: now) == "Kept since 20 Oct")
        #expect(UsageWords.since(lateEvening, timeZone: utc, now: now) == "Kept since 19 Oct")
        #expect(UsageWords.since(time("2025-10-20T07:12:00Z"), timeZone: berlin, now: now) == "Kept since 20 Oct 2025")
    }

    @Test func usageIsAskedForAtMostEveryFewSeconds() {
        let now = time("2026-11-18T10:00:00Z")
        #expect(UsageWords.wait(lastFetch: nil, now: now) == 0)
        #expect(UsageWords.wait(lastFetch: now.addingTimeInterval(-2), now: now) == UsageWords.fetchEvery - 2)
        #expect(UsageWords.wait(lastFetch: now.addingTimeInterval(-60), now: now) == 0)
    }

    private func time(_ text: String) -> Date {
        MailJSON.parseTime(text)!
    }
}

/// The AI group above the usage: the connection and each job's model in words.
struct AISettingsWordsTests {
    @Test func theConnectionAndTheModels() throws {
        let settings = SampleData.bundled.ai
        #expect(AIWords.connection(settings) == "Vercel's AI Gateway")
        #expect(AIWords.service(.direct(.anthropic)) == "Anthropic" && AIWords.service(.direct(.openai)) == "OpenAI")
        var removed = settings
        removed.credentialsSet = false
        #expect(AIWords.connection(removed) == "Vercel's AI Gateway, no key")
        #expect(AIWords.connection(AiSettings()) == "No AI service yet")
        let categorize = try #require(settings.job(.categorize))
        let summarize = try #require(settings.job(.summarize))
        #expect(AIWords.job(.categorize) == "Categorize" && AIWords.job(.unknown("extract")) == "Extract")
        #expect(AIWords.model(categorize) == "example/decision-1 (default)")
        #expect(AIWords.model(summarize) == "example/text-small-2")
        #expect(AIWords.model(AiJobSetting(job: .summarize, defaultModel: "")) == "Not chosen")
    }
}
