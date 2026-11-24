import UsualMailKit

/// What fills the window (the Mac's `MailWindow`, the iPhone's `PhoneWindow`).
enum MailStage: Hashable {
    /// Only the wallpaper: a device with no copy, until the server first answers, so neither Home nor the first
    /// run flashes.
    case waiting
    case onboarding
    case mail

    @MainActor
    static func showing(_ store: MailStore, onboarding: Bool) -> MailStage {
        if onboarding { return .onboarding }
        if case .offline = store.connection { return .mail }
        return store.counts == nil && store.lists.inboxes.isEmpty ? .waiting : .mail
    }
}
