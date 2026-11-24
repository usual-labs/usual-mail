import Foundation
import Testing

@testable import UsualMailKit

/// A receipt's or an invoice's payment details (core's `PaymentDetails`, docs/contract-ai.md, "Payment details"):
/// decoded, encoded back as the server wrote them, kept on the device and gone when the thread leaves those categories.
struct PaymentTests {
    private func thread(category: String = "invoice", payment: String?) -> String {
        let field = payment.map { #","payment":\#($0)"# } ?? ""
        return #"""
            {"id":"thr_x","inboxId":"inb_harbor","subject":"Invoice 7","snippet":"Please pay","participants":[],
             "lastMessageAt":"2026-11-18T09:00:00Z","messageCount":1,"unread":true,"hasAttachments":false,
             "category":"\#(category)","screened":false,"done":false,"trashed":false,"version":3\#(field)}
            """#
    }

    private func decoded(_ text: String) throws -> MailThread {
        try MailJSON.decoder().decode(MailThread.self, from: Data(text.utf8))
    }

    @Test func aThreadWithoutPaymentDetailsHasNone() throws {
        let plain = try decoded(thread(category: "conversation", payment: nil))
        #expect(plain.payment == nil)
        // Encoded only when present, so a stored or re-encoded thread stays as the server sent it.
        #expect(try encodedJSON(plain)["payment"] == nil)
    }

    @Test func everyFieldComesThroughAndGoesBackAsWritten() throws {
        let full = #"""
            {"party":"Kestrel Roasters","amount":{"minor":124000,"currency":"EUR"},"refund":false,"state":"due",
             "dueDate":"2026-11-30","what":"October's bean delivery"}
            """#
        let invoice = try decoded(thread(payment: full))
        #expect(
            invoice.payment
                == Payment(
                    party: "Kestrel Roasters", amount: Payment.Amount(minor: 124_000, currency: "EUR"), state: .due,
                    dueDate: "2026-11-30", what: "October's bean delivery"))
        #expect(try encodedJSON(invoice)["payment"] == json(full))
    }

    @Test func noAmountWithADueDate() throws {
        let partial =
            #"{"party":null,"amount":null,"refund":false,"state":null,"dueDate":"2026-12-01","what":null}"#
        let invoice = try decoded(thread(payment: partial))
        let payment = try #require(invoice.payment)
        #expect(payment.amount == nil && payment.party == nil && payment.what == nil && !payment.refund)
        #expect(payment.dueDate == "2026-12-01" && payment.state == nil)
        // Nulls are written back, as the server writes every field.
        #expect(try encodedJSON(invoice)["payment"] == json(partial))
    }

    @Test func eachStateAndNoneDecode() throws {
        func state(_ value: String) throws -> PaymentState? {
            let payment =
                #"{"party":"Cloudbase","amount":null,"refund":false,"state":\#(value),"dueDate":null,"what":null}"#
            return try decoded(thread(payment: payment)).payment?.state
        }
        #expect(try state(#""paid""#) == .paid)
        #expect(try state(#""scheduled""#) == .scheduled)
        #expect(try state(#""due""#) == .due)
        #expect(try state("null") == nil)
        // One this app doesn't know is none, so the title reads the category.
        let unknown = try decoded(
            thread(
                payment: #"{"party":null,"amount":null,"refund":false,"state":"overdue","dueDate":null,"what":null}"#))
        #expect(unknown.payment?.state == nil)
        // An older server's copy has no state at all.
        let older = try decoded(
            thread(payment: #"{"party":null,"amount":null,"refund":false,"dueDate":null,"what":null}"#))
        #expect(older.payment != nil && older.payment?.state == nil)
        #expect(PaymentState.allCases.map(\.rawValue) == ["paid", "scheduled", "due"])
    }

    @Test func theSamplesReceiptsAndInvoice() throws {
        let sample = SampleData.bundled
        func payment(_ id: String) -> Payment? { sample.threads.first { $0.id == id }?.payment }
        #expect(
            payment("thr_3")
                == Payment(
                    party: "Paperloop", amount: Payment.Amount(minor: 4900, currency: "EUR"), state: .paid,
                    what: "Your plan, renewing on 16 December"))
        #expect(payment("thr_6")?.state == .due && payment("thr_6")?.dueDate == "2026-11-30")
        #expect(payment("thr_6")?.amount?.minor == 124_000)
        #expect(
            payment("thr_10")
                == Payment(party: "Rail Booking", what: "Train tickets to Hamburg, Friday 20 November"))
        #expect(
            payment("thr_17")
                == Payment(
                    party: "Lumen Outdoor", amount: Payment.Amount(minor: 1200, currency: "EUR"), refund: true,
                    state: .paid, what: "The returned rain jacket"))
        // An invoice collected automatically.
        #expect(
            payment("thr_18")
                == Payment(
                    party: "Cloudbase Hosting", amount: Payment.Amount(minor: 1250, currency: "EUR"),
                    state: .scheduled, dueDate: "2026-12-02", what: "Your server in November"))
        // Only receipts and invoices carry them, and their summary is `what`.
        for thread in sample.threads {
            #expect((thread.payment != nil) == [.receipt, .invoice].contains(thread.category))
            if let payment = thread.payment { #expect(thread.summary == payment.what) }
        }
    }

    @Test func theCopyOnTheDeviceKeepsThem() async throws {
        let store = try await LocalStore.sample()
        let kept = try #require(try await store.thread(id: "thr_17"))
        #expect(kept.payment?.refund == true && kept.payment?.amount == Payment.Amount(minor: 1200, currency: "EUR"))
    }

    @Test func movingToAnotherCategoryDropsThemAtOnce() throws {
        let invoice = try #require(SampleData.bundled.threads.first { $0.id == "thr_6" })
        // An invoice turned receipt never shows its amount as paid while the server reads it again.
        #expect(invoice.applying(.categorize(.receipt)).payment == nil)
        #expect(invoice.applying(.categorize(.conversation)).payment == nil)
        // Filed again where it is, or any other action, keeps them.
        #expect(invoice.applying(.categorize(.invoice)).payment == invoice.payment)
        #expect(invoice.applying(.read).payment == invoice.payment)
    }

    @MainActor
    @Test func aChangedThreadWithoutThemLosesThem() async throws {
        let store = try await MailStore.sample()
        var thread = try #require(store.lists.thread(id: "thr_6"))
        #expect(thread.payment != nil)
        // The thread left the invoices: its `thread.changed` comes without the field.
        thread.category = .conversation
        thread.payment = nil
        thread.summary = nil
        thread.version += 1
        await store.receive(.threadChanged(thread))
        #expect(store.lists.thread(id: "thr_6")?.payment == nil)
        #expect(try await store.local.thread(id: "thr_6")?.payment == nil)
    }
}
