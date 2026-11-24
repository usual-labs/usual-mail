import Foundation
import Security
import Synchronization

/// What pairing gives a device: its server, its token and its id there.
public struct Credentials: Codable, Hashable, Sendable {
    public var server: ServerAddress
    /// Sent as `Authorization: Bearer <token>`. Kept only in the Keychain.
    public var token: String
    public var deviceId: String
    public var deviceName: String

    public init(server: ServerAddress, token: String, deviceId: String, deviceName: String) {
        self.server = server
        self.token = token
        self.deviceId = deviceId
        self.deviceName = deviceName
    }
}

/// Where the device's credentials are kept between launches.
public protocol CredentialStore: Sendable {
    func load() throws -> Credentials?
    func save(_ credentials: Credentials) throws
    func delete() throws
}

/// Keeps the credentials as one generic password in the Keychain, readable only after the device has
/// been unlocked once, and never synced or backed up to another device.
public struct KeychainCredentialStore: CredentialStore {
    public struct KeychainError: Error, Hashable {
        public let status: OSStatus
    }

    private let service: String
    private let account: String

    public init(service: String = "Usual Mail server", account: String = "paired-server") {
        self.service = service
        self.account = account
    }

    public func load() throws -> Credentials? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw KeychainError(status: status) }
        return try JSONDecoder().decode(Credentials.self, from: data)
    }

    public func save(_ credentials: Credentials) throws {
        let data = try JSONEncoder().encode(credentials)
        let status = SecItemUpdate(baseQuery as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var item = baseQuery
            item[kSecValueData as String] = data
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let added = SecItemAdd(item as CFDictionary, nil)
            guard added == errSecSuccess else { throw KeychainError(status: added) }
        } else if status != errSecSuccess {
            throw KeychainError(status: status)
        }
    }

    public func delete() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status: status) }
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}

/// Keeps credentials in memory only, for previews and tests.
public final class MemoryCredentialStore: CredentialStore {
    private let stored: Mutex<Credentials?>

    public init(_ credentials: Credentials? = nil) {
        stored = Mutex(credentials)
    }

    public func load() throws -> Credentials? { stored.withLock { $0 } }
    public func save(_ credentials: Credentials) throws { stored.withLock { $0 = credentials } }
    public func delete() throws { stored.withLock { $0 = nil } }
}
