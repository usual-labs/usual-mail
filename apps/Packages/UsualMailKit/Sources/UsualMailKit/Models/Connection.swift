import Foundation

/// A mail server's address and login, without the password (`ServerLogin` in core).
public struct ServerLogin: Codable, Hashable, Sendable {
    public var host: String
    public var port: Int
    /// True for TLS from the start (993, 465); false for STARTTLS.
    public var secure: Bool
    public var user: String

    public init(host: String, port: Int, secure: Bool, user: String) {
        self.host = host
        self.port = port
        self.secure = secure
        self.user = user
    }
}

/// How an inbox is connected, without anything secret (`InboxConnection` in core), so a form can show it again. Its
/// kind is the inbox's provider. A store from before the fourth revision may give an empty host, user or client id.
/// A kind a newer server sends is kept whole.
public enum InboxConnection: Codable, Hashable, Sendable {
    /// IMAP for reading, SMTP for sending, and whether a copy of sent mail is saved to the Sent folder.
    case imap(imap: ServerLogin, smtp: ServerLogin, saveSent: Bool)
    /// The Google OAuth client its refresh token belongs to. `signIn` is `google` when a person connected it by
    /// signing in with Google through the server's own client; absent when the client and token were given by hand.
    case gmail(clientId: String, signIn: String? = nil)
    case unknown(kind: String, payload: JSONValue)

    private enum Key: String, CodingKey {
        case kind, imap, smtp, saveSent, clientId, signIn
    }

    /// The `kind` in the JSON, which is the inbox's provider.
    public var kind: String {
        switch self {
        case .imap: "imap"
        case .gmail: "gmail"
        case .unknown(let kind, _): kind
        }
    }

    /// True for a Gmail inbox a person connected by signing in with Google: they reconnect it the same way.
    public var signsInWithGoogle: Bool {
        if case .gmail(_, let signIn) = self { signIn == "google" } else { false }
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: Key.self)
        let kind = try container.decode(String.self, forKey: .kind)
        switch kind {
        case "imap":
            self = .imap(
                imap: try container.decode(ServerLogin.self, forKey: .imap),
                smtp: try container.decode(ServerLogin.self, forKey: .smtp),
                saveSent: try container.decode(Bool.self, forKey: .saveSent))
        case "gmail":
            self = .gmail(
                clientId: try container.decode(String.self, forKey: .clientId),
                signIn: try container.decodeIfPresent(String.self, forKey: .signIn))
        default: self = .unknown(kind: kind, payload: try JSONValue(from: decoder))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        if case .unknown(_, let payload) = self {
            try payload.encode(to: encoder)
            return
        }
        var container = encoder.container(keyedBy: Key.self)
        try container.encode(kind, forKey: .kind)
        switch self {
        case .imap(let imap, let smtp, let saveSent):
            try container.encode(imap, forKey: .imap)
            try container.encode(smtp, forKey: .smtp)
            try container.encode(saveSent, forKey: .saveSent)
        case .gmail(let clientId, let signIn):
            try container.encode(clientId, forKey: .clientId)
            try container.encodeIfPresent(signIn, forKey: .signIn)
        case .unknown: break
        }
    }
}

/// `ImapCredentials` in core's provider.ts: what connecting an IMAP inbox, or changing its credentials, sends.
public struct ImapCredentials: Encodable, Hashable, Sendable {
    public struct Login: Encodable, Hashable, Sendable {
        public var host: String
        public var port: Int
        public var secure: Bool
        public var user: String
        public var password: String

        public init(host: String, port: Int, secure: Bool, user: String, password: String) {
            self.host = host
            self.port = port
            self.secure = secure
            self.user = user
            self.password = password
        }
    }

    public var imap: Login
    public var smtp: Login
    /// The mailbox's address, when it differs from the IMAP login.
    public var address: String?
    /// Save a copy of sent mail to the Sent folder. The provider's default is true.
    public var saveSent: Bool?

    public init(imap: Login, smtp: Login, address: String? = nil, saveSent: Bool? = nil) {
        self.imap = imap
        self.smtp = smtp
        self.address = address
        self.saveSent = saveSent
    }
}

/// `GmailCredentials` in core's provider.ts.
public struct GmailCredentials: Encodable, Hashable, Sendable {
    public var clientId: String
    public var clientSecret: String
    public var refreshToken: String

    public init(clientId: String, clientSecret: String, refreshToken: String) {
        self.clientId = clientId
        self.clientSecret = clientSecret
        self.refreshToken = refreshToken
    }
}

/// New credentials for an inbox, secrets included, in the shape its provider takes. They replace the stored ones
/// whole, so they carry the details the form showed from `InboxConnection` as well as the secrets. Sent once, in a
/// request body; never stored on the device.
public enum InboxCredentials: Hashable, Sendable {
    case imap(ImapCredentials)
    case gmail(GmailCredentials)

    /// As the JSON `InboxPatch.credentials` carries.
    public var json: JSONValue {
        get throws {
            let data =
                switch self {
                case .imap(let credentials): try MailJSON.encoder().encode(credentials)
                case .gmail(let credentials): try MailJSON.encoder().encode(credentials)
                }
            return try MailJSON.decoder().decode(JSONValue.self, from: data)
        }
    }

    /// Every secret in them, to keep out of anything shown again.
    public var secrets: [String] {
        switch self {
        case .imap(let credentials): [credentials.imap.password, credentials.smtp.password]
        case .gmail(let credentials): [credentials.clientSecret, credentials.refreshToken]
        }
    }
}
