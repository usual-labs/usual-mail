import Foundation
import Testing

@testable import UsualMailKit

/// Giving the server its Google client from the set-up: the file sent as it is, each refusal in the server's words,
/// asking before replacing only while a device may still give one, the set-up asked again before sending and after a
/// conflict, one file at a time, and stopping when the screen goes away.
@MainActor
struct GoogleClientGivingTests {
    private final class Settled: @unchecked Sendable {
        var all: [GoogleClientSetup.Settled] = []
    }

    private func setup(_ server: GoogleSetupServer, settled: Settled = Settled()) -> GoogleClientSetup {
        GoogleClientSetup(client: APIClient(server: testServer, token: "tok_1", transport: server.transport)) {
            settled.all.append($0)
        }
    }

    private func loaded(_ server: GoogleSetupServer, settled: Settled = Settled()) async -> GoogleClientSetup {
        let setup = setup(server, settled: settled)
        await setup.load()
        return setup
    }

    private var answer: GoogleClientSaved {
        try! MailJSON.decoder().decode(GoogleClientSaved.self, from: Data(GoogleSetupServer.saved.utf8))
    }

    @Test func theFileGoesAsItIsAfterTheSetUpIsAskedAgain() async throws {
        let server = GoogleSetupServer()
        let settled = Settled()
        let setup = await loaded(server, settled: settled)
        await setup.give(.file(GoogleSetupServer.file))
        #expect(setup.giving == .saved(answer))
        #expect(settled.all == [.saved(answer)])
        #expect(server.setups == 2)
        #expect(server.puts.map(\.pathAndQuery) == ["/v1/google/client"])
        #expect(server.puts.first?.httpBody == GoogleSetupServer.file)
    }

