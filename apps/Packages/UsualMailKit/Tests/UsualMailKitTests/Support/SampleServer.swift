import Foundation
import Synchronization

@testable import UsualMailKit

/// A small stand-in for the server, holding the sample's state and answering the routes a `MailStore` and
/// pairing use, following docs/contract.md (fifth revision): every change to an inbox, a thread, a record, a draft or a
/// rule raises its version; the lists are Home, the categories, stacks, waiting and screening, none with a trashed
/// thread and none but screening with a screened one; actions answer with the threads they named; `categorize` sets
/// who decided, and its undo makes the person the decider; `allow_sender` lets in every screened thread of the sender
/// in that inbox; Handled holds rules', agents' and the AI's records, carries trashed threads and leaves silent records
/// out unless asked (and with `attentionOnly` gives what needs a look); a sent draft without a note isn't kept; a
/// paused inbox answers `conflict` to sending, files and syncs; new credentials make an inbox `connecting`; a wrong
/// pairing code is `unauthorized`; the sample's sender pictures are drawn PNGs (`SampleServer+Avatars`); `block_sender`
/// adds the sender to the blocked senders, and unsubscribing answers a request (`SampleServer+Senders`). The counts and the AI's status are the state's own (tests change them); a settings
/// patch is kept, and its key never comes back. Tests can make one route fail once, hold every answer back until a
/// gate opens, hand out a teach prompt, make sending fail or carry a note, or make the provider refuse new
/// credentials.
final class SampleServer: HTTPTransport {
    struct State {
        var data: SampleData
        var nextID = 100
        /// "POST /v1/actions" → the reply to give once instead.
        var failures: [String: StubReply] = [:]
        var teach: TeachPrompt?
        var before: [String: ThreadPlacement] = [:]
        var pairingCode = "ABCD-1234"
        /// The owner's password, and what `GET /v1/info` says of the owner (`SampleServer+Owner.swift`).
        var ownerPassword: String?
        var ownerInfo: OwnerInfo?
        /// "POST /v1/actions" → a gate that route's answers wait for.
        var holds: [String: Gate] = [:]
        /// Like `holds`, but the answer is worked out first and waits afterwards, so it arrives stale.
        var lateHolds: [String: Gate] = [:]
        /// "GET /v1/drafts" for every request answered so far, in order.
        var answered: [String] = []
        /// Set to make sending refuse, with this reason.
        var sendRefusal: String?
        /// Set to make a send that works carry this note.
        var sendNote: String?
        /// Set to make the provider refuse new credentials, with these words.
        var credentialsRefusal: String?
        /// Set to make the provider name this address for new credentials.
        var credentialsAddress: String?
        /// The last credentials an inbox was given, as sent.
        var credentials: [String: JSONValue] = [:]
        /// The last AI settings patch, as sent.
        var aiPatch: JSONValue?
        var revoked: [String] = []
        /// A sender picture's id → the reply to give instead of the sample's drawn picture.
        var avatarReplies: [String: StubReply] = [:]
        /// The newest unsubscribe asked per sender (`SampleServer+Senders`).
        var unsubscribes: [SenderKey: Unsubscribe] = [:]
        /// What testing a new browser agent's key finds.
        var browserAgentTest = BrowserAgentSettings(service: .browserUse, state: .working)
    }

    let state: Mutex<State>
    private let recorded = Mutex<[URLRequest]>([])
    private let gate: Gate?

    init(_ data: SampleData = .bundled, gate: Gate? = nil) {
        state = Mutex(State(data: data))
        self.gate = gate
    }

