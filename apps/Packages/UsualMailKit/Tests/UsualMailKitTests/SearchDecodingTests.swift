import Foundation
import Testing

@testable import UsualMailKit

/// Search's shapes (core/src/search.ts) as the server sends them, and written back the same: a field is written only
/// when it came.
struct SearchDecodingTests {
    static let result = #"""
        {
          "items": [
            {
              "id": "thr_1", "inboxId": "inb_northwind", "subject": "Contract renewal for 2027",
              "snippet": "Hi, attached is the renewal.", "participants": [{"name": "Dana Whitfield", "email": "dana@lumen.example"}],
              "lastMessageAt": "2026-11-16T08:40:00Z", "messageCount": 2, "unread": true, "hasAttachments": true,
              "category": "conversation", "categorizedBy": "ai", "sender": "dana@lumen.example", "screened": false,
              "done": false, "trashed": false, "version": 7, "summary": "Dana sent the signed renewal.",
              "match": {
                "fields": ["subject", "attachments", "body"],
                "subject": [{"text": "Contract ", "match": false}, {"text": "renewal", "match": true}, {"text": " for 2027", "match": false}],
                "excerpt": {"field": "attachments", "runs": [{"text": "Lumen-", "match": false}, {"text": "Renewal", "match": true}, {"text": "-2027.pdf", "match": false}]}
              }
            },
            {
              "id": "thr_13", "inboxId": "inb_northwind", "subject": "Your order has shipped", "snippet": "On its way.",
              "participants": [], "lastMessageAt": "2026-11-14T16:00:00Z", "messageCount": 1, "unread": false,
              "hasAttachments": false, "category": "notification", "screened": false, "done": true, "trashed": false,
              "version": 3
            }
          ],
          "nextCursor": "c2",
          "understood": {"from": "dana", "hasAttachment": true, "text": "renewal \"for 2027\"", "exclude": ["draft"]},
          "people": [{"email": "dana@lumen.example", "name": "Dana Whitfield", "threads": 4, "lastMessageAt": "2026-11-16T08:40:00Z"}]
        }
        """#

    @Test func aResultCarriesTheThreadsWhereTheyMatchedWhatWasUnderstoodAndPeople() throws {
        let result = try MailJSON.decoder().decode(SearchResult.self, from: Data(Self.result.utf8))
        #expect(result.items.map(\.id) == ["thr_1", "thr_13"])
        #expect(result.nextCursor == "c2")
        // Each item is the thread exactly as lists give it.
        let first = result.items[0]
        #expect(first.thread.summary == "Dana sent the signed renewal." && first.thread.version == 7)
        #expect(first.thread.unread && first.thread.hasAttachments && first.thread.categorizedBy == .ai)
        let match = try #require(first.match)
        #expect(match.fields == [.subject, .attachments, .body])
        #expect(match.subject?.map(\.text) == ["Contract ", "renewal", " for 2027"])
        #expect(match.subject?.map(\.match) == [false, true, false])
        #expect(match.excerpt?.field == .attachments)
        #expect(
            match.excerpt?.runs == [SearchRun("Lumen-"), SearchRun("Renewal", match: true), SearchRun("-2027.pdf")])
        // A done thread, found by filters alone: no match.
        #expect(result.items[1].match == nil && result.items[1].thread.done)
        // What the server understood: the filters, the text left, the words left out.
        #expect(result.understood.filters == SearchFilters(from: "dana", hasAttachment: true))
        #expect(result.understood.text == "renewal \"for 2027\"" && result.understood.exclude == ["draft"])
        #expect(
            result.people == [
                SearchPerson(
                    email: "dana@lumen.example", name: "Dana Whitfield", threads: 4,
                    lastMessageAt: time("2026-11-16T08:40:00Z"))
            ])
        // Written back the same: nothing absent is written.
        #expect(try encodedJSON(result) == json(Self.result))
    }

    @Test func aLaterPageAndFiltersAloneCarryNoPeopleOrMatch() throws {
        let page = try MailJSON.decoder().decode(
            SearchResult.self,
            from: Data(
                #"""
                {"items": [], "understood": {"kinds": ["receipt", "done"], "inboxIds": ["inb_personal"], "unread": false,
                 "after": "2026-10-31T23:00:00Z", "text": ""}}
                """#.utf8))
        #expect(page.items.isEmpty && page.people == nil && page.nextCursor == nil)
        #expect(page.understood.filters.kinds == [.category(.receipt), .done])
        #expect(page.understood.filters.inboxIds == ["inb_personal"] && page.understood.filters.unread == false)
        #expect(page.understood.filters.after == time("2026-10-31T23:00:00Z"))
        #expect(page.understood.text.isEmpty && page.understood.exclude == nil)
    }

    @Test func kindsAndFieldsANewerServerAddsAreKept() throws {
        #expect(SearchKind(rawValue: "screened") == .screened && SearchKind(rawValue: "done") == .done)
        #expect(SearchKind(rawValue: "unknown") == .category(.uncategorized))
        #expect(
            SearchKind.all.map(\.rawValue) == [
                "conversation", "newsletter", "invoice", "receipt", "notification", "otp", "unknown", "screened",
                "done",
            ])
        let excerpt = try MailJSON.decoder().decode(
            SearchExcerpt.self, from: Data(#"{"field": "headers", "runs": []}"#.utf8))
        #expect(excerpt.field == .unknown("headers"))
        #expect(try encodedJSON(excerpt)["field"] == "headers")
    }

    static let remote = #"""
        {
          "items": [
            {"id": "gm:older_contract", "inboxId": "inb_northwind", "subject": "Re: Contract renewal for 2026",
             "from": {"name": "Marek Olsen", "email": "marek@northwind.example"}, "lastMessageAt": "2025-11-12T14:02:00Z",
             "snippet": "Thanks Dana, countersigned and filed.", "hasAttachments": true, "messageCount": 2, "archived": true}
          ],
          "nextCursor": "r2",
          "understood": {"text": "contract"},
          "inboxes": [
            {"inboxId": "inb_northwind", "state": "ok"},
            {"inboxId": "inb_harbor", "state": "unsupported", "message": "This inbox's mailbox can't be searched."},
            {"inboxId": "inb_personal", "state": "paused", "message": "This inbox is paused."},
            {"inboxId": "inb_work", "state": "needs_sign_in", "message": "Sign in with Google again."},
            {"inboxId": "inb_side", "state": "provider_error", "message": "Gmail is busy. Try again later."},
            {"inboxId": "inb_new", "state": "throttled"}
          ]
        }
        """#

    @Test func remoteResultsSayHowEachInboxAnswered() throws {
        let result = try MailJSON.decoder().decode(RemoteSearchResult.self, from: Data(Self.remote.utf8))
        let hit = try #require(result.items.first)
        #expect(hit.id == "gm:older_contract" && hit.archived && hit.messageCount == 2 && hit.hasAttachments)
        #expect(hit.from == Address(name: "Marek Olsen", email: "marek@northwind.example"))
        #expect(result.nextCursor == "r2" && result.understood.text == "contract")
        #expect(
            result.inboxes.map(\.state) == [
                .ok, .unsupported, .paused, .needsSignIn, .providerError, .unknown("throttled"),
            ])
        #expect(result.inboxes[0].message == nil && result.inboxes[4].message == "Gmail is busy. Try again later.")
        #expect(try encodedJSON(result) == json(Self.remote))
    }

    @Test func theSamplesBlockedSendersAndOlderMailDecode() throws {
        let sample = try SampleData.load()
        #expect(
            sample.blockedSenders.map(\.address) == [
                "outreach@linkboost.example", "deals@brightbuy.example", "sales@growthpipe.example",
            ])
        let linkboost = sample.blockedSenders[0]
        #expect(linkboost.blockedBy == .agent(agentId: "dev_agent_1", name: "Claude Code"))
        #expect(linkboost.messagesSinceBlocked == 1 && linkboost.lastMessageAt == time("2026-11-15T06:10:00Z"))
        #expect(sample.blockedSenders[1].blockedBy == .person(deviceId: "dev_mac_1"))
        // Their threads are done, and blocking them is on record.
        for id in ["thr_26", "thr_27", "thr_28"] { #expect(sample.threads.first { $0.id == id }?.done == true) }
        #expect(
            ["act_19", "act_20", "act_21"].map { id in sample.actions.first { $0.id == id }?.action }
                == [.blockSender, .blockSender, .blockSender])
        // Older mail only the mailbox holds: three conversations in Northwind's Gmail.
        #expect(sample.olderMail.count == 4 && Set(sample.olderMail.map(\.threadKey)).count == 3)
        #expect(sample.olderMail.allSatisfy { $0.inboxId == "inb_northwind" })
        #expect(sample.olderMail[0].attachments?.first?.filename == "Lumen-Northwind-2026.pdf")
        #expect(sample.olderMail.dropFirst().allSatisfy { $0.attachments == nil })
        #expect(sample.olderMail.map(\.archived) == [true, true, true, false])
    }

    @Test func aBlockedSenderWithoutStoredMailWritesNull() throws {
        let sender = BlockedSender(
            inboxId: "inb_harbor", address: "quiet@nowhere.example", blockedAt: time("2026-11-01T10:00:00Z"))
        #expect(
            try encodedJSON(sender)
                == json(
                    #"""
                    {"inboxId": "inb_harbor", "address": "quiet@nowhere.example", "blockedAt": "2026-11-01T10:00:00Z",
                     "messagesSinceBlocked": 0, "lastMessageAt": null}
                    """#))
    }
}
