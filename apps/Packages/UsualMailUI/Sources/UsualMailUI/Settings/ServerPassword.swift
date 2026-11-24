import SwiftUI
import UsualMailDesign
import UsualMailKit

/// The server's password in Settings' Accounts tab (docs/contract.md, "The owner's password"): whether one is set, and
/// setting a first or a new one from this paired device, which already has the owner's access, so the old one isn't
/// asked for. It is how a forgotten password is replaced while any device is signed in, and how a server paired before
/// passwords existed gets one. Read from the server when the tab shows (`GET /v1/owner`); nothing shows if it can't be.
struct ServerPassword: View {
    @Environment(MailStore.self) private var store
    @State private var owner: Owner?
    @State private var editing = false
    @State private var password = ""
    @State private var again = ""
    @State private var saving = false
    @State private var problem: String?
    @State private var saved = false

    var body: some View {
        Group {
            if let owner {
                VStack(alignment: .leading, spacing: 8) {
                    SettingsView.words(ServerPasswordWords.state(owner))
                    if editing {
                        StepField(label: "New password", text: $password, secure: true)
                        StepField(label: "New password again", text: $again, secure: true)
                            .onSubmit(save)
                        SettingsView.note(ServerPasswordWords.hint)
                        if let problem {
                            SettingsView.refusal(problem)
                                .transition(.blurReveal)
                        }
                        HStack(spacing: 12) {
                            SettingsView.link("Cancel") { close() }
                            Button(saving ? "Saving…" : "Save", action: save)
                                .pointer()
                                .font(Theme.sans(12, weight: .medium))
                                .disabled(saving || password.isEmpty || again.isEmpty)
                        }
                    } else {
                        if saved {
                            SettingsView.note(ServerPasswordWords.saved)
                                .transition(.blurReveal)
                        }
                        SettingsView.link(owner.password ? "Change the password…" : "Set a password…") {
                            withAnimation(Motion.move) {
                                saved = false
                                editing = true
                            }
                        }
                    }
                }
                .transition(.blurReveal)
            }
        }
        .animation(Motion.move, value: editing)
        .animation(Motion.reveal, value: problem)
        .task { owner = try? await store.apiClient.owner() }
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