    var requests: [URLRequest] { recorded.withLock { $0 } }

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        recorded.withLock { $0.append(request) }
        let reply = try await handle(request)
        let key = "\(request.httpMethod ?? "GET") \(request.url!.path)"
        let late = state.withLock { state in
            state.answered.append(key)
            return state.lateHolds[key]
        }
        if let late { await late.wait() }
        let response = HTTPURLResponse(
            url: request.url!, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers)!
        return (reply.body, response)
    }

    func stream(for request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, any Error>) {
        throw URLError(.unsupportedURL)
    }

    func client(token: String? = "tok_secret") -> APIClient {
        APIClient(server: testServer, token: token, transport: self)
    }

    /// Makes answers to `route` wait until the returned gate opens.
    func hold(_ route: String) -> Gate {
        let gate = Gate()
        state.withLock { $0.holds[route] = gate }
        return gate
    }

    /// Works out answers to `route` at once but holds them back until the returned gate opens, so they arrive stale.
    func holdAnswer(_ route: String) -> Gate {
        let gate = Gate()
        state.withLock { $0.lateHolds[route] = gate }
        return gate
    }

    func hasAnswered(_ route: String) -> Bool {
        state.withLock { $0.answered.contains(route) }
    }

    func failOnce(_ route: String, with reply: StubReply) {
        state.withLock { $0.failures[route] = reply }
    }

    var data: SampleData { state.withLock { $0.data } }

    func thread(_ id: String) -> MailThread? { data.threads.first { $0.id == id } }

    /// Changes a thread as the server would (raising its version) and returns the new copy, for events.
    func change(_ id: String, _ change: (inout MailThread) -> Void) -> MailThread {
        state.withLock { state in
            let index = state.data.threads.firstIndex { $0.id == id }!
            change(&state.data.threads[index])
            state.data.threads[index].version += 1
            return state.data.threads[index]
        }
    }

    private func handle(_ request: URLRequest) async throws -> StubReply {
        if let gate { await gate.wait() }
        let method = request.httpMethod ?? "GET"
        let url = request.url!
        let parts = url.path.split(separator: "/").map { $0.removingPercentEncoding ?? String($0) }
        let key = "\(method) \(url.path)"
        if let hold = state.withLock({ $0.holds[key] }) { await hold.wait() }
        if let failure = state.withLock({ $0.failures.removeValue(forKey: key) }) { return failure }
        let query = Dictionary(
            (URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []).map {
                ($0.name, $0.value ?? "")
            },
            uniquingKeysWith: { _, last in last })
        let body = request.httpBody ?? Data()

        // Matches "GET v1/threads/:id" against this request; the `:` parts come back in order.
        func route(_ template: String) -> [String]? {
            let pieces = template.split(separator: " ")
            guard pieces[0] == method else { return nil }
            let expected = pieces[1].split(separator: "/")
            guard expected.count == parts.count else { return nil }
            var values: [String] = []
            for (want, got) in zip(expected, parts) {
                if want.hasPrefix(":") { values.append(got) } else if want != got { return nil }
            }
            return values
        }

        if route("GET v1/info") != nil {
            let owner = state.withLock { $0.ownerInfo }
            return .json(ServerInfo(name: "usual-mail", version: "0.1.0", apiVersion: 1, owner: owner))
        } else if let reply = try ownerReply(method: method, parts: parts, body: body) {
            return reply
        } else if let reply = sendersReply(method: method, parts: parts) {
            return reply
        } else if route("POST v1/pair") != nil {
            let input = try MailJSON.decoder().decode(PairInput.self, from: body)
            guard input.code == state.withLock({ $0.pairingCode }) else {
                return .error("unauthorized", "That code is wrong, used or expired.", status: 401)
            }
            let device = Device(id: "dev_test", name: input.name, kind: .person, createdAt: data.now)
            return .json(["token": "tok_secret", "device": try encodedJSON(device)] as JSONValue)
        } else if let id = route("DELETE v1/devices/:id")?.first {
            state.withLock { $0.revoked.append(id) }
            return .noContent
        } else if route("GET v1/me") != nil {
            return .json(Device(id: "dev_test", name: "Test Mac", kind: .person, createdAt: data.now))
        } else if route("GET v1/inboxes") != nil {
            return .json(data.inboxes)
        } else if let id = route("POST v1/inboxes/:id/sync")?.first {
            if paused(id) {
                return .error("conflict", "This inbox is paused, so it doesn't sync. Resume it first.", status: 409)
            }
            return data.inboxes.contains { $0.id == id } ? .noContent : .error("not_found", "No inbox", status: 404)
        } else if let id = route("GET v1/inboxes/:id/rules")?.first {
            return .json(data.rules.filter { $0.inboxId == id })
        } else if let id = route("PATCH v1/inboxes/:id")?.first {
            let patch = try MailJSON.decoder().decode(InboxPatch.self, from: body)
            if patch.credentials != nil, let refusal = state.withLock({ $0.credentialsRefusal }) {
                return .error(
                    "provider_error", "The mailbox didn't accept the new credentials: \(refusal)", status: 502)
            }
            if let named = state.withLock({ $0.credentialsAddress }),
                let inbox = data.inboxes.first(where: { $0.id == id }),
                patch.credentials != nil, named != inbox.address
            {
                return .error("invalid", "These credentials are for \(named), not \(inbox.address)", status: 400)
            }
            guard let inbox = updateInbox(id, patch) else { return .error("not_found", "No inbox", status: 404) }
            return .json(inbox)
        } else if let id = route("PATCH v1/rules/:id")?.first {
            let patch = try MailJSON.decoder().decode(RulePatch.self, from: body)
            guard let rule = updateRule(id, patch) else { return .error("not_found", "No rule", status: 404) }
            return .json(rule)
        } else if let id = route("DELETE v1/rules/:id")?.first {
            let removed = state.withLock { state in
                let count = state.data.rules.count
                state.data.rules.removeAll { $0.id == id }
                return count != state.data.rules.count
            }
            return removed ? .noContent : .error("not_found", "No rule", status: 404)
        } else if route("GET v1/home") != nil {
            return .json(page(home(query), query))
        } else if let name = route("GET v1/categories/:category")?.first {
            let category = Category(rawValue: name)
            guard category.isKnown else { return .error("invalid", "No category \(name)", status: 400) }
            return .json(page(listed(threads(query) { $0.category == category && !$0.screened && !$0.done }), query))
        } else if let name = route("GET v1/stacks/:stack")?.first {
            let stack = Stack(rawValue: name)
            guard stack.isKnown else { return .error("invalid", "No stack \(name)", status: 400) }
            return .json(page(listed(threads(query) { $0.stack == stack && !$0.screened }), query))
        } else if route("GET v1/waiting") != nil {
            let waiting = threads(query) { $0.isWaiting(at: data.now) && !$0.done && !$0.screened && !$0.trashed }
            return .json(page(waiting.sorted { ($0.comeBackAt!, $0.id) < ($1.comeBackAt!, $1.id) }, query))
        } else if route("GET v1/screening") != nil {
            return .json(page(listed(threads(query) { $0.screened && !$0.done }), query))
        } else if route("GET v1/counts") != nil {
            return .json(data.counts)
        } else if route("GET v1/ai/usage") != nil {
            return usage(timeZone: query["tz"])
        } else if route("GET v1/first-sync") != nil {
            return .json(data.firstSync)
        } else if route("PATCH v1/first-sync") != nil {
            return updateFirstSync(try JSONDecoder().decode(JSONValue.self, from: body))
        } else if route("GET v1/ai/status") != nil {
            return .json(data.aiStatus)
        } else if route("GET v1/ai") != nil {
            return .json(data.ai)
        } else if route("PATCH v1/ai") != nil {
            return .json(updateAi(try JSONDecoder().decode(JSONValue.self, from: body)))
        } else if route("POST v1/ai/test") != nil {
            return .json(
                state.withLock { state in
                    state.data.aiStatus.version += 1
                    return state.data.aiStatus
                })
        } else if route("GET v1/handled") != nil {
            let states = query["states"].map { $0.split(separator: ",").map { ActionState(rawValue: String($0)) } }
            let includeSilent = query["includeSilent"] == "true"
            let attentionOnly = query["attentionOnly"] == "true"
            let everyState = ActionState.known
            return .json(
                Page(
                    items: handled(
                        states: states ?? (attentionOnly ? everyState : [.proposed, .applied]),
                        includeSilent: includeSilent, attentionOnly: attentionOnly)))
        } else if route("GET v1/search") != nil {
            // A stand-in for the server's index: the text anywhere in the subject, snippet, summary or participants, in
            // the inboxes asked for, done ones too; newest first; no match, people or operators.
            let text = (query["q"] ?? "").lowercased()
            let inboxIds = query["inboxIds"].map { $0.split(separator: ",").map(String.init) }
            let found = data.threads.filter { thread in
                (inboxIds?.contains(thread.inboxId) ?? true)
                    && ([thread.subject, thread.snippet, thread.summary ?? ""]
                        + thread.participants.flatMap { [$0.name ?? "", $0.email] })
                        .contains { $0.lowercased().contains(text) }
            }
            let page = paged(listed(found), cursor: query["cursor"], limit: query["limit"].flatMap { Int($0) })
            return .json(
                SearchResult(
                    items: page.items.map { SearchHit(thread: $0) }, nextCursor: page.nextCursor,
                    understood: SearchUnderstood(filters: SearchFilters(inboxIds: inboxIds), text: query["q"] ?? "")))
        } else if route("GET v1/drafts") != nil {
            return .json(Page(items: data.drafts.filter { [.draft, .failed].contains($0.state) }))
        } else if route("POST v1/drafts") != nil {
            return .json(saveDraft(try MailJSON.decoder().decode(DraftInput.self, from: body)))
        } else if let id = route("POST v1/drafts/:id/send")?.first {
            if paused(data.drafts.first { $0.id == id }?.inboxId) {
                return .error("conflict", "This inbox is paused, so it can't send mail. Resume it first.", status: 409)
            }
            guard let draft = sendDraft(id) else { return .error("not_found", "No draft", status: 404) }
            return .json(draft)
        } else if let id = route("DELETE v1/drafts/:id")?.first {
            state.withLock { $0.data.drafts.removeAll { $0.id == id } }
            return .noContent
        } else if route("GET v1/briefs/latest") != nil {
            return .json(data.brief)
        } else if let id = route("GET v1/briefs/:id")?.first {
            return id == data.brief.id ? .json(data.brief) : .error("not_found", "No brief", status: 404)
        } else if let ids = route("GET v1/messages/:id/attachments/:attachmentId") {
            if paused(data.messages.first { $0.id == ids[0] }?.inboxId) {
                return .error(
                    "conflict",
                    "This inbox is paused, so it can't fetch attachments from its mailbox. Resume it first.",
                    status: 409)
            }
            guard
                let attachment = data.messages.first(where: { $0.id == ids[0] })?.attachments.first(where: {
                    $0.id == ids[1]
                })
            else { return .error("not_found", "No attachment", status: 404) }
            return StubReply(
                status: 200, body: Data("bytes of \(attachment.filename)".utf8),
                headers: ["Content-Type": attachment.mimeType])
        } else if let id = route("GET v1/avatars/:id")?.first {
            return avatar(id)
        } else if let id = route("GET v1/threads/:id")?.first {
            guard let detail = data.detail(threadId: id) else { return .error("not_found", "No thread", status: 404) }
            return .json(detail)
        } else if route("POST v1/actions") != nil {
            return .json(act(try MailJSON.decoder().decode(ActInput.self, from: body)))
        } else if route("POST v1/actions/approve") != nil || route("POST v1/actions/reject") != nil {
            let ids = try JSONDecoder().decode([String: [String]].self, from: body)["actionIds"] ?? []
            return .json(answer(ids, approve: parts[2] == "approve"))
        } else if let id = route("POST v1/actions/:id/undo")?.first {
            return .json(undo(id))
        } else if route("POST v1/teach/:id") != nil {
            let accept = (try JSONDecoder().decode([String: Bool].self, from: body))["accept"] ?? false
            return accept ? .json(teachRule()) : .raw("null")
        }
        return .error("not_found", "No route \(key)", status: 404)
    }

    private func act(_ input: ActInput) -> ActResult {
        state.withLock { state in
            var records: [ActionRecord] = []
            for id in input.threadIds {
                guard let index = state.data.threads.firstIndex(where: { $0.id == id }) else { continue }
                let thread = state.data.threads[index]
                let changed = thread.applying(input.action)
                guard changed != thread else { continue }  // a no-op records nothing
                state.nextID += 1
                let record = ActionRecord(
                    id: "act_\(state.nextID)", threadId: id, inboxId: thread.inboxId, action: input.action,
                    actor: .person(deviceId: "dev_test"), reason: input.reason, state: .applied, at: state.data.now,
                    undoable: true)
                state.before[record.id] = thread.placement
                state.data.threads[index] = changed
                state.data.threads[index].version += 1
                state.data.actions.append(record)
                records.append(record)
                if input.action == .blockSender { SampleServer.noteBlocked(thread, in: &state) }
                // Letting a sender in lets in every screened thread of theirs in the inbox.
                if input.action == .allowSender, let sender = SampleServer.sender(of: id, in: state.data) {
                    for other in state.data.threads.indices
                    where state.data.threads[other].screened && state.data.threads[other].inboxId == thread.inboxId
                        && SampleServer.sender(of: state.data.threads[other].id, in: state.data) == sender
                    {
                        state.data.threads[other].screened = false
                        state.data.threads[other].version += 1
                    }
                }
                // `read` and `unread` set every message in the thread.
                if input.action == .read || input.action == .unread {
                    for message in state.data.messages.indices where state.data.messages[message].threadId == id {
                        state.data.messages[message].unread = input.action == .unread
                    }
                }
            }
            let threads = state.data.threads.filter { input.threadIds.contains($0.id) }
            return ActResult(records: records, threads: threads, teach: state.teach)
        }
    }

    private func undo(_ id: String) -> ActResult {
        state.withLock { state in
            guard let index = state.data.actions.firstIndex(where: { $0.id == id }) else {
                return ActResult(records: [])
            }
            var record = state.data.actions[index]
            record.state = .undone
            record.undoable = false
            record.undoneAt = state.data.now
            record.version += 1
            state.data.actions[index] = record
            var threads: [MailThread] = []
            if let thread = state.data.threads.firstIndex(where: { $0.id == record.threadId }) {
                if let placement = state.before[id] {
                    state.data.threads[thread].placement = placement
                    // Undoing a categorize makes whoever undid it the decider.
                    if case .categorize = record.action { state.data.threads[thread].categorizedBy = .person }
                    state.data.threads[thread].version += 1
                }
                threads.append(state.data.threads[thread])
            }
            let teach = record.actor.kind == "person" ? nil : state.teach
            return ActResult(records: [record], threads: threads, teach: teach)
        }
    }

    private func answer(_ ids: [String], approve: Bool) -> ActResult {
        state.withLock { state in
            var records: [ActionRecord] = []
            var threads: [MailThread] = []
            for id in ids {
                guard let index = state.data.actions.firstIndex(where: { $0.id == id }) else { continue }
                state.data.actions[index].state = approve ? .applied : .rejected
                state.data.actions[index].undoable = approve
                state.data.actions[index].version += 1
                if approve { state.data.actions[index].at = state.data.now }
                let record = state.data.actions[index]
                records.append(record)
                if let thread = state.data.threads.firstIndex(where: { $0.id == record.threadId }) {
                    if approve {
                        state.before[record.id] = state.data.threads[thread].placement
                        state.data.threads[thread] = state.data.threads[thread].applying(
                            record.action, by: CategorySource(record.actor))
                        state.data.threads[thread].version += 1
                    }
                    threads.append(state.data.threads[thread])
                }
            }
            return ActResult(records: records, threads: threads)
        }
    }

    private func saveDraft(_ input: DraftInput) -> Draft {
        state.withLock { state in
            let id =
                input.id
                ?? {
                    state.nextID += 1
                    return "drf_\(state.nextID)"
                }()
            let existing = state.data.drafts.first { $0.id == id }
            let draft = Draft(
                id: id, inboxId: input.inboxId, threadId: input.threadId, inReplyToMessageId: input.inReplyToMessageId,
                to: input.to, cc: input.cc ?? [], bcc: input.bcc ?? [], subject: input.subject, body: input.body,
                createdBy: existing?.createdBy ?? .person(deviceId: "dev_test"), state: .draft,
                updatedAt: state.data.now, version: (existing?.version ?? 0) + 1)
            state.data.drafts.removeAll { $0.id == id }
            state.data.drafts.append(draft)
            return draft
        }
    }

    private func sendDraft(_ id: String) -> Draft? {
        state.withLock { state in
            guard let index = state.data.drafts.firstIndex(where: { $0.id == id }) else { return nil }
            if let refusal = state.sendRefusal {
                state.data.drafts[index].state = .failed
                state.data.drafts[index].error = refusal
            } else {
                state.data.drafts[index].state = .sent
                state.data.drafts[index].error = nil
                state.data.drafts[index].note = state.sendNote
            }
            state.data.drafts[index].version += 2  // sending, then sent or failed, in one answer
            let draft = state.data.drafts[index]
            // A sent draft without a note isn't kept.
            if !draft.isKept { state.data.drafts.remove(at: index) }
            return draft
        }
    }

    private func updateRule(_ id: String, _ patch: RulePatch) -> Rule? {
        state.withLock { state in
            guard let index = state.data.rules.firstIndex(where: { $0.id == id }) else { return nil }
            state.data.rules[index].text = patch.text ?? state.data.rules[index].text
            state.data.rules[index].match = patch.match ?? state.data.rules[index].match
            state.data.rules[index].then = patch.then ?? state.data.rules[index].then
            state.data.rules[index].enabled = patch.enabled ?? state.data.rules[index].enabled
            state.data.rules[index].version += 1
            return state.data.rules[index]
        }
    }

    /// Changes a rule as the server would (raising its version) and returns the new copy, for events.
    func changeRule(_ id: String, _ change: (inout Rule) -> Void) -> Rule {
        state.withLock { state in
            let index = state.data.rules.firstIndex { $0.id == id }!
            change(&state.data.rules[index])
            state.data.rules[index].version += 1
            return state.data.rules[index]
        }
    }

    private func teachRule() -> Rule? {
        state.withLock { state in
            guard let teach = state.teach else { return nil }
            let rule = Rule(
                id: "rul_new", inboxId: teach.rule.inboxId, text: teach.rule.text, match: teach.rule.match,
                then: teach.rule.then, source: .correction, createdBy: .person(deviceId: "dev_test"),
                createdAt: state.data.now)
            state.data.rules.append(rule)
            return rule
        }
    }
}
