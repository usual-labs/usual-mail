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

    /// A mail out of Screening without its sender let in says so under the category's line, in core's words for each
    /// kind (`skippedScreeningLine`, docs/contract.md "Skipped Screening").
    @Test func whySkippedScreening() throws {
        let code = try #require(sample.threads.first { $0.id == "thr_15" })
        #expect(WhyWords.skipped(code) == "Skipped Screening: a one-time code")
        #expect(WhyWords.title(for: code) == "One-time code, sorted by the AI\nSkipped Screening: a one-time code")
        var mail = code
        let words: [(ScreeningPass, String)] = [
            (.code, "a one-time code"), (.signIn, "a sign-in link"), (.emailConfirmation, "an email confirmation"),
            (.security, "a security alert"), (.account, "a password reset or account change"),
            (.order, "a receipt or order update"), (.booking, "a booking"), (.payment, "a payment alert"),
        ]
        #expect(words.map(\.0) == ScreeningPass.known)
        for (pass, what) in words {
            mail.skippedScreening = pass
            #expect(WhyWords.skipped(mail) == "Skipped Screening: \(what)")
        }
        // A kind a newer server adds still says it skipped; a mail that didn't says nothing more.
        mail.skippedScreening = .unknown("ticket")
        #expect(WhyWords.skipped(mail) == "Skipped Screening")
        let other = try #require(sample.threads.first { $0.id == "thr_6" })
        #expect(WhyWords.skipped(other) == nil)
        #expect(WhyWords.title(for: other) == WhyWords.line(for: other))
    }

    /// Under the skipped line, the sender's choices: let in and block; block only once a sender picture shows (the
    /// server gives one only for a sender let in); none without a sender, as the row menu's block needs one.
    @Test func theSendersChoicesUnderTheSkippedLine() throws {
        var code = try #require(sample.threads.first { $0.id == "thr_15" })
        #expect(WhyWords.senderChoices(code) == [.letIn, .block])
        #expect(WhyWords.senderChoices(code).map(\.senderTitle) == ["Let in", "Block sender"])
        code.avatar = SenderPicture(picture: "/v1/avatars/5b0e7c1f3a9d4e2b8c6f1a0d9e7b3c21", fit: .fill, size: 180)
        #expect(WhyWords.senderChoices(code) == [.block])
        code.sender = nil
        #expect(WhyWords.senderChoices(code).isEmpty)
        let other = try #require(sample.threads.first { $0.id == "thr_6" })
        #expect(WhyWords.senderChoices(other).isEmpty)
    }
}
