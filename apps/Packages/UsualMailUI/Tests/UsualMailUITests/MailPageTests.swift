import Foundation
import SwiftUI
import Testing
import UsualMailKit

@testable import UsualMailUI

/// The mail page: its words, the snooze times, what the undo strip says, and the HTML page's type.
struct MailPageTests {
    let sample = SampleData.bundled

    @Test func whoWroteIt() {
        #expect(
            MailPage.senderLine(Address(name: "Maya Kim", email: "maya@studio.example"))
                == "Maya Kim (maya@studio.example)")
        #expect(MailPage.senderLine(Address(email: "maya@studio.example")) == "maya@studio.example")
        #expect(MailPage.senderLine(Address(name: "", email: "maya@studio.example")) == "maya@studio.example")
    }

    @Test func theSummaryBoxOnlyWithASummary() throws {
        var thread = try #require(sample.threads.first { $0.id == "thr_1" })
        let inbox = sample.inboxes.first { $0.id == thread.inboxId }
        let summary = try #require(thread.summary)
        #expect(MailPage.summaryLine(thread, inbox: inbox) == "Dana Whitfield - \(summary)")
        thread.summary = "  "
        #expect(MailPage.summaryLine(thread, inbox: inbox) == nil)
    }

    @Test func aReceiptsBoxCarriesItsMoneyWordsAndWhatForOnce() throws {
        let gb = Locale(identifier: "en_GB")
        var invoice = try #require(sample.threads.first { $0.id == "thr_6" })
        let inbox = sample.inboxes.first { $0.id == invoice.inboxId }
        // The title over the subtitle, though the thread's summary is the same `what`.
        #expect(
            MailPage.summaryLine(invoice, inbox: inbox, locale: gb)
                == "To be paid: €1,240.00 to Kestrel Roasters\nOctober's bean delivery · due 30 Nov")
        for thread in sample.threads where thread.payment != nil {
            let box = try #require(MailPage.summaryLine(thread, inbox: inbox, locale: gb))
            let what = try #require(thread.payment?.what)
            #expect(box.components(separatedBy: what).count == 2, "\(thread.id) shows what it was for once")
        }
        // Not read yet: the state before the subject, then the mail's first words.
        invoice.payment = nil
        invoice.summary = nil
        #expect(
            MailPage.summaryLine(invoice, inbox: inbox, locale: gb)
                == "To be paid · Invoice 2026-118, due 30 November\n\(invoice.snippet)")
        // Any other mail keeps "Sender - summary".
        let conversation = try #require(sample.threads.first { $0.id == "thr_1" })
        #expect(MailPage.summaryLine(conversation, inbox: inbox, locale: gb)?.hasPrefix("Dana Whitfield - ") == true)
    }

    @Test func textLinksOpenInTheBrowser() {
        let text = MailPage.linked("See www.copv.berlin or write to info@copv.example. Not a link: 030 / 76 88 66 33.")
        let links = text.runs.compactMap(\.link)
        #expect(links.map(\.absoluteString) == ["http://www.copv.berlin", "mailto:info@copv.example"])
        #expect(text.runs.filter { $0.link != nil }.allSatisfy { $0.underlineStyle == .single })
    }

    @Test func snoozeTimesOnAWednesdayMorning() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let now = try #require(MailJSON.parseTime("2026-11-18T10:00:00Z"))  // a Wednesday
        let choices = SnoozeChoice.choices(now: now, calendar: calendar)
        let times = choices.map { MailJSON.formatTime($0.at) }
        #expect(
            times == [
                "2026-11-18T18:00:00Z", "2026-11-19T08:00:00Z", "2026-11-21T09:00:00Z", "2026-11-23T08:00:00Z",
                "2026-11-19T08:00:00Z",
            ])
        #expect(choices.last?.ifNoReply == true)
        // In the evening there is no "later today", and on a Sunday no weekend; next week is the next Monday.
        let evening = try #require(MailJSON.parseTime("2026-11-18T17:30:00Z"))
        #expect(!SnoozeChoice.choices(now: evening, calendar: calendar).contains { $0.title.hasPrefix("Later today") })
        let sunday = try #require(MailJSON.parseTime("2026-11-22T10:00:00Z"))
        let onSunday = SnoozeChoice.choices(now: sunday, calendar: calendar)
        #expect(!onSunday.contains { $0.title.hasPrefix("This weekend") })
        #expect(onSunday.contains { MailJSON.formatTime($0.at) == "2026-11-23T08:00:00Z" })
    }

    @Test func whatTheUndoStripSays() {
        #expect(ActionWords.done(.done) == "Archived.")
        #expect(ActionWords.done(.stack(.replyLater)) == "Moved to To reply.")
        #expect(ActionWords.done(.stack(.setAside)) == "Pinned.")
        #expect(ActionWords.done(.categorize(.newsletter)) == "Moved to the feed.")
        #expect(ActionWords.done(.categorize(.receipt)) == "Moved to the paper trail as a receipt.")
        #expect(ActionWords.done(.trash) == "Removed.")
    }

    @Test func htmlMailIsSetInGeist() {
        // Both faces travel in the page, so the web view's own process can draw them.
        #expect(HTMLMail.fontData(postScriptName: "Geist-Regular") != nil)
        #expect(HTMLMail.baseStyle.components(separatedBy: "@font-face").count == 3)
        #expect(HTMLMail.baseStyle.contains("font:12px/1.45 'Usual Geist'"))
        #expect(HTMLMail.baseStyle.contains("data:font/ttf;base64,"))
    }
}
