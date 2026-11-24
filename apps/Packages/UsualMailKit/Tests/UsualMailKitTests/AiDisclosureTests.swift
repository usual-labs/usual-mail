import Foundation
import Testing

@testable import UsualMailKit

/// `GET /v1/ai/disclosure`: what saving a key would send, and to whom, as the server words it.
struct AiDisclosureTests {
    private let answer = #"""
        {"service":"Vercel's AI Gateway","destination":"Saving this key sends the mail of every inbox.","terms":"Its terms apply.","lead":"For each thread the AI processes, the server sends:","sent":[{"label":"To categorize it","words":"the sender"},{"label":"Never","words":"your guide"}],"history":"Up to 7 days back."}
        """#

    @Test func asksForTheServiceItWouldGoTo() async throws {
        let transport = StubTransport { [answer] _ in .raw(answer) }
        let client = APIClient(server: testServer, token: "tok_1", transport: transport)
        let disclosure = try await client.aiDisclosure(for: .gateway(.vercel))
        #expect(disclosure.service == "Vercel's AI Gateway")
        #expect(disclosure.sent.map(\.label) == ["To categorize it", "Never"])
        #expect(transport.lastRequest?.httpMethod == "GET")
        #expect(transport.lastRequest?.pathAndQuery == "/v1/ai/disclosure?gateway=vercel")

        _ = try await client.aiDisclosure(for: .direct(.anthropic))
        #expect(transport.lastRequest?.pathAndQuery == "/v1/ai/disclosure?provider=anthropic")
    }
}
