import Foundation
import Testing

@testable import UsualMailKit

/// Changing an inbox's icon from Settings: what the picker offers and marks, the patch it saves, a refusal in the
/// row's words, and the switch's copy of the inbox after the server's answer or its event.
@MainActor
struct InboxIconChoiceTests {
    private func loadedStore(_ server: SampleServer) async throws -> MailStore {
        let store = try await makeStore(server)
        await store.loadFromDisk()
        return store
    }

    @Test func theAppKnowsTheContractsFourteenIconsInItsOrder() throws {
        let names = [
            "person", "building", "briefcase", "house", "shop", "globe",
            "plane", "wallet", "family", "rocket", "school", "heart", "star", "leaf",
        ]
        #expect(InboxIcon.known.map(\.rawValue) == names)
        for name in names {
            let icon = try MailJSON.decoder().decode(InboxIcon.self, from: Data("\"\(name)\"".utf8))
            #expect(InboxIcon.known.contains(icon), "\(name) isn't known")
            #expect(try encodedJSON(icon) == .string(name))
        }
        #expect(InboxIcon(rawValue: "plane") == .plane && InboxIcon(rawValue: "leaf") == .leaf)
    }

    @Test func thePickerOffersEveryIconWithTheInboxsOwnMarked() {
        let options = InboxIconChoice.options(current: .shop)
        #expect(options.count == 14)
        #expect(options.map(\.icon) == InboxIcon.known)
        #expect(options.filter(\.isCurrent).map(\.icon) == [.shop])
        #expect(InboxIconChoice.options(current: .leaf).filter(\.isCurrent).map(\.icon) == [.leaf])
        // A newer server's icon, which this app can't draw, marks none of them.
        #expect(InboxIconChoice.options(current: .unknown("anchor")).allSatisfy { !$0.isCurrent })
    }

    @Test func aNewIconSavesLikeTheFirstSix() async throws {
        let server = SampleServer()
        let store = try await loadedStore(server)
        let choice = InboxIconChoice()
        await choice.choose(.rocket, for: "inb_northwind", in: store)
        #expect(server.requests.last?.jsonBody == json(#"{"icon":"rocket"}"#))
        #expect(store.lists.inboxes.first?.icon == .rocket)
    }

    @Test func choosingTheIconTheInboxHasDoesNothing() async throws {
        let server = SampleServer()
        let store = try await loadedStore(server)
        let choice = InboxIconChoice()
        let asked = server.requests.count
        await choice.choose(.person, for: "inb_personal", in: store)
        #expect(server.requests.count == asked)
        #expect(choice.state == .idle)
        #expect(store.lists.inbox(id: "inb_personal")?.icon == .person)
    }

    @Test func choosingAnotherSavesItAndTheSwitchTakesTheAnswer() async throws {
        let server = SampleServer()
        let store = try await loadedStore(server)
        let choice = InboxIconChoice()
        await choice.choose(.house, for: "inb_personal", in: store)
        let request = try #require(server.requests.last)
        #expect(request.httpMethod == "PATCH" && request.pathAndQuery == "/v1/inboxes/inb_personal")
        #expect(request.jsonBody == json(#"{"icon":"house"}"#))
        #expect(choice.state == .idle && choice.refusal == nil)
        // The switch draws `lists.inboxes`: the server's answer, its version higher, is in it.
        let personal = try #require(store.lists.inboxes.first { $0.id == "inb_personal" })
        #expect(personal.icon == .house && personal.version == 10)
        #expect(store.lists.inboxes.map(\.id) == ["inb_northwind", "inb_harbor", "inb_personal"])
        #expect(store.problem == nil)
    }

    @Test func whileTheSaveIsOnItsWayTheInboxKeepsItsIconAndAnotherChoiceWaits() async throws {
        let server = SampleServer()
        let gate = server.hold("PATCH /v1/inboxes/inb_harbor")
        let store = try await loadedStore(server)
        let choice = InboxIconChoice()
        let saving = Task { await choice.choose(.globe, for: "inb_harbor", in: store) }
        try await waitUntil("the save is on its way") { choice.isSaving }
        #expect(choice.state == .saving(.globe))
        // Inbox changes wait for the server: nothing draws the new icon yet.
        #expect(store.lists.inbox(id: "inb_harbor")?.icon == .shop)
        let asked = server.requests.count
        await choice.choose(.house, for: "inb_harbor", in: store)
        #expect(server.requests.count == asked && choice.state == .saving(.globe))
        await gate.open()
        await saving.value
        #expect(choice.state == .idle)
        #expect(store.lists.inbox(id: "inb_harbor")?.icon == .globe)
    }

    @Test func aRefusalIsSaidInTheRowAndTheOldIconStays() async throws {
        let server = SampleServer()
        server.failOnce(
            "PATCH /v1/inboxes/inb_harbor",
            with: .error("invalid", "That icon isn't one an inbox can have.", status: 400))
        let store = try await loadedStore(server)
        let choice = InboxIconChoice()
        await choice.choose(.house, for: "inb_harbor", in: store)
        #expect(server.requests.last?.jsonBody == json(#"{"icon":"house"}"#))
        #expect(choice.state == .refused("That icon isn't one an inbox can have."))
        #expect(choice.refusal == "That icon isn't one an inbox can have.")
        #expect(store.lists.inbox(id: "inb_harbor")?.icon == .shop)
        // The row says it, so the store's problem is taken.
        #expect(store.problem == nil)

        // Choosing again goes to the server again, and clears the words once it keeps it.
        await choice.choose(.house, for: "inb_harbor", in: store)
        #expect(choice.state == .idle)
        #expect(store.lists.inbox(id: "inb_harbor")?.icon == .house)
    }

    @Test func aRefusalWithoutWordsSaysTheServerDidNotKeepIt() async throws {
        let server = SampleServer()
        server.failOnce("PATCH /v1/inboxes/inb_harbor", with: .error("unauthorized", "Signed out.", status: 401))
        let store = try await loadedStore(server)
        // A refused token signs out without raising a problem.
        let choice = InboxIconChoice()
        await choice.choose(.house, for: "inb_harbor", in: store)
        #expect(choice.refusal == "Your server didn't keep the icon. Try again.")
        #expect(store.lists.inbox(id: "inb_harbor")?.icon == .shop)
    }

    @Test func anInboxChangedEventChangesTheSwitchAndAnOlderOneDoesNotUndoIt() async throws {
        let server = SampleServer()
        let store = try await loadedStore(server)
        // Changed elsewhere (another Mac, the dashboard): the event alone updates the copy the switch draws.
        let changed = try #require(server.updateInbox("inb_northwind", InboxPatch(icon: .briefcase)))
        await store.receive(.inboxChanged(changed))
        #expect(store.lists.inboxes.first?.icon == .briefcase)

        // A save here, then a late copy from before it: the higher version is kept.
        var stale = changed
        let choice = InboxIconChoice()
        await choice.choose(.globe, for: "inb_northwind", in: store)
        #expect(store.lists.inboxes.first?.icon == .globe)
        stale.icon = .building
        await store.receive(.inboxChanged(stale))
        #expect(store.lists.inboxes.first?.icon == .globe)
    }
}
