import UsualMailKit

/// The quiet line above a mail that says what the server did with its HTML and pictures from the web
/// (docs/contract-pictures.md): that its HTML was too long to show, how many trackers it took out, and why the other
/// pictures are held back. Nothing when it did none of these.
enum PictureWords {
    /// "This message is too long to show as designed.", "2 trackers removed", "Pictures show once you let this sender
    /// in.", those that apply joined with " · ", only the last keeping its full stop; nil when there is nothing to say.
    static func line(for pictures: RemotePictures?, htmlTooLarge: Bool = false) -> String? {
        var parts: [String] = []
        if htmlTooLarge { parts.append("This message is too long to show as designed.") }
        guard let pictures else { return parts.first }
        switch pictures.trackersRemoved {
        case ..<1: break
        case 1: parts.append("1 tracker removed")
        case let count: parts.append("\(count) trackers removed")
        }
        switch pictures.heldBack {
        case nil: break
        case .screened: parts.append("Pictures show once you let this sender in.")
        case .blocked: parts.append("Pictures from blocked senders aren't shown.")
        case .unknown: parts.append("Pictures are held back.")
        }
        guard let last = parts.popLast() else { return nil }
        // Only the last part keeps its full stop: "…as designed · 1 tracker removed · Pictures … aren't shown."
        let leading = parts.map { $0.hasSuffix(".") ? String($0.dropLast()) : $0 }
        return (leading + [last]).joined(separator: " · ")
    }

    /// Who made the trackers taken out, as the server's list names them: "From Mailchimp and HubSpot". Nil when no
    /// tracker was taken out or the list knew none of them.
    static func tooltip(for pictures: RemotePictures?) -> String? {
        guard let pictures, pictures.trackersRemoved > 0, !pictures.trackers.isEmpty else { return nil }
        return "From \(joined(pictures.trackers))"
    }

    /// Names joined the English way, without a comma before "and": "A", "A and B", "A, B and C".
    static func joined(_ names: [String]) -> String {
        guard let last = names.last else { return "" }
        guard names.count > 1 else { return last }
        return names.dropLast().joined(separator: ", ") + " and " + last
    }
}
