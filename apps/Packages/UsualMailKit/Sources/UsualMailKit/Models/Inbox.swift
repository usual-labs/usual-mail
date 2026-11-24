import Foundation

// Mirrors of `core/src/domain.ts`. Field names match the JSON; ids are opaque strings.

public struct Address: Codable, Hashable, Sendable {
    public var name: String?
    public var email: String

    public init(name: String? = nil, email: String) {
        self.name = name
        self.email = email
    }

    /// The name when there is one, otherwise the address.
    public var displayName: String { name.flatMap { $0.isEmpty ? nil : $0 } ?? email }
}

/// One connected mailbox. In the apps it is a profile with an icon and a position in the profile switch, and a
/// company's colour.
public struct Inbox: Codable, Hashable, Sendable, Identifiable, Versioned {
    public var id: String
    public var name: String
    public var address: String
    /// The company's colour as `#RRGGBB`.
    public var color: String
    /// Its icon in the profile switch.
    public var icon: InboxIcon
    /// Its place in the profile switch and the inbox list, from 0, no two alike and no gaps. The inbox list is ordered
    /// by it.
    public var position: Int
    public var provider: ProviderKind
    /// How it is connected, without secrets. Its kind is `provider`.
    public var connection: InboxConnection
    public var trust: TrustLevel
    /// Plain-language notes on how to handle this inbox. Markdown. People and agents read and edit it.
    public var guide: String
    /// Whether agents and chat apps may read this inbox at all.
    public var agentAccess: Bool
    /// `connecting` after connecting, new credentials or resuming, until the next good sync; `paused` while the
    /// person paused it, when the server reads nothing from the mailbox and writes nothing to it.
    public var status: InboxStatus
    /// Why the status is not `ok`, in words a person can act on.
    public var statusDetail: String?
    /// How far its first sync has got while it runs, once the server has a count; nil before and once it is done. It
    /// keeps its count while the inbox needs the person, or is paused (the server stops the first sync once the batch
    /// in hand is stored, and goes on from there when it is resumed); `fetching` is what to show.
    public var firstSync: FirstSyncProgress?
    /// Moving alone is not a change: it raises no version and sends no event. The inbox list carries it.
    public var lastSyncedAt: Date?
    public var createdAt: Date
    /// Rises with every change except `lastSyncedAt` moving, maybe by more than one. Of two copies, keep the higher.
    public var version: Int

    public init(
        id: String, name: String, address: String, color: String, icon: InboxIcon = .person, position: Int = 0,
        provider: ProviderKind, connection: InboxConnection, trust: TrustLevel, guide: String = "",
        agentAccess: Bool = false, status: InboxStatus = .ok, statusDetail: String? = nil,
        firstSync: FirstSyncProgress? = nil, lastSyncedAt: Date? = nil, createdAt: Date, version: Int = 1
    ) {
        self.id = id
        self.name = name
        self.address = address
        self.color = color
        self.icon = icon
        self.position = position
        self.provider = provider
        self.connection = connection
        self.trust = trust
        self.guide = guide
        self.agentAccess = agentAccess
        self.status = status
        self.statusDetail = statusDetail
        self.firstSync = firstSync
        self.lastSyncedAt = lastSyncedAt
        self.createdAt = createdAt
        self.version = version
    }

    /// Paused by the person: the server neither syncs it nor writes to its mailbox, and answers `conflict` to sending
    /// and to fetching a file. What is done to its threads meanwhile is kept and written back once it is resumed.
    public var isPaused: Bool { status == .paused }

    /// How far its first sync has got, to show: its count while it is connecting or ok; nil before the server has
    /// one, once the first sync is done, and while it is paused or needs the person (they say that instead).
    public var fetching: FirstSyncProgress? { status == .connecting || status == .ok ? firstSync : nil }

    /// Whether its mail is still being fetched: connecting, or a first sync still running (a long one's status may
    /// already say ok).
    public var isFetching: Bool { status == .connecting || fetching != nil }

    /// Why the server refused, in words, when it refused because this inbox is paused.
    public func pausedWords(_ refusal: PausedRefusal) -> String {
        switch refusal {
        case .sending:
            "\(name) is paused, so nothing is sent from it. The draft is kept: send it once the inbox is resumed."
        case .fetchingFile:
            "\(name) is paused, so your server can't fetch this file from its mailbox until the inbox is resumed."
        }
    }
}

/// What the server won't do for a paused inbox: each answers `conflict`. (So does a sync asked for now, which this
/// app doesn't ask for.)
public enum PausedRefusal: Hashable, Sendable {
    case sending
    case fetchingFile
}

/// Something that holds a token: one of the person's apps, or an agent.
public struct Device: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var kind: DeviceKind
    /// Agents only: the inboxes this agent was given.
    public var inboxIds: [String]?
    public var createdAt: Date
    public var lastSeenAt: Date?

    public init(
        id: String, name: String, kind: DeviceKind, inboxIds: [String]? = nil, createdAt: Date, lastSeenAt: Date? = nil
    ) {
        self.id = id
        self.name = name
        self.kind = kind
        self.inboxIds = inboxIds
        self.createdAt = createdAt
        self.lastSeenAt = lastSeenAt
    }
}

public struct ServerInfo: Codable, Hashable, Sendable {
    /// Always `usual-mail`.
    public var name: String
    public var version: String
    public var apiVersion: Int
    /// Whether Gmail can be connected by signing in with Google here. A server that leaves it out can't.
    public var googleSignIn: GoogleSignInInfo?

    public init(name: String, version: String, apiVersion: Int, googleSignIn: GoogleSignInInfo? = nil) {
        self.name = name
        self.version = version
        self.apiVersion = apiVersion
        self.googleSignIn = googleSignIn
    }
}

public struct Page<Item: Codable & Sendable>: Codable, Sendable {
    public var items: [Item]
    /// Pass back as `cursor` for the next page. Absent on the last page.
    public var nextCursor: String?

    public init(items: [Item], nextCursor: String? = nil) {
        self.items = items
        self.nextCursor = nextCursor
    }
}

extension Page: Equatable where Item: Equatable {}

/// A colour given as `#RRGGBB`, as inboxes carry it. Components run from 0 to 1.
public struct RGBColor: Hashable, Sendable {
    public var red: Double
    public var green: Double
    public var blue: Double

    public init?(hex: String) {
        var digits = hex.trimmingCharacters(in: .whitespaces)
        if digits.hasPrefix("#") { digits.removeFirst() }
        guard digits.count == 6, let value = UInt32(digits, radix: 16) else { return nil }
        red = Double((value >> 16) & 0xFF) / 255
        green = Double((value >> 8) & 0xFF) / 255
        blue = Double(value & 0xFF) / 255
    }
}
