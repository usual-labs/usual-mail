import Foundation
import UsualMailKit

/// A receipt's or an invoice's words, on the Receipts tab's rows and in the mail page's box (owner's words of
/// 2026-11-19: "title will show how much from where is invoiced, and the subtitle gives a short summary of for what",
/// the title starting with where the money stands: "To be paid", "Paid", or, for a bill collected automatically,
/// "Will be charged"). The server sends only the facts (`MailThread.payment`); the app composes the words. Where the
/// money stands is the server's `state`, else the thread's category (an invoice to be paid, a receipt paid).
/// Everything here is plain text from a model and is only ever shown as text.
struct PaymentWords: Equatable, RowWords {
    /// "To be paid: €1,240.00 to Kestrel Roasters", "Will be charged: €12.50 by Cloudbase Hosting", "Paid to Rail
    /// Booking", "Refunded: €12.00 by Lumen Outdoor", or, with neither the amount nor the party, the subject after
    /// where the money stands: "Paid · Your receipt".
    let title: String
    /// What it was for, with when it is due or will be charged ("October's bean delivery · due 30 Nov", "Your server
    /// in November · on 2 Dec"), never a date once paid; the mail's opening words when the server has no `what`.
    let subtitle: String

    /// Where the money stands, as the words say it.
    enum Standing: Equatable {
        case paid, refunded, scheduled, due

        /// A refund (only ever on a receipt) is refunded whatever its state says; otherwise the server's state, and
        /// while there is none, the category: an invoice is due, a receipt paid.
        init(_ payment: Payment?, invoice: Bool) {
            if !invoice && payment?.refund == true {
                self = .refunded
                return
            }
            switch payment?.state {
            case .paid: self = .paid
            case .scheduled: self = .scheduled
            case .due: self = .due
            case nil: self = invoice ? .due : .paid
            }
        }

        var verb: String {
            switch self {
            case .paid: "Paid"
            case .refunded: "Refunded"
            case .scheduled: "Will be charged"
            case .due: "To be paid"
            }
        }

        /// The money goes to the party, or comes from it: a refund, or a charge it takes.
        var preposition: String {
            switch self {
            case .paid, .due: "to"
            case .refunded, .scheduled: "by"
            }
        }

        /// How a date is said ("due 30 Nov", "on 2 Dec"); nil once paid, so a date that slipped through never shows.
        var dateWord: String? {
            switch self {
            case .due: "due"
            case .scheduled: "on"
            case .paid, .refunded: nil
            }
        }
    }

    /// The words of a receipt or an invoice, its amount in `locale`'s way; nil for any other thread.
    init?(_ thread: MailThread, locale: Locale = .current) {
        let invoice = thread.category == .invoice
        guard invoice || thread.category == .receipt else { return nil }
        let payment = thread.payment
        let standing = Standing(payment, invoice: invoice)
        let verb = standing.verb
        let preposition = standing.preposition
        // A zero amount is no amount: a model's 0 where the mail named none (2026-11-19; the server drops it too).
        let amount = payment?.amount.flatMap { $0.minor == 0 ? nil : Self.amount($0, locale: locale) }
        let party = HomeWords.oneLine(payment?.party ?? "")
        switch (amount, party.isEmpty) {
        case (let amount?, false): title = "\(verb): \(amount) \(preposition) \(party)"
        case (let amount?, true): title = "\(verb): \(amount)"
        case (nil, false): title = "\(verb) \(preposition) \(party)"
        case (nil, true): title = "\(verb) · \(thread.subject.isEmpty ? "(no subject)" : thread.subject)"
        }

        let what = HomeWords.oneLine(payment?.what ?? "")
        let about = what.isEmpty ? HomeWords.oneLine(thread.snippet) : what
        let date = standing.dateWord.flatMap { word in payment?.dueDate.flatMap(Self.day).map { "\(word) \($0)" } }
        switch (about.isEmpty, date) {
        case (false, let date?): subtitle = "\(about) · \(date)"
        case (true, let date?): subtitle = date.prefix(1).uppercased() + date.dropFirst()
        case (_, nil): subtitle = about
        }
    }

    /// The title over the subtitle, as the mail page's box shows them: one line each, the second left out when empty.
    var lines: String {
        subtitle.isEmpty ? title : "\(title)\n\(subtitle)"
    }

    /// An amount in `locale`'s way, "€1,240.00" in en_GB, "1.240,00 €" in de_DE: its minor units scaled by the
    /// currency's ISO 4217 minor digits, shown with exactly that many, so it reads as the mail wrote it.
    static func amount(_ amount: Payment.Amount, locale: Locale = .current) -> String {
        let digits = minorDigits(of: amount.currency)
        let value = Decimal(amount.minor) / pow(Decimal(10), digits)
        return value.formatted(.currency(code: amount.currency).locale(locale).precision(.fractionLength(digits)))
    }

    /// A currency's ISO 4217 minor digits: JPY 0, EUR 2, KWD 3. The server keeps amounts in these (its own table of
    /// ISO 4217's codes, `server/src/ai/currencies.ts`), so this mirrors that table rather than asking Foundation,
    /// whose figures follow CLDR and differ for some codes (0 for IQD, which has 3, and for HUF, LAK and LBP, which
    /// have 2). Every code not named has 2; the server drops amounts in codes it doesn't know.
    static func minorDigits(of currency: String) -> Int {
        let code = currency.uppercased()
        if zeroDigits.contains(code) { return 0 }
        if threeDigits.contains(code) { return 3 }
        if fourDigits.contains(code) { return 4 }
        return 2
    }

    private static let zeroDigits: Set = [
        "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "UYI", "VND", "VUV", "XAF", "XOF",
        "XPF",
    ]
    private static let threeDigits: Set = ["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]
    private static let fourDigits: Set = ["CLF", "UYW"]

    /// "30 Nov" for "2026-11-30", in the app's way of writing days (`HomeWords.ago`). The date is a calendar date with
    /// no time zone: it is read and written in one fixed calendar, so it never moves a day. Nil when it isn't one.
    static func day(_ date: String) -> String? {
        let parts = date.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3, let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]) else {
            return nil
        }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .gmt
        let components = DateComponents(year: year, month: month, day: day)
        guard components.isValidDate(in: calendar), let moment = calendar.date(from: components) else { return nil }
        let style = Date.FormatStyle(calendar: calendar, timeZone: calendar.timeZone).locale(
            Locale(identifier: "en_GB"))
        return moment.formatted(style.day().month(.abbreviated))
    }
}
