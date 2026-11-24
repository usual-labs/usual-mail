import Foundation

// One method per route in `core/src/api.ts`, in the same order. Bodies and responses follow
// docs/contract.md, "REST".

extension APIClient {
    // MARK: Server

    /// `GET /healthz`: true when the server answers `{ "ok": true }`.
    public func health() async throws -> Bool {
        struct Health: Decodable { var ok: Bool }
        return try await send(request(.get, "/healthz", authorized: false), as: Health.self).ok
    }

    public func info() async throws -> ServerInfo {
        try await send(request(.get, "/v1/info", authorized: false))
    }

    // MARK: Devices and pairing

    /// Trades a pairing code a person created for this device's token. Needs no token.
    public func pair(_ input: PairInput) async throws -> PairResult {
        try await send(request(.post, "/v1/pair", body: input, authorized: false))
    }

    /// `GET /v1/me`: the device this token belongs to.
    public func me() async throws -> Device {
        try await send(request(.get, "/v1/me"))
    }

    public func listDevices() async throws -> [Device] {
        try await send(request(.get, "/v1/devices"))
    }

    public func createPairingCode(_ input: PairingCodeInput) async throws -> PairingCode {
        try await send(request(.post, "/v1/pairing-codes", body: input))
    }

    /// A person may revoke any device; any caller may revoke itself, which ends its own token.
    public func revokeDevice(id: String) async throws {
        try await sendWithoutReply(request(.delete, "/v1/devices/\(Self.segment(id))"))
    }

    // MARK: Inboxes

    public func listInboxes() async throws -> [Inbox] {
        try await send(request(.get, "/v1/inboxes"))
    }

    public func connectInbox(_ input: ConnectInboxInput) async throws -> Inbox {
        try await send(request(.post, "/v1/inboxes", body: input))
    }

    /// Changes an inbox's fields, its credentials included (person only; the server checks them first).
    public func updateInbox(id: String, patch: InboxPatch) async throws -> Inbox {
        try await send(request(.patch, "/v1/inboxes/\(Self.segment(id))", body: patch))
    }

    public func removeInbox(id: String) async throws {
        try await sendWithoutReply(request(.delete, "/v1/inboxes/\(Self.segment(id))"))
    }

    /// Asks for a sync now. Returns once the server has queued it.
    public func syncInbox(id: String) async throws {
        try await sendWithoutReply(request(.post, "/v1/inboxes/\(Self.segment(id))/sync"))
    }

    // MARK: Signing in with Google

    /// `POST /v1/google/sign-ins`: starts connecting a Gmail inbox, or reconnecting one in place, by signing in with
    /// Google. Person only. Open the answer's `url` in the browser, then ask how it ended.
    public func startGoogleSignIn(_ input: GoogleSignInInput) async throws -> GoogleSignInStart {
        try await send(request(.post, "/v1/google/sign-ins", body: input))
    }

    /// `GET /v1/google/sign-ins/:id`: how a sign-in this device started stands.
    public func googleSignIn(id: String) async throws -> GoogleSignIn {
        try await send(request(.get, "/v1/google/sign-ins/\(Self.segment(id))"))
    }

    /// `GET /v1/google/setup`: how to set up the server's Google client (the browser agent's prompt, the steps by
    /// hand) and whether this device may give it one. Person only.
    public func googleSetup() async throws -> GoogleSetup {
        try await send(request(.get, "/v1/google/setup"))
    }

    /// `PUT /v1/google/client`: gives the server its Google client. `file` is the JSON file Google Cloud's console
    /// downloaded, sent byte for byte as it is (at most `GoogleClientFile.maxBytes`). Without `replace` the server keeps
    /// a client it already has and answers `conflict`. Person only.
    public func setGoogleClient(file: Data, replace: Bool = false) async throws -> GoogleClientSaved {
        var put = try request(.put, "/v1/google/client", query: replace ? [("replace", "true")] : [])
        put.httpBody = file
        put.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return try await send(put)
    }

