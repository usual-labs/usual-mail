import SwiftUI
import UsualMailDesign
import UsualMailKit

/// The server's password in Settings' Accounts tab (docs/contract.md, "The owner's password"): whether one is set, and
/// setting a first or a new one from this paired device, which already has the owner's access, so the old one isn't
/// asked for. It is how a forgotten password is replaced while any device is signed in, and how a server paired before
/// passwords existed gets one. Read from the server when the tab shows (`GET /v1/owner`); nothing shows if it can't be.
/// Not over plain http to a local network (`ServerAddress.carriesPasswords`): there it says why instead. Its rows are
/// the Server section's: the password's state, then setting it, or the two fields, Cancel and Save.
struct ServerPassword: View {
    @Environment(MailStore.self) private var store
    @State private var owner: Owner?
    @State private var editing = false
    @State private var password = ""
    @State private var again = ""
    @State private var saving = false
    @State private var problem: String?
    @State private var saved = false
    /// Whether the server has been asked, so a state it couldn't give reads as not known rather than still coming.
    @State private var asked = false

    var body: some View {
        // Rows of the Server section: the state, "…" until the server has said whether a password is set.
        SettingsView.row("Password", value: owner.map(ServerPasswordWords.short) ?? (asked ? "Not known" : "…"))
            .task {
                owner = try? await store.apiClient.owner()
                asked = true
            }
        if let owner {
            if !owner.password {
                SettingsView.note(ServerPasswordWords.state(owner))
            }
            if !store.apiClient.server.carriesPasswords {
                // Plain http on a local network: a password sent from here would travel readable.
                SettingsView.note(ServerPasswordWords.plainHTTP)
            } else if editing {
                StepField(label: "New password", text: $password, secure: true)
                StepField(label: "New password again", text: $again, secure: true)
                    .onSubmit(save)
                VStack(alignment: .leading, spacing: 6) {
                    SettingsView.note(ServerPasswordWords.hint)
                    if let problem {
                        SettingsView.refusal(problem)
                            .transition(.blurReveal)
                    }
                }
                HStack(spacing: 12) {
                    Button("Cancel") { close() }
                        .buttonStyle(.bordered)
                    Spacer(minLength: 0)
                    Button(saving ? "Saving…" : "Save", action: save)
                        .buttonStyle(.borderedProminent)
                        .disabled(saving || password.isEmpty || again.isEmpty)
                }
                .tint(Theme.ink)
                .pointer()
            } else {
                if saved {
                    SettingsView.note(ServerPasswordWords.saved)
                        .transition(.blurReveal)
                }
                SettingsView.action(owner.password ? "Change the password…" : "Set a password…") {
                    withAnimation(Motion.move) {
                        saved = false
                        editing = true
                    }
                }
            }
        }
    }

    private func close() {
        withAnimation(Motion.move) {
            editing = false
            password = ""
            again = ""
            problem = nil
        }
    }

    private func save() {
        if let refusal = ServerPasswordWords.refusal(password: password, again: again) {
            problem = refusal
            return
        }
        saving = true
        problem = nil
        Task {
            defer { saving = false }
            do {
                owner = try await store.apiClient.setOwnerPassword(OwnerPasswordInput(password: password))
                close()
                saved = true
            } catch {
                problem = error.localizedDescription
            }
        }
    }
}

/// The server password's words.
enum ServerPasswordWords {
    static let hint =
        "At least \(ownerPasswordMinimum) characters. You'll sign in with it in the apps and on the server's dashboard; "
        + "devices already signed in stay signed in."
    static let saved = "Saved. Sign in with the new password from now on."
    /// Why a password isn't set from a device that reaches the server over plain http on a local network.
    static let plainHTTP =
        "This device reaches the server over plain http, so anyone on that network could read a password sent from "
        + "here. Set it from a device that reaches the server over https, on the server's own machine or over "
        + "Tailscale."

    /// The state's row: "Set 24 Nov 2026", "Set", or "Not set".
    static func short(_ owner: Owner) -> String {
        guard owner.password else { return "Not set" }
        guard let at = owner.passwordSetAt else { return "Set" }
        return "Set \(at.formatted(date: .abbreviated, time: .omitted))"
    }

    /// "Password set 24 Nov 2026", "Password set", or "No password yet: …".
    static func state(_ owner: Owner) -> String {
        guard owner.password else {
            return "No password yet. Set one to sign in with it in the apps and on the server's dashboard."
        }
        guard let at = owner.passwordSetAt else { return "Password set." }
        return "Password set \(at.formatted(date: .abbreviated, time: .omitted))."
    }

    /// Why the two fields can't be saved, before the server is asked; nil when they can.
    static func refusal(password: String, again: String) -> String? {
        if password != again { return "The two passwords aren't the same. Type them again." }
        if password.count < ownerPasswordMinimum {
            return "The password needs at least \(ownerPasswordMinimum) characters."
        }
        return nil
    }
}
