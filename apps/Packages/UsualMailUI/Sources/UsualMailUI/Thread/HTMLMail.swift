import CoreText
import Foundation
import UsualMailDesign
import UsualMailKit
import WebKit

/// How a message's HTML is shown: in a web view with its scripts off, nothing stored, nothing from the web, inline
/// pictures from the server's attachment route and pictures from the web through the server's picture route (the
/// server took trackers out first), and links opened in the browser. The server has already sanitized the HTML (no
/// scripts, forms, frames, `link`, `base` or `meta`); this is the second wall.
enum HTMLMail {
    /// The scheme the page's pictures load through: inline ones as
    /// `usualmail-attachment://attachment/<message id>/<attachment id>`, pictures from the web as
    /// `usualmail-attachment://picture/<message id>/<picture id>`. The web view hands these to
    /// `AttachmentSchemeHandler`, which fetches them with the device's token.
    static let attachmentScheme = "usualmail-attachment"

    // MARK: The document

    /// The page the web view loads: the message's HTML under a content security policy that allows no scripts, no
    /// frames, no forms, nothing from the web, and pictures only through the scheme and from `data:`. `cid:` pictures
    /// that match an attachment's Content-ID point at the attachment route, and the pictures the server shows through
    /// itself at the picture route.
    static func document(for message: Message) -> String {
        let html = mapPictures(in: InlineParts(message: message).rewrite(message.html ?? ""), messageId: message.id)
        return """
            <!doctype html><html><head><meta charset="utf-8">
            <meta http-equiv="Content-Security-Policy" content="\(contentSecurityPolicy)">
            <meta name="color-scheme" content="light">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>\(baseStyle)</style></head><body>\(html)</body></html>
            """
    }

    /// The policy, as one header value. Every kind of load not named falls back to `default-src 'none'`. Never http
    /// or https: pictures from the web come through the server, on the scheme.
    static let contentSecurityPolicy = [
        "default-src 'none'", "script-src 'none'", "object-src 'none'", "frame-src 'none'",
        "child-src 'none'", "worker-src 'none'", "connect-src 'none'", "media-src 'none'",
        "form-action 'none'", "base-uri 'none'", "style-src 'unsafe-inline'", "img-src \(attachmentScheme): data:",
        "font-src data:",
    ].joined(separator: "; ")

    /// Defaults under the message's own styles, as the mail page shows text: Geist at 12 points in black at 75%,
    /// links underlined in the text's colour, no page colour of its own (a designed message keeps its colours),
    /// pictures no wider than the view, and no scroll bars anywhere in it (owner's direction of 2026-11-18; a wide
    /// part still scrolls sideways). The web view runs in its own process, which can't see the fonts the app
    /// registered, so Geist comes in the page as `data:` fonts, which the policy allows.
    static let baseStyle: String = {
        let faces = [("Geist-Regular", 400), ("Geist-SemiBold", 700)].compactMap { name, weight -> String? in
            guard let data = fontData(postScriptName: name) else { return nil }
            return "@font-face{font-family:'Usual Geist';font-weight:\(weight);"
                + "src:url(data:font/ttf;base64,\(data.base64EncodedString())) format('truetype')}"
        }
        return faces.joined() + """
            html{background:transparent;color:rgba(0,0,0,.75);-webkit-text-size-adjust:100%}\
            body{margin:0;display:flow-root;font:12px/1.45 'Usual Geist',-apple-system,system-ui,sans-serif;\
            overflow-wrap:anywhere}\
            body>:first-child{margin-top:0}body>:last-child{margin-bottom:0}\
            a{color:inherit;text-decoration:underline}b,strong{font-weight:700}\
            img{max-width:100%;height:auto}table{max-width:100%}\
            *{scrollbar-width:none}*::-webkit-scrollbar{display:none;width:0;height:0}
            """
    }()

    /// The file of a font the app registered, by its PostScript name.
    static func fontData(postScriptName: String) -> Data? {
        UsualFonts.register()
        let font = CTFontCreateWithName(postScriptName as CFString, 12, nil)
        guard CTFontCopyPostScriptName(font) as String == postScriptName,
            let url = CTFontCopyAttribute(font, kCTFontURLAttribute) as? URL
        else { return nil }
        return try? Data(contentsOf: url)
    }

    // MARK: Attachment and picture URLs

    static func attachmentURL(messageId: String, attachmentId: String) -> URL {
        schemeURL(host: "attachment", messageId, attachmentId)
    }

