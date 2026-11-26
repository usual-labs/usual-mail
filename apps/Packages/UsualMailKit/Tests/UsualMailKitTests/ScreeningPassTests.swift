import Foundation
import Testing

@testable import UsualMailKit

/// Why a thread whose sender isn't let in is out of Screening (`Thread.skippedScreening`, core's `ScreeningPass`,
/// docs/contract.md "Skipped Screening"): each kind core names, a kind a newer server adds, and none from an older one.
struct ScreeningPassTests {
    private func thread(skipped: String?) throws -> MailThread {
        let field = skipped.map { #","skippedScreening":\#($0)"# } ?? ""
        let text = #"""
            {"id":"thr_x","inboxId":"inb_northwind","subject":"Your sign-in link","snippet":"Sign in",
             "participants":[{"email":"no-reply@quillpad.example"}],"lastMessageAt":"2026-11-25T09:00:00Z",
             "messageCount":1,"unread":true,"hasAttachments":false,"category":"otp","categorizedBy":"ai",
             "sender":"no-reply@quillpad.example","screened":false,"done":false,"trashed":false,"version":2\#(field)}
            """#
        return try MailJSON.decoder().decode(MailThread.self, from: Data(text.utf8))
    }

    @Test func eachKindCoreNamesIsKnown() throws {
        let core = [
            "code", "sign_in", "email_confirmation", "security", "account", "order", "booking", "payment",
        ]
        #expect(ScreeningPass.known.map(\.rawValue) == core)
        for kind in core {
            let pass = try #require(try thread(skipped: "\"\(kind)\"").skippedScreening)
            #expect(pass.isKnown && pass.rawValue == kind)
            #expect(try encodedJSON(try thread(skipped: "\"\(kind)\""))["skippedScreening"] == .string(kind))
        }
        #expect(try thread(skipped: #""sign_in""#).skippedScreening == .signIn)
    }

    @Test func aNewerKindIsKeptAndNoneIsNotWritten() throws {
        let newer = try thread(skipped: #""ticket""#)
        #expect(newer.skippedScreening == .unknown("ticket"))
        #expect(try encodedJSON(newer)["skippedScreening"] == .string("ticket"))
        // An older server sends none; `null` reads as none too.
        let older = try thread(skipped: nil)
        #expect(older.skippedScreening == nil)
        #expect(try encodedJSON(older)["skippedScreening"] == nil)
        #expect(try thread(skipped: "null").skippedScreening == nil)
    }

    @Test func theSampleHasACodeThatSkippedIt() throws {
        let code = try #require(SampleData.bundled.threads.first { $0.id == "thr_15" })
        #expect(code.skippedScreening == .code && !code.screened)
    }
}
