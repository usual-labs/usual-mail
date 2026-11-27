import Foundation

@testable import UsualMailKit

/// The stand-in server's blocked senders and unsubscribing (docs/contract.md, "Blocked senders", "Unsubscribing"):
/// `GET /v1/senders?state=blocked` lists the sample's blocked senders and those `block_sender` blocked since, the newest
/// block first, each with the newest unsubscribe asked for them; `POST /v1/threads/:id/unsubscribe` answers a request,
/// `working`, one per sender and inbox (asking again starts over, unless one is still working), blocking nobody, and
/// `invalid` for a thread without a sender. Tests move a request on with `moveUnsubscribe`, as the server's work would,
/// and send the copy as `unsubscribe.changed`.
extension SampleServer {
    /// The senders' routes, or nil for any other.
    func sendersReply(method: String, parts: [String]) -> StubReply? {
        if method == "GET", parts == ["v1", "senders"] {
            return .json(Page(items: blocked()))
        }
        if method == "POST", parts.count == 4, parts[0] == "v1", parts[1] == "threads", parts[3] == "unsubscribe" {
            return unsubscribe(threadId: parts[2])
        }
        return nil
    }

    /// The newest request asked for a sender, if any.
    func unsubscribe(for key: SenderKey) -> Unsubscribe? {
        state.withLock { $0.unsubscribes[key] }
    }

    /// Moves a sender's request on as the server's work would (raising its version) and returns the new copy, for
    /// events.
    func moveUnsubscribe(_ key: SenderKey, _ change: (inout Unsubscribe) -> Void) -> Unsubscribe {
        state.withLock { state in
            var unsubscribe = state.unsubscribes[key]!
            change(&unsubscribe)
            unsubscribe.version += 1
            unsubscribe.updatedAt = state.data.now
            state.unsubscribes[key] = unsubscribe
            return unsubscribe
        }
    }

    /// Notes a sender `block_sender` blocked, as the server's list would have them: blocked now by this device.
    static func noteBlocked(_ thread: MailThread, in state: inout State) {
        guard let sender = thread.sender else { return }
        let key = SenderKey(inboxId: thread.inboxId, address: sender)
        state.data.blockedSenders.removeAll { $0.id == key }
        state.data.blockedSenders.append(
            BlockedSender(
                inboxId: thread.inboxId, address: sender.lowercased(), blockedAt: state.data.now,
                blockedBy: .person(deviceId: "dev_test")))
    }

    private func blocked() -> [BlockedSender] {
        state.withLock { state in
            BlockedSenderList(
                state.data.blockedSenders.map { sender in
                    var sender = sender
                    sender.unsubscribe = state.unsubscribes[sender.id]
                    return sender
                }
            ).items
        }
    }

    private func unsubscribe(threadId: String) -> StubReply {
        state.withLock { state in
            guard let thread = state.data.threads.first(where: { $0.id == threadId }) else {
                return .error("not_found", "No thread", status: 404)
            }
            guard let sender = thread.sender else {
                return .error("invalid", "This thread has no sender to unsubscribe from.", status: 400)
            }
            let key = SenderKey(inboxId: thread.inboxId, address: sender)
            if let working = state.unsubscribes[key], working.state == .working { return .json(working) }
            let unsubscribe = Unsubscribe(
                inboxId: thread.inboxId, address: sender.lowercased(), threadId: threadId, state: .working,
                askedAt: state.data.now, updatedAt: state.data.now,
                version: (state.unsubscribes[key]?.version ?? 0) + 1)
            state.unsubscribes[key] = unsubscribe
            return .json(unsubscribe)
        }
    }
}
