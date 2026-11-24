import SwiftUI
import UsualMailKit

/// Settings' About tab: the wordmark and the owner's manifesto (onboarding's, `WelcomeStep.manifesto`), the links (the
/// website now; the source code once the repository is public, `ProjectLinks.isPublished`), and the versions of this
/// app and of the server (its API's too), or that the sample has no server.
struct AboutTab: View {
    @Environment(MailStore.self) private var store

    var body: some View {
        SettingsView.page {
            VStack(alignment: .leading, spacing: 12) {
                Text(verbatim: "Usual Mail")
                    .font(Theme.wordmark(20))
                    .foregroundStyle(Theme.ink)
                Text(verbatim: WelcomeStep.manifesto)
                    .font(Theme.sans(12))
                    .lineSpacing(4)
                    .foregroundStyle(Theme.body)
                    .frame(maxWidth: 440, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            SettingsView.group("Links") {
                ForEach(AboutWords.links(published: ProjectLinks.isPublished), id: \.url) { link in
                    Link(destination: link.url) {
                        HStack(spacing: 6) {
                            Text(verbatim: link.title)
                                .foregroundStyle(Theme.ink)
                            Text(verbatim: link.shown)
                                .foregroundStyle(Theme.secondary)
                                .underline()
                        }
                        .font(Theme.sans(12))
                    }
                    .pointer()
                }
            }
            SettingsView.group("Versions") {
                Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 16, verticalSpacing: 4) {
                    ForEach(versions, id: \.label) { line in
                        GridRow {
                            Text(verbatim: line.label)
                                .font(Theme.sans(12))
                                .foregroundStyle(Theme.ink)
                            Text(verbatim: line.value)
                                .font(Theme.sans(12))
                                .foregroundStyle(Theme.secondary)
                                .textSelection(.enabled)
                        }
                    }
                }
            }
        }
        .animation(Motion.reveal, value: store.serverInfo)
        .task { await store.loadServerInfo() }
    }

    private var versions: [AboutWords.Line] {
        let info = Bundle.main.infoDictionary
        return AboutWords.versions(
            appVersion: info?["CFBundleShortVersionString"] as? String, build: info?["CFBundleVersion"] as? String,
            server: store.serverInfo, sample: store.isSample)
    }
}

/// The About tab's words.
enum AboutWords {
    struct Link: Hashable {
        let title: String
        let url: URL
        /// The address as shown, without its scheme.
        var shown: String { url.absoluteString.replacingOccurrences(of: "https://", with: "") }
    }

    struct Line: Hashable {
        let label: String
        let value: String
    }

    /// The website, and the source code only once the repository is published.
    static func links(published: Bool) -> [Link] {
        var links = [Link(title: "Website", url: ProjectLinks.website)]
        if let source = ProjectLinks.sourceCode(published: published) {
            links.append(Link(title: "Source code", url: source))
        }
        return links
    }

    /// "App 0.1.0 (1)"; the server's version and its API's, "not heard from yet" before it answers; in the sample, that
    /// there is no server.
    static func versions(appVersion: String?, build: String?, server: ServerInfo?, sample: Bool) -> [Line] {
        let app: String =
            switch (appVersion, build) {
            case (let version?, let build?) where build != version: "\(version) (\(build))"
            case (let version?, _): version
            default: "Not known"
            }
        if sample {
            return [Line(label: "App", value: app), Line(label: "Server", value: "Sample data, no server")]
        }
        guard let server else {
            return [Line(label: "App", value: app), Line(label: "Server", value: "Not heard from yet")]
        }
        return [
            Line(label: "App", value: app), Line(label: "Server", value: server.version),
            Line(label: "API", value: "Version \(server.apiVersion)"),
        ]
    }
}
