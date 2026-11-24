import Foundation
import Testing

@testable import UsualMailKit

/// A notification's event (core's `NotificationEvent`, docs/contract-ai.md, "Notification events"): decoded with and
/// without each part, its group too, encoded back as the server wrote it, kept on the device and gone when the thread
/// leaves `notification`.
struct NotificationEventTests {
    private func thread(category: String = "notification", event: String?) -> String {
        let field = event.map { #","event":\#($0)"# } ?? ""
        return #"""
            {"id":"thr_x","inboxId":"inb_personal","subject":"Your parcel","snippet":"On its way","participants":[],
             "lastMessageAt":"2026-11-16T07:05:00Z","messageCount":1,"unread":true,"hasAttachments":false,
             "category":"\#(category)","screened":false,"done":false,"trashed":false,"version":2\#(field)}
            """#
    }

    private func decoded(_ text: String) throws -> MailThread {
        try MailJSON.decoder().decode(MailThread.self, from: Data(text.utf8))
    }

    @Test func aThreadWithoutAnEventHasNone() throws {
        let plain = try decoded(thread(event: nil))
        #expect(plain.event == nil)
        // Encoded only when present, so a stored or re-encoded thread stays as the server sent it.
        #expect(try encodedJSON(plain)["event"] == nil)
    }

    @Test func everyPartComesThroughAndGoesBackAsWritten() throws {
        let full = #"""
            {"status":"Out for delivery","about":"Parcel from Fernhill Books",
             "when":{"date":"2026-11-16","time":"15:15","endTime":"18:15"}}
            """#
        let parcel = try decoded(thread(event: full))
        #expect(
            parcel.event
                == NotificationEvent(
                    status: "Out for delivery", about: "Parcel from Fernhill Books",
                    when: .init(date: "2026-11-16", time: "15:15", endTime: "18:15")))
        #expect(try encodedJSON(parcel)["event"] == json(full))
    }

    @Test func eachPartMayBeMissing() throws {
        // A time with no end.
        let oneTime =
            #"{"status":"Appointment confirmed","about":null,"when":{"date":"2026-11-23","time":"12:00","endTime":null}}"#
        let appointment = try #require(try decoded(thread(event: oneTime)).event)
        #expect(appointment.about == nil && appointment.when == .init(date: "2026-11-23", time: "12:00"))
        #expect(try encodedJSON(decoded(thread(event: oneTime)))["event"] == json(oneTime))

        // A date with no time.
        let dayOnly =
            #"{"status":"Delivered","about":"Parcel","when":{"date":"2026-11-13","time":null,"endTime":null}}"#
        let delivered = try #require(try decoded(thread(event: dayOnly)).event)
        #expect(delivered.when == .init(date: "2026-11-13") && delivered.when?.time == nil)
        #expect(try encodedJSON(decoded(thread(event: dayOnly)))["event"] == json(dayOnly))

        // A status with no when.
        let noWhen = #"{"status":"Password changed","about":null,"when":null}"#
        let changed = try #require(try decoded(thread(event: noWhen)).event)
        #expect(changed == NotificationEvent(status: "Password changed"))
        #expect(try encodedJSON(decoded(thread(event: noWhen)))["event"] == json(noWhen))

        // A digest: every part null, the event there all the same, and written back with its nulls.
        let digest = #"{"status":null,"about":null,"when":null}"#
        let weekly = try decoded(thread(event: digest))
        #expect(weekly.event == NotificationEvent())
        #expect(try encodedJSON(weekly)["event"] == json(digest))

        // A `when` whose times are left out rather than null decodes the same.
        let terse = try decoded(thread(event: #"{"status":"Delivered","about":null,"when":{"date":"2026-11-13"}}"#))
        #expect(terse.event?.when == .init(date: "2026-11-13"))
    }

    @Test func theGroupComesThroughAndIsLeftOutWhenThereIsNone() throws {
        let grouped = #"{"status":"Delivered","about":null,"when":null,"group":"r4c7e91a0d2b58f3e6a1c9d07"}"#
        let parcel = try decoded(thread(event: grouped))
        #expect(parcel.event == NotificationEvent(status: "Delivered", group: "r4c7e91a0d2b58f3e6a1c9d07"))
        #expect(try encodedJSON(parcel)["event"] == json(grouped))
        // Absent or null: no group, and none written back, as the server leaves it out.
        let none = #"{"status":"Delivered","about":null,"when":null}"#
        for event in [none, #"{"status":"Delivered","about":null,"when":null,"group":null}"#] {
            let single = try decoded(thread(event: event))
            #expect(single.event == NotificationEvent(status: "Delivered") && single.event?.group == nil)
            #expect(try encodedJSON(single)["event"] == json(none))
        }
    }

    @Test func aGroupThatIsntAStringIsNoneAndTheRestStays() throws {
        // Read leniently: a number, an object or an empty string is no group, and the event is kept.
        for group in ["42", #"{"id":"x"}"#, #""""#, "true"] {
            let event = try decoded(
                thread(event: #"{"status":"Delivered","about":"Parcel","when":null,"group":\#(group)}"#))
            #expect(event.event == NotificationEvent(status: "Delivered", about: "Parcel"), "\(group)")
        }
    }

    @Test func theSamplesNotifications() throws {
        let sample = SampleData.bundled
        func event(_ id: String) -> NotificationEvent? { sample.threads.first { $0.id == id }?.event }
        #expect(
            event("thr_19")
                == NotificationEvent(
                    status: "Out for delivery", about: "Parcel from Fernhill Books",
                    when: .init(date: "2026-11-16", time: "15:15", endTime: "18:15")))
        #expect(
            event("thr_20")
                == NotificationEvent(
                    status: "Appointment confirmed", about: "Check-up with Dr. Moor",
                    when: .init(date: "2026-11-23", time: "12:00"), group: "a8f3d6b2e1c094a7d5e2b8c13"))
        #expect(
            event("thr_21")
                == NotificationEvent(
                    status: "Delivered", about: "Parcel with the walking boots", when: .init(date: "2026-11-13"),
                    group: "r4c7e91a0d2b58f3e6a1c9d07"))
        // Two groups: the walking boots' parcel, three mails, and the check-up, confirmed then moved.
        let groups = Dictionary(grouping: sample.threads.filter { $0.event?.group != nil }) { $0.event?.group ?? "" }
        #expect(groups["r4c7e91a0d2b58f3e6a1c9d07"]?.map(\.id).sorted() == ["thr_21", "thr_23", "thr_24"])
        #expect(groups["a8f3d6b2e1c094a7d5e2b8c13"]?.map(\.id).sorted() == ["thr_20", "thr_25"])
        #expect(groups.count == 2)
        #expect(event("thr_19")?.group == nil && event("thr_22")?.group == nil)
        // A digest tells of no event.
        #expect(event("thr_22") == NotificationEvent())
        // Not processed yet.
        #expect(event("thr_11") == nil)
        // Only notifications carry one.
        for thread in sample.threads where thread.event != nil {
            #expect(thread.category == .notification)
        }
    }