    // MARK: Views

    /// `GET /v1/home`: conversation and uncategorized threads that are let in, not done, on no stack and not waiting.
    public func home(_ query: ListQuery = ListQuery()) async throws -> Page<MailThread> {
        try await send(request(.get, "/v1/home", query: Self.listQuery(query)))
    }

    /// `GET /v1/categories/:category`: a category's threads that are let in and not done, stacked and waiting ones
    /// included. The server answers `invalid` for a category it doesn't know.
    public func category(_ category: Category, _ query: ListQuery = ListQuery()) async throws -> Page<MailThread> {
        try await send(
            request(.get, "/v1/categories/\(Self.segment(category.rawValue))", query: Self.listQuery(query)))
    }

    /// Several categories as one list whose cursor runs across them all, newest first, as the paper trail asks for
    /// invoices and receipts (`/v1/categories/invoice,receipt`). Only categories this app knows are sent, never an
    /// empty name (the server answers 400 to either); with none left, the list is empty and nothing is asked.
    public func categories(_ categories: [Category], _ query: ListQuery = ListQuery()) async throws
        -> Page<MailThread>
    {
        var names: [String] = []
        for category in categories where category.isKnown && !names.contains(category.rawValue) {
            names.append(category.rawValue)
        }
        guard !names.isEmpty else { return Page(items: []) }
        let path = "/v1/categories/" + names.map { Self.segment($0) }.joined(separator: ",")
        return try await send(request(.get, path, query: Self.listQuery(query)))
    }

    public func stack(_ stack: Stack, _ query: ListQuery = ListQuery()) async throws -> Page<MailThread> {
        try await send(request(.get, "/v1/stacks/\(Self.segment(stack.rawValue))", query: Self.listQuery(query)))
    }

    /// `GET /v1/waiting`: threads whose come-back time is ahead, soonest first.
    public func waiting(_ query: ListQuery = ListQuery()) async throws -> Page<MailThread> {
        try await send(request(.get, "/v1/waiting", query: Self.listQuery(query)))
    }

    /// `GET /v1/screening`: screened threads that are not done.
    public func screening(_ query: ListQuery = ListQuery()) async throws -> Page<MailThread> {
        try await send(request(.get, "/v1/screening", query: Self.listQuery(query)))
    }

    /// `GET /v1/counts`: how many threads each list holds, per inbox this device may see and in all.
    public func counts() async throws -> Counts {
        try await send(request(.get, "/v1/counts"))
    }

    public func handled(_ query: HandledQuery = HandledQuery()) async throws -> Page<HandledItem> {
        var items = Self.listQuery(query.list)
        if let states = query.states {
            items.append(("states", states.map(\.rawValue).joined(separator: ",")))
        }
        if query.includeSilent { items.append(("includeSilent", "true")) }
        if query.attentionOnly { items.append(("attentionOnly", "true")) }
        return try await send(request(.get, "/v1/handled", query: items))
    }

    public func thread(id: String) async throws -> ThreadDetail {
        try await send(request(.get, "/v1/threads/\(Self.segment(id))"))
    }

    // Search, `search`, `searchRemote` and `openRemote`: APIClient+Search.swift.

    /// An attachment's bytes, with the type the server gives them.
    public func attachment(messageId: String, attachmentId: String) async throws -> AttachmentData {
        let path = "/v1/messages/\(Self.segment(messageId))/attachments/\(Self.segment(attachmentId))"
        let (data, response) = try await perform(request(.get, path, accept: "*/*"))
        return AttachmentData(data: data, mimeType: response.value(forHTTPHeaderField: "Content-Type"))
    }

