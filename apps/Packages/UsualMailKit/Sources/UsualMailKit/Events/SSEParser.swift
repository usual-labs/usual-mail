import Foundation

/// One server-sent event.
public struct ServerSentEvent: Hashable, Sendable {
    /// The `event:` name, or `message` when the event had none.
    public var event: String
    /// The `data:` lines joined with line breaks.
    public var data: String
    /// The last `id:` seen so far, as the stream format defines it.
    public var id: String?

    public init(event: String = "message", data: String, id: String? = nil) {
        self.event = event
        self.data = data
        self.id = id
    }
}

/// Reads the `text/event-stream` format as the HTML standard defines it, from chunks that may split
/// anywhere: inside a line, between a CR and its LF, or inside a UTF-8 character.
public struct SSEParser: Sendable {
    private var line = Data()
    private var afterCR = false
    private var isFirstLine = true
    private var eventType = ""
    private var dataLines: [String] = []
    /// The last event id, which outlives the event that set it.
    public private(set) var lastEventID: String?
    /// The reconnection time the server asked for, in milliseconds.
    public private(set) var retry: Int?

    public init() {}

    /// Reads a chunk and returns the events it completed.
    public mutating func feed(_ chunk: Data) -> [ServerSentEvent] {
        var events: [ServerSentEvent] = []
        for byte in chunk {
            if afterCR {
                afterCR = false
                if byte == 0x0A { continue }
            }
            switch byte {
            case 0x0D:
                afterCR = true
                if let event = endLine() { events.append(event) }
            case 0x0A:
                if let event = endLine() { events.append(event) }
            default:
                line.append(byte)
            }
        }
        return events
    }

    /// The stream ended. An event without its closing blank line is dropped, as the standard says.
    public mutating func finish() {
        line.removeAll()
        eventType = ""
        dataLines.removeAll()
        afterCR = false
    }

    private mutating func endLine() -> ServerSentEvent? {
        var bytes = line
        line.removeAll(keepingCapacity: true)
        if isFirstLine {
            isFirstLine = false
            if bytes.starts(with: [0xEF, 0xBB, 0xBF]) { bytes.removeFirst(3) }
        }
        let text = String(decoding: bytes, as: UTF8.self)
        if text.isEmpty { return dispatch() }
        if text.hasPrefix(":") { return nil }

        let field: Substring
        var value: Substring
        if let colon = text.firstIndex(of: ":") {
            field = text[..<colon]
            value = text[text.index(after: colon)...]
            if value.hasPrefix(" ") { value.removeFirst() }
        } else {
            field = text[...]
            value = ""
        }
        switch field {
        case "event": eventType = String(value)
        case "data": dataLines.append(String(value))
        case "id": if !value.contains("\0") { lastEventID = String(value) }
        case "retry": if !value.isEmpty, value.allSatisfy(\.isASCIIDigit) { retry = Int(value) }
        default: break
        }
        return nil
    }

    private mutating func dispatch() -> ServerSentEvent? {
        defer {
            eventType = ""
            dataLines.removeAll()
        }
        guard !dataLines.isEmpty else { return nil }
        return ServerSentEvent(
            event: eventType.isEmpty ? "message" : eventType, data: dataLines.joined(separator: "\n"), id: lastEventID)
    }
}

extension Character {
    fileprivate var isASCIIDigit: Bool { isASCII && isNumber }
}
