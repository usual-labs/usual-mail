import Foundation
import Testing

@testable import UsualMailKit

/// New credentials in the shape core's provider.ts gives them, and how they travel in an inbox's patch.
struct InboxCredentialsTests {
    @Test func imapCredentialsAreWrittenAsCoreDescribesThem() throws {
        // Made-up values; nothing here is a real mailbox.
        let credentials = InboxCredentials.imap(
            ImapCredentials(
                imap: .init(host: "imap.home.example", port: 993, secure: true, user: "me", password: "not-real-1"),
                smtp: .init(host: "smtp.home.example", port: 587, secure: false, user: "me", password: "not-real-2"),
                address: "me@home.example", saveSent: false))
        let json = try credentials.json
        #expect(
            json
                == JSONValue.object([
                    "imap": [
                        "host": "imap.home.example", "port": 993, "secure": true, "user": "me",
                        "password": "not-real-1",
                    ],
                    "smtp": [
                        "host": "smtp.home.example", "port": 587, "secure": false, "user": "me",
                        "password": "not-real-2",
                    ],
                    "address": "me@home.example", "saveSent": false,
                ]))
        // Ports go out as whole numbers.
        let body = String(decoding: try MailJSON.encoder().encode(InboxPatch(credentials: json)), as: UTF8.self)
        #expect(body.contains(#""port":993"#) && body.contains(#""port":587"#))
        #expect(credentials.secrets == ["not-real-1", "not-real-2"])
    }

    @Test func anAbsentAddressIsLeftOutAndGmailCarriesItsThreeFields() throws {
        let imap = InboxCredentials.imap(
            ImapCredentials(
                imap: .init(host: "h.example", port: 993, secure: true, user: "a@h.example", password: "pw-1234"),
                smtp: .init(host: "h.example", port: 465, secure: true, user: "a@h.example", password: "pw-1234"),
                saveSent: true))
        #expect(try imap.json["address"] == nil)
        let gmail = InboxCredentials.gmail(
            GmailCredentials(clientId: "client.example", clientSecret: "secret-1", refreshToken: "token-1"))
        #expect(
            try gmail.json
                == json(#"{"clientId":"client.example","clientSecret":"secret-1","refreshToken":"token-1"}"#))
        #expect(gmail.secrets == ["secret-1", "token-1"])
    }
}

/// Changing an inbox's credentials through the store, against the stand-in server: the connection comes back without
/// secrets, the inbox is `connecting` until its next good sync, and a refusal shows the provider's words.
@MainActor
struct MailStoreCredentialsTests {
    let sample = SampleData.bundled

    private func loadedStore(_ server: SampleServer) async throws -> MailStore {
        let store = try await makeStore(server)
        await store.loadFromDisk()
        return store
    }

    private let newPassword = InboxCredentials.imap(
        ImapCredentials(
            imap: .init(
                host: "imap.home.example", port: 993, secure: true, user: "me@home.example", password: "pw-new-1"),
            smtp: .init(
                host: "smtp.home.example", port: 465, secure: true, user: "me@home.example", password: "pw-new-1"),
            saveSent: true))

    @Test func newCredentialsAreSentWholeAndTheInboxConnects() async throws {
        let server = SampleServer()
        let store = try await loadedStore(server)
        #expect(store.lists.inbox(id: "inb_personal")?.status == .needsAttention)
        let answer = await store.changeCredentials("inb_personal", to: newPassword)
        guard case .saved(let inbox) = answer else {
            Issue.record("Expected the credentials to be saved, got \(answer)")
            return
        }
        let request = try #require(server.requests.last)
        #expect(request.httpMethod == "PATCH" && request.pathAndQuery == "/v1/inboxes/inb_personal")
        #expect(request.jsonBody == ["credentials": try newPassword.json])
        // Connecting until its next good sync; the reason it needed attention is gone.
        #expect(inbox.status == .connecting && inbox.statusDetail == nil && inbox.version == 10)
        let stored = try #require(store.lists.inbox(id: "inb_personal"))
        #expect(stored == inbox)
        #expect(store.problem == nil)
    }

    @Test func aChangedServerComesBackInTheConnection() async throws {
        let server = SampleServer()
        let store = try await loadedStore(server)
        var moved = newPassword
        if case .imap(var imap) = moved {
            imap.smtp.port = 587
            imap.smtp.secure = false
            moved = .imap(imap)
        }
        _ = await store.changeCredentials("inb_personal", to: moved)
        guard case .imap(_, let smtp, _) = store.lists.inbox(id: "inb_personal")?.connection else {
            Issue.record("Personal connects over IMAP")
            return
        }
        #expect(smtp == ServerLogin(host: "smtp.home.example", port: 587, secure: false, user: "me@home.example"))
    }

