import AppKit
import Foundation
import SwiftUI
import Testing
import UsualMailKit

@testable import UsualMailUI

/// The guided Google set-up laid out for real, in an offscreen window that is never shown: the first run's Gmail step
/// (its own tasks asking a stand-in server with no Google client, which answers the set-up as core writes it), in the
/// app's own fonts (registered as the app registers them at launch), and the sheet. The sizes are the windows' content
/// under their 32-point title strip, as captured on screen: 1512 × 982 is 1512 × 950 here, 1100 × 620 is 1100 × 588,
/// and the smallest, 820 × 592, is 820 × 560. Where things end up is read from the layout marks (`LayoutMarks`), and
/// whether the scrolling part fits from `FittedScrollFits`.
@MainActor
struct GoogleSetupLayoutTests {
    /// The default window's content.
    nonisolated static let large = CGSize(width: 1512, height: 950)
    /// A short window's content.
    nonisolated static let short = CGSize(width: 1100, height: 588)
    /// The smallest window's content.
    nonisolated static let small = CGSize(width: 820, height: 560)

    @Test func atTheDefaultWindowTheWholeAgentPathShowsWithRoomAround() async throws {
        let seen = try await show(gmailStep, in: Self.large)
        try seen.expectMargins(in: Self.large)
        #expect(seen.fits == [true])
        // The drop area and the note under it are wholly inside the card, below the part above, which shows whole.
        try seen.expectFileInView()
        try seen.expectPromptActionsInView()
        // The card is as tall as its content, inside the window with room to spare (about 605 on screen).
        #expect(seen.card.height > 560 && seen.card.height < 660, "\(seen.card)")
        #expect(seen.card.minY > 120)
        // The content is as wide as the card's other words (440 less 2 × 24), with no bar beside it.
        #expect(seen.marks[.drop]?.width == 392)
    }

    @Test(arguments: [GoogleSetupLayoutTests.short, GoogleSetupLayoutTests.small])
    func inAShortWindowTheFileStaysInViewAndThePartAboveScrolls(window: CGSize) async throws {
        let seen = try await show(gmailStep, in: window)
        try seen.expectMargins(in: window)
        #expect(seen.fits == [false], "\(window)")
        try seen.expectFileInView()
        // "Copy the prompt" comes first in the agent's path, so it shows above the fade, not under it.
        try seen.expectPromptActionsInView()
        // The part above keeps a useful height, its bar beside the content, not on it.
        let viewport = try #require(seen.marks[.viewport])
        #expect(viewport.height >= GuideLayout.useful - 0.5, "\(window): \(viewport)")
        let drop = try #require(seen.marks[.drop])
        #expect(drop.width == 392)
        #expect(viewport.maxX - FittedScrollMetrics.fixedBar >= seen.card.maxX - 24 - 1)
    }

    @Test func doingItByHandScrollsAboveTheFileAtTheDefaultWindow() async throws {
        let setup = try await loadedSetup(path: .byHand)
        let card = VStack(alignment: .leading, spacing: 16) {
            StepTitle("Connect your Gmail")
            StepText(GmailStep.words)
            GoogleClientGuide(setup: setup)
            Color.gray.frame(height: 36)
        }
        .onboardingCard()
        let seen = try await show(card, in: Self.large)
        try seen.expectMargins(in: Self.large)
        // Seven steps are taller than the window: the card takes the window less its margin, the steps scroll, and the
        // file section stays whole below them.
        #expect(seen.fits == [false])
        #expect(seen.card.height > Self.large.height - 2 * 24 - 2)
        try seen.expectFileInView()
    }

    @Test func theSheetFitsItsWindowAndKeepsTheFileInView() async throws {
        for (window, fits) in [(CGSize(width: 1512, height: 950), true), (Self.small, false)] {
            let setup = try await loadedSetup(path: .agent)
            let sheet = VStack(alignment: .leading, spacing: 16) {
                StepTitle(AddGmailSheet.title)
                GoogleClientGuide(setup: setup)
                StepText(GmailStep.testUser, size: 10, color: Theme.time)
                Color.gray.frame(height: 32)
            }
            .padding(24)
            .frame(width: 380, alignment: .leading)
            .frame(maxHeight: AddGmailSheet.maxHeight(window: window))
            .environment(\.windowSize, window)
            // A sheet is as tall as its content wants, at most its limit.
            Theme.registerFonts()
            let wanted = sizeOf(sheet, width: 380)
            #expect(wanted.height <= window.height - 48, "\(window): \(wanted)")
            let seen = try await show(sheet, in: CGSize(width: 380, height: wanted.height), framed: false)
            #expect(seen.fits == [fits], "\(window)")
            try seen.expectFileInView(in: CGRect(origin: .zero, size: CGSize(width: 380, height: wanted.height)))
        }
    }

