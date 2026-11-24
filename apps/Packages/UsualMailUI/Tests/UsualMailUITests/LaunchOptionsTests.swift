import Foundation
import SwiftUI
import Testing
import UsualMailKit

@testable import UsualMailUI

/// The debug builds' launch options (Shell/LaunchOptions.swift). These tests run in a debug build, as `swift test`
/// does; a release build reads every option as absent.
@MainActor
struct LaunchOptionsTests {
    private func options(_ values: [String: String]) -> LaunchOptions {
        LaunchOptions { values[$0] }
    }

    @Test func nothingGivenMeansNothing() {
        let none = options([:])
        #expect(!none.sample)
        #expect(none.pairing == nil)
        #expect(none.place == nil)
        #expect(none.inbox == nil)
        #expect(none.thread == nil)
        #expect(none.windowSize == nil)
        #expect(!none.showsTooltips)
        #expect(none.settingsTab == nil)
        #expect(none.searchText == nil)
        #expect(!none.railStaysOpen)
        // The window opens on Home, as ever, with nothing in search's field and the rail narrow.
        #expect(none.navigation == Navigation())
        let search = none.searchModel()
        #expect(search.text.isEmpty && search.requested == nil)
        #expect(!none.railOpening().isOpen)
    }

    @Test func tooltipsShowOnlyWhenAsked() {
        #expect(options(["UsualMailShowTooltips": "YES"]).showsTooltips)
        #expect(!options(["UsualMailShowTooltips": "NO"]).showsTooltips)
    }

    @Test func whereTheWindowOpens() {
        #expect(LaunchOptions.place(parsing: "home") == .tab(.home))
        #expect(LaunchOptions.place(parsing: "reads") == .tab(.reads))
        #expect(LaunchOptions.place(parsing: "receipts") == .tab(.receipts))
        #expect(LaunchOptions.place(parsing: "notifications") == .tab(.notifications))
        // The rail's lists keep the names they had as tabs.
        #expect(LaunchOptions.place(parsing: "reply") == .toReply)
        #expect(LaunchOptions.place(parsing: "pinned") == .pinned)
        #expect(LaunchOptions.place(parsing: "snoozed") == .snoozed)
        #expect(options(["UsualMailPlace": "pinned"]).place == .pinned)
        #expect(LaunchOptions.place(parsing: "screening") == .screening)
        #expect(LaunchOptions.place(parsing: "search") == .search)
        #expect(LaunchOptions.place(parsing: "inbox") == .inbox)
        #expect(LaunchOptions.place(parsing: "settings") == .settings)
        #expect(LaunchOptions.place(parsing: "now") == nil)
        let given = options(["UsualMailInbox": "inb_harbor", "UsualMailThread": "thr_1"])
        #expect(given.inbox == "inb_harbor")
        #expect(given.thread == "thr_1")
    }

    @Test func settingsOpensOnTheTabGiven() {
        for tab in SettingsTab.allCases {
            #expect(options(["UsualMailSettingsTab": tab.rawValue]).settingsTab == tab)
        }
        #expect(options(["UsualMailSettingsTab": "general"]).settingsTab == nil)
        let given = options(["UsualMailPlace": "settings", "UsualMailSettingsTab": "blocked"]).navigation
        #expect(given.place == .settings && given.settingsTab == .blocked)
        // Without one, Accounts.
        #expect(options(["UsualMailPlace": "settings"]).navigation.settingsTab == .accounts)
        // Opened elsewhere, Settings is on that tab when the person goes there.
        var later = options(["UsualMailSettingsTab": "about"]).navigation
        #expect(later.place == .tab(.home))
        later.press(.settings)
        #expect(later.place == .settings && later.settingsTab == .about)
    }

    @Test func searchOpensOverTheStackGiven() {
        let home = options(["UsualMailSearch": "renewal"]).navigation
        #expect(home.place == .search && home.searchReturnTitle == "Home" && home.reading == nil)
        let pinned = options(["UsualMailSearch": "renewal", "UsualMailPlace": "pinned"]).navigation
        #expect(pinned.place == .search && pinned.searchReturnTitle == "Pinned")
        // Search given as the place too: the same, a mail read from it kept.
        let read = options(["UsualMailSearch": "renewal", "UsualMailPlace": "search", "UsualMailThread": "thr_1"])
        #expect(read.navigation.place == .search && read.navigation.reading == "thr_1")
    }

    @Test func searchesItsTextAtOnceAsIfTyped() async throws {
        let given = options(["UsualMailSearch": "contract renewal"])
        #expect(given.searchText == "contract renewal")
        // Typing's pause never ends here, so only a search asked without it is answered.
        let pause: @Sendable (Duration) async throws -> Void = { _ in try await Task.sleep(for: .seconds(600)) }
        let service = RecordingSearch()
        let model = given.searchModel(SearchModel(service: service, sleep: pause, timeZone: { "UTC" }))
        #expect(model.text == "contract renewal")
        try await waitUntil("it is answered") { model.phase == .answered }
        #expect(service.texts == ["contract renewal"])
        // The ordinary search: no sentence asked, no older mail.
        #expect(service.asks.isEmpty && service.remoteQueries.isEmpty && !model.isAsking)

        // As the window makes it, before the page has the store: the text in the field, its query waiting. The page,
        // appearing, gives it the store and asks again (`SearchView`), at once.
        let early = given.searchModel(SearchModel(sleep: pause, timeZone: { "UTC" }))
        #expect(early.text == "contract renewal" && early.requested?.text == "contract renewal")
        let served = RecordingSearch()
        early.service = served
        if early.requested != nil { early.refresh() }
        try await waitUntil("it is answered") { early.phase == .answered }
        #expect(served.texts == ["contract renewal"] && served.asks.isEmpty && served.remoteQueries.isEmpty)
    }

