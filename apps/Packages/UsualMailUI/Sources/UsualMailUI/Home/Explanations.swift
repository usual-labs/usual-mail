import Foundation
import UsualMailKit

/// Why Home shows a mail's opening words instead of a summary, from the server's AI status. Nil when there is nothing
/// to explain. The key turns the AI on for every inbox at once (owner's decision of 2026-11-17), so no inbox is left out
/// on its own.
enum AIWords {
    /// The line under Home's list, said only when something shown has no summary. While the AI works it says how many
    /// mails still wait; the AI works through all synced mail, so nothing is past its reach.
    static func note(status: AiStatus?, threads: [MailThread]) -> String? {
        let missing = threads.filter { ($0.summary ?? "").isEmpty }
        guard !missing.isEmpty, let status else { return nil }
        if status.state != .working {
            return [sentence(for: status), waiting(status.pending)].compactMap(\.self).joined(separator: " ")
        }
        switch status.pending {
        case 0: return nil
        case 1: return "1 mail is waiting for a summary."
        default: return "\(status.pending) mails are waiting for a summary."
        }
    }

    /// Why the AI isn't summarizing, in words a person can act on. The server's own detail wins when it gives one.
    static func sentence(for status: AiStatus) -> String {
        if let detail = status.detail?.trimmingCharacters(in: .whitespacesAndNewlines), !detail.isEmpty,
            status.state != .notSetUp, status.state != .paused
        {
            return "No summaries: \(detail)"
        }
        switch status.state {
        case .notSetUp: return "Summaries start once AI is set up on your server."
        case .paused: return "AI is paused on your server, so there are no new summaries."
        case .keyRefused: return "No summaries: the AI service refused the key."
        case .modelNotFound:
            let job = status.job.map { " for \($0 == .summarize ? "summaries" : "sorting")" } ?? ""
            return "No summaries: the AI service doesn't know the model chosen\(job)."
        case .outOfCredit: return "No summaries: the AI account is out of credit."
        case .unavailable: return "No summaries for now: the AI service can't be reached."
        case .working: return ""
        case .unknown: return "No summaries for now."
        }
    }

    static func waiting(_ pending: Int) -> String? {
        switch pending {
        case 0: nil
        case 1: "1 mail is waiting."
        default: "\(pending) mails are waiting."
        }
    }

    /// The service the server's AI reaches, as core names it (`aiServiceName`): "Vercel's AI Gateway", "OpenAI",
    /// "Anthropic"; one a newer server names, by its own name.
    static func service(_ connection: AiConnection) -> String {
        switch connection {
        case .gateway(.vercel): "Vercel's AI Gateway"
        case .gateway(let gateway): gateway.rawValue
        case .direct(.openai): "OpenAI"
        case .direct(.anthropic): "Anthropic"
        case .direct(let provider): provider.rawValue
        case .unknown(let kind, _): kind
        }
    }

    /// Settings' line on how the AI is reached: the service, and whether its key is gone.
    static func connection(_ settings: AiSettings) -> String {
        guard let connection = settings.connection else { return "No AI service yet" }
        return settings.credentialsSet ? service(connection) : "\(service(connection)), no key"
    }

    /// "Categorize", "Summarize"; a job a newer server names, capitalized.
    static func job(_ job: AiJob) -> String {
        switch job {
        case .categorize: "Categorize"
        case .summarize: "Summarize"
        case .unknown(let raw): raw.prefix(1).uppercased() + raw.dropFirst()
        }
    }

    /// The model a job runs on, "(default)" when it is the server's choice; "Not chosen" while there is none.
    static func model(_ setting: AiJobSetting) -> String {
        let model = setting.effectiveModel
        if model.isEmpty { return "Not chosen" }
        return setting.model == nil ? "\(model) (default)" : model
    }
}

/// What kind of mail a thread is, and who decided it: the reading view's "why it's here".
enum WhyWords {
    static func title(_ category: UsualMailKit.Category) -> String {
        switch category {
        case .conversation: "Conversation"
        case .newsletter: "Newsletter"
        case .invoice: "Invoice"
        case .receipt: "Receipt"
        case .notification: "Notification"
        case .otp: "One-time code"
        default: "Not sorted yet"
        }
    }

    /// "Conversation, sorted by the AI", "Newsletter, by a rule: The Weekly Build goes to Reads", "Receipt, as your
    /// mailbox files it", "Conversation, as you sorted it", "Not sorted yet".
    /// `rules` are the thread's inbox's, so a rule can be named by its own text.
    static func line(for thread: MailThread, rules: [Rule] = []) -> String {
        let what = title(thread.category)
        guard let source = thread.categorizedBy else { return what }
        let reason = thread.reason?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        switch source {
        case .ai: return "\(what), sorted by the AI"
        case .rule:
            let ruleText: String? =
                if case .rule(let id)? = thread.categorizedByActor {
                    rules.first { $0.id == id }?.text.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
                } else { nil }
            return (ruleText ?? reason).map { "\(what), by a rule: \($0)" } ?? "\(what), by a rule"
        case .agent:
            let agent =
                if case .agent(_, let name)? = thread.categorizedByActor, !name.isEmpty { name } else { "an agent" }
            return reason.map { "\(what), by \(agent): \($0)" } ?? "\(what), by \(agent)"
        case .person: return "\(what), as you sorted it"
        case .mailbox: return "\(what), as your mailbox files it"
        default: return what
        }
    }
}

extension WhyWords {
    /// "Skipped Screening: a sign-in link": why a thread from a sender who isn't let in is out of Screening, in core's
    /// words (`skippedScreeningLine`), under the category's line; nil for a thread that didn't skip it. A kind this app
    /// doesn't know yet says only "Skipped Screening".
    static func skipped(_ thread: MailThread) -> String? {
        guard let pass = thread.skippedScreening else { return nil }
        guard let what = words(pass) else { return "Skipped Screening" }
        return "Skipped Screening: \(what)"
    }

    /// What each kind is, as core's `SCREENING_PASS_WORDS` says it.
    static func words(_ pass: ScreeningPass) -> String? {
        switch pass {
        case .code: "a one-time code"
        case .signIn: "a sign-in link"
        case .emailConfirmation: "an email confirmation"
        case .security: "a security alert"
        case .account: "a password reset or account change"
        case .order: "a receipt or order update"
        case .booking: "a booking"
        case .payment: "a payment alert"
        default: nil
        }
    }

    /// The iPhone's More menu's title: the category's line, and under it the skipped line when there is one.
    static func title(for thread: MailThread, rules: [Rule] = []) -> String {
        let line = line(for: thread, rules: rules)
        return skipped(thread).map { "\(line)\n\($0)" } ?? line
    }
}

extension String {
    fileprivate var nilIfEmpty: String? { isEmpty ? nil : self }
}