    /// The message and attachment ids in an attachment URL, or nil for any other URL.
    static func attachmentIDs(in url: URL) -> (messageId: String, attachmentId: String)? {
        schemeIDs(in: url, host: "attachment").map { (messageId: $0, attachmentId: $1) }
    }

    /// Where the page loads a picture the server shows through itself.
    static func pictureURL(messageId: String, pictureId: String) -> URL {
        schemeURL(host: "picture", messageId, pictureId)
    }

    /// The message and picture ids in a picture URL, or nil for any other URL.
    static func pictureIDs(in url: URL) -> (messageId: String, pictureId: String)? {
        schemeIDs(in: url, host: "picture").map { (messageId: $0, pictureId: $1) }
    }

    private static func schemeURL(host: String, _ messageId: String, _ id: String) -> URL {
        var components = URLComponents()
        components.scheme = attachmentScheme
        components.host = host
        components.percentEncodedPath = "/" + [messageId, id].map(escape).joined(separator: "/")
        return components.url!
    }

    private static func schemeIDs(in url: URL, host: String) -> (String, String)? {
        guard url.scheme == attachmentScheme, url.host() == host else { return nil }
        let parts = url.path(percentEncoded: true).split(separator: "/").compactMap { $0.removingPercentEncoding }
        guard parts.count == 2 else { return nil }
        return (parts[0], parts[1])
    }

    private static func escape(_ id: String) -> String {
        id.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? id
    }

    // MARK: Pictures from the web

    /// A picture the server shows through itself, as the HTML it serves names it (docs/contract-pictures.md):
    /// `/v1/messages/<message id>/pictures/<picture id>`, relative to the server, the message id percent-encoded as
    /// core's `encodeURIComponent` leaves it, the picture id 22 characters of base64url. Never part of a longer path.
    private static let picturePath = try! NSRegularExpression(
        pattern: #"(?<![\w/.%~-])/v1/messages/([A-Za-z0-9._~!*'()%-]+)/pictures/([A-Za-z0-9_-]{22})(?![\w-])"#)

    private struct PicturePath {
        let range: Range<String.Index>
        let messageId: String
        let pictureId: String
    }

    /// Every place the HTML names a picture the server shows, with the message and picture it names.
    private static func picturePaths(in html: String) -> [PicturePath] {
        picturePath.matches(in: html, range: NSRange(html.startIndex..., in: html)).compactMap { match in
            guard let whole = Range(match.range, in: html), let message = Range(match.range(at: 1), in: html),
                let picture = Range(match.range(at: 2), in: html),
                let messageId = html[message].removingPercentEncoding
            else { return nil }
            return PicturePath(range: whole, messageId: messageId, pictureId: String(html[picture]))
        }
    }

    /// The ids of the pictures a message's HTML shows through the server. A path naming another message isn't one.
    static func shownPictures(in message: Message) -> Set<String> {
        Set(picturePaths(in: message.html ?? "").filter { $0.messageId == message.id }.map(\.pictureId))
    }

    /// The HTML with each of this message's pictures from the web pointing at its picture URL: in an `<img>`'s `src`,
    /// a table part's `background`, and a style attribute's or a style block's `url()` and `image-set()` (in a style
    /// attribute its quotes arrive as `&quot;`). A path naming another message stays as it is, so it loads nothing:
    /// the page has no base address and the policy allows no other.
    static func mapPictures(in html: String, messageId: String) -> String {
        var result = ""
        var rest = html.startIndex
        for path in picturePaths(in: html) where path.messageId == messageId {
            result += html[rest..<path.range.lowerBound]
            result += pictureURL(messageId: messageId, pictureId: path.pictureId).absoluteString
            rest = path.range.upperBound
        }
        return result + html[rest...]
    }

    // MARK: Links

    enum LinkDecision: Equatable {
        /// The page itself, or a jump within it.
        case load
        /// A link the person followed: it opens in the browser (or the system's app for mailto and tel).
        case openOutside(URL)
        /// Anything else: redirects, refreshes, frames, other schemes.
        case refuse
    }

    /// What to do with a navigation the web view asks about.
    static func decide(url: URL?, followedLink: Bool) -> LinkDecision {
        guard let url, let scheme = url.scheme?.lowercased() else { return .refuse }
        if scheme == "about" { return .load }  // the loaded page and its # anchors
        if followedLink, ["http", "https", "mailto", "tel"].contains(scheme) { return .openOutside(url) }
        return .refuse
    }

    // MARK: Web view settings

    /// The web view's settings for mail: no JavaScript from the content, no windows, nothing kept between loads, no
    /// media playing by itself, and the attachment scheme handled by `handler`.
    @MainActor
    static func configuration(handler: any WKURLSchemeHandler) -> WKWebViewConfiguration {
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = false
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.websiteDataStore = .nonPersistent()
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        configuration.setURLSchemeHandler(handler, forURLScheme: attachmentScheme)
        #if os(iOS)
            configuration.dataDetectorTypes = []
            configuration.allowsInlineMediaPlayback = false
        #endif
        return configuration
    }
}

/// Matches a message's `cid:` pictures to its attachments by Content-ID.
///
/// A `cid:` URL holds a Content-ID without its angle brackets, percent-encoded where needed (RFC 2392), and core's
/// `AttachmentMeta.contentId` holds it the same way. A `cid:` takes the attachment with that Content-ID, compared
/// exactly, then ignoring case. Only as a last resort, for inline attachments that carry no Content-ID, the old
/// guess remains: a `cid:` whose part before `@` is such an attachment's file name takes it, and if exactly one
/// `cid:` and one such attachment are left, they go together. Anything else stays unmatched: its picture doesn't
/// load, and the attachment is listed under the message instead.
struct InlineParts {
    let message: Message

