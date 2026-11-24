import Foundation

@testable import UsualMailKit

/// The stand-in server's owner's password (docs/contract.md, "The owner's password"): signing in with it, claiming
/// while `ownerInfo` says the server is claimable, and the owner as `GET /v1/owner` answers.
extension SampleServer {
    /// Starts the stand-in as a server with this password (nil: none yet) and this owner info.
    func owner(password: String?, info: OwnerInfo) {
        state.withLock {
            $0.ownerPassword = password
            $0.ownerInfo = info
        }
    }

    /// The owner's routes, or nil for any other.
    func ownerReply(method: String, parts: [String], body: Data) throws -> StubReply? {
        guard parts.count >= 2, parts[0] == "v1", parts[1] == "owner" else { return nil }
        let device = Device(id: "dev_test", name: "Test Mac", kind: .person, createdAt: data.now)
        let paired = StubReply.json(["token": "tok_secret", "device": try encodedJSON(device)] as JSONValue)
        switch (method, parts.dropFirst(2).joined(separator: "/")) {
        case ("POST", "sign-in"):
            let input = try MailJSON.decoder().decode(OwnerSignInInput.self, from: body)
            guard let password = state.withLock({ $0.ownerPassword }) else {
                return .error("conflict", "This server has no password yet.", status: 409)
            }
            guard input.password == password else {
                return .error("unauthorized", "That password is wrong.", status: 401)
            }
            return paired
        case ("POST", "claim"):
            let input = try MailJSON.decoder().decode(OwnerClaimInput.self, from: body)
            let info = state.withLock { $0.ownerInfo } ?? .none
            guard info.claimable else { return .error("conflict", "This server already has an owner.", status: 409) }
            guard info.claim == .password else { return .error("forbidden", "Sign in with Google first.", status: 403) }
            state.withLock {
                $0.ownerPassword = input.password
                $0.ownerInfo = OwnerInfo(password: true, claimable: false)
            }
            return paired
        case ("GET", ""):
            let password = state.withLock { $0.ownerPassword }
            return .json(Owner(email: nil, password: password != nil, passwordSetAt: password == nil ? nil : data.now))
        case ("PUT", "password"):
            let input = try MailJSON.decoder().decode(OwnerPasswordInput.self, from: body)
            state.withLock { $0.ownerPassword = input.password }
            return .json(Owner(email: nil, password: true, passwordSetAt: data.now))
        default:
            return nil
        }
    }
}
