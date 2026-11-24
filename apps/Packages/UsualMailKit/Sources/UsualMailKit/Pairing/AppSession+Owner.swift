import Foundation

// Connecting with the owner's password (docs/contract.md, "The owner's password"): the server's `GET /v1/info` says
// whether it has a password, can be claimed here, must be claimed in a browser (its host named the owner's email, which
// Google proves), or has no password yet (a pairing code, then a password in Settings).

extension AppSession {
    /// What connecting with a password needs, by what the server says of its owner.
    public enum PasswordStep: Equatable, Sendable {
        /// It has a password: sign in with it.
        case signIn
        /// Nobody owns it yet: set its password here, and this device is its owner's.
        case claim
        /// Nobody owns it yet, but its host named the owner's email: set it up in a browser, through Google.
        case claimInBrowser
        /// It has an owner but no password yet: pair with a code, then set a password in Settings.
        case codeOnly
    }

    /// Asks the server at `address` what connecting with a password needs. Nil, with `pairingProblem` set, when it
    /// can't be reached or isn't a Usual Mail server; for `.claimInBrowser` and `.codeOnly`, `pairingProblem` says
    /// what to do instead.
    public func passwordStep(address: String) async -> PasswordStep? {
        isPairing = true
        pairingProblem = nil
        defer { isPairing = false }
        let typed = address.trimmingCharacters(in: .whitespaces)
        do {
            let server = try ServerAddress(parsing: address)
            // A password only over https, to this machine or over Tailscale: elsewhere a code, asked before anything is
            // sent (`ServerAddress.carriesPasswords`).
            guard server.carriesPasswords else {
                pairingProblem = Self.ownerWords.plainHTTP(server.displayName)
                return .codeOnly
            }
            guard let info = try await speaksTo(APIClient(server: server, transport: transport), server: server) else {
                return nil
            }
            let step = Self.passwordStep(info.owner ?? .none)
            switch step {
            case .claimInBrowser: pairingProblem = Self.ownerWords.claimInBrowser(typed)
            case .codeOnly: pairingProblem = Self.ownerWords.codeOnly
            case .signIn, .claim: break
            }
            return step
        } catch let error as ServerAddress.ParseError {
            pairingProblem = error.localizedDescription
        } catch let error as APIError {
            pairingProblem = Self.reachProblem(error, address: typed) ?? error.localizedDescription
        } catch {
            pairingProblem = error.localizedDescription
        }
        return nil
    }

    /// The step `owner` calls for.
    static func passwordStep(_ owner: OwnerInfo) -> PasswordStep {
        if owner.password { return .signIn }
        guard owner.claimable else { return .codeOnly }
        return owner.claim == .password ? .claim : .claimInBrowser
    }

    /// Signs this device in with the owner's password.
    public func signIn(address: String, password: String) async {
        guard !password.isEmpty else {
            pairingProblem = Self.ownerWords.typePassword
            return
        }
        await connect(address: address) { client in
            try Self.refusePlainHTTP(client.server)
            return try await client.signInOwner(OwnerSignInInput(password: password, name: self.deviceName))
        } refused: { error in
            Self.ownerProblem(error, address: address.trimmingCharacters(in: .whitespaces))
        }
    }

    /// Claims an unclaimed server with a new password (twice, so a typo isn't kept), and an optional email.
    public func claim(address: String, email: String, password: String, again: String) async {
        guard password == again else {
            pairingProblem = Self.ownerWords.differ
            return
        }
        guard password.count >= ownerPasswordMinimum else {
            pairingProblem = Self.ownerWords.tooShort
            return
        }
        let email = email.trimmingCharacters(in: .whitespacesAndNewlines)
        await connect(address: address) { client in
            try Self.refusePlainHTTP(client.server)
            return try await client.claimOwner(
                OwnerClaimInput(password: password, name: self.deviceName, email: email.isEmpty ? nil : email))
        } refused: { error in
            Self.ownerProblem(error, address: address.trimmingCharacters(in: .whitespaces))
        }
    }

    /// Refuses to send a password where `ServerAddress.carriesPasswords` says it would travel readable.
    static func refusePlainHTTP(_ server: ServerAddress) throws {
        guard server.carriesPasswords else { throw Refusal(words: ownerWords.plainHTTP(server.displayName)) }
    }

    /// What to tell the person when the password or a claim is refused. `address` is what they typed.
    static func ownerProblem(_ error: APIError, address: String) -> String {
        if let words = reachProblem(error, address: address) { return words }
        switch error.code {
        case .unauthorized:
            return ownerWords.wrong
        case .rateLimited:
            let wait = error.retryAfter.map { APIError.wait(seconds: $0) } ?? "ten minutes"
            return "Too many wrong codes or passwords. Wait \(wait), then try again."
        case .conflict:
            return ownerWords.conflict
        case .forbidden:
            return ownerWords.claimInBrowser(address)
        default:
            return error.localizedDescription
        }
    }

    /// The words for connecting with the owner's password.
    enum ownerWords {
        static let typePassword = "Enter your server's password."
        static let wrong =
            "That password is wrong. Forgot it? Open your server's address in a browser and choose \"Forgot your password?\"."
        static let differ = "The two passwords aren't the same. Type them again."
        static let tooShort = "The password needs at least \(ownerPasswordMinimum) characters."
        static let conflict =
            "This server already has an owner, or has no password yet. Connect with a pairing code instead."
        static let codeOnly =
            "This server has no password yet. Connect with a pairing code, then set a password in Settings."
        static func plainHTTP(_ address: String) -> String {
            """
            \(address) is reached over plain http, so anyone on that network could read a password sent to it. Connect \
            with a pairing code instead: it works once. Your password works over https, on the server's own machine \
            or over Tailscale.
            """
        }
        static func claimInBrowser(_ address: String) -> String {
            """
            This server's host named its owner's email. Open \(address) in a browser, sign in with Google there and \
            set the server's password, then sign in here with it.
            """
        }
    }
}
