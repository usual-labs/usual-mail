import Foundation

// The blocked senders' routes (docs/contract.md, "Blocked senders"): `senders` and `allowSender` in `core/src/api.ts`;
// and unsubscribing from a sender (docs/contract.md, "Unsubscribing"): `unsubscribe`. All are a person's: an agent's
// token is answered `needs_person`.

extension APIClient {
    /// `GET /v1/senders?state=blocked`: one page of the senders blocked in the inboxes asked for (`inboxId`, or every
    /// inbox), the newest block first. Pass `nextCursor` back as `cursor` for the next page.
    public func senders(_ query: ListQuery = ListQuery()) async throws -> Page<BlockedSender> {
        try await send(request(.get, "/v1/senders", query: [("state", "blocked")] + Self.listQuery(query)))
    }

    /// `POST /v1/senders/allow`: lets the sender in (unblocks them), as `allow_sender` on their newest thread that isn't
    /// trashed or gone. The answer has that one record and the threads it changed; `records` is empty when no such
    /// thread is left or the sender was already let in, and then there is nothing to undo.
    public func allowSender(inboxId: String, address: String) async throws -> ActResult {
        struct Body: Encodable {
            var inboxId: String
            var address: String
        }
        return try await send(request(.post, "/v1/senders/allow", body: Body(inboxId: inboxId, address: address)))
    }

    /// `POST /v1/threads/:id/unsubscribe`, no body: asks the thread's sender to stop sending, in the background, the
    /// cheapest way their mail offers. The answer is the request, `working` at first; `unsubscribe.changed` brings the
    /// rest. Asking again starts over, unless one is still working, which is answered as it is. It blocks nobody (the
    /// app does `block_sender` too); `invalid` for a thread with no sender.
    public func unsubscribe(threadId: String) async throws -> Unsubscribe {
        try await send(request(.post, "/v1/threads/\(Self.segment(threadId))/unsubscribe"))
    }
}