    /// A picture from the web that a message's HTML shows through the server, with the type the server read from its
    /// bytes (PNG, JPEG, GIF, WebP or AVIF). A person's device only: an agent gets `needs_person`. `not_found` for a
    /// picture the message doesn't show (or a server without pictures); a picture the server refuses comes blank (a
    /// 1×1 GIF); `provider_error` with the reason in words only when its site failed.
    public func picture(messageId: String, pictureId: String) async throws -> AttachmentData {
        let path = "/v1/messages/\(Self.segment(messageId))/pictures/\(Self.segment(pictureId))"
        let (data, response) = try await perform(request(.get, path, accept: "*/*"))
        return AttachmentData(data: data, mimeType: response.value(forHTTPHeaderField: "Content-Type"))
    }

    /// A sender's picture (`SenderPicture.id`, docs/contract-avatars.md), with its type: PNG, JPEG or WebP only. A
    /// person's device only: an agent gets `needs_person`. `not_found` for a picture the server doesn't keep, a gone
    /// one included (`SenderPictures.isGone`), which is not the same as a server that can't be reached
    /// (`APIError.isOffline`).
    public func avatar(id: String) async throws -> AttachmentData {
        let (data, response) = try await perform(request(.get, "/v1/avatars/\(Self.segment(id))", accept: "*/*"))
        return AttachmentData(data: data, mimeType: response.value(forHTTPHeaderField: "Content-Type"))
    }

    // MARK: Actions

    public func act(_ input: ActInput) async throws -> ActResult {
        try await send(request(.post, "/v1/actions", body: input))
    }

    public func undo(actionId: String) async throws -> ActResult {
        try await send(request(.post, "/v1/actions/\(Self.segment(actionId))/undo"))
    }

    /// Person only: applies proposals, all of them or none.
    public func approve(actionIds: [String]) async throws -> ActResult {
        try await send(request(.post, "/v1/actions/approve", body: ActionIDs(actionIds: actionIds)))
    }

    /// Person only: turns proposals down.
    public func reject(actionIds: [String]) async throws -> ActResult {
        try await send(request(.post, "/v1/actions/reject", body: ActionIDs(actionIds: actionIds)))
    }

    // MARK: Rules

    public func listRules(inboxId: String) async throws -> [Rule] {
        try await send(request(.get, "/v1/inboxes/\(Self.segment(inboxId))/rules"))
    }

    /// The body is the draft without `inboxId`, which the path carries.
    public func createRule(_ draft: RuleDraft) async throws -> Rule {
        let body = RuleBody(text: draft.text, match: draft.match, then: draft.then)
        return try await send(request(.post, "/v1/inboxes/\(Self.segment(draft.inboxId))/rules", body: body))
    }

    public func updateRule(id: String, patch: RulePatch) async throws -> Rule {
        try await send(request(.patch, "/v1/rules/\(Self.segment(id))", body: patch))
    }

    public func deleteRule(id: String) async throws {
        try await sendWithoutReply(request(.delete, "/v1/rules/\(Self.segment(id))"))
    }

    /// Person only. Yes creates the rule and returns it; no returns `nil`.
    public func answerTeach(id: String, accept: Bool) async throws -> Rule? {
        try await sendOptional(request(.post, "/v1/teach/\(Self.segment(id))", body: TeachAnswer(accept: accept)))
    }

    // MARK: Triage

    public func triageQueue(inboxId: String? = nil, limit: Int? = nil) async throws -> [TriageItem] {
        try await send(request(.get, "/v1/triage", query: Self.listQuery(ListQuery(inboxId: inboxId, limit: limit))))
    }

    public func decide(_ decisions: [TriageDecision]) async throws -> ActResult {
        try await send(request(.post, "/v1/triage/decisions", body: Decisions(decisions: decisions)))
    }

    // MARK: Drafts

    public func listDrafts(_ query: ListQuery = ListQuery()) async throws -> Page<Draft> {
        try await send(request(.get, "/v1/drafts", query: Self.listQuery(query)))
    }

    public func saveDraft(_ input: DraftInput) async throws -> Draft {
        try await send(request(.post, "/v1/drafts", body: input))
    }

    public func deleteDraft(id: String) async throws {
        try await sendWithoutReply(request(.delete, "/v1/drafts/\(Self.segment(id))"))
    }

