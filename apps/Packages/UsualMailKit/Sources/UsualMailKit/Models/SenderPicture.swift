import Foundation

/// The picture an app shows for a thread's sender or a message's From instead of initials: an organisation's own site
/// icon, kept by the person's server and served through it (core's `Avatar`, docs/contract-avatars.md). Called
/// `SenderPicture` here because the screens already have an `Avatar` view. Absent means initials.
public struct SenderPicture: Codable, Hashable, Sendable {
    /// The picture route under the server's root, `/v1/avatars/<id>`, exactly as the server sent it. The id changes
    /// whenever the picture does.
    public var picture: String
    public var fit: SenderPictureFit
    /// The picture's longer side in pixels, as the server serves it (at least 16).
    public var size: Int

    public init(picture: String, fit: SenderPictureFit, size: Int) {
        self.picture = picture
        self.fit = fit
        self.size = size
    }

    /// The picture's id, the last part of `picture`, which is also what this device keeps it by: only when `picture`
    /// is exactly `/v1/avatars/` and 32 lowercase hexadecimal digits (the server's own ids). Anything else (an
    /// absolute address, another host, `..`, a query, another route) is nil, and initials show.
    public var id: String? {
        let prefix = "/v1/avatars/"
        guard picture.hasPrefix(prefix) else { return nil }
        let id = picture.dropFirst(prefix.count)
        return Self.isPictureID(id) ? String(id) : nil
    }

    /// 32 lowercase hexadecimal digits, as the server makes them: a hash of the domain and the picture's bytes.
    public static func isPictureID(_ id: some StringProtocol) -> Bool {
        id.utf8.count == 32 && id.utf8.allSatisfy { (0x30...0x39).contains($0) || (0x61...0x66).contains($0) }
    }
}

/// How the round avatar draws the picture. `fill`: a full square made to be cut to a circle (a maskable manifest icon,
/// an apple-touch-icon), scaled to fill it. `inset`: a mark that may sit on transparency (a favicon, any other icon),
/// scaled to fit inside the circle on a white disc. A value this app doesn't know is kept, and drawn as `inset`.
public enum SenderPictureFit: OpenEnum {
    case fill, inset
    case unknown(String)

    public static let known: [SenderPictureFit] = [.fill, .inset]

    public var rawValue: String {
        switch self {
        case .fill: "fill"
        case .inset: "inset"
        case .unknown(let raw): raw
        }
    }

    /// Only `fill` fills the circle; `inset` and any value this app doesn't know sit on a white disc.
    public var fillsTheCircle: Bool { self == .fill }
}
