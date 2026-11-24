import Foundation
import Testing
import UsualMailKit
import WebKit

@testable import UsualMailUI

/// The HTML view's settings, checked without loading a page: what the web view is told, the page it is given, and
/// what it may load or follow. Nothing here runs WebKit's renderer.
struct HTMLMailTests {
    private func message(html: String, attachments: [AttachmentMeta] = []) -> Message {
        Message(
            id: "msg/1", threadId: "thr_1", inboxId: "inb_northwind", from: Address(email: "a@b.example"),
            date: Date(timeIntervalSince1970: 0), subject: "s", html: html, attachments: attachments)
    }

    private func picture(_ id: String, _ filename: String, contentId: String? = nil) -> AttachmentMeta {
        AttachmentMeta(id: id, filename: filename, mimeType: "image/png", size: 10, inline: true, contentId: contentId)
    }

    @MainActor
    @Test func theWebViewRunsNoScriptsAndKeepsNothing() {
        let handler = AttachmentSchemeHandler(
            client: APIClient(server: try! ServerAddress(parsing: "mail.local")), message: message(html: ""))
        let configuration = HTMLMail.configuration(handler: handler)
        #expect(configuration.defaultWebpagePreferences.allowsContentJavaScript == false)
        #expect(configuration.preferences.javaScriptCanOpenWindowsAutomatically == false)
        #expect(configuration.websiteDataStore.isPersistent == false)
        #expect(configuration.mediaTypesRequiringUserActionForPlayback == .all)
        #expect(configuration.urlSchemeHandler(forURLScheme: HTMLMail.attachmentScheme) === handler)
    }

    @Test func nothingLoadsFromTheWeb() {
        let policy = HTMLMail.contentSecurityPolicy
        #expect(policy.contains("default-src 'none'"))
        #expect(policy.contains("script-src 'none'"))
        #expect(policy.contains("frame-src 'none'") && policy.contains("form-action 'none'"))
        #expect(policy.contains("img-src usualmail-attachment: data:;"))
        #expect(policy.hasSuffix("font-src data:"))
        #expect(!policy.contains("http"))
    }

    @Test func thePageCarriesThePolicyBeforeTheMessage() throws {
        // An address on the web, as an older server sent it, stays as it is and the policy refuses it.
        let html = #"<p>Hi</p><img src="https://tracker.example/p.gif">"#
        let page = HTMLMail.document(for: message(html: html))
        let policy = try #require(page.range(of: "Content-Security-Policy"))
        let body = try #require(page.range(of: "<p>Hi</p>"))
        #expect(policy.lowerBound < body.lowerBound)
        #expect(page.contains(HTMLMail.contentSecurityPolicy))
        #expect(page.contains(#"<meta name="color-scheme" content="light">"#))
        #expect(!page.contains("https: http:"))
    }

    @Test func inlinePicturesMatchTheirContentID() {
        let html = #"<img src="cid:logo.png@01D9"><img src="cid:banner@x"><img src="cid:logo.png@01D9">"#
        // The file names point the other way; the Content-IDs decide.
        let mail = message(
            html: html,
            attachments: [
                picture("att_1", "banner.jpg", contentId: "logo.png@01D9"),
                picture("att_2", "logo.png", contentId: "banner@x"),
            ])
        let parts = InlineParts(message: mail)
        #expect(parts.matches == ["logo.png@01D9": "att_1", "banner@x": "att_2"])
        #expect(parts.unmatched.isEmpty)
        let page = HTMLMail.document(for: mail)
        #expect(page.contains(#"src="usualmail-attachment://attachment/msg%2F1/att_1""#))
        #expect(page.contains(#"src="usualmail-attachment://attachment/msg%2F1/att_2""#))
        #expect(!page.contains("cid:"))
    }

