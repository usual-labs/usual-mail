import Foundation

/// The JSON coders for talking to the server: ISO 8601 times in UTC with whole seconds (`IsoTime` in core), keys
/// sorted so request bodies are stable.
public enum MailJSON {
    public static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let text = try container.decode(String.self)
            guard let date = parseTime(text) else {
                throw DecodingError.dataCorruptedError(
                    in: container, debugDescription: "\"\(text)\" is not an ISO 8601 time")
            }
            return date
        }
        return decoder
    }

    public static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(formatTime(date))
        }
        return encoder
    }

    /// Accepts times with or without fractional seconds, in UTC or with an offset.
    public static func parseTime(_ text: String) -> Date? {
        if let date = try? Date(text, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)) {
            return date
        }
        return try? Date(text, strategy: Date.ISO8601FormatStyle())
    }

    /// `2026-11-16T09:30:00Z`: UTC, whole seconds, no fractions, as the contract writes every time. A fraction is
    /// dropped (rounded down).
    public static func formatTime(_ date: Date) -> String {
        let whole = Date(timeIntervalSince1970: date.timeIntervalSince1970.rounded(.down))
        return whole.formatted(Date.ISO8601FormatStyle())
    }
}
