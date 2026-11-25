import Foundation
import Testing

@testable import UsualMailKit

struct SampleDecodingTests {
    @Test func theWholeSampleDecodes() throws {
        let sample = try SampleData.load()
        #expect(sample.now == time("2026-11-16T09:30:00Z"))
        // In the inbox list's order, by position.
        #expect(sample.inboxes.map(\.id) == ["inb_northwind", "inb_harbor", "inb_personal"])
        #expect(sample.inboxes.map(\.position) == [0, 1, 2])
        // Three blocked senders' threads (thr_26 to thr_28, done) and their blocks (act_19 to act_21) joined on
        // 2026-11-20, with the blocked senders themselves and the older mail only the mailbox holds.
        #expect(sample.threads.count == 28)
        #expect(sample.messages.count == 37)
        #expect(sample.drafts.count == 2)
        #expect(sample.actions.count == 21)
        #expect(sample.rules.count == 4)
        #expect(sample.brief.sections.map(\.inboxId) == ["inb_northwind", "inb_harbor"])
    }

    @Test func theThirdRevisionsFieldsComeThrough() throws {
        let sample = try SampleData.load()
        #expect(sample.inboxes.map(\.version) == [14, 6, 9])
        #expect(sample.drafts.first?.version == 2 && sample.drafts.first?.note == nil)
        #expect(sample.actions.allSatisfy { $0.note == nil && $0.error == nil })
        #expect(sample.messages.first { $0.id == "msg_4a" }?.listId == "weekly-build.weeklybuild.example")
        #expect(sample.messages.filter { $0.listId != nil }.count == 1)
        #expect(
            sample.brief.sections.flatMap(\.highlights).map(\.subject) == [
                "Contract renewal for 2027", "Two candidates for the design role", "Invoice 2026-118, due 30 November",
            ])
        #expect(sample.messages.flatMap(\.attachments).allSatisfy { $0.contentId == nil })
    }

    @Test func theFourthRevisionsFieldsComeThrough() throws {
        let sample = try SampleData.load()
        // Every inbox says how it is connected, without a secret.
        #expect(sample.inboxes.map(\.connection.kind) == sample.inboxes.map(\.provider.rawValue))
        let personal = try #require(sample.inboxes.first { $0.id == "inb_personal" })
        #expect(
            personal.connection
                == .imap(
                    imap: ServerLogin(host: "imap.home.example", port: 993, secure: true, user: "me@home.example"),
                    smtp: ServerLogin(host: "smtp.home.example", port: 465, secure: true, user: "me@home.example"),
                    saveSent: true))
        let harbor = try #require(sample.inboxes.first { $0.id == "inb_harbor" })
        guard case .imap(_, let smtp, _) = harbor.connection else {
            Issue.record("Harbor & Pine connects over IMAP")
            return
        }
        #expect(smtp.port == 587 && !smtp.secure)  // STARTTLS
        let northwind = try #require(sample.inboxes.first { $0.id == "inb_northwind" })
        #expect(northwind.connection == .gmail(clientId: "000000000000-sample.apps.googleusercontent.example"))
        // Every rule has a version and says who made it.
        #expect(sample.rules.map(\.version) == [9, 5, 3, 1])
        #expect(sample.rules.first { $0.id == "rul_1" }?.createdBy == .person(deviceId: "dev_mac_1"))
        #expect(
            sample.rules.first { $0.id == "rul_4" }?.createdBy == .agent(agentId: "dev_agent_1", name: "Claude Code"))
        // A sent draft with a note, kept for a day in its thread.
        let sent = try #require(sample.drafts.first { $0.id == "drf_2" })
        #expect(sent.state == .sent && sent.threadId == "thr_7" && sent.note?.contains("mailbox is full") == true)
        #expect(sent.isKept && sent.createdBy == .person(deviceId: "dev_mac_1"))
        #expect(sample.detail(threadId: "thr_7")?.drafts.map(\.id) == ["drf_2"])
    }

    @Test func connectionsFromAnOlderStoreOrANewerServerDecode() throws {
        let decoder = MailJSON.decoder()
        // A store from before the fourth revision: empty host, user or client id.
        let blank = try decoder.decode(
            InboxConnection.self,
            from: Data(
                #"""
                {"kind":"imap","imap":{"host":"","port":993,"secure":true,"user":""},
                 "smtp":{"host":"","port":465,"secure":true,"user":""},"saveSent":true}
                """#.utf8))
        #expect(
            blank
                == .imap(
                    imap: ServerLogin(host: "", port: 993, secure: true, user: ""),
                    smtp: ServerLogin(host: "", port: 465, secure: true, user: ""), saveSent: true))
        #expect(
            try decoder.decode(InboxConnection.self, from: Data(#"{"kind":"gmail","clientId":""}"#.utf8))
                == .gmail(clientId: ""))
        // A kind a newer server sends is unknown, kept whole.
        let outlook = try decoder.decode(
            InboxConnection.self, from: Data(#"{"kind":"outlook","tenant":"t1","user":"a@b.example"}"#.utf8))
        #expect(outlook.kind == "outlook")
        #expect(try encodedJSON(outlook) == json(#"{"kind":"outlook","tenant":"t1","user":"a@b.example"}"#))
        // Rules from before rules recorded their maker say "system".
        let rule = try decoder.decode(
            Rule.self,
            from: Data(
                #"""
                {"id":"r","inboxId":"i","text":"t","match":{"from":"a@b.example"},"then":[{"kind":"done"}],
                 "source":"agent","enabled":false,"hits":0,"createdBy":{"kind":"system"},
                 "createdAt":"2026-11-01T00:00:00Z","version":2}
                """#.utf8))
        #expect(rule.createdBy == .system && rule.version == 2)
    }

    @Test func notesContentIdsAndProviderKindsDecode() throws {
        let decoder = MailJSON.decoder()
        let record = try decoder.decode(
            ActionRecord.self,
            from: Data(
                #"""
                {"id":"a","threadId":"t","inboxId":"i","action":{"kind":"stack","stack":"reply_later"},
                 "actor":{"kind":"rule","ruleId":"r"},"state":"applied","at":"2026-11-16T09:30:00Z","undoable":true,
                 "silent":false,"note":"This server can't keep stacks","version":3}
                """#.utf8))
        #expect(record.note == "This server can't keep stacks" && !record.silent)
        let attachment = try decoder.decode(
            AttachmentMeta.self,
            from: Data(
                #"{"id":"att","filename":"logo.png","mimeType":"image/png","size":10,"inline":true,"contentId":"logo@x"}"#
                    .utf8))
        #expect(attachment.contentId == "logo@x")
        // Outlook left the contract: a server that still sends it gets an unknown kind, kept as sent.
        #expect(ProviderKind(rawValue: "outlook") == .unknown("outlook"))
        #expect(ProviderKind.known == [.imap, .gmail])
    }

    @Test func everyValueIsOneTheAppKnows() throws {
        let sample = try SampleData.load()
        #expect(
            sample.inboxes.allSatisfy {
                $0.trust.isKnown && $0.status.isKnown && $0.provider.isKnown && $0.icon.isKnown
            })
        #expect(
            sample.threads.allSatisfy {
                $0.category.isKnown && ($0.categorizedBy?.isKnown ?? true) && ($0.stack?.isKnown ?? true)
            })
        #expect(sample.actions.allSatisfy { $0.state.isKnown })
        for record in sample.actions {
            if case .unknown = record.action { Issue.record("\(record.id) has an unknown action") }
            if case .unknown = record.actor { Issue.record("\(record.id) has an unknown actor") }
        }
        #expect(sample.rules.flatMap(\.then).allSatisfy { if case .unknown = $0 { false } else { true } })
        #expect(sample.aiStatus.state.isKnown && sample.ai.jobs.allSatisfy { $0.job.isKnown })
    }

    @Test func fieldsComeThroughAsTheSampleHasThem() throws {
        let sample = try SampleData.load()
        let personal = try #require(sample.inboxes.first { $0.id == "inb_personal" })
        #expect(personal.status == .needsAttention)
        #expect(personal.statusDetail == "The IMAP server at imap.home.example refused the user name or password.")
        #expect(personal.trust == .actSilently)
        #expect(personal.agentAccess)

        let lease = try #require(sample.threads.first { $0.id == "thr_9" })
        #expect(lease.comeBackAt == time("2026-11-19T08:00:00Z"))
        #expect(lease.comeBackIfNoReply == true)
        #expect(lease.participants.first?.displayName == "Harbor & Pine")

        let photos = try #require(sample.threads.first { $0.id == "thr_7" })
        #expect(photos.stack == .replyLater)
        #expect(photos.version == 4 && photos.trashed == false)
        #expect(sample.threads.first { $0.id == "thr_1" }?.need == .reply)

        let draft = try #require(sample.drafts.first)
        #expect(draft.createdBy == .agent(agentId: "dev_agent_1", name: "Claude Code"))
        let undone = try #require(sample.actions.first { $0.id == "act_15" })
        #expect(undone.state == .undone && undone.version == 2 && undone.undoneAt == time("2026-11-16T09:10:00Z"))
        #expect(sample.actions.first { $0.id == "act_6" }?.actor == .person(deviceId: "dev_mac_1"))
        #expect(
            sample.rules.first { $0.id == "rul_4" }?.match == RuleMatch(subjectContains: "shipped", automated: true))
        #expect(sample.messages.first { $0.id == "msg_1a" }?.attachments.first?.size == 184_320)
    }

    @Test func modelsEncodeBackToTheSampleJSON() throws {
        let sample = try SampleData.load()
        let original = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: SampleData.bundledURL))
        #expect(try encodedJSON(sample) == original)
    }
}

struct ForwardCompatibilityTests {
    @Test func unknownStringValuesDecodeAndEncodeBack() throws {
        let thread = try MailJSON.decoder().decode(
            MailThread.self,
            from: Data(
                #"""
                {"id":"t","inboxId":"i","subject":"s","snippet":"","participants":[],"lastMessageAt":"2026-11-16T09:30:00Z",
                 "messageCount":1,"unread":false,"hasAttachments":false,"category":"travel","categorizedBy":"oracle",
                 "screened":false,"done":false,"stack":"read_later","trashed":false,"version":1,"need":"sign",
                 "shinyNewField":true}
                """#.utf8))
        // A category this app doesn't know is kept whole, and listed as uncategorized, so it shows in Home.
        #expect(thread.category == .unknown("travel"))
        #expect(!thread.category.isKnown && thread.category.listed == .uncategorized && thread.category.isUncategorized)
        #expect(thread.category.isShownInHome)
        #expect(thread.categorizedBy == .unknown("oracle"))
        #expect(thread.stack == .unknown("read_later"))
        #expect(thread.need == .unknown("sign"))
        #expect(try encodedJSON(thread)["category"] == "travel")
        // The contract's own `unknown` is a known category, spelled `uncategorized` here.
        #expect(Category(rawValue: "unknown") == .uncategorized && Category.uncategorized.isKnown)
        #expect(Category(rawValue: "receipt") == .receipt && !Category.receipt.isShownInHome)
        #expect(!Category.notification.isShownInHome && !Category.newsletter.isShownInHome)
        #expect(Category.conversation.isShownInHome && Category.uncategorized.isShownInHome)
        #expect(
            Category.known.map(\.rawValue) == [
                "conversation", "newsletter", "invoice", "receipt", "notification", "otp", "unknown",
            ])
        #expect(!Category.decidable.contains(.uncategorized) && Category.filed.count == 5)
        let inbox = try MailJSON.decoder().decode(InboxIcon.self, from: Data(#""anchor""#.utf8))
        #expect(inbox == .unknown("anchor") && InboxIcon(rawValue: "shop") == .shop)
        #expect(AiState(rawValue: "melting") == .unknown("melting") && AiState(rawValue: "key_refused") == .keyRefused)
    }

    @Test func unknownActionsAndActorsKeepTheirWholeObject() throws {
        let record = try MailJSON.decoder().decode(
            ActionRecord.self,
            from: Data(
                #"""
                {"id":"a","threadId":"t","inboxId":"i","action":{"kind":"snooze_forever","why":"bored"},
                 "actor":{"kind":"robot","serial":7},"state":"pondering","at":"2026-11-16T09:30:00Z","undoable":false,
                 "silent":false,"version":1}
                """#.utf8))
        #expect(record.action.kind == "snooze_forever")
        #expect(record.actor.kind == "robot")
        #expect(record.state == .unknown("pondering"))
        let encoded = try encodedJSON(record)
        #expect(encoded["action"] == json(#"{"kind":"snooze_forever","why":"bored"}"#))
        #expect(encoded["actor"] == json(#"{"kind":"robot","serial":7}"#))
    }

    @Test func unknownEventTypesDecode() throws {
        let event = try MailJSON.decoder().decode(
            MailEvent.self, from: Data(#"{"type":"clip.saved","clipId":"c"}"#.utf8))
        #expect(event == .unknown(type: "clip.saved"))
    }

    @Test func errorCodesFromStatusesFollowTheContract() {
        #expect(ErrorCode(status: 400) == .invalid)
        #expect(ErrorCode(status: 401) == .unauthorized)
        #expect(ErrorCode(status: 403) == .forbidden)
        #expect(ErrorCode(status: 404) == .notFound)
        #expect(ErrorCode(status: 409) == .conflict)
        #expect(ErrorCode(status: 429) == .rateLimited)
        #expect(ErrorCode(status: 500) == .internal)
        #expect(ErrorCode(status: 502) == .providerError)
        #expect(ErrorCode(status: 418) == .unknown("http_418"))
    }
}

struct ActionInputEncodingTests {
    /// Every `ActionInput` case, with the exact JSON core/src/domain.ts describes.
    static let cases: [(ActionInput, String)] = [
        (.categorize(.conversation), #"{"category":"conversation","kind":"categorize"}"#),
        (.categorize(.newsletter), #"{"category":"newsletter","kind":"categorize"}"#),
        (.categorize(.invoice), #"{"category":"invoice","kind":"categorize"}"#),
        (.categorize(.receipt), #"{"category":"receipt","kind":"categorize"}"#),
        (.categorize(.notification), #"{"category":"notification","kind":"categorize"}"#),
        (.categorize(.otp), #"{"category":"otp","kind":"categorize"}"#),
        (.done, #"{"kind":"done"}"#),
        (.notDone, #"{"kind":"not_done"}"#),
        (.read, #"{"kind":"read"}"#),
        (.unread, #"{"kind":"unread"}"#),
        (.stack(.replyLater), #"{"kind":"stack","stack":"reply_later"}"#),
        (.stack(.setAside), #"{"kind":"stack","stack":"set_aside"}"#),
        (.unstack, #"{"kind":"unstack"}"#),
        (.comeBack(at: time("2026-11-19T08:00:00Z")), #"{"at":"2026-11-19T08:00:00Z","kind":"come_back"}"#),
        (
            .comeBack(at: time("2026-11-19T08:00:00Z"), ifNoReply: true),
            #"{"at":"2026-11-19T08:00:00Z","ifNoReply":true,"kind":"come_back"}"#
        ),
        (
            .comeBack(at: time("2026-11-19T08:00:00Z"), ifNoReply: false),
            #"{"at":"2026-11-19T08:00:00Z","ifNoReply":false,"kind":"come_back"}"#
        ),
        (.cancelComeBack, #"{"kind":"cancel_come_back"}"#),
        (.allowSender, #"{"kind":"allow_sender"}"#),
        (.blockSender, #"{"kind":"block_sender"}"#),
        (.trash, #"{"kind":"trash"}"#),
    ]

    @Test(arguments: cases)
    func encodesExactly(_ action: ActionInput, _ expected: String) throws {
        let text = String(decoding: try MailJSON.encoder().encode(action), as: UTF8.self)
        #expect(text == expected)
        #expect(try MailJSON.decoder().decode(ActionInput.self, from: Data(expected.utf8)) == action)
    }

    @Test func needsPersonMatchesCore() {
        let needing = Self.cases.map(\.0).filter(\.needsPerson).map(\.kind)
        #expect(Set(needing) == ["trash", "block_sender"])
    }

    @Test func actorsEncodeExactly() throws {
        let cases: [(Doer, String)] = [
            (.person(deviceId: "dev_1"), #"{"deviceId":"dev_1","kind":"person"}"#),
            (.rule(ruleId: "rul_1"), #"{"kind":"rule","ruleId":"rul_1"}"#),
            (.agent(agentId: "a", name: "Hermes"), #"{"agentId":"a","kind":"agent","name":"Hermes"}"#),
            (
                .ai(job: .categorize, model: "example/decision-1"),
                #"{"job":"categorize","kind":"ai","model":"example/decision-1"}"#
            ),
            (.system, #"{"kind":"system"}"#),
        ]
        for (actor, expected) in cases {
            #expect(String(decoding: try MailJSON.encoder().encode(actor), as: UTF8.self) == expected)
            #expect(try MailJSON.decoder().decode(Doer.self, from: Data(expected.utf8)) == actor)
        }
    }
}

struct ActResultTests {
    @Test func actResultsCarryTheirThreads() throws {
        let sample = SampleData.bundled
        let result = ActResult(records: [sample.actions[0]], threads: [sample.threads[2]])
        let encoded = try encodedJSON(result)
        #expect(encoded["threads"] == .array([try encodedJSON(sample.threads[2])]))
        #expect(encoded["teach"] == nil)
        #expect(try MailJSON.decoder().decode(ActResult.self, from: MailJSON.encoder().encode(result)) == result)
    }
}

struct MailEventTests {
    @Test func everyEventTypeDecodes() throws {
        let sample = SampleData.bundled
        let events: [MailEvent] = [
            .inboxChanged(sample.inboxes[0]),
            .inboxRemoved(inboxId: "inb_personal"),
            .threadChanged(sample.threads[0]),
            .threadRemoved(threadId: "thr_1", inboxId: "inb_northwind"),
            .actionRecorded(sample.actions[0]),
            .draftChanged(sample.drafts[0]),
            .draftRemoved(draftId: "drf_1", inboxId: "inb_northwind"),
            .ruleChanged(sample.rules[3]),
            .ruleRemoved(ruleId: "rul_4", inboxId: "inb_personal"),
            .triagePending(inboxId: "inb_harbor", count: 3),
            .countsChanged(sample.counts),
            .aiStatusChanged(sample.aiStatus),
            .aiSettingsChanged(sample.ai),
            .briefReady(briefId: "brf_2"),
        ]
        for event in events {
            let data = try MailJSON.encoder().encode(event)
            #expect(try MailJSON.decoder().decode(MailEvent.self, from: data) == event)
            #expect(try encodedJSON(event)["type"]?.stringValue == event.type)
        }
        let removed = try MailJSON.decoder().decode(
            MailEvent.self, from: Data(#"{"type":"thread.removed","threadId":"t","inboxId":"i"}"#.utf8))
        #expect(removed == .threadRemoved(threadId: "t", inboxId: "i"))
        let pending = try MailJSON.decoder().decode(
            MailEvent.self, from: Data(#"{"type":"triage.pending","inboxId":"i","count":4}"#.utf8))
        #expect(pending == .triagePending(inboxId: "i", count: 4))
        let ruleGone = try MailJSON.decoder().decode(
            MailEvent.self, from: Data(#"{"type":"rule.removed","ruleId":"r","inboxId":"i"}"#.utf8))
        #expect(ruleGone == .ruleRemoved(ruleId: "r", inboxId: "i") && ruleGone.type == "rule.removed")
        #expect(try encodedJSON(MailEvent.ruleChanged(sample.rules[0]))["rule"] == (try encodedJSON(sample.rules[0])))
    }
}

struct TimeAndTextTests {
    @Test func timesWithAndWithoutFractionsAndOffsets() throws {
        #expect(MailJSON.parseTime("2026-11-16T09:30:00Z") == Date(timeIntervalSince1970: 1_794_821_400))
        #expect(MailJSON.parseTime("2026-11-16T09:30:00.250Z") == Date(timeIntervalSince1970: 1_794_821_400.25))
        #expect(MailJSON.parseTime("2026-11-16T10:30:00+01:00") == Date(timeIntervalSince1970: 1_794_821_400))
        #expect(MailJSON.parseTime("16 November") == nil)
        #expect(MailJSON.formatTime(Date(timeIntervalSince1970: 1_794_821_400)) == "2026-11-16T09:30:00Z")
        // The contract's times have whole seconds and no fractions, so a fraction is dropped.
        #expect(MailJSON.formatTime(Date(timeIntervalSince1970: 1_794_821_400.999)) == "2026-11-16T09:30:00Z")
        let comeBack = ActionInput.comeBack(at: Date(timeIntervalSince1970: 1_794_821_400.25))
        let text = String(decoding: try MailJSON.encoder().encode(comeBack), as: UTF8.self)
        #expect(text == #"{"at":"2026-11-16T09:30:00Z","kind":"come_back"}"#)
    }

    @Test func htmlOnlyMessagesReadAsText() {
        let message = Message(
            id: "m", threadId: "t", inboxId: "i", from: Address(email: "a@b.example"), date: .now, subject: "s",
            html: "<h1>Notes</h1><p>Fish &amp; chips<br>at <strong>seven</strong></p><style>p{}</style>")
        #expect(message.plainText == "Notes\nFish & chips\nat seven")
        let sample = SampleData.bundled.messages.first { $0.id == "msg_1b" }
        #expect(sample?.plainText.hasPrefix("Thanks. Could you confirm") == true)
    }

    @Test func inboxColoursParse() {
        let blue = RGBColor(hex: "#2F6FED")
        #expect(blue?.red == Double(0x2F) / 255)
        #expect(blue?.blue == Double(0xED) / 255)
        #expect(RGBColor(hex: "2f6fed") == blue)
        #expect(RGBColor(hex: "#12345") == nil)
        #expect(RGBColor(hex: "blue") == nil)
    }

    @Test func placementFollowsEachActionAsTheContractSays() {
        let thread = SampleData.bundled.threads.first { $0.id == "thr_1" }!
        let stacked = SampleData.bundled.threads.first { $0.id == "thr_7" }!
        let waiting = SampleData.bundled.threads.first { $0.id == "thr_9" }!
        let screened = SampleData.bundled.threads.first { $0.id == "thr_5" }!
        // categorize sets the category and who decided it, and nothing else
        let filed = thread.applying(.categorize(.newsletter))
        #expect(filed.category == .newsletter && filed.categorizedBy == .person && filed.summary == thread.summary)
        #expect(filed.screened == thread.screened && filed.done == thread.done && filed.unread == thread.unread)
        #expect(thread.applying(.categorize(.invoice), by: .rule).categorizedBy == .rule)
        // it lets no sender in, except that a one-time code is never screened, and never summarized
        #expect(screened.applying(.categorize(.newsletter)).screened)
        let code = screened.applying(.categorize(.otp))
        #expect(!code.screened && code.summary == nil && code.category == .otp)
        #expect(thread.applying(.read).unread == false)
        // done takes it off its stack and clears a come-back time
        #expect(stacked.applying(.done).done && stacked.applying(.done).stack == nil)
        #expect(waiting.applying(.done).comeBackAt == nil && waiting.applying(.done).comeBackIfNoReply == nil)
        #expect(thread.applying(.done).applying(.notDone).done == false)
        // stack and come_back clear done
        let done = thread.applying(.done)
        #expect(done.applying(.stack(.setAside)).stack == .setAside && !done.applying(.stack(.setAside)).done)
        #expect(thread.applying(.stack(.setAside)).applying(.unstack).stack == nil)
        let later = done.applying(.comeBack(at: time("2026-11-20T08:00:00Z"), ifNoReply: true))
        #expect(later.comeBackAt == time("2026-11-20T08:00:00Z") && later.comeBackIfNoReply == true && !later.done)
        #expect(later.applying(.cancelComeBack).comeBackAt == nil)
        // allow_sender lets the thread out of screening and changes nothing else
        let allowed = screened.applying(.allowSender)
        #expect(!allowed.screened && allowed.category == screened.category && allowed.done == screened.done)
        #expect(thread.applying(.allowSender) == thread)
        #expect(stacked.applying(.blockSender).done && stacked.applying(.blockSender).stack == nil)
        // trash sets trashed and nothing else
        #expect(thread.applying(.trash).trashed && !thread.applying(.trash).done)
        #expect(thread.applying(.unknown(kind: "x", payload: [:])) == thread)
        // the placement round-trips every field undo puts back
        var moved = screened.applying(.trash).applying(.unread).applying(.categorize(.receipt)).applying(.allowSender)
        moved.placement = screened.placement
        moved.categorizedBy = screened.categorizedBy
        moved.categorizedByActor = screened.categorizedByActor
        #expect(moved == screened)
    }
}