    @Test func aContentIDMatchesPercentEncodedAndInAnyCase() {
        let html = #"<img src="cid:part1.%3C06%3E%40mail.example"><img src="CID:Logo@X">"#
        let mail = message(
            html: html,
            attachments: [
                picture("att_1", "image001.png", contentId: "part1.<06>@mail.example"),
                picture("att_2", "image002.png", contentId: "logo@x"),
            ])
        #expect(InlineParts(message: mail).matches == ["part1.%3C06%3E%40mail.example": "att_1", "Logo@X": "att_2"])
        #expect(HTMLMail.document(for: mail).range(of: "cid:", options: .caseInsensitive) == nil)
    }

    @Test func fileNamesAreALastResortOnlyWithoutContentIDs() {
        // An attachment with a Content-ID is never guessed for another cid.
        let html = #"<img src="cid:logo.png@x">"#
        let identified = message(html: html, attachments: [picture("att_1", "logo.png", contentId: "other@x")])
        #expect(InlineParts(message: identified).matches.isEmpty)
        #expect(InlineParts.listed(identified).map(\.id) == ["att_1"])
        // Without Content-IDs, the old guess still works: the file name, then one left with one.
        let html2 = #"<img src="cid:logo.png@01D9"><img src="cid:banner@x">"#
        let bare = message(html: html2, attachments: [picture("att_2", "banner.jpg"), picture("att_1", "logo.png")])
        #expect(InlineParts(message: bare).matches == ["logo.png@01D9": "att_1", "banner@x": "att_2"])
    }

    @Test func anAmbiguousPictureStaysUnmatchedAndIsListed() {
        let html = #"<img src="cid:one@x"><img src="cid:two@x">"#
        let attachments = [
            picture("att_1", "a.png"), picture("att_2", "b.png"),
            AttachmentMeta(id: "att_3", filename: "terms.pdf", mimeType: "application/pdf", size: 9, inline: false),
        ]
        let mail = message(html: html, attachments: attachments)
        #expect(InlineParts(message: mail).matches.isEmpty)
        #expect(InlineParts.listed(mail).map(\.id) == ["att_1", "att_2", "att_3"])
        var plain = mail
        plain.html = nil
        #expect(InlineParts.listed(plain).map(\.id) == ["att_1", "att_2", "att_3"])
    }

    @Test func attachmentURLsRoundTrip() throws {
        let url = HTMLMail.attachmentURL(messageId: "msg/1 ä", attachmentId: "att#2")
        let ids = try #require(HTMLMail.attachmentIDs(in: url))
        #expect(ids.messageId == "msg/1 ä" && ids.attachmentId == "att#2")
        #expect(HTMLMail.attachmentIDs(in: URL(string: "https://attachment/a/b")!) == nil)
        #expect(HTMLMail.attachmentIDs(in: URL(string: "usualmail-attachment://attachment/only-one")!) == nil)
    }

    /// A picture id as the server makes them: 22 characters of base64url.
    private func pictureID(_ letter: String) -> String { letter + String(repeating: "x", count: 20) + "_" }

    /// The server's path for one of `msg/1`'s pictures, percent-encoded as core's `picturePath` writes it.
    private func path(_ pictureId: String, message: String = "msg%2F1") -> String {
        "/v1/messages/\(message)/pictures/\(pictureId)"
    }

    private func mapped(_ pictureId: String) -> String {
        HTMLMail.pictureURL(messageId: "msg/1", pictureId: pictureId).absoluteString
    }

