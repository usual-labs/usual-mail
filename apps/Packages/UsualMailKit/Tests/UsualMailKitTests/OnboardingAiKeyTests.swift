import Foundation
import Synchronization
import Testing

@testable import UsualMailKit

/// The first run's AI key step: the server's words before any key is saved, saving and the server's test, the approved
/// words for each failure, and the key kept nowhere.
@MainActor
struct OnboardingAiKeyTests {
    /// What the server answers to `GET /v1/ai/disclosure?gateway=vercel`, in core's shape (`aiDisclosure`).
    nonisolated static let words = #"""
        {"service":"Vercel's AI Gateway","destination":"Saving this key sends the mail of every inbox connected to this server, now and later, out of your server to Vercel's AI Gateway.","terms":"Vercel's AI Gateway's own terms then apply to what it receives.","lead":"For each thread the AI processes, the server sends:","sent":[{"label":"To categorize it","words":"the subject."},{"label":"To summarize it","words":"the text."},{"label":"Never","words":"attachments."}],"history":"It processes new mail as it arrives."}
        """#

    /// The sample server with no key yet, plus the disclosure route, answered with `disclosure`.
    private final class Server: Sendable {
        let sample: SampleServer
        let transport: StubTransport

        init(disclosure: StubReply = .raw(OnboardingAiKeyTests.words), _ change: (inout SampleData) -> Void = { _ in })
        {
            var data = SampleData.bundled
            data.ai.credentialsSet = false
            data.ai.connection = nil
            data.aiStatus.state = .notSetUp
            change(&data)
            let sample = SampleServer(data)
            self.sample = sample
            transport = StubTransport { request in
                if request.url?.path == "/v1/ai/disclosure" { return disclosure }
                let (body, response) = try await sample.data(for: request)
                return StubReply(status: response.statusCode, body: body)
            }
        }

        /// Sets the status the server's test leads to.
        func testLeadsTo(_ state: AiState, detail: String? = nil) {
            sample.state.withLock {
                $0.data.aiStatus.state = state
                $0.data.aiStatus.detail = detail
                $0.data.aiStatus.version += 1
            }
        }

        var routes: [String] { transport.requests.map { "\($0.httpMethod ?? "GET") \($0.pathAndQuery)" } }
    }

    private func store(_ server: Server) async throws -> MailStore {
        let now = SampleData.bundled.now
        let store = MailStore(
            client: APIClient(server: testServer, token: "tok_secret", transport: server.transport),
            local: try LocalStore(), clock: { now })
        await store.refresh()
        return store
    }

    @Test func theWordsComeFromTheServerBeforeAKeyCanBeSaved() async throws {
        let server = Server()
        let model = OnboardingAiKey(store: try await store(server))
        #expect(model.disclosure == .loading && !model.canSave)
        await model.loadDisclosure()
        guard case .loaded(let words) = model.disclosure else {
            Issue.record("Expected the words")
            return
        }
        #expect(words.destination.hasPrefix("Saving this key sends the mail of every inbox"))
        #expect(words.sent.map(\.label) == ["To categorize it", "To summarize it", "Never"])
        #expect(server.routes.last == "GET /v1/ai/disclosure?gateway=vercel")
        #expect(model.canSave)
    }

    @Test func withoutTheWordsNoKeyIsSaved() async throws {
        let server = Server(disclosure: .error("invalid", "Name one service.", status: 400))
        let model = OnboardingAiKey(store: try await store(server))
        await model.loadDisclosure()
        guard case .failed(let words) = model.disclosure else {
            Issue.record("Expected a failure")
            return
        }
        #expect(words.contains("can't be saved yet") && words.contains("Name one service."))
        #expect(!model.canSave)
        await model.save(key: "not-a-real-key")
        #expect(!server.routes.contains("PATCH /v1/ai") && model.check == .idle)
    }

    @Test func wordsThatSayNothingAreNoWords() async throws {
        let blank = Self.words.replacingOccurrences(
            of: "Vercel's AI Gateway's own terms then apply to what it receives.", with: " ")
        let server = Server(disclosure: .raw(blank))
        let model = OnboardingAiKey(store: try await store(server))
        await model.loadDisclosure()
        #expect(model.disclosure == .failed("Your server sent no words on what the AI would be sent."))
        #expect(!model.canSave)
    }

    @Test func aKeyThatWorksMovesOnAndIsKeptNowhere() async throws {
        let server = Server()
        let store = try await store(server)
        let model = OnboardingAiKey(store: store)
        await model.loadDisclosure()
        server.testLeadsTo(.working)
        await model.save(key: "  not-a-real-key\n")
        #expect(model.check == .done(.works))
        let patch = try #require(server.transport.requests.first { $0.httpMethod == "PATCH" })
        #expect(patch.pathAndQuery == "/v1/ai")
        #expect(
            patch.jsonBody == json(#"{"credentials":{"kind":"gateway","gateway":"vercel","apiKey":"not-a-real-key"}}"#))
        // The status is read once the server has answered, after its test.
        #expect(Array(server.routes.suffix(2)) == ["PATCH /v1/ai", "GET /v1/ai/status"])
        #expect(store.aiSettings?.credentialsSet == true && store.aiStatus?.state == .working)
        let kept = try await store.local.status()
        let stored = String(decoding: try StoredJSON.encode(try #require(kept.aiSettings)), as: UTF8.self)
        #expect(!stored.contains("not-a-real-key"))
    }

    @Test func aRefusedKeyIsSaidInTheApprovedWordsAndCanBeTestedAgain() async throws {
        let server = Server()
        let store = try await store(server)
        let model = OnboardingAiKey(store: store)
        await model.loadDisclosure()
        server.testLeadsTo(.keyRefused, detail: "The gateway said 401.")
        await model.save(key: "not-a-real-key")
        #expect(
            model.check
                == .done(.problem("Vercel didn't accept this key. Check that you copied all of it, or make a new one."))
        )
        #expect(model.canTestAgain)

        server.testLeadsTo(.outOfCredit)
        await model.testAgain()
        #expect(model.check == .done(.problem("Your Vercel account is out of credit. Add some, then test again.")))
        #expect(server.routes.last == "POST /v1/ai/test")

        server.testLeadsTo(.working)
        await model.testAgain()
        #expect(model.check == .done(.works) && !model.canTestAgain)
    }

    @Test func anUnknownModelIsSaidInTheServersWords() async throws {
        let server = Server()
        let model = OnboardingAiKey(store: try await store(server))
        await model.loadDisclosure()
        let detail = "On Vercel's AI Gateway, categorizing needs a decision model; example/text-1 is a language model."
        server.testLeadsTo(.modelNotFound, detail: detail)
        await model.save(key: "not-a-real-key")
        #expect(model.check == .done(.problem(detail)))
    }

    @Test func aRefusalShowsTheServersWordsWithoutTheKey() async throws {
        let server = Server()
        server.sample.failOnce(
            "PATCH /v1/ai", with: .error("invalid", "The key not-a-real-key is malformed", status: 400))
        let store = try await store(server)
        let model = OnboardingAiKey(store: store)
        await model.loadDisclosure()
        await model.save(key: "not-a-real-key")
        #expect(model.check == .done(.problem("The key ••• is malformed")))
        // The step shows it, so the store doesn't hold it as well.
        #expect(store.problem == nil)
        #expect(store.aiSettings?.credentialsSet == false)
        #expect(!model.canTestAgain && model.canSave)
    }

    @Test func aKeyRefusedBeforeAQuitSaysWhyOnReturn() async throws {
        let server = Server {
            $0.ai.credentialsSet = true
            $0.ai.connection = .gateway(.vercel)
            $0.aiStatus.state = .unavailable
        }
        let model = OnboardingAiKey(store: try await store(server))
        #expect(
            model.check
                == .done(.problem("Your server couldn't reach Vercel. Check its internet connection and try again.")))
        #expect(model.canTestAgain)
    }
}
