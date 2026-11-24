import Foundation
import Testing
import UsualMailKit

@testable import UsualMailUI

/// A receipt's or an invoice's words (owner's words of 2026-11-19): where the money stands, how much and to or from
/// whom in the title, what for under it, with when it is due or will be charged.
struct PaymentWordsTests {
    let gb = Locale(identifier: "en_GB")

    private func thread(
        _ category: UsualMailKit.Category, party: String? = nil, minor: Int? = nil, currency: String = "EUR",
        refund: Bool = false, state: PaymentState? = nil, due: String? = nil, what: String? = nil,
        snippet: String = "The mail's first words", details: Bool = true
    ) -> MailThread {
        let amount = minor.map { Payment.Amount(minor: $0, currency: currency) }
        return MailThread(
            id: "thr_x", inboxId: "inb_harbor", subject: "Your receipt", snippet: snippet,
            lastMessageAt: Date(timeIntervalSince1970: 1_800_000_000), category: category, summary: what,
            payment: details
                ? Payment(party: party, amount: amount, refund: refund, state: state, dueDate: due, what: what) : nil)
    }

    private func title(_ thread: MailThread) -> String? {
        PaymentWords(thread, locale: gb)?.title
    }

    // MARK: While the server says nothing of where the money stands: the category

    @Test func anInvoiceIsToBePaid() {
        #expect(
            title(thread(.invoice, party: "Kestrel Roasters", minor: 124_000))
                == "To be paid: €1,240.00 to Kestrel Roasters")
        #expect(title(thread(.invoice, party: "Kestrel Roasters")) == "To be paid to Kestrel Roasters")
        #expect(title(thread(.invoice, minor: 124_000)) == "To be paid: €1,240.00")
        #expect(title(thread(.invoice)) == "To be paid · Your receipt")
        #expect(title(thread(.invoice, details: false)) == "To be paid · Your receipt")
        // A refund the server never sends on an invoice changes nothing: it means something only on a receipt.
        #expect(
            title(thread(.invoice, party: "Kestrel Roasters", minor: 100, refund: true))
                == "To be paid: €1.00 to Kestrel Roasters")
    }

    @Test func aReceiptIsPaid() {
        #expect(title(thread(.receipt, party: "Paperloop", minor: 4900)) == "Paid: €49.00 to Paperloop")
        #expect(title(thread(.receipt, party: "Paperloop")) == "Paid to Paperloop")
        #expect(title(thread(.receipt, minor: 4900)) == "Paid: €49.00")
        #expect(title(thread(.receipt)) == "Paid · Your receipt")
        #expect(title(thread(.receipt, details: false)) == "Paid · Your receipt")
    }

    // MARK: Where the server says the money stands

    @Test func paidWhateverTheCategory() {
        for category in [UsualMailKit.Category.receipt, .invoice] {
            func paid(party: String? = nil, minor: Int? = nil) -> String? {
                title(thread(category, party: party, minor: minor, state: .paid))
            }
            #expect(paid(party: "Paperloop", minor: 4900) == "Paid: €49.00 to Paperloop")
            #expect(paid(party: "Paperloop") == "Paid to Paperloop")
            #expect(paid(minor: 4900) == "Paid: €49.00")
            #expect(paid() == "Paid · Your receipt")
        }
    }

    @Test func willBeChargedByTheParty() {
        for category in [UsualMailKit.Category.invoice, .receipt] {
            func scheduled(party: String? = nil, minor: Int? = nil) -> String? {
                title(thread(category, party: party, minor: minor, state: .scheduled))
            }
            #expect(
                scheduled(party: "Cloudbase Hosting", minor: 1250) == "Will be charged: €12.50 by Cloudbase Hosting")
            #expect(scheduled(party: "Cloudbase Hosting") == "Will be charged by Cloudbase Hosting")
            #expect(scheduled(minor: 1250) == "Will be charged: €12.50")
            #expect(scheduled() == "Will be charged · Your receipt")
        }
    }

    @Test func toBePaidWhateverTheCategory() {
        // A receipt for an order bought on invoice is still a receipt, and its money is due.
        for category in [UsualMailKit.Category.receipt, .invoice] {
            func due(party: String? = nil, minor: Int? = nil) -> String? {
                title(thread(category, party: party, minor: minor, state: .due))
            }
            #expect(due(party: "Kestrel Roasters", minor: 124_000) == "To be paid: €1,240.00 to Kestrel Roasters")
            #expect(due(party: "Kestrel Roasters") == "To be paid to Kestrel Roasters")
            #expect(due(minor: 124_000) == "To be paid: €1,240.00")
            #expect(due() == "To be paid · Your receipt")
        }
    }

    @Test func aZeroAmountIsNoAmount() {
        #expect(title(thread(.receipt, party: "Fernhill.de", minor: 0)) == "Paid to Fernhill.de")
        #expect(title(thread(.invoice, party: "Hetzner", minor: 0, currency: "JPY")) == "To be paid to Hetzner")
        #expect(title(thread(.receipt, party: "Lumen", minor: 0, refund: true)) == "Refunded by Lumen")
        #expect(title(thread(.receipt, minor: 0)) == "Paid · Your receipt")
        // The mail page's box uses the same words.
        let words = PaymentWords(thread(.receipt, party: "Fernhill.de", minor: 0, what: "Two paperbacks"), locale: gb)
        #expect(words?.title == "Paid to Fernhill.de" && words?.subtitle == "Two paperbacks")
    }

    @Test func aRefundIsRefundedByTheParty() {
        #expect(
            title(thread(.receipt, party: "Lumen Outdoor", minor: 1200, refund: true))
                == "Refunded: €12.00 by Lumen Outdoor")
        #expect(title(thread(.receipt, party: "Lumen Outdoor", refund: true)) == "Refunded by Lumen Outdoor")
        #expect(title(thread(.receipt, minor: 1200, refund: true)) == "Refunded: €12.00")
        #expect(title(thread(.receipt, refund: true)) == "Refunded · Your receipt")
        // The server sends a refund as paid; with a state this app doesn't know (none), still refunded.
        #expect(
            title(thread(.receipt, party: "Lumen Outdoor", minor: 1200, refund: true, state: .paid))
                == "Refunded: €12.00 by Lumen Outdoor")
        #expect(
            title(thread(.receipt, party: "Lumen Outdoor", minor: 1200, refund: true, state: nil))
                == "Refunded: €12.00 by Lumen Outdoor")
    }

    @Test func aPartyOfOnlySpacesIsNone() {
        #expect(title(thread(.receipt, party: "  \n ", minor: 4900)) == "Paid: €49.00")
        #expect(title(thread(.receipt, party: "Paper\nloop  Ltd")) == "Paid to Paper loop Ltd")
    }

    @Test func otherMailHasNoMoneyWords() {
        for category in [UsualMailKit.Category.conversation, .newsletter, .notification, .otp, .uncategorized] {
            #expect(PaymentWords(thread(category, party: "Paperloop", minor: 4900), locale: gb) == nil)
        }
    }

    @Test func amountsInTheirCurrencysMinorUnitsAndThePersonsWay() {
        func amount(_ minor: Int, _ currency: String, _ locale: String = "en_GB") -> String {
            PaymentWords.amount(Payment.Amount(minor: minor, currency: currency), locale: Locale(identifier: locale))
        }
        #expect(amount(4900, "EUR") == "€49.00")
        #expect(amount(4900, "EUR", "de_DE") == "49,00\u{00A0}€")
        #expect(amount(124_000, "EUR", "de_DE") == "1.240,00\u{00A0}€")
        // Yen have no minor unit, Kuwaiti dinars three.
        #expect(amount(1500, "JPY") == "JP¥1,500")
        #expect(amount(1500, "JPY", "ja_JP") == "¥1,500")
        #expect(amount(12_345, "KWD") == "KWD\u{00A0}12.345")
        // ISO 4217's digits, not Foundation's: it says 0 for Iraqi dinars, which have 3, so 12.345 would read 12.
        #expect(amount(12_345, "IQD") == "IQD\u{00A0}12.345")
        #expect(amount(123_450, "HUF") == "HUF\u{00A0}1,234.50")
        #expect(PaymentWords.minorDigits(of: "JPY") == 0 && PaymentWords.minorDigits(of: "jpy") == 0)
        #expect(PaymentWords.minorDigits(of: "KWD") == 3 && PaymentWords.minorDigits(of: "CLF") == 4)
        #expect(PaymentWords.minorDigits(of: "EUR") == 2 && PaymentWords.minorDigits(of: "XYZ") == 2)
    }

    @Test func theDateIsSaidAsDueOrOnAndNeverOncePaid() {
        func subtitle(_ category: UsualMailKit.Category, _ state: PaymentState?, refund: Bool = false) -> String? {
            PaymentWords(
                thread(category, refund: refund, state: state, due: "2026-12-02", what: "Your server"), locale: gb)?
                .subtitle
        }
        #expect(subtitle(.invoice, .scheduled) == "Your server · on 2 Dec")
        #expect(subtitle(.receipt, .scheduled) == "Your server · on 2 Dec")
        #expect(subtitle(.invoice, .due) == "Your server · due 2 Dec")
        #expect(subtitle(.receipt, .due) == "Your server · due 2 Dec")
        #expect(subtitle(.invoice, nil) == "Your server · due 2 Dec")
        // Paid: no date, even one that slipped through.
        #expect(subtitle(.invoice, .paid) == "Your server")
        #expect(subtitle(.receipt, .paid) == "Your server")
        #expect(subtitle(.receipt, nil) == "Your server")
        #expect(subtitle(.receipt, .paid, refund: true) == "Your server")
        #expect(subtitle(.receipt, nil, refund: true) == "Your server")
        // Alone, it starts the line.
        let alone = thread(.invoice, state: .scheduled, due: "2026-12-02", snippet: "")
        #expect(PaymentWords(alone, locale: gb)?.subtitle == "On 2 Dec")
    }

    @Test func theSubtitleIsWhatForWithWhenAnInvoiceIsDue() {
        func subtitle(_ thread: MailThread) -> String? { PaymentWords(thread, locale: gb)?.subtitle }
        let what = "October's bean delivery"
        #expect(subtitle(thread(.invoice, due: "2026-11-30", what: what)) == "October's bean delivery · due 30 Nov")
        #expect(subtitle(thread(.invoice, what: what)) == what)
        // A receipt is never due.
        #expect(subtitle(thread(.receipt, due: "2026-11-30", what: what)) == what)
        // Without `what`, the snippet as one run of text.
        #expect(subtitle(thread(.receipt, snippet: "Thanks for\n your  order")) == "Thanks for your order")
        #expect(subtitle(thread(.receipt, details: false)) == "The mail's first words")
        #expect(subtitle(thread(.invoice, due: "2026-12-01")) == "The mail's first words · due 1 Dec")
        #expect(subtitle(thread(.invoice, due: "2026-12-01", snippet: "")) == "Due 1 Dec")
        #expect(subtitle(thread(.receipt, snippet: "")) == "")
        // A date that isn't one is left out.
        #expect(subtitle(thread(.invoice, due: "2026-02-30", what: what)) == what)
        #expect(subtitle(thread(.invoice, due: "30.11.2026", what: what)) == what)
    }

    @Test func aDueDateIsACalendarDateThatNeverMovesADay() {
        // Read and written in one fixed calendar, so the first and last days of the year stay where they are
        // whatever the Mac's time zone.
        #expect(PaymentWords.day("2026-01-01") == "1 Jan")
        #expect(PaymentWords.day("2026-12-31") == "31 Dec")
        #expect(PaymentWords.day("2028-02-29") == "29 Feb")
        #expect(PaymentWords.day("2026-02-29") == nil)
        #expect(PaymentWords.day("") == nil && PaymentWords.day("2026-11") == nil)
    }

    @Test func theSamplesReceiptsAndInvoiceInBritishEnglish() throws {
        let sample = SampleData.bundled
        func words(_ id: String) throws -> PaymentWords? {
            PaymentWords(try #require(sample.threads.first { $0.id == id }), locale: gb)
        }
        let kestrel = try words("thr_6")
        #expect(kestrel?.title == "To be paid: €1,240.00 to Kestrel Roasters")
        #expect(kestrel?.subtitle == "October's bean delivery · due 30 Nov")
        let rail = try words("thr_10")
        #expect(rail?.title == "Paid to Rail Booking")
        #expect(rail?.subtitle == "Train tickets to Hamburg, Friday 20 November")
        let lumen = try words("thr_17")
        #expect(lumen?.title == "Refunded: €12.00 by Lumen Outdoor")
        #expect(lumen?.subtitle == "The returned rain jacket")
        let paperloop = try words("thr_3")
        #expect(paperloop?.title == "Paid: €49.00 to Paperloop")
        #expect(paperloop?.subtitle == "Your plan, renewing on 16 December")
        let cloudbase = try words("thr_18")
        #expect(cloudbase?.title == "Will be charged: €12.50 by Cloudbase Hosting")
        #expect(cloudbase?.subtitle == "Your server in November · on 2 Dec")
    }
}
