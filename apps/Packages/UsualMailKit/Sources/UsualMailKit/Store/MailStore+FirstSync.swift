import Foundation

extension MailStore {
    /// Fetches the first sync's window. Person only: an agent's token gets `needs_person`, which leaves
    /// `firstSyncWindow` as it was (nil) without a problem. The refresh fetches it too.
    public func loadFirstSyncWindow() async {
        do {
            let window = try await client.firstSync()
            if window != firstSyncWindow { firstSyncWindow = window }
        } catch {
            reportPersonOnly(error)
        }
    }

    /// Sets how many days back a new inbox's first sync reaches. Person only. It waits for the server and keeps the
    /// window it answers with. Returns false when the server refused (`invalid` outside 1 to
    /// `FirstSyncWindow.maxDays`, `conflict` when the window isn't changeable) or couldn't be reached; `problem` says
    /// why, as for the AI's settings.
    @discardableResult
    public func updateFirstSync(days: Int) async -> Bool {
        do {
            firstSyncWindow = try await client.updateFirstSync(FirstSyncWindowPatch(days: days))
            return true
        } catch {
            report(error)
            return false
        }
    }
}
