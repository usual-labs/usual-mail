import Foundation
import Testing

@testable import UsualMailKit

/// The server's Google client set up from this device (core/src/google-client.ts, google-setup.ts): the routes, the
/// models, and what the guided set-up `GoogleSignInStep` shows while the server has no client offers.
struct GoogleClientSetupModelTests {
    @Test func theSetUpDecodesAsCoreWritesIt() throws {
        let setup = try MailJSON.decoder().decode(GoogleSetup.self, from: Data(GoogleSetupServer.guided.utf8))
        #expect(setup.googleSignIn.missing == [.client])
        #expect(setup.googleSignIn.redirectUri == GoogleSetupServer.redirect)
        #expect(setup.client == GoogleClientState(source: .none, changeable: true))
        #expect(setup.prompt?.contains("- Redirect address: \(GoogleSetupServer.redirect)") == true)
        #expect(setup.promptNote?.hasPrefix("Sign in to console.cloud.google.com") == true)
        #expect(setup.steps?.map(\.id) == [.project, .gmailApi, .client, .unknown("later_step")])
        #expect(setup.steps?.first?.copy == [GoogleSetupValue(label: "Project name", value: "Usual Mail")])
        #expect(setup.steps?[1].copy == nil)
        #expect(setup.noAddress == nil)

        let none = try MailJSON.decoder().decode(GoogleSetup.self, from: Data(GoogleSetupServer.noAddress.utf8))
        #expect(none.prompt == nil && none.steps == nil && none.googleSignIn.redirectUri == nil)
        #expect(none.noAddress?.hasPrefix("This server doesn't know its own address") == true)

        // A newer server's words about the client, and fields this app doesn't know, decode; an older one's absence too.
        let noted = try MailJSON.decoder().decode(
            GoogleClientState.self,
            from: Data(#"{"source":"later","clientId":"c.example","changeable":true,"note":"Mind this.","x":1}"#.utf8))
        #expect(
            noted
                == GoogleClientState(
                    source: .unknown("later"), clientId: "c.example", changeable: true, note: "Mind this."))
    }

    @Test func whatTheServerAnswersOnceSavedDecodes() throws {
        let saved = try MailJSON.decoder().decode(GoogleClientSaved.self, from: Data(GoogleSetupServer.saved.utf8))
        #expect(saved.clientId == "c.apps.googleusercontent.example" && !saved.replaced)
        #expect(saved.googleSignIn == GoogleSignInInfo(available: true, redirectUri: GoogleSetupServer.redirect))
        #expect(saved.redirectHint?.hasPrefix("The client file doesn't list") == true)
        let plain = try MailJSON.decoder().decode(
            GoogleClientSaved.self,
            from: Data(#"{"clientId":"c","replaced":true,"googleSignIn":{"available":true}}"#.utf8))
        #expect(plain.redirectHint == nil && plain.replaced)
    }

    @Test func theRoutesSendWhatTheContractSays() async throws {
        let transport = StubTransport { request in
            request.httpMethod == "GET" ? .raw(GoogleSetupServer.guided) : .raw(GoogleSetupServer.saved)
        }
        let client = APIClient(server: testServer, token: "tok_1", transport: transport)
        _ = try await client.googleSetup()
        var request = try #require(transport.lastRequest)
        #expect(request.httpMethod == "GET" && request.pathAndQuery == "/v1/google/setup")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer tok_1")

        _ = try await client.setGoogleClient(file: GoogleSetupServer.file)
        request = try #require(transport.lastRequest)
        #expect(request.httpMethod == "PUT" && request.pathAndQuery == "/v1/google/client")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer tok_1")
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
        // The file's own bytes: its spacing, key order, escapes and last line break, never decoded and written again.
        #expect(request.httpBody == GoogleSetupServer.file)

        _ = try await client.setGoogleClient(file: GoogleSetupServer.file, replace: true)
        request = try #require(transport.lastRequest)
        #expect(request.pathAndQuery == "/v1/google/client?replace=true" && request.httpBody == GoogleSetupServer.file)
    }
}

/// What the set-up shows once asked for: the paths, or only the host's words; a set-up that can't be had; an older
/// server.
@MainActor
struct GoogleClientSetupLoadingTests {
    private func setup(_ server: GoogleSetupServer) -> GoogleClientSetup {
        GoogleClientSetup(client: APIClient(server: testServer, token: "tok_1", transport: server.transport)) { _ in }
    }

    private func decoded(_ json: String) -> GoogleSetup {
        try! MailJSON.decoder().decode(GoogleSetup.self, from: Data(json.utf8))
    }

    @Test func itOffersBothPathsTheAgentsFirst() async {
        let setup = setup(GoogleSetupServer())
        #expect(setup.loading == .loading && setup.shown == nil)
        await setup.load()
        #expect(setup.shown == .guided(paths: [.agent, .byHand]))
        #expect(setup.path == .agent && setup.shownPath == .agent)
        setup.path = .byHand
        #expect(setup.shownPath == .byHand)
        #expect(setup.note == nil)
    }

    @Test func onlyThePathsTheServerSentWordsFor() {
        var steps = decoded(GoogleSetupServer.guided)
        steps.prompt = nil
        #expect(GoogleClientSetup.shown(steps) == .guided(paths: [.byHand]))
        var prompt = decoded(GoogleSetupServer.guided)
        prompt.steps = []
        #expect(GoogleClientSetup.shown(prompt) == .guided(paths: [.agent]))
        var neither = steps
        neither.steps = nil
        #expect(GoogleClientSetup.shown(neither) == .hostOnly([Onboarding.GoogleClient.empty]))
    }

    @Test func withoutAnAddressOnlyItsHostCanAndNothingIsSent() async {
        let server = GoogleSetupServer(setup: GoogleSetupServer.noAddress)
        let setup = setup(server)
        await setup.load()
        #expect(setup.shown == .hostOnly([decoded(GoogleSetupServer.noAddress).noAddress!]))
        await setup.give(.file(GoogleSetupServer.file))
        #expect(setup.giving == .idle)
        #expect(server.puts.isEmpty)
    }

    @Test func aServerThatTakesNoClientFromADeviceSaysWhyAndNothingIsSent() async {
        let server = GoogleSetupServer(setup: GoogleSetupServer.demo)
        let setup = setup(server)
        await setup.load()
        #expect(setup.shown == .hostOnly([GoogleSetupServer.demoReason]))
        await setup.give(.file(GoogleSetupServer.file))
        #expect(setup.giving == .idle && server.puts.isEmpty)

        var both = decoded(GoogleSetupServer.noAddress)
        both.client = GoogleClientState(source: .none, changeable: false, reason: GoogleSetupServer.demoReason)
        #expect(GoogleClientSetup.shown(both) == .hostOnly([both.noAddress!, GoogleSetupServer.demoReason]))
    }

    @Test func theServersNoteOnTheClientShows() async {
        let noted = GoogleSetupServer.guided.replacingOccurrences(
            of: #""changeable":true"#,
            with: #""changeable":true,"note":"A Google client file is saved, but the server doesn't use it.""#)
        let setup = setup(GoogleSetupServer(setup: noted))
        await setup.load()
        #expect(setup.note == "A Google client file is saved, but the server doesn't use it.")
    }

    @Test func aSetUpThatCantBeHadSaysWhyAndTriesAgain() async {
        let server = GoogleSetupServer(setup: nil)
        let setup = setup(server)
        await setup.load()
        #expect(setup.loading == .failed("Your server couldn't say how to set up its Google client. The disk is full."))
        server.setup = GoogleSetupServer.guided
        await setup.load()
        #expect(setup.shown == .guided(paths: [.agent, .byHand]))
    }

    @Test func aServerOlderThanTheSetUpSaysTheApprovedWords() async {
        let server = GoogleSetupServer()
        server.older = true
        let setup = setup(server)
        await setup.load()
        #expect(setup.loading == .older && setup.shown == nil)
    }

    @Test func askingAgainQuietlyKeepsWhatItHadWhenTheServerCantBeAsked() async {
        let server = GoogleSetupServer()
        let setup = setup(server)
        await setup.load()
        let before = setup.loading
        server.unreachable = true
        await setup.refresh()
        #expect(setup.loading == before)
        // And follows a server that no longer takes a client from a device.
        server.unreachable = false
        server.setup = GoogleSetupServer.demo
        await setup.refresh()
        #expect(setup.shown == .hostOnly([GoogleSetupServer.demoReason]))
    }
}