    @Test func theFileGoesCompactOnlyWhenThePartAboveWouldLoseItsUsefulHeight() {
        // Whole when both fit.
        #expect(
            GuideLayout.plan(above: 300, regular: 150, compact: 100, room: 500, spacing: 12)
                == GuideLayout.Plan(above: 300, file: 150, compact: false))
        // The file whole, the part above scrolling in what is left.
        #expect(
            GuideLayout.plan(above: 600, regular: 150, compact: 100, room: 400, spacing: 12)
                == GuideLayout.Plan(above: 238, file: 150, compact: false))
        // Compact when the part above would drop below its useful height.
        #expect(
            GuideLayout.plan(above: 600, regular: 150, compact: 100, room: 250, spacing: 12)
                == GuideLayout.Plan(above: 138, file: 100, compact: true))
        // Shorter still, the file section stays compact and the part above keeps a sliver.
        #expect(
            GuideLayout.plan(above: 600, regular: 150, compact: 100, room: 160, spacing: 12)
                == GuideLayout.Plan(above: GuideLayout.sliver, file: 100, compact: true))
        // Where even that doesn't fit, the file section scrolls in what is left: nothing runs past the room.
        #expect(
            GuideLayout.plan(above: 600, regular: 150, compact: 100, room: 120, spacing: 12)
                == GuideLayout.Plan(above: GuideLayout.sliver, file: 60, compact: true))
        // Offered no height and no cap: whole.
        #expect(
            GuideLayout.plan(above: 2000, regular: 150, compact: 100, room: .infinity, spacing: 12).file == 150)
    }

    @Test func aSheetsOrSettingsLimitComesFromItsWindow() {
        #expect(GoogleClientGuide.cap(window: .zero) == .infinity)
        #expect(GoogleClientGuide.cap(window: CGSize(width: 1512, height: 982)) == CGFloat(742))
        #expect(GoogleClientGuide.cap(window: Self.small) == CGFloat(320))
        #expect(GoogleClientGuide.cap(window: CGSize(width: 400, height: 300)) == 240)
        #expect(AddGmailSheet.maxHeight(window: .zero) == nil)
        #expect(AddGmailSheet.maxHeight(window: Self.small) == CGFloat(512))
    }

    @Test func theScrollTakesItsContentsHeightWhereverThereIsRoom() {
        #expect(FittedLayout.height(natural: 420, offered: 900, cap: .infinity, floor: 80) == 420)
        #expect(FittedLayout.height(natural: 420, offered: 300, cap: .infinity, floor: 80) == 300)
        #expect(FittedLayout.height(natural: 420, offered: 20, cap: .infinity, floor: 80) == 80)
        #expect(FittedLayout.height(natural: 60, offered: 20, cap: .infinity, floor: 80) == 60)
        #expect(FittedLayout.height(natural: 420, offered: nil, cap: 320, floor: 80) == 320)
        #expect(FittedLayout.height(natural: 420, offered: nil, cap: .infinity, floor: 80) == 420)
        // The room kept beside the content: all of the gutter with no bar or a floating one, less an always-shown bar.
        #expect(FittedScrollMetrics.padding(gutter: 16, fits: true, fixedBar: 15) == 16)
        #expect(FittedScrollMetrics.padding(gutter: 16, fits: false, fixedBar: 15) == 1)
        #expect(FittedScrollMetrics.padding(gutter: 16, fits: false, fixedBar: 0) == 16)
        // Whether more lies beyond an edge, for the fades.
        let middle = ScrollEdges(content: 1000, visible: CGRect(x: 0, y: 200, width: 300, height: 300))
        #expect(!middle.fits && middle.moreAbove && middle.moreBelow)
        let top = ScrollEdges(content: 1000, visible: CGRect(x: 0, y: 0, width: 300, height: 300))
        #expect(!top.moreAbove && top.moreBelow)
        let all = ScrollEdges(content: 300, visible: CGRect(x: 0, y: 0, width: 300, height: 300))
        #expect(all.fits && !all.moreAbove && !all.moreBelow)
    }

    // MARK: Showing

    /// The first run's Gmail step as the window shows it, on a store whose server has no Google client.
    private var gmailStep: some View {
        let server = SetupServer()
        let session = AppSession(
            credentials: MemoryCredentialStore(), transport: server, databaseDirectory: nil, deviceName: "Test",
            listens: false)
        return GmailStep(session: session) {}
            .environment(store(server))
    }

    private func store(_ server: SetupServer) -> MailStore {
        MailStore(
            client: APIClient(
                server: try! ServerAddress(parsing: "http://127.0.0.1:8484"), token: "tok", transport: server),
            local: try! LocalStore())
    }

    private func loadedSetup(path: GoogleClientSetup.Path) async throws -> GoogleClientSetup {
        let setup = GoogleClientSetup(
            client: APIClient(
                server: try ServerAddress(parsing: "http://127.0.0.1:8484"), token: "tok", transport: SetupServer())
        ) { _ in }
        await setup.load()
        setup.path = path
        #expect(setup.shown == .guided(paths: [.agent, .byHand]))
        return setup
    }

    /// Hosts `view` in an offscreen window of `size`, inside the first run's frame unless it is a sheet, and waits until
    /// the set-up shows.
    private func show(_ view: some View, in size: CGSize, framed: Bool = true) async throws -> Seen {
        // The app registers its fonts at launch; without them the words would be set in a stand-in face and wrap
        // differently from the screen.
        #expect(Theme.registerFonts().isEmpty)
        let seen = Seen()
        let root = Group {
            if framed {
                OnboardingFrame { view }
            } else {
                view.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            }
        }
        .overlayPreferenceValue(LayoutMarks.self) { marks in
            GeometryReader { proxy in
                let frames = marks.mapValues { proxy[$0] }
                Color.clear
                    .onAppear { seen.marks = frames }
                    .onChange(of: frames) { _, now in seen.marks = now }
            }
        }
        .onPreferenceChange(FittedScrollFits.self) { fits in
            MainActor.assumeIsolated { seen.fits = fits }
        }
        let host = NSHostingView(rootView: root)
        host.sizingOptions = []
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        window.setContentSize(size)
        defer { window.contentView = nil }
        try await waitUntil("the set-up is laid out") {
            host.layoutSubtreeIfNeeded()
            return seen.marks[.file] != nil && !seen.fits.isEmpty && (!framed || seen.marks[.card] != nil)
        }
        // Let the scroll view report its geometry, then read where everything ended up.
        try await Task.sleep(for: .milliseconds(100))
        host.layoutSubtreeIfNeeded()
        return seen
    }

    private func sizeOf(_ view: some View, width: CGFloat) -> CGSize {
        let host = NSHostingView(rootView: view)
        return host.fittingSize
    }
}

