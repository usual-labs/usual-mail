import SwiftUI
import UsualMailKit

/// A small line of text in the window's bottom-right corner while the server works on mail (owner's direction of
/// 2026-11-18): fetching an inbox's mail, with how far its first sync has got (the owner's decision of 2026-11-23),
/// then sorting and summarizing it, with how many threads are left. Just words on the wallpaper, no container: dark
/// where the wallpaper under them is light and light where it is dark (`WallpaperTone`, worked out again when the person
/// changes the background or softens it), with a stronger halo where it is busy. They come in a blur reveal, count as
/// the server's inboxes and status change (the AI's at most once a second, a first sync's at most every two seconds),
/// and leave once nothing is happening.
struct ActivityNote: View {
    /// The window's size, to know which part of the wallpaper lies under the words.
    let window: CGSize
    @Environment(MailStore.self) private var store
    @State private var frame: CGRect = .zero

    var body: some View {
        let lines = ActivityWords.lines(inboxes: store.lists.inboxes, status: store.aiStatus)
        let measured = !frame.isEmpty
        let light = measured && WallpaperTone.isLight(under: frame, in: window)
        let busy = measured && WallpaperTone.isBusy(under: frame, in: window)
        ZStack(alignment: .bottomTrailing) {
            if !lines.isEmpty {
                VStack(alignment: .trailing, spacing: 2) {
                    ForEach(lines, id: \.self) { line in
                        Text(verbatim: line)
                            .font(Theme.sans(10))
                            .lineLimit(1)
                            .contentTransition(.numericText())
                    }
                }
                .foregroundStyle(light ? Color.black.opacity(0.7) : Color.white.opacity(0.9))
                .shadow(color: (light ? Color.white : Color.black).opacity(busy ? 0.6 : 0.25), radius: busy ? 3 : 2)
                .transition(.blurReveal)
                .accessibilityElement(children: .combine)
            }
        }
        .onGeometryChange(for: CGRect.self) {
            $0.frame(in: .global)
        } action: {
            frame = $0
        }
        .animation(Motion.reveal, value: lines)
        .animation(Motion.reveal, value: light)
    }
}

/// What the server is doing with mail, in a line each; empty when nothing is happening.
enum ActivityWords {
    static func lines(inboxes: [Inbox], status: AiStatus?) -> [String] {
        var lines: [String] = []
        // Connecting, or a first sync still running: how far they have got, those the server has a count for.
        let fetching = inboxes.filter(\.isFetching)
        let count = FirstSyncProgress.sum(fetching).map { " · \($0.count)" } ?? "…"
        if fetching.count == 1, let inbox = fetching.first {
            lines.append("Fetching mail from \(inbox.name)\(count)")
        } else if fetching.count > 1 {
            lines.append("Fetching mail from \(fetching.count) inboxes\(count)")
        }
        if let status, status.state == .working, status.pending > 0 {
            lines.append("Sorting and summarizing · \(status.pending) left")
        }
        return lines
    }
}
