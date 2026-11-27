import Foundation

/// Unsubscribing from a sender (docs/contract.md, "Unsubscribing"; the owner's request of 2026-11-27: swiping a Feed
/// post "should unsubscribe from it, so I won't ever get that any feed from those or email from those").
extension MailStore {
    /// What the undo strip says after unsubscribing: Undo takes back the block alone; the request to stop still goes
    /// (the security review of 2026-11-27).
    public static let unsubscribeWords = "Blocked, and asking them to stop. Undo only unblocks."

    /// The first server version that unsubscribes (docs/contract.md, "Unsubscribing").
    public static let unsubscribeVersion = "0.1.5"

    /// What the undo strip says when the server can't unsubscribe yet: the swipe only blocked.
    public static let oldServerWords = "Blocked. Update your server to 0.1.5 to unsubscribe."

    /// Whether the server can unsubscribe: false only once it said a version older than 0.1.5 (`GET /v1/info`, asked on
    /// connecting); true while that isn't known, as asking then answers for itself.
    public var serverUnsubscribes: Bool {
        guard let version = serverInfo?.version else { return true }
        return Self.version(version, isAtLeast: Self.unsubscribeVersion)
    }

    /// Whether `version` ("0.1.5", "0.2.0-dev") is `least` or later, by its numbers; one that can't be read counts as new.
    static func version(_ version: String, isAtLeast least: String) -> Bool {
        let numbers = { (text: String) -> [Int]? in
            let parts = text.split(separator: "-", maxSplits: 1).first.map { $0.split(separator: ".") } ?? []
            let read = parts.compactMap { Int($0) }
            return read.count == parts.count && !read.isEmpty ? read : nil
        }
        guard let have = numbers(version), let need = numbers(least) else { return true }
        for index in 0..<max(have.count, need.count) {
            let (a, b) = (index < have.count ? have[index] : 0, index < need.count ? need[index] : 0)
            if a != b { return a > b }
        }
        return true
    }

    /// Unsubscribes from a thread's sender. First the person's `block_sender`, as `perform` does it: every thread of
    /// theirs in that inbox archived at once, now and later, and the undo strip ("Blocked. Asking them to stop.")
    /// offering to unblock. Then, once the server took the block, `POST /v1/threads/:id/unsubscribe` asks the server to
    /// have the sender stop, the cheapest way their mail offers. Its answer (`working`) shows on the sender's row in
    /// Settings' Blocked tab, and `unsubscribe.changed` moves it on. Undoing unblocks them; the request to stop can't be
    /// taken back. A refused block asks nothing (its refusal is reported, as any action's); a refused request is
    /// reported the same way, and the block stays. The sample asks nothing. Returns the request as the server answered
    /// it, or nil.
    @discardableResult
    public func unsubscribe(threadID: String) async -> Unsubscribe? {
        // A server older than 0.1.5 has no way to ask: the swipe blocks, and the strip says why it did only that.
        guard serverUnsubscribes else {
            _ = await act(.blockSender, on: [threadID], reason: nil, asked: true, words: Self.oldServerWords)
            return nil
        }
        let blocked = await act(.blockSender, on: [threadID], reason: nil, asked: true, words: Self.unsubscribeWords)
        guard blocked, !isSample else { return nil }
        do {
            let answer = try await client.unsubscribe(threadId: threadID)
            apply(answer)
            return answer
        } catch let error as APIError where Self.routeMissing(error) {
            // A server that didn't say its version and has no such route: older than 0.1.5.
            problem = Problem(message: Self.oldServerWords)
            return nil
        } catch {
            report(error)
            return nil
        }
    }

    /// Whether the server answered as one without the unsubscribe route does: "No such route", its words for a path it
    /// doesn't know (a missing thread is "No such thread"), or a bare 404.
    static func routeMissing(_ error: APIError) -> Bool {
        switch error {
        case .server(let code, let message, let status, _):
            status == 404 && code == .notFound && message == "No such route"
        case .unexpectedResponse(let status, _): status == 404
        default: false
        }
    }
}
