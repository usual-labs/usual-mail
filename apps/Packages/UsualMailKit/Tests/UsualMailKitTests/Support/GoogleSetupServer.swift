import Foundation
import Synchronization

@testable import UsualMailKit

/// A stand-in server for the Google client's set-up: `/v1/info` without a client until one is given, `/v1/google/setup`
/// from `setup` (nil: a 500 in its own words; `setupAfterPut` instead once a file was sent), and each
/// `PUT /v1/google/client` answered by the next of `puts` (the last repeating). With `holdsPuts`, a PUT opens
/// `putStarted` and then waits until its task is cancelled.
final class GoogleSetupServer: @unchecked Sendable {
    static let redirect = "http://127.0.0.1:8484/v1/google/callback"

    static let guided = #"""
        {"googleSignIn":{"available":false,"redirectUri":"http://127.0.0.1:8484/v1/google/callback","missing":["client"]},
         "client":{"source":"none","changeable":true},
         "prompt":"Set up Sign in with Google for my Usual Mail server for me.\n- Redirect address: http://127.0.0.1:8484/v1/google/callback\n- Gmail addresses I'll connect: [FILL IN: one or more, like me@gmail.example]",
         "promptNote":"Sign in to console.cloud.google.com in your own browser, fill in the two lines that still say FILL IN, then give the whole prompt to your own AI agent.",
         "steps":[
          {"id":"project","title":"Create a project","lines":["Create a new project, for example \"Usual Mail\"."],"url":"https://console.cloud.google.com/projectcreate","copy":[{"label":"Project name","value":"Usual Mail"}]},
          {"id":"gmail_api","title":"Turn on the Gmail API","lines":["Enable it."],"url":"https://console.cloud.google.com/apis/library/gmail.googleapis.com"},
          {"id":"client","title":"Create the client","lines":["A Web application.","No slash at the end."],"url":"https://console.cloud.google.com/auth/clients","copy":[{"label":"Authorized redirect URI","value":"http://127.0.0.1:8484/v1/google/callback"},{"label":"Client name","value":"Usual Mail server"}]},
          {"id":"later_step","title":"Something newer","lines":[],"url":"https://console.cloud.google.com/later","later":true}
         ],
         "later":{"x":1}}
        """#

    static let noAddress = #"""
        {"googleSignIn":{"available":false,"missing":["client","address"]},"client":{"source":"none","changeable":true},
         "noAddress":"This server doesn't know its own address, so there is no redirect address to register at Google yet."}
        """#

    static let demoReason =
        "This server keeps no Google client: it runs in demo mode, with made-up mail and nothing kept."

    static let demo = guided.replacingOccurrences(
        of: #""changeable":true"#, with: #""changeable":false,"reason":"\#(demoReason)""#)

    /// The set-up once a client came from elsewhere: sign-in available.
    static let alreadyThere = guided.replacingOccurrences(
        of: #""available":false,"redirectUri":"\#(redirect)","missing":["client"]"#,
        with: #""available":true,"redirectUri":"\#(redirect)""#)

    static let saved = #"""
        {"clientId":"c.apps.googleusercontent.example","replaced":false,
         "googleSignIn":{"available":true,"redirectUri":"http://127.0.0.1:8484/v1/google/callback"},
         "redirectHint":"The client file doesn't list http://127.0.0.1:8484/v1/google/callback among the client's redirect addresses."}
        """#

    /// Saved, but the server still has no client it can use.
    static let savedUnused = #"""
        {"clientId":"c.apps.googleusercontent.example","replaced":true,
         "googleSignIn":{"available":false,"redirectUri":"http://127.0.0.1:8484/v1/google/callback","missing":["client"]}}
        """#

    /// A client file as Google might download it, with spacing, an escape and a last line break a re-encoding would
    /// change.
    static let file = Data(
        "{\"web\":{\"client_id\":\"c.apps.googleusercontent.example\",  \"project_id\":\"usual-mail\",\n\"client_secret\":\"s\\u00e9cret\",\"redirect_uris\":[\"http://127.0.0.1:8585/v1/google/callback\"]}}\n"
            .utf8)

    var setup: String?
    var setupAfterPut: String?
    var older = false
    var unreachable = false
    var holdsPuts = false
    let putStarted = Gate()
    private let replies: [StubReply]
    private let state = Mutex<(puts: [URLRequest], setups: Int, given: Bool)>(([], 0, false))

    init(setup: String? = GoogleSetupServer.guided, puts: [StubReply] = [.raw(GoogleSetupServer.saved)]) {
        self.setup = setup
        self.replies = puts
    }

    var puts: [URLRequest] { state.withLock { $0.puts } }
    /// How many times the set-up was asked for.
    var setups: Int { state.withLock { $0.setups } }

    /// A client given elsewhere (the command, another device): sign-in is available and the set-up says so.
    func giveElsewhere() {
        state.withLock { $0.given = true }
        setup = Self.alreadyThere
    }

    var transport: StubTransport {
        StubTransport { [self] request in
            if unreachable { throw URLError(.cannotConnectToHost) }
            switch (request.httpMethod, request.url!.path) {
            case ("GET", "/v1/info"):
                let given = state.withLock { $0.given }
                let google =
                    given
                    ? #"{"available":true,"redirectUri":"\#(Self.redirect)"}"#
                    : #"{"available":false,"redirectUri":"\#(Self.redirect)","missing":["client"]}"#
                return .raw(#"{"name":"usual-mail","version":"0.2.0","apiVersion":1,"googleSignIn":\#(google)}"#)
            case ("GET", "/v1/google/setup"):
                let sent = state.withLock { state in
                    state.setups += 1
                    return !state.puts.isEmpty
                }
                if older { return .error("not_found", "No such route", status: 404) }
                guard let setup = (sent ? setupAfterPut : nil) ?? setup else {
                    return .error("internal", "The disk is full.", status: 500)
                }
                return .raw(setup)
            case ("PUT", "/v1/google/client"):
                let reply = state.withLock { state in
                    state.puts.append(request)
                    return replies[min(state.puts.count, replies.count) - 1]
                }
                if holdsPuts {
                    await putStarted.open()
                    try await Task.sleep(for: .seconds(60))
                }
                if reply.status == 200 { state.withLock { $0.given = true } }
                return reply
            default:
                return .error("not_found", "No such route", status: 404)
            }
        }
    }
}