    @Test func aRefusalShowsTheProvidersWordsAndChangesNothing() async throws {
        let server = SampleServer()
        server.state.withLock { $0.credentialsRefusal = "Invalid login: 535 Authentication failed" }
        let store = try await loadedStore(server)
        let before = try #require(store.lists.inbox(id: "inb_personal"))
        let answer = await store.changeCredentials("inb_personal", to: newPassword)
        #expect(
            answer
                == .refused(
                    "The mailbox didn't accept the new credentials: Invalid login: 535 Authentication failed"))
        #expect(store.lists.inbox(id: "inb_personal") == before)
        #expect(store.problem == nil)  // the form shows it, not an alert
    }

    @Test func credentialsForAnotherMailboxAreRefused() async throws {
        let server = SampleServer()
        server.state.withLock { $0.credentialsAddress = "someone@else.example" }
        let store = try await loadedStore(server)
        let answer = await store.changeCredentials("inb_personal", to: newPassword)
        #expect(answer == .refused("These credentials are for someone@else.example, not me@home.example"))
    }

    @Test func aSecretTheProviderRepeatsIsNotShown() async throws {
        let server = SampleServer()
        server.state.withLock { $0.credentialsRefusal = "Password pw-new-1 is wrong" }
        let store = try await loadedStore(server)
        let answer = await store.changeCredentials("inb_personal", to: newPassword)
        #expect(answer == .refused("The mailbox didn't accept the new credentials: Password ••• is wrong"))
        #expect(MailStore.withoutSecrets("abc and abcd", ["abc", "abcd"]) == "abc and •••")  // short ones stay
    }

    @Test func offlineNothingChangesAndItSaysSo() async throws {
        let store = MailStore(
            client: APIClient(
                server: testServer, token: "t", transport: StubTransport { _ in throw URLError(.timedOut) }),
            local: try await LocalStore.sample(), clock: { SampleData.bundled.now })
        await store.loadFromDisk()
        guard case .refused(let words) = await store.changeCredentials("inb_personal", to: newPassword) else {
            Issue.record("Expected a refusal")
            return
        }
        #expect(words.hasPrefix("Can't reach your server."))
        #expect(store.lists.inbox(id: "inb_personal")?.status == .needsAttention)
    }

    @Test func aPausedInboxStaysPausedWithNewCredentials() async throws {
        let server = SampleServer()
        let store = try await loadedStore(server)
        #expect(await store.updateInbox("inb_harbor", InboxPatch(paused: true)))
        #expect(store.lists.inbox(id: "inb_harbor")?.status == .paused)
        let harborPassword = InboxCredentials.imap(
            ImapCredentials(
                imap: .init(
                    host: "mail.harborpine.example", port: 993, secure: true, user: "founder@harborpine.example",
                    password: "pw-harbor"),
                smtp: .init(
                    host: "mail.harborpine.example", port: 587, secure: false, user: "founder@harborpine.example",
                    password: "pw-harbor"), saveSent: true))
        guard case .saved(let inbox) = await store.changeCredentials("inb_harbor", to: harborPassword) else {
            Issue.record("Expected the credentials to be saved")
            return
        }
        #expect(inbox.status == .paused && inbox.isPaused)
        // Resuming makes it connecting until its next good sync.
        #expect(await store.updateInbox("inb_harbor", InboxPatch(paused: false)))
        #expect(store.lists.inbox(id: "inb_harbor")?.status == .connecting)
    }

    @Test func theDashboardPageIsUnderTheServersRootWithTheIdEncoded() async throws {
        let store = try await makeStore(SampleServer())
        #expect(
            store.dashboardURL(inboxId: "inb/harbor").absoluteString == "http://mail.local:8787/inboxes/inb%2Fharbor")
        let behindAProxy = MailStore(
            client: APIClient(server: try ServerAddress(parsing: "https://example.com/mail/"), token: "t"),
            local: try LocalStore())
        #expect(
            behindAProxy.dashboardURL(inboxId: "inb harbor?").absoluteString
                == "https://example.com/mail/inboxes/inb%20harbor%3F")
    }
}

/// A paused inbox (docs/contract.md, "Inboxes"): the server sends nothing and fetches no file for it, answering
/// `conflict`, which the app says in words; actions on its threads still apply and wait to be written back.
@MainActor
struct PausedInboxTests {
    private func pausedHarbor() async throws -> (SampleServer, MailStore) {
        let server = SampleServer()
        let store = try await makeStore(server)
        await store.loadFromDisk()
        #expect(await store.updateInbox("inb_harbor", InboxPatch(paused: true)))
        return (server, store)
    }

    @Test func sendingFromAPausedInboxSaysSo() async throws {
        let (server, store) = try await pausedHarbor()
        let saved = try #require(
            await store.saveDraft(
                DraftInput(
                    inboxId: "inb_harbor", to: [Address(email: "accounts@kestrel.example")], subject: "Beans", body: "")
            ))
        #expect(await store.send(draftID: saved.id) == nil)
        #expect(server.requests.last?.pathAndQuery == "/v1/drafts/\(saved.id)/send")
        #expect(
            store.problem?.message
                == "Harbor & Pine is paused, so nothing is sent from it. The draft is kept: send it once the inbox is resumed."
        )
        #expect(try await store.local.draft(id: saved.id)?.state == .draft)
    }

    @Test func aFileFromAPausedInboxSaysSo() async throws {
        let (_, store) = try await pausedHarbor()
        let sample = SampleData.bundled
        let message = try #require(sample.messages.first { $0.inboxId == "inb_harbor" && !$0.attachments.isEmpty })
        #expect(await store.file(for: message.attachments[0], in: message) == nil)
        #expect(
            store.problem?.message
                == "Harbor & Pine is paused, so your server can't fetch this file from its mailbox until the inbox is resumed."
        )
    }

    @Test func aConflictForAnInboxNotPausedHereKeepsTheServersWords() async throws {
        let server = SampleServer()
        server.failOnce(
            "POST /v1/drafts/drf_1/send", with: .error("conflict", "This draft is already sending", status: 409))
        let store = try await makeStore(server)
        await store.loadFromDisk()
        #expect(await store.send(draftID: "drf_1") == nil)
        #expect(store.problem?.message == "This draft is already sending")
    }

    @Test func anActionOnAPausedInboxsThreadStillApplies() async throws {
        let (server, store) = try await pausedHarbor()
        await store.perform(.done, on: ["thr_6"])
        #expect(server.thread("thr_6")?.done == true)
        #expect(!store.lists.threads(in: .invoice, inbox: nil).contains { $0.id == "thr_6" })
        #expect(store.lastAction?.records.map(\.inboxId) == ["inb_harbor"])
        #expect(store.problem == nil)
    }
}
