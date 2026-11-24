import CoreTransferable
import SwiftUI
import UniformTypeIdentifiers
import UsualMailDesign
import UsualMailKit

/// The end of both paths of the guided set-up: the file Google downloaded, given to the server. On the Mac it can be
/// dropped here; "Choose file…" works on both. The app refuses a file too large before sending; the server's words
/// show for anything it refuses; when it already has a client file or inboxes under another client, its words, then
/// "Replace it" (the same file again, replacing) or Cancel. The set-up takes one file at a time.
///
/// Offered less height than it needs (a short window, where it stays in view below the scrolling part), the drop area
/// becomes one row; offered less than even that (a sheet at its smallest on a small iPhone), the section scrolls in
/// the room it has rather than running past it.
struct ClientFileDrop: View {
    let setup: GoogleClientSetup
    @State private var choosing = false
    @State private var targeted = false

    typealias Words = Onboarding.GoogleClient

    /// The note on the file's name: the secondary colour the card's other notes use (black at 50%, about 3.9:1 on the
    /// card; the window is always light).
    static let noteColor = Theme.secondary

    var body: some View {
        ViewThatFits(in: .vertical) {
            section(compact: false)
            section(compact: true)
            ScrollView { section(compact: true) }
                .scrollBounceBehavior(.basedOnSize)
        }
        .layoutMark(.file)
        .fileImporter(isPresented: $choosing, allowedContentTypes: [.json]) { result in
            guard case .success(let url) = result else { return }
            Task { await setup.give(fileAt: url) }
        }
    }

    private func section(compact: Bool) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(Words.fileTitle)
                .font(Theme.sans(12, weight: .semibold))
                .foregroundStyle(Theme.ink)
                .accessibilityAddTraits(.isHeader)
            if let note = setup.note {
                StepText(note)
            }
            if case .askingToReplace(let words) = setup.giving {
                StepText(words, color: Theme.ink)
                    .transition(.blurReveal)
                HStack(spacing: 16) {
                    Button {
                        Task { await setup.replace() }
                    } label: {
                        LightButtonLabel(title: Words.replace)
                    }
                    .buttonStyle(PlainControlStyle())
                    QuietButton(Words.cancel) { setup.cancelReplacing() }
                }
                .transition(.blurReveal)
            } else {
                giving(compact: compact)
                    .layoutMark(.drop)
                StepText(Words.fileNote, size: 10, color: Self.noteColor)
                    .layoutMark(.fileNote)
                if case .refused(let words) = setup.giving {
                    StepText(words, color: UsualColor.danger)
                        .transition(.blurReveal)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var sending: Bool { setup.isBusy }

    /// On the Mac a drop area around the button, its words above it, or beside it in one row where the room is short;
    /// on the iPhone the button alone.
    @ViewBuilder private func giving(compact: Bool) -> some View {
        #if os(macOS)
            Group {
                if compact {
                    HStack(spacing: 12) {
                        dropWords
                        Spacer(minLength: 0)
                        choose
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                } else {
                    VStack(spacing: 8) {
                        dropWords
                        choose
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                }
            }
            .background(Color.white.opacity(targeted ? 0.8 : 0.45), in: RoundedRectangle(cornerRadius: 10))
            .overlay {
                RoundedRectangle(cornerRadius: 10)
                    .strokeBorder(
                        Theme.ink.opacity(targeted ? 0.6 : 0.2), style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
            }
            .dropDestination(for: DroppedClientFile.self) { files, _ in
                guard let file = files.first, !sending else { return false }
                Task { await setup.give(file.read) }
                return true
            } isTargeted: {
                targeted = $0
            }
            .animation(.easeOut(duration: 0.15), value: targeted)
        #else
            choose
        #endif
    }

    private var dropWords: some View {
        Text(Words.dropHere)
            .font(Theme.sans(12))
            .foregroundStyle(Theme.secondary)
    }

    private var choose: some View {
        Button {
            choosing = true
        } label: {
            LightButtonLabel(title: sending ? Words.sending : Words.chooseFile, busy: sending)
        }
        .buttonStyle(PlainControlStyle())
        .disabled(sending)
    }
}

/// A JSON file dropped on the set-up, read where the system hands it over: the sandbox lets the app read a dropped
/// file there, and only at most one byte more than the server takes is read.
struct DroppedClientFile: Transferable {
    let read: GoogleClientFile.Read

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .json) { received in
            DroppedClientFile(read: GoogleClientFile.read(at: received.file))
        }
    }
}