    @Test func aChosenFileIsReadThenSent() async throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "google-client-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let file = folder.appending(path: "client_secret_1.json")
        try GoogleSetupServer.file.write(to: file)
        let server = GoogleSetupServer()
        let setup = await loaded(server)
        await setup.give(fileAt: file)
        #expect(server.puts.first?.httpBody == GoogleSetupServer.file)
        await setup.give(fileAt: folder)
        #expect(setup.giving == .refused(Onboarding.GoogleClient.unreadable) && server.puts.count == 1)
    }

    @Test func aFileTooLargeIsRefusedInTheAppsWordsBeforeSending() async {
        let server = GoogleSetupServer()
        let setup = await loaded(server)
        await setup.give(GoogleClientFile.checked(Data(repeating: 0x20, count: 16_385)))
        #expect(setup.giving == .refused(Onboarding.GoogleClient.tooLarge))
        await setup.give(.unreadable)
        #expect(setup.giving == .refused(Onboarding.GoogleClient.unreadable))
        #expect(server.puts.isEmpty)
    }

    /// Each refusal in the server's own words, as it wrote them for a person.
    @Test(arguments: [
        (400, "invalid", "That file holds a Desktop app client, so nothing was saved."),
        (403, "needs_person", "Only a person's device can do this"),
        (500, "internal", "The server couldn't save the Google client, so nothing changed. The server's log says why."),
        (429, "rate_limited", "Too many tries."),
    ])
    func aRefusalShowsTheServersWords(status: Int, code: String, message: String) async {
        let setup = await loaded(GoogleSetupServer(puts: [.error(code, message, status: status)]))
        await setup.give(.file(GoogleSetupServer.file))
        #expect(setup.giving == .refused(message))
    }

    @Test func aDeviceTheServerNoLongerKnowsOrCantReachIsSaidInTheAppsWords() async {
        let unknown = await loaded(
            GoogleSetupServer(puts: [.error("unauthorized", "Sign in with Authorization: Bearer <token>", status: 401)])
        )
        await unknown.give(.file(GoogleSetupServer.file))
        #expect(unknown.giving == .refused("This device isn't signed in to the server any more."))

        let server = GoogleSetupServer()
        let away = await loaded(server)
        server.unreachable = true
        await away.give(.file(GoogleSetupServer.file))
        #expect(
            away.giving == .refused("The file wasn't sent. Can't reach your server. Nothing answered at its address."))
    }

    @Test func aServerWithAClientFileAsksBeforeTheSameFileReplacesIt() async throws {
        let conflict = "This server already has a Google client file, so nothing was saved."
        let server = GoogleSetupServer(puts: [.error("conflict", conflict, status: 409), .raw(GoogleSetupServer.saved)])
        let settled = Settled()
        let setup = await loaded(server, settled: settled)
        await setup.give(.file(GoogleSetupServer.file))
        #expect(setup.giving == .askingToReplace(conflict))
        #expect(setup.heldForReplacing == GoogleSetupServer.file)
        // Asked when loading, before sending, and after the conflict.
        #expect(server.setups == 3)
        #expect(settled.all.isEmpty)
        await setup.replace()
        #expect(server.puts.map(\.pathAndQuery) == ["/v1/google/client", "/v1/google/client?replace=true"])
        #expect(server.puts.map(\.httpBody) == [GoogleSetupServer.file, GoogleSetupServer.file])
        #expect(setup.giving == .saved(answer) && settled.all == [.saved(answer)])
        #expect(setup.heldForReplacing == nil)
    }

    @Test func aConflictThatCantBeReplacedShowsTheServersWordsAsItIsNow() async {
        // The host restarted in demo mode after the set-up was loaded: no Replace it, the server's reason instead.
        let server = GoogleSetupServer(puts: [.error("conflict", "This server keeps no Google client.", status: 409)])
        server.setupAfterPut = GoogleSetupServer.demo
        let setup = await loaded(server)
        await setup.give(.file(GoogleSetupServer.file))
        #expect(setup.giving == .idle && setup.heldForReplacing == nil)
        #expect(setup.shown == .hostOnly([GoogleSetupServer.demoReason]))
        await setup.replace()
        #expect(server.puts.count == 1)
    }

    @Test func aConflictWhenTheServerCantBeAskedAgainIsARefusal() async {
        let conflict = "This server already has a Google client file, so nothing was saved."
        let server = GoogleSetupServer(puts: [.error("conflict", conflict, status: 409)])
        // The set-up answers before the file is sent, then can't be read after the conflict.
        server.setupAfterPut = "not json"
        let setup = await loaded(server)
        await setup.give(.file(GoogleSetupServer.file))
        #expect(setup.giving == .refused(conflict) && setup.heldForReplacing == nil)
    }

    @Test func cancellingDropsTheFile() async {
        let conflict = "This server already has this Google client (the same client id), so nothing was saved."
        let server = GoogleSetupServer(puts: [.error("conflict", conflict, status: 409)])
        let setup = await loaded(server)
        await setup.give(.file(GoogleSetupServer.file))
        #expect(setup.heldForReplacing == GoogleSetupServer.file)
        setup.cancelReplacing()
        #expect(setup.giving == .idle && setup.heldForReplacing == nil)
        await setup.replace()
        #expect(server.puts.count == 1)
    }

    @Test func aConflictWhileReplacingIsARefusal() async {
        let first = "This server already has another Google client, so nothing was saved."
        let then = "USUAL_MAIL_GOOGLE_CLIENT_ID and USUAL_MAIL_GOOGLE_CLIENT_SECRET give this server its Google client."
        let setup = await loaded(
            GoogleSetupServer(puts: [.error("conflict", first, status: 409), .error("conflict", then, status: 409)]))
        await setup.give(.file(GoogleSetupServer.file))
        await setup.replace()
        #expect(setup.giving == .refused(then))
    }

    @Test func aClientGivenElsewhereIsUsedNotOverwritten() async {
        let server = GoogleSetupServer()
        let settled = Settled()
        let setup = await loaded(server, settled: settled)
        server.giveElsewhere()
        await setup.give(.file(GoogleSetupServer.file))
        #expect(server.puts.isEmpty)
        #expect(setup.giving == .idle)
        #expect(
            settled.all == [.alreadyThere(GoogleSignInInfo(available: true, redirectUri: GoogleSetupServer.redirect))])

        // The same when the screen comes back to the front.
        let later = GoogleSetupServer()
        let again = Settled()
        let shown = await loaded(later, settled: again)
        later.giveElsewhere()
        await shown.refresh()
        #expect(
            again.all == [.alreadyThere(GoogleSignInInfo(available: true, redirectUri: GoogleSetupServer.redirect))])
    }

    @Test func aFileKeptButNotUsableSaysSo() async {
        let server = GoogleSetupServer(puts: [.raw(GoogleSetupServer.savedUnused)])
        server.setupAfterPut = GoogleSetupServer.guided.replacingOccurrences(
            of: #""changeable":true"#, with: #""changeable":true,"note":"Other users can read the file.""#)
        let settled = Settled()
        let setup = await loaded(server, settled: settled)
        await setup.give(.file(GoogleSetupServer.file))
        #expect(setup.giving == .refused(Onboarding.GoogleClient.keptUnused))
        #expect(setup.note == "Other users can read the file.")
        #expect(settled.all.isEmpty)
    }

    @Test func aSecondFileWaitsForTheFirst() async {
        let server = GoogleSetupServer()
        server.holdsPuts = true
        let settled = Settled()
        let setup = await loaded(server, settled: settled)
        let first = Task { await setup.give(.file(GoogleSetupServer.file)) }
        await server.putStarted.wait()
        #expect(setup.isBusy)
        await setup.give(.file(Data("{}".utf8)))
        await setup.give(.tooLarge)
        #expect(setup.giving == .sending && server.puts.count == 1)
        // The screen goes away: the upload stops, and nothing is handed back.
        setup.stop()
        await first.value
        #expect(setup.giving == .idle && settled.all.isEmpty)
    }

    /// The whole step: the server has no client, so the set-up shows; once it took the file, the step is the button
    /// again by itself, with its notes, nothing is opened, and the store's word on the server agrees.
    @Test func onceTheServerHasItsClientTheStepIsTheButton() async throws {
        final class Opened: @unchecked Sendable {
            var urls: [URL] = []
        }
        let server = GoogleSetupServer()
        let now = SampleData.bundled.now
        let store = MailStore(
            client: APIClient(server: testServer, token: "tok_1", transport: server.transport),
            local: try await LocalStore.sample(), clock: { now })
        await store.loadServerInfo()
        #expect(store.serverInfo?.googleSignIn?.available == false)
        let opened = Opened()
        let flow = GoogleSignInFlow(client: store.apiClient, open: { opened.urls.append($0) }, connected: {})
        await flow.check()
        #expect(flow.step == .needsClient)
        let setup = GoogleClientSetup(client: store.apiClient) { [flow, store] settled in
            flow.clientSettled(settled)
            store.googleSignInChanged(settled.googleSignIn)
        }
        await setup.load()
        await setup.give(.file(GoogleSetupServer.file))
        #expect(flow.step == .ready)
        #expect(flow.notes.first == Onboarding.GoogleClient.saved)
        #expect(flow.notes.count == 2 && flow.notes[1].hasPrefix("The client file doesn't list"))
        #expect(
            store.serverInfo?.googleSignIn == GoogleSignInInfo(available: true, redirectUri: GoogleSetupServer.redirect)
        )
        #expect(opened.urls.isEmpty)
        #expect(server.puts.count == 1)
    }

    @Test func aClientFromElsewhereIsSeenWhenTheStepAsksAgain() async {
        let server = GoogleSetupServer()
        let flow = GoogleSignInFlow(
            client: APIClient(server: testServer, token: "tok_1", transport: server.transport), open: { _ in },
            connected: {})
        await flow.check()
        #expect(flow.step == .needsClient)
        await flow.recheck()
        #expect(flow.step == .needsClient)
        server.giveElsewhere()
        await flow.recheck()
        #expect(flow.step == .ready)
    }

    @Test func noHintNoSecondNote() {
        let flow = GoogleSignInFlow(
            client: APIClient(server: testServer, token: "tok_1", transport: StubTransport()), open: { _ in },
            connected: {})
        flow.clientSettled(.alreadyThere(GoogleSignInInfo(available: true)))
        #expect(flow.step == .ready && flow.notes == [Onboarding.GoogleClient.saved])
    }
}
