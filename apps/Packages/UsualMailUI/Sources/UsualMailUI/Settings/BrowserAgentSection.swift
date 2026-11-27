import SwiftUI
import UsualMailKit

/// "Unsubscribing", on Settings' AI tab (the owner's request of 2026-11-27; docs/contract.md, "Unsubscribing"): the
/// optional browser agent, Browser Use, that opens a sender's unsubscribe page when their mail offers nothing cheaper.
/// While none is set up: what it is for, a link to get a key, core's words on what Browser Use is sent
/// (`BrowserAgentDisclosure`, above the field, so they are read before Save, as the AI key's words are shown before its
/// key is saved), the key in a secure field and Save. Once set up: how it stands, in the server's state and words, and
/// Remove. The key leaves the field the moment it is sent and is kept nowhere on the device (`BrowserAgentSetup`). Shown
/// only where the AI's settings are, a person's device; the same on the Mac and the iPhone, each drawing the form its
/// way.
struct BrowserAgentSection: View {
    @Environment(MailStore.self) private var store
    @State private var setup: BrowserAgentSetup?
    @State private var key = ""

    var body: some View {
        let settings = store.aiSettings?.browserAgent
        SettingsView.group("Unsubscribing", footer: settings == nil ? [] : [BrowserAgentWords.removing]) {
            if !store.serverUnsubscribes {
                // A server older than 0.1.5 neither unsubscribes nor takes a key.
                SettingsView.words(BrowserAgentWords.oldServer)
            } else if let settings {
                SettingsView.row(BrowserAgentWords.service, value: BrowserAgentWords.short(settings))
                if let note = BrowserAgentWords.note(settings) {
                    SettingsView.note(note)
                        .transition(.blurReveal)
                }
                refusal
                SettingsView.action(
                    setup?.step == .removing ? "Removing…" : "Remove the key", destructive: true, action: remove
                )
                .disabled(setup?.isBusy == true)
            } else {
                SettingsView.words(BrowserAgentWords.intro)
                SettingsView.link(BrowserAgentWords.getKey) { Links.open(BrowserAgentWords.keys) }
                disclosure
                StepField(label: BrowserAgentWords.field, text: $key, secure: true)
                    .onSubmit(save)
                refusal
                HStack {
                    Spacer(minLength: 0)
                    Button(setup?.step == .saving ? "Saving…" : "Save", action: save)
                        .buttonStyle(.borderedProminent)
                        .tint(Theme.ink)
                        .disabled(!canSave)
                        .pointer()
                }
            }
        }
        .animation(Motion.reveal, value: settings)
        .animation(Motion.reveal, value: setup?.refusal)
        .task {
            if setup == nil { setup = BrowserAgentSetup(store: store) }
        }
    }

    /// Core's words on what Browser Use is sent: its title, then each line.
    private var disclosure: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(verbatim: BrowserAgentDisclosure.title)
                .font(Theme.sans(SettingsType.note, weight: .semibold))
                .foregroundStyle(Theme.ink)
            ForEach(BrowserAgentDisclosure.lines, id: \.self) { SettingsView.note($0) }
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder private var refusal: some View {
        if let refusal = setup?.refusal {
            SettingsView.refusal(refusal)
                .transition(.blurReveal)
        }
    }

    private var canSave: Bool {
        setup?.isBusy == false && !key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Sends the key and clears the field at once, so it stays nowhere while the server tests it.
    private func save() {
        guard canSave, let setup else { return }
        let typed = key
        key = ""
        Task { await setup.save(key: typed) }
    }

    private func remove() {
        guard let setup else { return }
        Task { await setup.remove() }
    }
}

/// The Unsubscribing section's words.
enum BrowserAgentWords {
    static let service = "Browser Use"
    static let field = "Browser Use key"
    static let getKey = "Get a key from Browser Use"
    /// Where a Browser Use key is made.
    static let keys = URL(string: "https://cloud.browser-use.com")!

    static let intro =
        "Optional. Unsubscribing asks a sender the cheapest way their mail offers. When it offers nothing but a page, "
        + "a browser agent can open that page and unsubscribe for you; without one, the page is left for you to open, "
        + "under Blocked."

    static let removing = "Without the key, a page that is left is yours to open, under Blocked."
    /// On a server older than 0.1.5, in the key's place.
    static let oldServer =
        "Unsubscribing, and Browser Use with it, needs your server at version 0.1.5 or newer. Update it to set a key here."

    /// The state in a word or two, for its row.
    static func short(_ settings: BrowserAgentSettings) -> String {
        switch settings.state {
        case .working: "Working"
        case .keyRefused: "Key refused"
        case .outOfCredit: "Out of credit"
        case .unavailable: "Unavailable"
        case .unknown: "Not known"
        }
    }

    /// Under the row, unless it works: the server's words as they are, else a line of its own.
    static func note(_ settings: BrowserAgentSettings) -> String? {
        if let detail = settings.detail?.trimmingCharacters(in: .whitespacesAndNewlines), !detail.isEmpty {
            return detail
        }
        switch settings.state {
        case .working: return nil
        case .keyRefused: return "Browser Use refused the key. Remove it and save a new one."
        case .outOfCredit: return "Your Browser Use account is out of credit."
        case .unavailable: return "Browser Use couldn't be reached. This usually passes by itself."
        case .unknown: return nil
        }
    }
}
