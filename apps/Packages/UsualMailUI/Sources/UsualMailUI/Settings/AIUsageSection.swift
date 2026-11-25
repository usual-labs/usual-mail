import SwiftUI
import UsualMailKit

/// The Service section's rows in Settings: the service the AI reaches, then a row per job with the model it runs on.
struct AISettingsRows: View {
    let settings: AiSettings

    var body: some View {
        SettingsView.words(AIWords.connection(settings))
        ForEach(settings.jobs, id: \.job) { setting in
            SettingsView.row(AIWords.job(setting.job), value: AIWords.model(setting))
        }
    }
}

/// "Usage", on Settings' AI tab (owner's request of 2026-11-18): what the server's AI used of the person's account, today or over the
/// last 7 or 30 days, as one table of Categorize, Summarize and Total by requests, tokens and cost, with when the
/// server began keeping it. Shown only once the server has answered (never made-up zeros); an agent's device never
/// gets it. No charts. The period is the system's segmented control, its first row. On the Mac the table is a grid; on
/// the iPhone, too narrow for four columns, a row per job and one for the total, each with its cost at the right and
/// its requests and tokens under its name.
struct AIUsageSection: View {
    @Environment(MailStore.self) private var store
    @State private var period = AiUsagePeriod.today

    var body: some View {
        if let usage = store.aiUsage {
            let table = UsageTable(rows: usage.rows(in: period))
            // The day it began, in the time zone the periods were cut in (this device's).
            let since = UsageWords.since(usage.since, timeZone: TimeZone(identifier: usage.timeZone) ?? .current)
            SettingsView.group("Usage", footer: [since]) {
                Picker("Period", selection: $period.animation(Motion.reveal)) {
                    ForEach(AiUsagePeriod.allCases, id: \.self) { choice in
                        Text(verbatim: UsageWords.title(choice)).tag(choice)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                if table.isEmpty {
                    SettingsView.words(UsageWords.empty(period))
                } else {
                    #if os(iOS)
                        ForEach(table.jobs, id: \.job) { UsageRow(line: $0) }
                        if let total = table.total { UsageRow(line: total) }
                    #else
                        UsageGrid(table: table)
                    #endif
                }
            }
        }
    }
}

/// On the iPhone, one line of the usage table as a row: its name (the total's in semibold) and models at the left, its
/// cost at the right, its requests and tokens under its name.
private struct UsageRow: View {
    let line: UsageLine

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(verbatim: UsageWords.name(line))
                    .font(Theme.sans(SettingsType.body, weight: line.job == nil ? .semibold : .regular))
                    .foregroundStyle(Theme.ink)
                Spacer(minLength: 12)
                Text(verbatim: UsageWords.cost(line.cost))
                    .foregroundStyle(Theme.secondary)
                    .monospacedDigit()
            }
            Text(verbatim: "Requests \(UsageWords.requests(line)) · Tokens \(UsageWords.tokens(line.tokens))")
                .font(Theme.sans(SettingsType.note))
                .foregroundStyle(Theme.secondary)
                .monospacedDigit()
            ForEach(line.models, id: \.self) { model in
                Text(verbatim: model)
                    .font(Theme.sans(SettingsType.note))
                    .foregroundStyle(Theme.time)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

/// The table: a header, a line per job with its models under it in 10 points, a hairline, then the total.
private struct UsageGrid: View {
    let table: UsageTable

    var body: some View {
        Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 20, verticalSpacing: 10) {
            GridRow {
                Color.clear.gridCellUnsizedAxes([.horizontal, .vertical])
                header("Requests")
                header("Tokens (in / out)")
                header("Cost")
            }
            ForEach(table.jobs, id: \.job) { line in
                row(line)
            }
            if let total = table.total {
                Rectangle()
                    .fill(Theme.hairline)
                    .frame(height: 1)
                row(total)
            }
        }
    }

    private func header(_ title: String) -> some View {
        Text(verbatim: title)
            .font(Theme.sans(10))
            .foregroundStyle(Theme.time)
    }

    private func row(_ line: UsageLine) -> some View {
        GridRow {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: UsageWords.name(line))
                    .font(Theme.sans(12, weight: line.job == nil ? .semibold : .regular))
                    .foregroundStyle(Theme.ink)
                ForEach(line.models, id: \.self) { model in
                    Text(verbatim: model)
                        .font(Theme.sans(10))
                        .foregroundStyle(Theme.time)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            value(UsageWords.requests(line))
            value(UsageWords.tokens(line.tokens))
            value(UsageWords.cost(line.cost))
        }
    }

    private func value(_ text: String) -> some View {
        Text(verbatim: text)
            .font(Theme.sans(12))
            .foregroundStyle(Theme.secondary)
            .monospacedDigit()
    }
}

extension View {
    /// Asks for the AI's usage when the view appears, and again whenever the AI's status changes (each
    /// `ai.status.changed` raises its version), at most every `UsageWords.fetchEvery` seconds. A cost comes some time
    /// after its request, so it shows at a later ask.
    func fetchesAiUsage() -> some View {
        modifier(UsageFetch())
    }
}

private struct UsageFetch: ViewModifier {
    @Environment(MailStore.self) private var store
    @State private var lastFetch: Date?

    func body(content: Content) -> some View {
        content.task(id: store.aiStatus?.version) {
            let wait = UsageWords.wait(lastFetch: lastFetch, now: Date())
            if wait > 0 {
                // A newer status cancels the wait and starts its own, so changes in a burst make one ask.
                do { try await Task.sleep(for: .seconds(wait)) } catch { return }
            }
            lastFetch = Date()
            // Not cancelled with the wait: an ask under way finishes even when the next status arrives.
            await Task { await store.loadAiUsage() }.value
        }
    }
}