    @Test func picturesFromTheWebPointAtThePictureRoute() {
        let (a, b, c, d, e, f) = (
            pictureID("a"), pictureID("b"), pictureID("c"), pictureID("d"), pictureID("e"), pictureID("f")
        )
        // As the server writes them: an <img>, a table part's background, a style attribute (its quotes as &quot;),
        // and a style block's url() and image-set(). A held-back picture keeps its <img> without an address.
        let html = """
            <style>.hero{background:url("\(path(d))")}.x{background-image:image-set("\(path(e))" 1x, "\(path(f))" 2x)}</style>
            <img src="\(path(a))" alt="Logo" width="120"><table><tr><td background="\(path(b))">Sale</td></tr></table>
            <div style="background-image:url(&quot;\(path(c))&quot;)">Hi</div><img alt="Banner" width="600">
            """
        let mail = message(html: html)
        #expect(mapped(a) == "usualmail-attachment://picture/msg%2F1/\(a)")
        let page = HTMLMail.document(for: mail)
        #expect(page.contains(#"<img src="\#(mapped(a))" alt="Logo" width="120">"#))
        #expect(page.contains(#"<td background="\#(mapped(b))">"#))
        #expect(page.contains(#"style="background-image:url(&quot;\#(mapped(c))&quot;)""#))
        #expect(page.contains(#".hero{background:url("\#(mapped(d))")}"#))
        #expect(page.contains(#"image-set("\#(mapped(e))" 1x, "\#(mapped(f))" 2x)"#))
        #expect(page.contains(#"<img alt="Banner" width="600">"#))
        #expect(!page.contains("/v1/messages/"))
        #expect(HTMLMail.shownPictures(in: mail) == [a, b, c, d, e, f])
    }

    @Test func anotherMessagesPictureStaysUnmapped() {
        let a = pictureID("a")
        let html = """
            <img src="\(path(a, message: "msg_other"))"><img src="/mail\(path(a))">\
            <img src="\(path(a + "x"))"><p>\(path("short"))</p>
            """
        let mail = message(html: html)
        // Another message's picture, one under a longer path, an id too long or too short: left as they are, so they
        // load nothing.
        #expect(HTMLMail.mapPictures(in: html, messageId: "msg/1") == html)
        #expect(HTMLMail.shownPictures(in: mail).isEmpty)
        #expect(!HTMLMail.document(for: mail).contains("usualmail-attachment://picture"))
    }

    @Test func pictureURLsRoundTrip() throws {
        let url = HTMLMail.pictureURL(messageId: "msg/1 ä", pictureId: "AbCdEfGhIjKlMnOpQrSt_-")
        let ids = try #require(HTMLMail.pictureIDs(in: url))
        #expect(ids.messageId == "msg/1 ä" && ids.pictureId == "AbCdEfGhIjKlMnOpQrSt_-")
        // An attachment URL isn't a picture's, nor the other way round.
        #expect(HTMLMail.pictureIDs(in: HTMLMail.attachmentURL(messageId: "msg/1", attachmentId: "att_1")) == nil)
        #expect(HTMLMail.attachmentIDs(in: url) == nil)
        #expect(HTMLMail.pictureIDs(in: URL(string: "https://picture/a/b")!) == nil)
        #expect(HTMLMail.pictureIDs(in: URL(string: "usualmail-attachment://picture/only-one")!) == nil)
    }

