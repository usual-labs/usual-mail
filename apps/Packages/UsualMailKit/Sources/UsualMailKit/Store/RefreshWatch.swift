import Foundation
import Synchronization

/// Notes what changes while a refresh is fetching, so the refresh doesn't remove it for being missing from what it
/// fetched earlier, or bring back what was removed meanwhile (`RefreshKeep`).
///
/// Inboxes, threads, records, drafts and rules carry versions, so a refresh never writes an older copy over a newer
/// one. What versions can't settle is removal: a list that no longer has something says nothing about when it went,
/// and a removal leaves no copy to compare. So the watch is only about removal: a thing made or brought back while
/// the lists were on their way isn't removed for being missing from them, and a thing removed meanwhile isn't brought
/// back. The refresh reads these ids inside its own write transaction; every other write notes its ids before it is
/// queued, so nothing slips between the two.
final class RefreshWatch: Sendable {
    private struct State {
        var watching = false
        var changed = RefreshKeep()
    }

    private let state = Mutex(State())

    /// Starts noting changes, forgetting earlier ones. Called before a refresh fetches.
    func begin() {
        state.withLock { $0 = State(watching: true) }
    }

    /// Stops noting changes. Called once the refresh has written.
    func end() {
        state.withLock { $0 = State() }
    }

    /// Notes ids that changed, if a refresh is fetching.
    func note(_ ids: RefreshKeep) {
        state.withLock { state in
            if state.watching { state.changed.formUnion(ids) }
        }
    }

    /// What changed since `begin()`.
    var changed: RefreshKeep {
        state.withLock { $0.changed }
    }
}
