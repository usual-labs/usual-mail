import Foundation
import Testing
import UsualMailKit

@testable import UsualMailUI

/// Why Home shows opening words instead of summaries, and why a thread is where it is.
struct ExplanationTests {
    let sample = SampleData.bundled

    /// A status as the server sends it.
    private func status(_ state: String, pending: Int = 0, detail: String? = nil) -> AiStatus {
        var json: [String: Any] = ["state": state, "pending": pending, "version": 1]
        if let detail { json["detail"] = detail }
        let data = try! JSONSerialization.data(withJSONObject: json)
        return try! MailJSON.decoder().decode(AiStatus.self, from: data)
    }

    private var unsummarized: [MailThread] {
        sample.threads.filter { ($0.summary ?? "").isEmpty }
    }

    @Test func nothingToSayWhenEverythingHasASummary() {
        let summarized = sample.threads.filter { !($0.summary ?? "").isEmpty }
        #expect(AIWords.note(status: status("key_refused"), threads: summarized) == nil)
    }

    @Test func eachStateInWords() {
        let threads = unsummarized
        #expect(!threads.isEmpty)
        #expect(
            AIWords.note(status: status("not_set_up"), threads: threads)
                == "Summaries start once AI is set up on your server.")
        #expect(
            AIWords.note(status: status("out_of_credit", pending: 3), threads: threads)
                == "No summaries: the AI account is out of credit. 3 mails are waiting.")
        #expect(
            AIWords.note(
                status: status("key_refused", detail: "Invalid API key."), threads: threads)
                == "No summaries: Invalid API key.")
        #expect(
            AIWords.note(status: status("unavailable", pending: 1), threads: threads)
                == "No summaries for now: the AI service can't be reached. 1 mail is waiting.")
    }

    @MainActor @Test func whileTheAIWorksOnlyWhatWaits() async throws {
        // The sample as the demo server serves it: four mails waiting for the AI (`aiStatus.pending`). No inbox is left out on its own (the key
        // turns the AI on for all of them), and no mail is past its reach (it works through all synced mail).
        let store = try await MailStore.sample()
        let home = HomeList(store.lists, inbox: nil)
        #expect(
            AIWords.note(status: store.aiStatus, threads: home.new + home.seen) == "4 mails are waiting for a summary.")
        #expect(
            AIWords.note(status: status("working", pending: 1), threads: home.new + home.seen)
                == "1 mail is waiting for a summary.")
        #expect(AIWords.note(status: status("working"), threads: home.new + home.seen) == nil)
        #expect(AIWords.note(status: nil, threads: home.new + home.seen) == nil)
    }

    @Test func whyItsHere() throws {
        func thread(_ id: String) throws -> MailThread { try #require(sample.threads.first { $0.id == id }) }
        #expect(WhyWords.line(for: try thread("thr_6")) == "Invoice, sorted by the AI")
        #expect(WhyWords.line(for: try thread("thr_2")) == "Conversation, as you sorted it")
        #expect(WhyWords.line(for: try thread("thr_10")) == "Receipt, as your mailbox files it")
        #expect(WhyWords.line(for: try thread("thr_12")) == "Not sorted yet")
        // An agent is named when the server says which one (thr_1 was sorted by Claude Code).
        #expect(WhyWords.line(for: try thread("thr_1")).hasPrefix("Conversation, by Claude Code"))
        // A rule is named by its own text, looked up by the id the server gives.
        let thr3 = try thread("thr_3")
        if case .rule(let id)? = thr3.categorizedByActor, let rule = sample.rules.first(where: { $0.id == id }) {
            #expect(WhyWords.line(for: thr3, rules: sample.rules) == "Receipt, by a rule: \(rule.text)")
        } else {
            Issue.record("thr_3 should name its rule")
        }
        let byRule = try thread("thr_4")
        #expect(WhyWords.line(for: byRule).hasPrefix("Newsletter, by a rule"))
    }
}
