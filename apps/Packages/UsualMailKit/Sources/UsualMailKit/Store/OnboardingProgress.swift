import CryptoKit
import Foundation
import Observation

/// What this Mac remembers of the first run: for each server, the step after pairing it reached, from the moment those
/// steps begin until "Go to Home"; and whether the person once chose to run their own server, so pairing again starts
/// at the server's address rather than at the welcome. Kept in the app's defaults, each server named by a hash of its
/// address, so the address isn't spelled out (as `AppSession` names each server's copy). Observable, so the window
/// leaves the first run as soon as it ends.
@MainActor
@Observable
public final class OnboardingProgress {
    /// The app's own, in the standard defaults.
    public static let shared = OnboardingProgress()

    static let stepsKey = "UsualMailOnboardingSteps"
    static let ownServerKey = "UsualMailOnboardingOwnServer"

    @ObservationIgnored private let defaults: any OnboardingDefaults
    /// Each server's hashed name and the step it reached.
    private var steps: [String: String]
    /// True once the person chose to run their own server.
    public private(set) var choseOwnServer: Bool

    public init(defaults: any OnboardingDefaults = UserDefaults.standard) {
        self.defaults = defaults
        steps = defaults.object(forKey: Self.stepsKey) as? [String: String] ?? [:]
        choseOwnServer = defaults.object(forKey: Self.ownServerKey) as? Bool ?? false
    }

    /// The step after pairing this Mac reached with `server`, or nil when it never began or has finished.
    public func step(for server: ServerAddress) -> Onboarding.Step? {
        steps[Self.name(server)].flatMap(Onboarding.Step.init(rawValue:))
    }

    /// Notes the step after pairing this Mac has reached with `server`. Steps before pairing aren't kept per server.
    public func save(_ step: Onboarding.Step, for server: ServerAddress) {
        guard !step.isBeforePairing else { return }
        let name = Self.name(server)
        guard steps[name] != step.rawValue else { return }
        steps[name] = step.rawValue
        defaults.set(steps, forKey: Self.stepsKey)
    }

    /// Ends the first run with `server` on this Mac: "Go to Home".
    public func finish(for server: ServerAddress) {
        guard steps.removeValue(forKey: Self.name(server)) != nil else { return }
        defaults.set(steps, forKey: Self.stepsKey)
    }

    /// Notes that the person chose to run their own server.
    public func chooseOwnServer() {
        guard !choseOwnServer else { return }
        choseOwnServer = true
        defaults.set(true, forKey: Self.ownServerKey)
    }

    /// A server's name in the defaults: the start of a hash of its address.
    static func name(_ server: ServerAddress) -> String {
        let digest = SHA256.hash(data: Data(server.baseURL.absoluteString.utf8))
        return digest.prefix(12).map { String(format: "%02x", $0) }.joined()
    }
}

/// Where `OnboardingProgress` keeps what it remembers: the app's `UserDefaults`, or a stand-in in tests.
public protocol OnboardingDefaults: AnyObject {
    func object(forKey defaultName: String) -> Any?
    func set(_ value: Any?, forKey defaultName: String)
}

extension UserDefaults: OnboardingDefaults {}
