import SwiftUI
import UsualMailKit
import WebKit

#if os(macOS)
    import AppKit
#else
    import UIKit
#endif

/// A message's HTML in its own web view, set up by `HTMLMail`: scripts off, nothing stored, nothing from the web,
/// inline pictures through the attachment route and pictures from the web through the server's picture route, links
/// opened outside. The view sizes itself to the page's height, so it sits inside the thread's scroll view: measured once the page loads, and again whenever
/// the view's width changes, as text reflows. Always drawn light, as mail is written for a white page.
struct HTMLMailView: View {
    let message: Message
    let client: APIClient
    @State private var height: CGFloat = 120

    var body: some View {
        HTMLMailWebView(message: message, client: client, height: $height)
            .frame(height: height)
            .accessibilityLabel("Message from \(message.from.displayName)")
    }
}

#if os(macOS)
    private typealias Representable = NSViewRepresentable
#else
    private typealias Representable = UIViewRepresentable
#endif

private struct HTMLMailWebView: Representable {
    let message: Message
    let client: APIClient
    @Binding var height: CGFloat

    func makeCoordinator() -> HTMLMailCoordinator {
        HTMLMailCoordinator(client: client, message: message)
    }

    #if os(macOS)
        func makeNSView(context: Context) -> WKWebView { makeWebView(context.coordinator) }
        func updateNSView(_ webView: WKWebView, context: Context) { update(webView, context.coordinator) }
    #else
        func makeUIView(context: Context) -> WKWebView { makeWebView(context.coordinator) }
        func updateUIView(_ webView: WKWebView, context: Context) { update(webView, context.coordinator) }
    #endif

    private func makeWebView(_ coordinator: HTMLMailCoordinator) -> WKWebView {
        let webView = MailWebView(
            frame: .zero, configuration: HTMLMail.configuration(handler: coordinator.attachments))
        webView.navigationDelegate = coordinator
        webView.onWidthChange = { [weak coordinator, weak webView] in
            guard let coordinator, let webView else { return }
            coordinator.widthChanged(webView)
        }
        webView.allowsBackForwardNavigationGestures = false
        #if os(macOS)
            webView.appearance = NSAppearance(named: .aqua)
            // Let the card show through a page without colours of its own. The key is WebKit's on the Mac; checked
            // first so a WebKit without it only keeps its white page.
            if webView.responds(to: NSSelectorFromString("setDrawsBackground:"))
                || webView.responds(to: NSSelectorFromString("_setDrawsBackground:"))
            {
                webView.setValue(false, forKey: "drawsBackground")
            }
            webView.underPageBackgroundColor = .clear
        #else
            webView.overrideUserInterfaceStyle = .light
            webView.isOpaque = false
            webView.scrollView.isScrollEnabled = false
        #endif
        coordinator.onHeight = { measured in
            if abs(measured - height) > 1 { height = measured }
        }
        return webView
    }

    private func update(_ webView: WKWebView, _ coordinator: HTMLMailCoordinator) {
        coordinator.onHeight = { measured in
            if abs(measured - height) > 1 { height = measured }
        }
        // The HTML too: a sender let in brings the same message back with its pictures.
        let key = "\(message.id)|\(message.html?.hashValue ?? 0)"
        guard coordinator.loadedKey != key else { return }
        coordinator.loadedKey = key
        coordinator.loaded = false
        coordinator.attachments.message = message
        webView.loadHTMLString(HTMLMail.document(for: message), baseURL: nil)
    }
}

/// A web view that says when its width changes after layout, so the page can be measured again. On the Mac it is as
/// tall as its page, so it has nothing to scroll up or down: it hands vertical scrolling to the mail page around it,
/// which WebKit would otherwise keep (the page didn't scroll with the pointer over a mail, 2026-11-18), and keeps
/// sideways scrolling for a mail wider than the card.
final class MailWebView: WKWebView {
    var onWidthChange: (() -> Void)?
    private var widths = WidthWatch()

    #if os(macOS)
        override func layout() {
            super.layout()
            if widths.changed(to: bounds.width) { onWidthChange?() }
        }

        override func scrollWheel(with event: NSEvent) {
            if Self.passesOn(deltaX: event.scrollingDeltaX, deltaY: event.scrollingDeltaY), let next = nextResponder {
                next.scrollWheel(with: event)
            } else {
                super.scrollWheel(with: event)
            }
        }
    #else
        override func layoutSubviews() {
            super.layoutSubviews()
            if widths.changed(to: bounds.width) { onWidthChange?() }
        }
    #endif
}

extension MailWebView {
    /// Whether a scroll goes to the page around the mail: mostly up or down. A sideways one stays with the mail.
    nonisolated static func passesOn(deltaX: CGFloat, deltaY: CGFloat) -> Bool {
        abs(deltaY) >= abs(deltaX)
    }
}

/// Tells a real change of width from layout passes that keep it (a new height lays the view out again too).
struct WidthWatch {
    private(set) var width: CGFloat = 0

    /// True when `newWidth` is a usable width more than half a point from the last one seen.
    mutating func changed(to newWidth: CGFloat) -> Bool {
        guard newWidth > 0, abs(newWidth - width) > 0.5 else { return false }
        width = newWidth
        return true
    }
}

