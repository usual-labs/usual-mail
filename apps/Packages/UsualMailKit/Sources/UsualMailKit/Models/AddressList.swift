import Foundation

extension Address {
    /// The address as a person types it: `Dana Whitfield <dana@lumen.example>`, or the bare address.
    public var formatted: String {
        guard let name, !name.isEmpty else { return email }
        let needsQuotes = name.contains { ",;<>\"".contains($0) }
        let shown = needsQuotes ? "\"\(name.replacingOccurrences(of: "\"", with: ""))\"" : name
        return "\(shown) <\(email)>"
    }

    /// A list as a To or Cc field shows it, separated by commas.
    public static func format(_ list: [Address]) -> String {
        list.map(\.formatted).joined(separator: ", ")
    }

    /// Reads what a person typed into a To or Cc field: entries separated by commas or semicolons, each a bare
    /// address or `Name <address>`, with or without quotes around the name. Entries that aren't an address come
    /// back in `invalid`, as typed.
    public static func parseList(_ text: String) -> (addresses: [Address], invalid: [String]) {
        var addresses: [Address] = []
        var invalid: [String] = []
        for entry in split(text) {
            if let address = parse(entry) { addresses.append(address) } else { invalid.append(entry) }
        }
        return (addresses, invalid)
    }

    /// One entry, or nil when it holds no usable address.
    static func parse(_ entry: String) -> Address? {
        let trimmed = entry.trimmingCharacters(in: .whitespacesAndNewlines)
        if let open = trimmed.lastIndex(of: "<"), let close = trimmed.lastIndex(of: ">"), open < close {
            let email = String(trimmed[trimmed.index(after: open)..<close]).trimmingCharacters(in: .whitespaces)
            var name = String(trimmed[..<open]).trimmingCharacters(in: .whitespaces)
            if name.hasPrefix("\""), name.hasSuffix("\""), name.count >= 2 {
                name = String(name.dropFirst().dropLast())
            }
            guard isEmail(email) else { return nil }
            return Address(name: name.isEmpty ? nil : name, email: email.lowercased())
        }
        guard isEmail(trimmed) else { return nil }
        return Address(email: trimmed.lowercased())
    }

    /// One `@`, something before it, and a dotted domain after it, with no spaces or brackets.
    static func isEmail(_ text: String) -> Bool {
        let parts = text.split(separator: "@", omittingEmptySubsequences: false)
        guard parts.count == 2, !parts[0].isEmpty, parts[1].contains("."), !parts[1].hasPrefix("."),
            !parts[1].hasSuffix(".")
        else { return false }
        return !text.contains { $0.isWhitespace || "<>,;\"()[]".contains($0) }
    }

    /// Splits on commas and semicolons outside quotes and angle brackets, dropping empty entries.
    private static func split(_ text: String) -> [String] {
        var entries: [String] = []
        var current = ""
        var quoted = false
        var bracketed = false
        for character in text {
            switch character {
            case "\"": quoted.toggle()
            case "<" where !quoted: bracketed = true
            case ">" where !quoted: bracketed = false
            case ",", ";":
                if !quoted && !bracketed {
                    entries.append(current)
                    current = ""
                    continue
                }
            default: break
            }
            current.append(character)
        }
        entries.append(current)
        return entries.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    }
}
