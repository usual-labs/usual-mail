import CryptoKit
import Foundation
import Observation

/// Whether this device is paired with a server, and the `MailStore` for it once it is.
///
/// Pairing takes the server's address and a pairing code a person created (a new server prints one
/// for the owner's first device), checks the address is a Usual Mail server, trades the code for a
/// token with `POST /v1/pair` and keeps the token in the Keychain.
@MainActor
@Observable
public final class AppSession {
    public enum State {
        case starting
        case unpaired
        case paired(MailStore)
    }

    public private(set) var state = State.starting
    public internal(set) var isPairing = false
    public private(set) var isDisconnecting = false
    /// Why pairing failed, or why the device was signed out, in words a person can act on.
    public internal(set) var pairingProblem: String?
    public private(set) var credentials: Credentials?

    @ObservationIgnored private let credentialStore: any CredentialStore
    @ObservationIgnored let transport: any HTTPTransport
    @ObservationIgnored private let databaseDirectory: URL?
    @ObservationIgnored let deviceName: String
    @ObservationIgnored private let clock: @Sendable () -> Date
    @ObservationIgnored private let listens: Bool

    /// - Parameters:
    ///   - databaseDirectory: where each server's on-device copy goes; `nil` keeps it in memory.
    ///   - listens: whether the store follows the server's event stream.
    public init(
        credentials: any CredentialStore, transport: any HTTPTransport = URLSessionTransport(),
        databaseDirectory: URL? = AppSession.defaultDatabaseDirectory, deviceName: String,
        listens: Bool = true, clock: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.credentialStore = credentials
        self.transport = transport
        self.databaseDirectory = databaseDirectory
        self.deviceName = deviceName
        self.listens = listens
        self.clock = clock
    }

    public nonisolated static var defaultDatabaseDirectory: URL {
        URL.applicationSupportDirectory.appending(path: "UsualMail", directoryHint: .isDirectory)
    }

    public var store: MailStore? {
        if case .paired(let store) = state { store } else { nil }
    }

    /// Opens the paired server's copy, or shows pairing if the device isn't paired. Only the first call
    /// does anything, so each window may call it.
    public func restore() {
        guard case .starting = state else { return }
        do {
            if let saved = try credentialStore.load() {
                try open(saved)
                return
            }
        } catch {
            pairingProblem = "Couldn't read this device's sign-in: \(error.localizedDescription)"
        }
        state = .unpaired
    }

    /// Pairs with the server at `address` using a pairing code.
    public func pair(address: String, code: String) async {
        let code = code.trimmingCharacters(in: .whitespacesAndNewlines)
        // A good address and no code: said before the server is asked. A bad address is said first.
        if code.isEmpty, (try? ServerAddress(parsing: address)) != nil {
            pairingProblem = "Enter the pairing code your server gave you."
            return
        }
        await connect(address: address) { client in
            try await client.pair(PairInput(code: code, name: self.deviceName))
        } refused: { error in
            Self.pairingProblem(error, address: address.trimmingCharacters(in: .whitespaces))
        }
    }

    /// A refusal the app itself makes before asking the server, in words.
    struct Refusal: Error {
        let words: String
    }

    /// Checks that `address` is a Usual Mail server this app speaks to, trades something for this device's token with
    /// `trade` (a pairing code, the owner's password, a claim), keeps the token and opens the server's copy. A refusal
    /// is put in words by `refused`.
    func connect(
        address: String, trade: (APIClient) async throws -> PairResult, refused: (APIError) -> String
    ) async {
        isPairing = true
        pairingProblem = nil
        defer { isPairing = false }
        do {
            let server = try ServerAddress(parsing: address)
            let client = APIClient(server: server, transport: transport)
            guard try await speaksTo(client, server: server) != nil else { return }
            let result = try await trade(client)
            let saved = Credentials(
                server: server, token: result.token, deviceId: result.device.id, deviceName: result.device.name)
            try credentialStore.save(saved)
            // A new pairing starts a new copy. A copy left from an earlier pairing with the same address may come
            // from a store since reset, whose versions start over, and its higher versions would win.
            removeCopy(for: server)
            try open(saved)
        } catch let error as ServerAddress.ParseError {
            pairingProblem = error.localizedDescription
        } catch let refusal as Refusal {
            pairingProblem = refusal.words
        } catch let error as APIError {
            pairingProblem = refused(error)
        } catch {
            pairingProblem = error.localizedDescription
        }
    }

    /// The server's `GET /v1/info` when it is a Usual Mail server this app speaks to; nil, with the problem in
    /// `pairingProblem`, when it isn't.
    func speaksTo(_ client: APIClient, server: ServerAddress) async throws -> ServerInfo? {
        let info = try await client.info()
        guard info.name == "usual-mail" else {
            pairingProblem = "\(server.displayName) answered, but it isn't a Usual Mail server."
            return nil
        }
        guard info.apiVersion == 1 else {
            pairingProblem = "\(server.displayName) needs a newer version of this app."
            return nil
        }
        return info
    }