    @MainActor
    @Test func theSchemeServesOnlyPicturesThisMessageShows() {
        let (shown, unshown) = (pictureID("a"), pictureID("b"))
        let mail = message(html: #"<img src="\#(path(shown))">"#, attachments: [picture("att_1", "logo.png")])
        let handler = AttachmentSchemeHandler(
            client: APIClient(server: try! ServerAddress(parsing: "mail.local")), message: mail)
        #expect(
            handler.load(for: HTMLMail.pictureURL(messageId: "msg/1", pictureId: shown))
                == .picture(messageId: "msg/1", pictureId: shown))
        #expect(handler.load(for: HTMLMail.pictureURL(messageId: "msg/1", pictureId: unshown)) == nil)
        #expect(handler.load(for: HTMLMail.pictureURL(messageId: "msg_other", pictureId: shown)) == nil)
        #expect(
            handler.load(for: HTMLMail.attachmentURL(messageId: "msg/1", attachmentId: "att_1"))
                == .attachment(messageId: "msg/1", mail.attachments[0]))
        #expect(handler.load(for: URL(string: "https://example.com\(path(shown))")) == nil)
        // Another message on show: the last one's pictures are refused.
        let next = #"<img src="\#(path(unshown, message: "msg_2"))">"#
        handler.message = Message(
            id: "msg_2", threadId: "thr_1", inboxId: "inb_northwind", from: Address(email: "a@b.example"),
            date: Date(timeIntervalSince1970: 0), subject: "s", html: next)
        #expect(handler.load(for: HTMLMail.pictureURL(messageId: "msg/1", pictureId: shown)) == nil)
        #expect(
            handler.load(for: HTMLMail.pictureURL(messageId: "msg_2", pictureId: unshown))
                == .picture(messageId: "msg_2", pictureId: unshown))
    }

    @MainActor
    @Test func theSchemeServesOnlyThisMessagesAttachments() {
        let mail = message(html: "", attachments: [picture("att_1", "logo.png")])
        let handler = AttachmentSchemeHandler(
            client: APIClient(server: try! ServerAddress(parsing: "mail.local")), message: mail)
        #expect(
            handler.attachment(for: HTMLMail.attachmentURL(messageId: "msg/1", attachmentId: "att_1"))?.id == "att_1")
        #expect(handler.attachment(for: HTMLMail.attachmentURL(messageId: "msg_other", attachmentId: "att_1")) == nil)
        #expect(handler.attachment(for: HTMLMail.attachmentURL(messageId: "msg/1", attachmentId: "att_9")) == nil)
        #expect(handler.attachment(for: URL(string: "https://example.com/logo.png")) == nil)
    }

    @Test func aNewWidthAsksForANewMeasurementAndNothingElseDoes() {
        var widths = WidthWatch()
        // Not laid out yet; then a width; the same width again (a new height lays the view out again); a sliver
        // more; then the window narrows and the text reflows.
        let changes = [0, 640, 640, 640.3, 420].map { widths.changed(to: $0) }
        #expect(changes == [false, true, false, false, true])
        #expect(widths.width == 420)
        // The measurement is the body's height with its margins, so the view can shrink as well as grow.
        let script = HTMLMailCoordinator.heightScript
        #expect(script.contains("b.scrollHeight") && script.contains("marginTop") && script.contains("marginBottom"))
    }

    @Test func aMailShowsNoScrollBars() {
        #expect(HTMLMail.baseStyle.contains("*::-webkit-scrollbar{display:none"))
        #expect(HTMLMail.baseStyle.contains("scrollbar-width:none"))
    }

    @Test func scrollingUpOrDownMovesThePageAroundTheMail() {
        // The web view is as tall as its page: up and down go to the mail page, sideways stays with a wide mail.
        #expect(MailWebView.passesOn(deltaX: 0, deltaY: -12))
        #expect(MailWebView.passesOn(deltaX: 2, deltaY: 9))
        #expect(!MailWebView.passesOn(deltaX: -14, deltaY: 1))
    }

    @Test func linksOpenOutsideAndNothingElseNavigates() {
        let link = URL(string: "https://example.com/terms")!
        #expect(HTMLMail.decide(url: link, followedLink: true) == .openOutside(link))
        #expect(
            HTMLMail.decide(url: URL(string: "mailto:a@b.example")!, followedLink: true)
                == .openOutside(URL(string: "mailto:a@b.example")!))
        #expect(HTMLMail.decide(url: link, followedLink: false) == .refuse)  // a redirect or refresh
        #expect(HTMLMail.decide(url: URL(string: "about:blank")!, followedLink: false) == .load)
        #expect(HTMLMail.decide(url: URL(string: "about:blank#top")!, followedLink: true) == .load)
        #expect(HTMLMail.decide(url: URL(string: "javascript:alert(1)")!, followedLink: true) == .refuse)
        #expect(HTMLMail.decide(url: URL(string: "file:///etc/hosts")!, followedLink: true) == .refuse)
        #expect(HTMLMail.decide(url: nil, followedLink: true) == .refuse)
    }
}