/// Decides navigations and measures the page once it has loaded and whenever its width changes.
@MainActor
final class HTMLMailCoordinator: NSObject, WKNavigationDelegate {
    let attachments: AttachmentSchemeHandler
    var loadedKey: String?
    /// The current page has finished loading, so measuring it means something.
    var loaded = false
    var onHeight: ((CGFloat) -> Void)?

    init(client: APIClient, message: Message) {
        attachments = AttachmentSchemeHandler(client: client, message: message)
    }

    /// The page's content height, from the app's own script world (the page's scripts stay off). The body's height
    /// with its margins rather than the document's scroll height, which never drops below the view's current
    /// height and so would never let the view shrink when it widens.
    nonisolated static let heightScript = """
        (() => { const b = document.body; if (!b) { return document.documentElement.scrollHeight; } \
        const s = getComputedStyle(b); \
        return Math.ceil(b.scrollHeight + parseFloat(s.marginTop) + parseFloat(s.marginBottom)); })()
        """

    func widthChanged(_ webView: WKWebView) {
        if loaded { measure(webView) }
    }

    func measure(_ webView: WKWebView) {
        webView.evaluateJavaScript(Self.heightScript, in: nil, in: .defaultClient) { [weak self] result in
            guard case .success(let value) = result, let number = value as? NSNumber else { return }
            self?.onHeight?(CGFloat(truncating: number))
        }
    }

    func webView(
        _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
    ) {
        let decision = HTMLMail.decide(
            url: navigationAction.request.url, followedLink: navigationAction.navigationType == .linkActivated)
        switch decision {
        case .load:
            decisionHandler(.allow)
        case .openOutside(let url):
            decisionHandler(.cancel)
            #if os(macOS)
                NSWorkspace.shared.open(url)
            #else
                UIApplication.shared.open(url)
            #endif
        case .refuse:
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded = true
        measure(webView)
    }
}

/// Serves `usualmail-attachment:` URLs, with the device's token, for the message on show only: inline pictures from
/// the server's attachment route, and pictures from the web its HTML shows from the picture route. Anything else the
/// page asks for through the scheme fails, and so does a picture the server can't give (`not_found`,
/// `provider_error`, offline): WebKit then shows the picture's alt text or the space it declares.
@MainActor
final class AttachmentSchemeHandler: NSObject, WKURLSchemeHandler {
    let client: APIClient
    var message: Message {
        didSet { pictures = HTMLMail.shownPictures(in: message) }
    }
    /// The pictures from the web the message's HTML shows, by id.
    private var pictures: Set<String>
    private var running: [ObjectIdentifier: Task<Void, Never>] = [:]

    init(client: APIClient, message: Message) {
        self.client = client
        self.message = message
        pictures = HTMLMail.shownPictures(in: message)
    }

    /// What a URL asks the server for, if anything.
    enum Load: Equatable {
        case attachment(messageId: String, AttachmentMeta)
        case picture(messageId: String, pictureId: String)
    }

    /// The attachment or picture a URL names, if it belongs to the message on show and, for a picture, its HTML shows
    /// it.
    func load(for url: URL?) -> Load? {
        if let attachment = attachment(for: url) { return .attachment(messageId: message.id, attachment) }
        guard let url, let ids = HTMLMail.pictureIDs(in: url), ids.messageId == message.id,
            pictures.contains(ids.pictureId)
        else { return nil }
        return .picture(messageId: message.id, pictureId: ids.pictureId)
    }

    /// The attachment a URL names, if it belongs to the message on show.
    func attachment(for url: URL?) -> AttachmentMeta? {
        guard let url, let ids = HTMLMail.attachmentIDs(in: url), ids.messageId == message.id else { return nil }
        return message.attachments.first { $0.id == ids.attachmentId }
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
        let key = ObjectIdentifier(urlSchemeTask)
        guard let url = urlSchemeTask.request.url, let load = load(for: url) else {
            urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist))
            return
        }
        running[key] = Task { [client] in
            do {
                let file: AttachmentData
                let declared: String?
                switch load {
                case .attachment(let messageId, let attachment):
                    file = try await client.attachment(messageId: messageId, attachmentId: attachment.id)
                    declared = attachment.mimeType
                case .picture(let messageId, let pictureId):
                    file = try await client.picture(messageId: messageId, pictureId: pictureId)
                    declared = nil
                }
                guard !Task.isCancelled else { return }
                let type = file.mimeType?.split(separator: ";").first.map(String.init) ?? declared
                let response = URLResponse(
                    url: url, mimeType: type?.trimmingCharacters(in: .whitespaces),
                    expectedContentLength: file.data.count,
                    textEncodingName: nil)
                urlSchemeTask.didReceive(response)
                urlSchemeTask.didReceive(file.data)
                urlSchemeTask.didFinish()
            } catch {
                guard !Task.isCancelled else { return }
                urlSchemeTask.didFailWithError(error)
            }
            self.running[key] = nil
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {
        running.removeValue(forKey: ObjectIdentifier(urlSchemeTask))?.cancel()
    }
}