    /// Person only.
    public func sendDraft(id: String) async throws -> Draft {
        try await send(request(.post, "/v1/drafts/\(Self.segment(id))/send"))
    }

    // MARK: The server's AI

    /// `GET /v1/ai`: the settings, without the key. Person only.
    public func aiSettings() async throws -> AiSettings {
        try await send(request(.get, "/v1/ai"))
    }

    /// `PATCH /v1/ai`: new credentials, models or pause. Person only. Credentials are stored, then tested at once; the
    /// status says how it went.
    public func updateAiSettings(_ patch: AiSettingsPatch) async throws -> AiSettings {
        try await send(request(.patch, "/v1/ai", body: patch))
    }

    /// `GET /v1/ai/status`: whether the AI works. Anyone may read it.
    public func aiStatus() async throws -> AiStatus {
        try await send(request(.get, "/v1/ai/status"))
    }

    /// `GET /v1/ai/disclosure`: what saving a key for `connection` would send, and to whom, in core's words. Person
    /// only; it works with no key set. Show it as given before `updateAiSettings` sends credentials.
    public func aiDisclosure(for connection: AiConnection) async throws -> AiDisclosure {
        let query: [(String, String)] =
            switch connection {
            case .gateway(let gateway): [("gateway", gateway.rawValue)]
            case .direct(let provider): [("provider", provider.rawValue)]
            case .unknown: []
            }
        return try await send(request(.get, "/v1/ai/disclosure", query: query))
    }

    /// `POST /v1/ai/test`: one small request per job's model, with no mail in it. Person only.
    public func testAi() async throws -> AiStatus {
        try await send(request(.post, "/v1/ai/test"))
    }

    /// `GET /v1/ai/usage?tz=…`: requests, tokens and cost by job and model for today, the last 7 and the last 30
    /// days, cut at midnight in `timeZone` (an IANA identifier such as `Europe/Berlin`; the server answers `invalid`
    /// for one it doesn't know). Person only.
    public func aiUsage(timeZone: String) async throws -> AiUsage {
        try await send(request(.get, "/v1/ai/usage", query: [("tz", timeZone)]))
    }

    // MARK: The first sync

    /// `GET /v1/first-sync`: how many days back a new inbox's first sync reaches. Person only.
    public func firstSync() async throws -> FirstSyncWindow {
        try await send(request(.get, "/v1/first-sync"))
    }

    /// `PATCH /v1/first-sync`: a new window, kept by the server and applied at once. Person only. The server answers
    /// `invalid` outside 1 to `FirstSyncWindow.maxDays` days, and `conflict` when the window isn't changeable.
    public func updateFirstSync(_ patch: FirstSyncWindowPatch) async throws -> FirstSyncWindow {
        try await send(request(.patch, "/v1/first-sync", body: patch))
    }

    // MARK: Briefs

    public func latestBrief() async throws -> Brief? {
        try await sendOptional(request(.get, "/v1/briefs/latest"))
    }

    public func brief(id: String) async throws -> Brief {
        try await send(request(.get, "/v1/briefs/\(Self.segment(id))"))
    }

    public func writeBrief(_ input: BriefInput) async throws -> Brief {
        try await send(request(.post, "/v1/briefs", body: input))
    }

    // MARK: Events

    /// `GET /v1/events`, the server-sent event stream. `EventStream` sends it.
    public func eventsRequest() throws -> URLRequest {
        var events = try request(.get, "/v1/events", accept: "text/event-stream")
        events.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        // The server sends a comment every 25 seconds; give up on a silent connection well after that.
        events.timeoutInterval = 90
        return events
    }
}

private struct ActionIDs: Encodable {
    var actionIds: [String]
}

private struct TeachAnswer: Encodable {
    var accept: Bool
}

private struct Decisions: Encodable {
    var decisions: [TriageDecision]
}

private struct RuleBody: Encodable {
    var text: String
    var match: RuleMatch
    var then: [ActionInput]
}
