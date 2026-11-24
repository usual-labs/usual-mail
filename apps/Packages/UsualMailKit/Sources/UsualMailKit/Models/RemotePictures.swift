import Foundation

/// What the server did with the pictures a message's HTML takes from the web (`core/src/pictures.ts`,
/// docs/contract-pictures.md): it shows them through itself, takes trackers out before anything is fetched, and holds
/// them back while the sender isn't let in.
public struct RemotePictures: Codable, Hashable, Sendable {
    /// Pictures shown through the server: the HTML points each at the picture route.
    public var shown: Int
    /// Tracking pictures taken out before anything was fetched, each address once.
    public var trackersRemoved: Int
    /// Who made the trackers the server's list knows, by the list's names, each once, in alphabetical order.
    public var trackers: [String]
    /// Set when the message's other pictures from the web are held back, so none is shown, until its sender is let in.
    public var heldBack: PicturesHeldBack?

    public init(shown: Int, trackersRemoved: Int = 0, trackers: [String] = [], heldBack: PicturesHeldBack? = nil) {
        self.shown = shown
        self.trackersRemoved = trackersRemoved
        self.trackers = trackers
        self.heldBack = heldBack
    }
}

/// Why a message's pictures from the web are held back: its thread is screened, or its sender is blocked.
public enum PicturesHeldBack: OpenEnum {
    case screened, blocked
    case unknown(String)

    public static let known: [PicturesHeldBack] = [.screened, .blocked]

    public var rawValue: String {
        switch self {
        case .screened: "screened"
        case .blocked: "blocked"
        case .unknown(let raw): raw
        }
    }
}
