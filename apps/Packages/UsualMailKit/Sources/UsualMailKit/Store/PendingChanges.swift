import Foundation

/// Changes the app shows before the server has confirmed them, kept on top of the server's own copy.
///
/// Of two server copies, the higher `version` is kept as the confirmed one. When the server sends a copy while
/// changes are pending, the changes are applied to it again, so an event about something else doesn't flash the
/// old state back. When the server accepts a change, the copy it answers with becomes the confirmed one; when it
/// refuses, the change is dropped and the confirmed copy, with any other pending changes, is shown again.
struct PendingChanges<Value: Versioned> {
    typealias Change = @Sendable (Value) -> Value

    private var confirmed: [String: Value] = [:]
    private var queued: [String: [(token: UUID, change: Change)]] = [:]

    /// The ids with changes waiting for the server.
    var ids: Set<String> { Set(queued.keys) }

    func isPending(_ id: String) -> Bool { queued[id] != nil }

    /// Adds a change on top of `current`, what is shown now. Returns what to show.
    mutating func add(_ change: @escaping Change, to id: String, current: Value, token: UUID) -> Value {
        // With changes already pending, `current` has them on top; the confirmed copy stays the server's.
        if confirmed[id] == nil { confirmed[id] = current }
        queued[id, default: []].append((token, change))
        return shown(id) ?? change(current)
    }

    /// The server sent its own copy. Returns what to show: the newer confirmed copy with any pending changes on top.
    mutating func serverSent(_ value: Value, for id: String) -> Value {
        guard queued[id] != nil else { return value }
        confirmed[id] = Self.newer(confirmed[id], value)
        return shown(id) ?? value
    }

    /// The server accepted the change with `token` and answered with `copy`, the thing as it is now. Returns what
    /// to show, or nil if nothing was pending. Without a copy, the change is applied to the confirmed one.
    mutating func accepted(_ token: UUID, for id: String, copy: Value?) -> Value? {
        guard let change = remove(token, for: id) else { return nil }
        if let copy {
            confirmed[id] = Self.newer(confirmed[id], copy)
        } else {
            confirmed[id] = confirmed[id].map(change)
        }
        return settle(id)
    }

    /// The server refused the change with `token`. Returns what to show, or nil if nothing was pending.
    mutating func refused(_ token: UUID, for id: String) -> Value? {
        guard remove(token, for: id) != nil else { return nil }
        return settle(id)
    }

    /// The thing is gone on the server; its pending changes no longer matter.
    mutating func forget(_ id: String) {
        queued[id] = nil
        confirmed[id] = nil
    }

    /// Of a kept copy and a new one, the new one unless the kept one has a higher version.
    static func newer(_ kept: Value?, _ new: Value) -> Value {
        guard let kept, kept.version > new.version else { return new }
        return kept
    }

    private mutating func remove(_ token: UUID, for id: String) -> Change? {
        guard var list = queued[id], let index = list.firstIndex(where: { $0.token == token }) else { return nil }
        let change = list.remove(at: index).change
        queued[id] = list
        return change
    }

    /// What to show once a change has left the queue; forgets the confirmed copy when none remain.
    private mutating func settle(_ id: String) -> Value? {
        let value = shown(id)
        if queued[id]?.isEmpty ?? true {
            queued[id] = nil
            confirmed[id] = nil
        }
        return value
    }

    private func shown(_ id: String) -> Value? {
        guard let base = confirmed[id] else { return nil }
        return (queued[id] ?? []).reduce(base) { value, entry in entry.change(value) }
    }
}
