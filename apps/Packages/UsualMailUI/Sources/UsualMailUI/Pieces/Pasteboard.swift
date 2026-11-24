import Observation

#if os(macOS)
    import AppKit
#else
    import UIKit
#endif

/// Putting words on the system's pasteboard, for the person to paste elsewhere.
enum Pasteboard {
    @MainActor
    static func copy(_ text: String) {
        #if os(macOS)
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
        #else
            UIPasteboard.general.string = text
        #endif
    }
}

/// A copy button's moment of "Copied": the words go on the pasteboard, `copied` is true for `shown`, and a copy made
/// meanwhile keeps it so for its own full moment.
@MainActor
@Observable
final class CopyFeedback {
    private(set) var copied = false

    /// How long "Copied" shows.
    static let shown: Duration = .seconds(2)

    @ObservationIgnored private var copies = 0
    @ObservationIgnored private let put: @MainActor (String) -> Void
    @ObservationIgnored private let pause: @Sendable (Duration) async throws -> Void

    init(
        put: @escaping @MainActor (String) -> Void = { Pasteboard.copy($0) },
        pause: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) {
        self.put = put
        self.pause = pause
    }

    /// Copies `text`, then says so for a moment.
    func copy(_ text: String) async {
        put(text)
        copies += 1
        let mine = copies
        copied = true
        try? await pause(Self.shown)
        if copies == mine { copied = false }
    }
}
