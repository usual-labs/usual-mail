import SwiftUI
import UsualMailKit

#if os(macOS)
    import AppKit
#endif

/// Launch arguments that open a debug build in a given state, so its screens can be looked at and captured on a Mac
/// where nothing may drive the window. In a release build every option reads as absent, and the sample and pairing
/// at launch are not compiled at all.
///
/// ```sh
/// open UsualMail.app --args -UsualMailSample YES -UsualMailPlace home -UsualMailInbox inb_northwind
/// ```
///
/// - `-UsualMailSample YES`: core's sample data on the device, with no server (it reads as offline).
/// - `-UsualMailTour YES`: the sample as the onboarding tour's clips show it (`SampleData.tour`: every inbox well,
///   nothing left for the AI, a summary on every mail); implies `-UsualMailSample`.
/// - `-UsualMailPairServer <address> -UsualMailPairCode <code>`: pair at launch when not paired. The code is used
///   once and kept nowhere; only the token pairing gives is saved, in the Keychain, as pairing by hand does.
/// - `-UsualMailPlace home|reads|receipts|notifications|reply|pinned|snoozed|screening|search|inbox|settings`,
///   `-UsualMailInbox <id>` (the profile) and `-UsualMailThread <id>` (read in the card): where the window opens.
/// - `-UsualMailSettingsTab accounts|ai|appearance|blocked|about`: the tab Settings opens on, at launch with
///   `-UsualMailPlace settings` (Accounts when not given).
/// - `-UsualMailSearch "<text>"`: the window opens on search, over `-UsualMailPlace`'s stack (Home without), with that
///   text in the field, searched at once as if typed but without typing's pause. Only the ordinary search: no sentence
///   is asked, and older mail waits for its button.
/// - `-UsualMailRailOpen YES`: the rail stays open (wide, each button named) for the session, as if the pointer rested
///   on it, so its open state can be captured.
/// - `-UsualMailWindowSize <width>x<height>`: the window opens at that content size.
/// - `-UsualMailShowTooltips YES`: every icon's tooltip shows without hovering, to capture where they sit.
public struct LaunchOptions: Sendable {
    private let lookup: @Sendable (String) -> String?

    /// Options read through `lookup`, for tests.
    init(_ lookup: @escaping @Sendable (String) -> String?) {
        self.lookup = lookup
    }

    /// This process's options: its launch arguments in a debug build, none in a release build.
    public static let current: LaunchOptions = {
        #if DEBUG
            LaunchOptions { UserDefaults.standard.string(forKey: $0) }
        #else
            LaunchOptions { _ in nil }
        #endif
    }()

    #if DEBUG
        public var sample: Bool { flag("UsualMailSample") || tour }
        /// `-UsualMailTour YES`: the sample as the onboarding tour's clips show it (`SampleData.tour`).
        var tour: Bool { flag("UsualMailTour") }

        /// The server's address and a pairing code to pair with at launch, when both are given.
        var pairing: (address: String, code: String)? {
            guard let address = value("UsualMailPairServer"), let code = value("UsualMailPairCode") else { return nil }
            return (address, code)
        }

        /// Pairs `session` with the server and code given at launch, if it isn't paired already.
        @MainActor
        public func pairIfAsked(_ session: AppSession) async {
            session.restore()
            guard case .unpaired = session.state, let pairing else { return }
            await session.pair(address: pairing.address, code: pairing.code)
        }
    #endif

    var place: Place? { value("UsualMailPlace").flatMap(Self.place(parsing:)) }

    var inbox: String? { value("UsualMailInbox") }

    var thread: String? { value("UsualMailThread") }

    var settingsTab: SettingsTab? { value("UsualMailSettingsTab").flatMap(SettingsTab.init(rawValue:)) }

    var searchText: String? { value("UsualMailSearch") }

    var railStaysOpen: Bool { flag("UsualMailRailOpen") }

    var showsTooltips: Bool { flag("UsualMailShowTooltips") }