    @Test func theRailStaysOpenWhenAsked() async throws {
        let given = options(["UsualMailRailOpen": "YES"])
        #expect(given.railStaysOpen)
        #expect(!options(["UsualMailRailOpen": "NO"]).railStaysOpen)
        // Open from the start, without the pointer, and through the pointer leaving and a drag coming and going.
        let rail = given.railOpening()
        #expect(rail.isOpen && rail.staysOpen)
        rail.pointerOnRail(true)
        rail.pointerOnRail(false)
        #expect(rail.isOpen)
        rail.mail(dragging: true, landed: false, choosingSnooze: false)
        rail.mail(dragging: false, landed: false, choosingSnooze: false)
        #expect(rail.isOpen)
        // As open as the pointer resting on it makes it: wide, named.
        #expect(RailLook(isOpen: rail.isOpen).width == RailFit.openWidth)
    }

    @Test func windowSize() {
        #expect(options(["UsualMailWindowSize": "760x560"]).windowSize == CGSize(width: 760, height: 560))
        #expect(options(["UsualMailWindowSize": "760"]).windowSize == nil)
        #expect(options(["UsualMailWindowSize": "0x560"]).windowSize == nil)
    }

    @Test func sampleTakesOnlyAYes() {
        #expect(options(["UsualMailSample": "YES"]).sample)
        #expect(!options(["UsualMailSample": "NO"]).sample)
        // In zsh, "-UsualMailSample YES" in one variable arrives as one argument: no key, so no sample.
        #expect(!options(["UsualMailSample YES": ""]).sample)
    }

    @Test func pairingNeedsBothServerAndCode() {
        #expect(options(["UsualMailPairServer": "http://127.0.0.1:8484"]).pairing == nil)
        #expect(options(["UsualMailPairCode": "ABCD-1234"]).pairing == nil)
        let both = options(["UsualMailPairServer": "http://127.0.0.1:8484", "UsualMailPairCode": "ABCD-1234"])
        #expect(both.pairing?.address == "http://127.0.0.1:8484")
        #expect(both.pairing?.code == "ABCD-1234")
    }

    @Test func pairsAtLaunchOnlyWhenAskedAndUnpaired() async {
        let transport = RecordingTransport()
        let session = AppSession(
            credentials: MemoryCredentialStore(), transport: transport, databaseDirectory: nil, deviceName: "Test",
            listens: false)
        await options([:]).pairIfAsked(session)
        #expect(transport.requests.isEmpty)
        #expect(session.pairingProblem == nil)

        let asked = options(["UsualMailPairServer": "http://127.0.0.1:8484", "UsualMailPairCode": "ABCD-1234"])
        await asked.pairIfAsked(session)
        // It asked that server (which, here, can't be reached) and says so without repeating the code.
        #expect(transport.requests.first?.url?.absoluteString == "http://127.0.0.1:8484/v1/info")
        let problem = session.pairingProblem ?? ""
        #expect(!problem.isEmpty)
        #expect(!problem.contains("ABCD-1234"))
    }

    @Test func alreadyPairedIsLeftAlone() async throws {
        let transport = RecordingTransport()
        let saved = Credentials(
            server: try ServerAddress(parsing: "http://127.0.0.1:8484"), token: "tok_1", deviceId: "dev_1",
            deviceName: "Test")
        let credentials = MemoryCredentialStore()
        try credentials.save(saved)
        let session = AppSession(
            credentials: credentials, transport: transport, databaseDirectory: nil, deviceName: "Test", listens: false)
        let asked = options(["UsualMailPairServer": "http://127.0.0.1:8484", "UsualMailPairCode": "ABCD-1234"])
        await asked.pairIfAsked(session)
        #expect(session.store != nil)
        #expect(!transport.requests.contains { $0.url?.path == "/v1/pair" })
    }
}

/// A stand-in for the store's search: it keeps what was asked and finds nothing.
@MainActor
private final class RecordingSearch: SearchService {
    private(set) var queries: [SearchQuery] = []
    private(set) var remoteQueries: [SearchQuery] = []
    private(set) var asks: [SearchAskInput] = []

    /// The text of each query asked, in order.
    var texts: [String] { queries.map { $0.text ?? "" } }

    func search(_ query: SearchQuery) async throws -> SearchResult {
        queries.append(query)
        return SearchResult(items: [])
    }

    func searchRemote(_ query: SearchQuery) async throws -> RemoteSearchResult {
        remoteQueries.append(query)
        return RemoteSearchResult(items: [])
    }

    func openRemote(id: String) async throws -> ThreadDetail {
        throw CancellationError()
    }

    func askSearch(_ input: SearchAskInput) async throws -> SearchAskResult {
        asks.append(input)
        throw CancellationError()
    }
}

/// A transport that keeps each request and answers that the server can't be reached.
private final class RecordingTransport: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var kept: [URLRequest] = []

    var requests: [URLRequest] { lock.withLock { kept } }

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        lock.withLock { kept.append(request) }
        throw URLError(.cannotConnectToHost)
    }

    func stream(for request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, any Error>) {
        lock.withLock { kept.append(request) }
        throw URLError(.cannotConnectToHost)
    }
}
