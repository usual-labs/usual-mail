import Foundation
import UsualMailKit

/// Whether the party a money row names is the sender's own organisation, so the sender's picture may sit beside it
/// (the rule that a logo never sits beside someone else's name; coordinator's decision of 2026-11-19 after a
/// marketplace's refund named the merchant beside the marketplace's logo). Conservative: when unsure, it isn't, and
/// the row draws the party's initials instead.
///
/// The rule: both sides become words (case and accents aside, split at anything not a letter or digit, legal endings
/// such as GmbH, AG, Inc or Ltd dropped). The sender is known by its display name and by its address's domain name
/// (the label before the top-level domain, "amazon" in "auto-confirm@amazon.de", skipping a second level such as
/// "co" in "shop.co.uk"). They match when the party's words are the start of one of those, word for word, or one of
/// those is the start of the party's: "Amazon" matches "Amazon.de"; "Quillpad" matches "Quillpad Console"; "KORVANO"
/// matches neither "Amazon.de" nor "amazon". The first word must have at least two characters.
enum PartyMatch {
    static func isSender(party: String, sender: Address?) -> Bool {
        let partyWords = words(party)
        guard let first = partyWords.first, first.count >= 2, let sender else { return false }
        var names: [[String]] = []
        if let name = sender.name { names.append(words(name)) }
        if let label = domainLabel(of: sender.email) { names.append([label]) }
        return names.contains { name in
            guard !name.isEmpty else { return false }
            return name.starts(with: partyWords) || partyWords.starts(with: name)
        }
    }

    /// Legal endings that don't name an organisation.
    static let legalEndings: Set<String> = [
        "gmbh", "ag", "kg", "eg", "se", "sa", "sas", "sarl", "srl", "spa", "bv", "nv", "inc", "ltd", "llc", "plc",
        "corp", "corporation", "limited", "company", "ug",
    ]

    /// A name's words, lowercased without accents, legal endings dropped.
    static func words(_ text: String) -> [String] {
        let folded = text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "en"))
        return folded.split { !$0.isLetter && !$0.isNumber }.map(String.init).filter { !legalEndings.contains($0) }
    }

    /// Second levels under a country's domain that aren't a name ("co" in "co.uk").
    static let secondLevels: Set<String> = ["co", "com", "org", "net", "ac", "gov", "edu", "ne", "or"]

    /// The domain's name label: the one before the top-level domain, or before a second level under it.
    static func domainLabel(of email: String) -> String? {
        guard let at = email.lastIndex(of: "@") else { return nil }
        var labels = email[email.index(after: at)...].lowercased().split(separator: ".").map(String.init)
        guard labels.count >= 2 else { return nil }
        labels.removeLast()
        if labels.count >= 2, let last = labels.last, secondLevels.contains(last) { labels.removeLast() }
        guard let label = labels.last, label.count >= 2 else { return nil }
        return label
    }
}
