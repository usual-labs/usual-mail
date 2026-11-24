import Foundation

/// Where Usual Mail lives on the web, for Settings' About tab and anything else that links to it (onboarding's guides
/// could take their address from `sourceCode`).
public enum ProjectLinks {
    /// The website, live now.
    public static let website = URL(string: "https://mail.usual.dev")!

    /// The repository with the source code. Not public yet: nothing shows it until `isPublished` is true.
    public static let repository = URL(string: "https://github.com/usual-labs/usual-mail")!

    /// Whether the repository is public. The one line to change when it is published.
    public static let isPublished = false

    /// The source code's address once the repository is public; nil until then, so no link points at a page that
    /// can't be opened.
    public static var sourceCode: URL? { sourceCode(published: isPublished) }

    /// `sourceCode` for a given state of the switch, for tests.
    public static func sourceCode(published: Bool) -> URL? {
        published ? repository : nil
    }
}