    /// What to tell the person when pairing fails (docs/contract.md, "REST", "Sign-in"), in the owner's approved
    /// words of 2026-11-17 (the onboarding session's copy). `address` is what they typed.
    static func pairingProblem(_ error: APIError, address: String) -> String {
        if let words = reachProblem(error, address: address) { return words }
        switch error.code {
        case .unauthorized:
            return """
                That code didn't work. It may be mistyped, used already or expired. Your server makes a new one: run \
                usual-mail pair, or see owner-pairing-code in its data folder. On Cloudflare, open the server's \
                address and look in Data Studio again, or use the dashboard's Devices and agents page.
                """
        case .rateLimited:
            // The server says how long in Retry-After; without it, the limit lasts at most ten minutes.
            let wait = error.retryAfter.map { APIError.wait(seconds: $0) } ?? "ten minutes"
            return "Too many wrong codes. Wait \(wait), then try again."
        default:
            return error.localizedDescription
        }
    }

    /// Why the server at `address` couldn't be reached, when that is the problem.
    static func reachProblem(_ error: APIError, address: String) -> String? {
        switch error {
        case .unreachable(_, let cause?) where offline.contains(cause):
            "This Mac is offline, so it couldn't reach \(address). Connect it, then try again."
        case .unreachable(_, let cause?) where insecure.contains(cause):
            """
            A secure connection to \(address) couldn't be made. Check that the address starts with the right \
            scheme (https:// for a server elsewhere).
            """
        case .unreachable:
            """
            No Usual Mail server answered at \(address). Check the address, and that the server is running \
            (usual-mail status).
            """
        default: nil
        }
    }

    /// This Mac itself is offline: no server was asked.
    private static let offline: Set<URLError.Code> = [
        .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed, .internationalRoamingOff,
    ]

    /// Something answered, but no secure connection could be made: often https to a server that speaks http, or
    /// the other way round.
    private static let insecure: Set<URLError.Code> = [
        .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate,
        .serverCertificateHasUnknownRoot, .serverCertificateNotYetValid, .clientCertificateRejected,
        .clientCertificateRequired, .appTransportSecurityRequiresSecureConnection,
    ]

    /// Disconnects from the server: revokes this device there, which ends its token, then forgets the token and
    /// the on-device copy. If the server can't be told, the device still forgets it and pairing says the server
    /// still lists it.
    public func disconnect() async {
        guard let credentials, !isDisconnecting else { return }
        isDisconnecting = true
        defer { isDisconnecting = false }
        let client = APIClient(server: credentials.server, token: credentials.token, transport: transport)
        do {
            try await client.revokeDevice(id: credentials.deviceId)
            signOut()
        } catch let error as APIError where error.code == .unauthorized || error.code == .notFound {
            // The token or the device is already gone on the server.
            signOut()
        } catch {
            signOut(
                reason: """
                    This device forgot its sign-in, but \(credentials.server.displayName) couldn't be told, so it \
                    still lists "\(credentials.deviceName)". Remove it from the server's devices.
                    """)
        }
    }

    /// Forgets the server on this device only: deletes the token and the on-device copy. With `reason`, pairing
    /// shows why. `disconnect()` also revokes the device on the server.
    public func signOut(reason: String? = nil) {
        if let credentials { removeCopy(for: credentials.server) }
        try? credentialStore.delete()
        credentials = nil
        pairingProblem = reason
        state = .unpaired
    }

    private func open(_ saved: Credentials) throws {
        let client = APIClient(server: saved.server, token: saved.token, transport: transport)
        let local = try databaseURL(for: saved.server).map { try LocalStore(url: $0) } ?? LocalStore()
        let store = MailStore(
            client: client, local: local, events: listens ? EventStream(client: client) : nil, clock: clock)
        store.onUnauthorized = { [weak self] in
            self?.signOut(reason: "Your server signed this device out. Pair it again with a new code.")
        }
        credentials = saved
        state = .paired(store)
    }

    /// Deletes the on-device copy kept for `server`, if there is one.
    private func removeCopy(for server: ServerAddress) {
        guard let url = databaseURL(for: server) else { return }
        for suffix in ["", "-wal", "-shm"] {
            try? FileManager.default.removeItem(at: URL(filePath: url.path(percentEncoded: false) + suffix))
        }
    }

    /// One file per server, named by a hash so the address isn't spelled out on disk.
    private func databaseURL(for server: ServerAddress) -> URL? {
        guard let databaseDirectory else { return nil }
        let digest = SHA256.hash(data: Data(server.baseURL.absoluteString.utf8))
        let name = digest.prefix(12).map { String(format: "%02x", $0) }.joined()
        return databaseDirectory.appending(path: "mail-\(name).sqlite")
    }
}