    /// Each matched `cid:` value (as written in the HTML, without `cid:`) to its attachment's id.
    var matches: [String: String] {
        let references = Self.references(in: message.html ?? "")
        var matched: [String: String] = [:]
        let identified = message.attachments.filter { $0.contentId != nil }
        for reference in references {
            let wanted = Self.contentID(reference)
            let exact = identified.first { $0.contentId.map(Self.contentID) == wanted }
            let caseless = identified.first { $0.contentId.map(Self.contentID)?.lowercased() == wanted.lowercased() }
            if let attachment = exact ?? caseless { matched[reference] = attachment.id }
        }

        // The last resort, for inline attachments without a Content-ID.
        var free = message.attachments.filter { $0.inline && $0.contentId == nil }
        for reference in references where matched[reference] == nil {
            let local = Self.contentID(reference).split(separator: "@").first.map { String($0).lowercased() }
            if let local, let index = free.firstIndex(where: { $0.filename.lowercased() == local }) {
                matched[reference] = free.remove(at: index).id
            }
        }
        let left = references.filter { matched[$0] == nil }
        if left.count == 1, free.count == 1 { matched[left[0]] = free[0].id }
        return matched
    }

    /// A Content-ID as compared: percent-decoding undone, angle brackets and spaces taken off.
    static func contentID(_ value: String) -> String {
        let decoded = value.removingPercentEncoding ?? value
        return decoded.trimmingCharacters(in: CharacterSet(charactersIn: "<> \t"))
    }

    /// The inline attachments no picture in the HTML uses, to list with the other attachments.
    var unmatched: [AttachmentMeta] {
        let used = Set(matches.values)
        return message.attachments.filter { $0.inline && !used.contains($0.id) }
    }

    /// The attachments to list under a message's body: every file, and the inline pictures its HTML doesn't show
    /// (all of them for a message without HTML).
    static func listed(_ message: Message) -> [AttachmentMeta] {
        let unshown =
            message.html == nil ? message.attachments.filter(\.inline) : InlineParts(message: message).unmatched
        let ids = Set(unshown.map(\.id))
        return message.attachments.filter { !$0.inline || ids.contains($0.id) }
    }

    /// The HTML with each matched `cid:` pointing at the attachment route.
    func rewrite(_ html: String) -> String {
        var result = html
        for (reference, attachmentId) in matches {
            let url = HTMLMail.attachmentURL(messageId: message.id, attachmentId: attachmentId).absoluteString
            for prefix in ["cid:", "CID:", "Cid:"] {
                result = result.replacingOccurrences(of: prefix + reference, with: url)
            }
        }
        return result
    }

    /// Every distinct `cid:` value in the HTML, in order of first appearance.
    static func references(in html: String) -> [String] {
        guard let pattern = try? NSRegularExpression(pattern: #"cid:([^"'\s)>]+)"#, options: .caseInsensitive) else {
            return []
        }
        var seen: [String] = []
        for match in pattern.matches(in: html, range: NSRange(html.startIndex..., in: html)) {
            guard let range = Range(match.range(at: 1), in: html) else { continue }
            let value = String(html[range])
            if !seen.contains(value) { seen.append(value) }
        }
        return seen
    }
}