    /// Where the window opens: at `-UsualMailPlace` (Home without), with `-UsualMailThread` open there, the mail stack
    /// on `-UsualMailInbox`, Settings on `-UsualMailSettingsTab`, and search over it all with `-UsualMailSearch`.
    var navigation: Navigation {
        var nav = Navigation(place: place ?? .tab(.home), reading: thread, profile: inbox)
        if let settingsTab { nav.settingsTab = settingsTab }
        if searchText != nil, nav.place != .search { nav.openSearch() }
        return nav
    }

    /// The search page's model: with `-UsualMailSearch`, its text in the field and searched at once, as if typed but
    /// without typing's pause. Before the page has the store, nothing can be asked; the page asks again as it appears
    /// (`SearchView`). The ordinary search only: no sentence is asked, and older mail waits for its button.
    @MainActor
    func searchModel(_ model: SearchModel = SearchModel()) -> SearchModel {
        guard let searchText else { return model }
        model.text = searchText
        // Typed text waits for typing's pause; asking again starts at once, in place of that wait.
        model.refresh()
        return model
    }

    /// How the rail opens: as ever, or kept open with `-UsualMailRailOpen`.
    @MainActor
    func railOpening() -> RailOpening {
        RailOpening(staysOpen: railStaysOpen)
    }

    var windowSize: CGSize? {
        guard let parts = value("UsualMailWindowSize")?.split(separator: "x"), parts.count == 2,
            let width = Double(parts[0]), let height = Double(parts[1]), width > 0, height > 0
        else { return nil }
        return CGSize(width: width, height: height)
    }

    static func place(parsing text: String) -> Place? {
        if let tab = Tab(rawValue: text) { return .tab(tab) }
        switch text {
        // The rail's lists, which were tabs until 2026-11-19, keep the tabs' names.
        case "reply": return .toReply
        case "pinned": return .pinned
        case "snoozed": return .snoozed
        case "screening": return .screening
        case "search": return .search
        case "inbox": return .inbox
        case "settings": return .settings
        default: return nil
        }
    }

    private func value(_ key: String) -> String? {
        lookup(key).flatMap { $0.isEmpty ? nil : $0 }
    }

    private func flag(_ key: String) -> Bool {
        ["YES", "yes", "true", "1"].contains(value(key) ?? "")
    }
}

#if DEBUG
    /// The mail on core's sample data, with no server behind it: what `-UsualMailSample YES` shows. Actions show and
    /// are then taken back, as they would be offline.
    public struct SampleMailView: View {
        let session: AppSession
        @State private var store: MailStore?
        @State private var problem: String?

        public init(session: AppSession) {
            self.session = session
        }

        public var body: some View {
            if let store {
                #if os(macOS)
                    MailWindow(session: session)
                        .environment(store)
                #else
                    PhoneWindow(session: session)
                        .environment(store)
                #endif
            } else {
                Text(problem ?? "Loading the sample…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .task {
                        do {
                            store = try await MailStore.sample(LaunchOptions.current.tour ? .tour : .bundled)
                        } catch {
                            problem = "Couldn't load the sample: \(error.localizedDescription)"
                        }
                    }
            }
        }
    }
#endif

extension View {
    /// Applies `-UsualMailWindowSize` in debug builds: the window takes that content size once it opens. Changes
    /// nothing otherwise.
    public func launchSize() -> some View {
        #if DEBUG && os(macOS)
            background(WindowSizer(size: LaunchOptions.current.windowSize))
        #else
            self
        #endif
    }
}

#if DEBUG && os(macOS)
    /// Gives the window its launch size once, when the view joins it.
    private struct WindowSizer: NSViewRepresentable {
        let size: CGSize?

        func makeNSView(context: Context) -> NSView { SizingView(size: size) }
        func updateNSView(_ view: NSView, context: Context) {}

        final class SizingView: NSView {
            let size: CGSize?
            private var sized = false

            init(size: CGSize?) {
                self.size = size
                super.init(frame: .zero)
            }

            required init?(coder: NSCoder) { nil }

            override func viewDidMoveToWindow() {
                super.viewDidMoveToWindow()
                guard let size, let window, !sized else { return }
                sized = true
                DispatchQueue.main.async { window.setContentSize(size) }
            }
        }
    }
#endif
