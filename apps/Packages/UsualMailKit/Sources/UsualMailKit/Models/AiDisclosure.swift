import Foundation

/// What saving an AI key sends and to whom (`AiDisclosure` in core/src/ai-words.ts). The server builds it
/// (`GET /v1/ai/disclosure`) so every interface shows the same words; an interface shows it as given before it saves a
/// key, which is the person's consent for every inbox on the server, now and later.
public struct AiDisclosure: Codable, Hashable, Sendable {
    /// One thing sent, or never sent: "To categorize it", then its words.
    public struct Item: Codable, Hashable, Sendable {
        public var label: String
        public var words: String

        public init(label: String, words: String) {
            self.label = label
            self.words = words
        }
    }

    /// The service the mail goes to: "Vercel's AI Gateway".
    public var service: String
    /// A whole sentence on where every inbox's mail goes.
    public var destination: String
    /// That the service's own terms then apply.
    public var terms: String
    /// "For each thread the AI processes, the server sends:"
    public var lead: String
    /// To categorize it, to summarize it, and never, in that order.
    public var sent: [Item]
    /// How far back it reaches.
    public var history: String

    public init(
        service: String, destination: String, terms: String, lead: String, sent: [Item], history: String
    ) {
        self.service = service
        self.destination = destination
        self.terms = terms
        self.lead = lead
        self.sent = sent
        self.history = history
    }
}
