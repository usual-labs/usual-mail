import AppKit
import Foundation
import SwiftUI
import Testing
import UsualMailKit

@testable import UsualMailUI

/// The guided set-up of the server's Google client, shown where Sign in with Google would be while the server has
/// none: the app's own words, the only pages it opens, "Copied" for a moment, the Gmail step's notes held back while
/// there is nothing to sign in with, and the whole set-up scrolling rather than running past a short window or sheet.
@MainActor
struct GoogleClientSetupViewTests {
    typealias Words = Onboarding.GoogleClient

    /// Every sentence the app itself says in the set-up.
    private var everyWord: [String] {
        [
            Words.lead, Words.agentPath, Words.byHandPath, Words.agentLine, Words.copyPrompt, Words.copied,
            Words.seePrompt, Words.open, Words.fileTitle, Words.dropHere, Words.chooseFile, Words.fileNote,
            Words.sending, Words.tooLarge, Words.unreadable, Words.notSent, Words.replace, Words.cancel, Words.saved,
            Words.keptUnused, Words.notLoaded, Words.older, Words.empty, Words.copyLabel("Scope"),
            Words.openLabel("Create a project"),
        ]
    }

    @Test func theWordsArePlainAndDontRepeatTheServersNote() {
        for words in everyWord {
            #expect(!words.contains("—") && !words.contains("–"), "\(words)")
            #expect(words == words.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        // The server's note says how to sign in and hand the prompt over, and what stays with the person.
        for said in ["Sign in", "terms", "browser"] {
            #expect(!Words.agentLine.contains(said))
        }
        #expect(Words.agentPath == "Let my agent do it" && Words.byHandPath == "Do it myself")
        #expect(Words.fileTitle == "Give the file to your server" && Words.chooseFile == "Choose file…")
        #expect(Words.lead.hasPrefix("Your server can't sign in to Google yet."))
    }

    /// The note under the drop area is in the card's secondary colour, as its other notes, not the faint time colour.
    @Test func theFilesNoteReadsLikeTheCardsOtherNotes() {
        #expect(Words.fileNote == "It's the JSON file Google downloaded. Its name starts with client_secret_.")
        let card = Self.over(Theme.card, on: (1, 1, 1))
        let note = Self.over(ClientFileDrop.noteColor, on: card)
        let faint = Self.over(Theme.time, on: card)
        #expect(Self.contrast(note, card) > 3.5, "\(Self.contrast(note, card))")
        #expect(Self.contrast(faint, card) < 2.5)
    }

    /// `color` drawn over an opaque `ground`, as sRGB channels from 0 to 1.
    private static func over(_ color: Color, on ground: (Double, Double, Double)) -> (Double, Double, Double) {
        let resolved = color.resolve(in: EnvironmentValues())
        let alpha = Double(resolved.opacity)
        func mix(_ top: Float, _ bottom: Double) -> Double { Double(top) * alpha + bottom * (1 - alpha) }
        // `Color.Resolved` gives linear channels; back to sRGB for mixing as the screen does.
        func srgb(_ linear: Float) -> Float {
            linear <= 0.0031308 ? linear * 12.92 : 1.055 * pow(linear, 1 / 2.4) - 0.055
        }
        return (
            mix(srgb(resolved.linearRed), ground.0), mix(srgb(resolved.linearGreen), ground.1),
            mix(srgb(resolved.linearBlue), ground.2)
        )
    }

    /// WCAG's contrast ratio of two opaque sRGB colours.
    private static func contrast(_ a: (Double, Double, Double), _ b: (Double, Double, Double)) -> Double {
        func luminance(_ c: (Double, Double, Double)) -> Double {
            func linear(_ v: Double) -> Double { v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
            return 0.2126 * linear(c.0) + 0.7152 * linear(c.1) + 0.0722 * linear(c.2)
        }
        let (x, y) = (luminance(a), luminance(b))
        return (max(x, y) + 0.05) / (min(x, y) + 0.05)
    }

    @Test func onlyGoogleCloudsConsoleOpens() {
        #expect(
            StepsPath.page("https://console.cloud.google.com/projectcreate")?.absoluteString
                == "https://console.cloud.google.com/projectcreate")
        #expect(StepsPath.page("https://CONSOLE.cloud.google.com/auth/clients") != nil)
        for refused in [
            "http://console.cloud.google.com/projectcreate", "https://accounts.google.com/",
            "https://console.cloud.google.com.evil.example/", "https://evil.example/console.cloud.google.com",
            "https://me@console.cloud.google.com/", "https://console.cloud.google.com:8443/",
            "file:///etc/hosts", "javascript:alert(1)", "console.cloud.google.com", "",
        ] {
            #expect(StepsPath.page(refused) == nil, "\(refused)")
        }
    }

    @Test func copiedShowsForItsMomentAndALaterCopyKeepsIt() async {
        let pauses = Pauses()
        let pasteboard = Pasted()
        let feedback = CopyFeedback(put: { pasteboard.all.append($0) }, pause: { _ in await pauses.next() })
        let first = Task { await feedback.copy("the prompt") }
        await pauses.waitFor(1)
        #expect(pasteboard.all == ["the prompt"] && feedback.copied)
        let second = Task { await feedback.copy("the scope") }
        await pauses.waitFor(2)
        // The first moment ends while the second runs: still "Copied".
        await pauses.release(0)
        await first.value
        #expect(feedback.copied)
        await pauses.release(1)
        await second.value
        #expect(!feedback.copied && pasteboard.all == ["the prompt", "the scope"])
        #expect(CopyFeedback.shown == .seconds(2))
    }

    @Test func theGmailStepsNotesWaitWhileThereIsNothingToSignInWith() {
        #expect(GoogleSignInStep.holdsNotes(nil))
        #expect(GoogleSignInStep.holdsNotes(.checking))
        #expect(GoogleSignInStep.holdsNotes(.needsClient))
        #expect(!GoogleSignInStep.holdsNotes(.ready))
        #expect(!GoogleSignInStep.holdsNotes(.unavailable("Your server is older.")))
        #expect(!GoogleSignInStep.holdsNotes(.failed("No.")))
    }

    /// A card with the server's note and a refusal showing, offered less than it needs: the set-up takes what is left
    /// and scrolls, so the card stays inside what it is offered.
    @Test func theSetUpScrollsInsteadOfRunningPastTheWindow() async throws {
        let setup = try await longSetUp()
        await setup.give(.tooLarge)
        #expect(setup.giving == .refused(Words.tooLarge))
        let card = VStack(alignment: .leading, spacing: 16) {
            StepTitle("Connect your Gmail")
            StepText(GmailStep.words)
            GoogleClientGuide(setup: setup)
            Color.gray.frame(height: 32)
        }
        .padding(24)
        .frame(width: 440)
        // At its own height it needs more than 420 points; offered the window, or 420, it stays inside.
        #expect(try height(of: card, offered: nil) > 420)
        #expect(try height(of: card, offered: 560) <= 560)
        #expect(try height(of: card, offered: 420) <= 420)
    }

    /// In a sheet on a window of a given height, the set-up stops at that window's limit and scrolls.
    @Test func inASheetTheSetUpStopsAtItsWindowsLimit() async throws {
        let setup = try await longSetUp()
        let window = CGSize(width: 820, height: 560)
        let guide = GoogleClientGuide(setup: setup).frame(width: 332).environment(\.windowSize, window)
        #expect(try height(of: guide, offered: nil) == GoogleClientGuide.cap(window: window))
    }

    /// A set-up whose steps run far past any window, with the server's note.
    private func longSetUp() async throws -> GoogleClientSetup {
        let line = "A line of the step, long enough to wrap onto a second line in the card at its width."
        let steps = (1...12).map { index in
            #"{"id":"project","title":"Step \#(index)","lines":["\#(line)","\#(line)"],"url":"https://console.cloud.google.com/x","copy":[{"label":"Name","value":"Usual Mail"}]}"#
        }
        let json =
            #"{"googleSignIn":{"available":false,"redirectUri":"http://127.0.0.1:8484/v1/google/callback","missing":["client"]},"#
            + #""client":{"source":"none","changeable":true,"note":"\#(line) \#(line)"},"#
            + #""prompt":"Set up.","promptNote":"\#(line)","steps":[\#(steps.joined(separator: ","))]}"#
        let setup = GoogleClientSetup(
            client: APIClient(
                server: try ServerAddress(parsing: "http://mail.local:8787"), token: "tok_1",
                transport: SetupTransport(json: json))
        ) { _ in }
        await setup.load()
        setup.path = .byHand
        #expect(setup.shown == .guided(paths: [.agent, .byHand]))
        return setup
    }

    private func height(of view: some View, offered: CGFloat?) throws -> CGFloat {
        _ = NSHostingView(rootView: EmptyView())
        let renderer = ImageRenderer(content: view)
        renderer.scale = 1
        renderer.proposedSize = ProposedViewSize(width: nil, height: offered)
        let image = try #require(renderer.cgImage)
        return CGFloat(image.height)
    }
}

/// Answers every request with the same set-up.
private struct SetupTransport: HTTPTransport {
    let json: String

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
        return (Data(json.utf8), response)
    }

    func stream(for request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, any Error>) {
        throw URLError(.unsupportedURL)
    }
}

/// What was put on the pasteboard.
@MainActor
private final class Pasted {
    var all: [String] = []
}

/// Pauses that end only when the test says, in the order they began.
@MainActor
private final class Pauses {
    private var waiting: [CheckedContinuation<Void, Never>?] = []
    private var begun = 0

    func next() async {
        await withCheckedContinuation { continuation in
            waiting.append(continuation)
            begun += 1
        }
    }

    func waitFor(_ count: Int) async {
        while begun < count { await Task.yield() }
    }

    func release(_ index: Int) async {
        waiting[index]?.resume()
        waiting[index] = nil
        await Task.yield()
    }
}
