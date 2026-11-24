import Foundation

/// What the server's AI read in a receipt or an invoice, each fact checked against the mail it was given (core's
/// `PaymentDetails`, docs/contract-ai.md, "Payment details"). A fact it couldn't check is nil. Whether it is paid, will
/// be charged or is to be paid is `state`, and the thread's category while that is nil. Plain text, never HTML.
public struct Payment: Codable, Hashable, Sendable {
    /// The company or person the money goes to or came from, as they call themselves; else the sender's name.
    public var party: String?
    /// How much, kept only when the same number is written in the mail. Never negative: a refund says so in `refund`.
    public var amount: Amount?
    /// The money came back to the reader. Only ever true on a receipt, and then `state` is `paid`.
    public var refund: Bool
    /// Where the money stands, or nil when the mail doesn't say, the server's copy is older than states, or the state
    /// is one this app doesn't know.
    public var state: PaymentState?
    /// A calendar date with no time zone ("2026-11-30") the mail states: when it will be charged (`scheduled`) or is
    /// due (`due`, or a nil state on an invoice). Never while the money is paid.
    public var dueDate: String?
    /// What it was for, in one short plain line, without the party or the amount. The thread's `summary` is this when
    /// there is one.
    public var what: String?

    public init(
        party: String? = nil, amount: Amount? = nil, refund: Bool = false, state: PaymentState? = nil,
        dueDate: String? = nil, what: String? = nil
    ) {
        self.party = party
        self.amount = amount
        self.refund = refund
        self.state = state
        self.dueDate = dueDate
        self.what = what
    }

    /// An amount in its currency's ISO 4217 minor units: cents for EUR, whole yen for JPY, fils for KWD.
    public struct Amount: Codable, Hashable, Sendable {
        /// The amount in the currency's minor units, never negative.
        public var minor: Int
        /// The ISO 4217 code, "EUR".
        public var currency: String

        public init(minor: Int, currency: String) {
            self.minor = minor
            self.currency = currency
        }
    }

    enum CodingKeys: String, CodingKey {
        case party, amount, refund, state, dueDate, what
    }

    /// Every field is written, null included, as the server writes them, so the copy's JSON matches the server's.
    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(party, forKey: .party)
        try container.encode(amount, forKey: .amount)
        try container.encode(refund, forKey: .refund)
        try container.encode(state?.rawValue, forKey: .state)
        try container.encode(dueDate, forKey: .dueDate)
        try container.encode(what, forKey: .what)
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        party = try container.decodeIfPresent(String.self, forKey: .party)
        amount = try container.decodeIfPresent(Amount.self, forKey: .amount)
        refund = try container.decodeIfPresent(Bool.self, forKey: .refund) ?? false
        // An unknown state is none, as the contract asks; an older server's copy has none.
        state = try container.decodeIfPresent(String.self, forKey: .state).flatMap(PaymentState.init(rawValue:))
        dueDate = try container.decodeIfPresent(String.self, forKey: .dueDate)
        what = try container.decodeIfPresent(String.self, forKey: .what)
    }
}

/// Where a receipt's or an invoice's money stands (core's `PaymentState`): paid, to be charged automatically
/// (`scheduled`), or to be paid by the reader (`due`). The category stays what sorting decided, so an invoice may be
/// `paid` and a receipt `due` or `scheduled`.
public enum PaymentState: String, Codable, Hashable, Sendable, CaseIterable {
    case paid, scheduled, due
}