/// What the layout came to, in the window's coordinates.
@MainActor
private final class Seen {
    var marks: [LayoutMark: CGRect] = [:]
    var fits: [Bool] = []

    var card: CGRect { marks[.card] ?? .zero }

    /// The file section (heading, drop area, note, any message) lies wholly inside `area` (the card, unless given) and
    /// clear of the scrolling part above it, so nothing of it is under that part's fade or scrolled away.
    func expectFileInView(in area: CGRect? = nil) throws {
        let area = area ?? card
        let file = try #require(marks[.file])
        let viewport = try #require(marks[.viewport])
        #expect(area.insetBy(dx: -0.5, dy: -0.5).contains(file), "\(file) outside \(area)")
        #expect(file.minY >= viewport.maxY - 0.5, "\(file) under \(viewport)")
        for mark in [LayoutMark.drop, .fileNote] {
            let frame = try #require(marks[mark])
            #expect(file.insetBy(dx: -0.5, dy: -0.5).contains(frame), "\(mark) \(frame) outside \(file)")
        }
    }

    /// The agent's row ("Copy the prompt", "See the prompt") lies inside the visible part of the scrolling part, clear
    /// of its bottom fade whenever that part doesn't fit (at rest, more then lies below).
    func expectPromptActionsInView() throws {
        let row = try #require(marks[.promptActions])
        let viewport = try #require(marks[.viewport])
        let fade = fits == [false] ? FittedScrollMetrics.fade : 0
        #expect(row.minY >= viewport.minY - 0.5, "\(row) above \(viewport)")
        #expect(row.maxY <= viewport.maxY - fade + 0.5, "\(row) under the fade of \(viewport)")
    }

    /// The card keeps at least the first run's margin from each edge of a window of `size`.
    func expectMargins(in size: CGSize) throws {
        let card = try #require(marks[.card])
        let margin: CGFloat = 24 - 0.5
        #expect(card.minX >= margin && card.minY >= margin, "\(card) in \(size)")
        #expect(card.maxX <= size.width - margin && card.maxY <= size.height - margin, "\(card) in \(size)")
    }
}

/// A server with no Google client that answers the set-up as core writes it; nothing else.
private struct SetupServer: HTTPTransport {
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let body: String
        var status = 200
        switch request.url?.path {
        case "/v1/info":
            body =
                #"{"name":"usual-mail","version":"0.2.0","apiVersion":1,"googleSignIn":{"available":false,"#
                + #""redirectUri":"http://127.0.0.1:8484/v1/google/callback","missing":["client"]}}"#
        case "/v1/google/setup":
            body = GoogleSetupFixture.core
        default:
            body = #"{"error":{"code":"not_found","message":"No such route"}}"#
            status = 404
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
        return (Data(body.utf8), response)
    }

    func stream(for request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, any Error>) {
        throw URLError(.unsupportedURL)
    }
}