    @Test func theCopyOnTheDeviceKeepsThem() async throws {
        let store = try await LocalStore.sample()
        let kept = try #require(try await store.thread(id: "thr_19"))
        #expect(kept.event?.when == .init(date: "2026-11-16", time: "15:15", endTime: "18:15"))
        #expect(try await store.thread(id: "thr_22")?.event == NotificationEvent())
    }

    @Test func movingToAnotherCategoryDropsItAtOnce() throws {
        let parcel = try #require(SampleData.bundled.threads.first { $0.id == "thr_19" })
        #expect(parcel.applying(.categorize(.conversation)).event == nil)
        #expect(parcel.applying(.categorize(.receipt)).event == nil)
        // Filed again where it is, or any other action, keeps it.
        #expect(parcel.applying(.categorize(.notification)).event == parcel.event)
        #expect(parcel.applying(.read).event == parcel.event)
    }

    @MainActor
    @Test func aChangedThreadWithoutItLosesIt() async throws {
        let store = try await MailStore.sample()
        var thread = try #require(store.lists.thread(id: "thr_19"))
        #expect(thread.event != nil)
        // The thread left the notifications: its `thread.changed` comes without the field.
        thread.category = .conversation
        thread.event = nil
        thread.version += 1
        await store.receive(.threadChanged(thread))
        #expect(store.lists.thread(id: "thr_19")?.event == nil)
        #expect(try await store.local.thread(id: "thr_19")?.event == nil)
    }

    @MainActor
    @Test func theSampleStoreKeepsTheSamplesMoment() async throws {
        // The sample mode shows the sample at its own times: its "now" is the sample's, not the Mac's.
        let store = try await MailStore.sample()
        #expect(store.now == SampleData.bundled.now)
    }
}
