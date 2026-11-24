import Testing
import UsualMailKit

@testable import UsualMailUI

/// The quiet line above a mail that says what the server took out of its pictures or held back.
struct PictureWordsTests {
    @Test func nothingToSayWithoutTrackersOrHeldBackPictures() {
        #expect(PictureWords.line(for: nil) == nil)
        #expect(PictureWords.line(for: RemotePictures(shown: 4)) == nil)
        #expect(PictureWords.tooltip(for: nil) == nil)
        #expect(PictureWords.tooltip(for: RemotePictures(shown: 4)) == nil)
    }

    @Test func trackersRemovedAreCounted() {
        #expect(PictureWords.line(for: RemotePictures(shown: 2, trackersRemoved: 1)) == "1 tracker removed")
        #expect(PictureWords.line(for: RemotePictures(shown: 0, trackersRemoved: 3)) == "3 trackers removed")
    }

    @Test func heldBackPicturesSayWhy() {
        #expect(
            PictureWords.line(for: RemotePictures(shown: 0, heldBack: .screened))
                == "Pictures show once you let this sender in.")
        #expect(
            PictureWords.line(for: RemotePictures(shown: 0, heldBack: .blocked))
                == "Pictures from blocked senders aren't shown.")
        // A reason a newer server gives that this app doesn't know.
        #expect(
            PictureWords.line(for: RemotePictures(shown: 0, heldBack: .unknown("later"))) == "Pictures are held back.")
    }

    @Test func bothAreJoined() {
        let both = RemotePictures(shown: 0, trackersRemoved: 2, trackers: ["Mailchimp"], heldBack: .screened)
        #expect(PictureWords.line(for: both) == "2 trackers removed · Pictures show once you let this sender in.")
    }

    @Test func aMessageTooLongToShowAsDesignedSaysSo() {
        let tooLong = "This message is too long to show as designed."
        #expect(PictureWords.line(for: nil, htmlTooLarge: true) == tooLong)
        #expect(PictureWords.line(for: RemotePictures(shown: 0), htmlTooLarge: true) == tooLong)
        #expect(
            PictureWords.line(for: RemotePictures(shown: 0, trackersRemoved: 1, heldBack: .blocked), htmlTooLarge: true)
                == "This message is too long to show as designed · 1 tracker removed · Pictures from blocked senders aren't shown."
        )
        #expect(PictureWords.line(for: nil, htmlTooLarge: false) == nil)
    }

    @Test func theTooltipNamesWhoMadeTheTrackers() {
        func tooltip(_ trackers: [String], removed: Int = 3) -> String? {
            PictureWords.tooltip(for: RemotePictures(shown: 1, trackersRemoved: removed, trackers: trackers))
        }
        #expect(tooltip([]) == nil)
        #expect(tooltip(["Mailchimp"]) == "From Mailchimp")
        #expect(tooltip(["HubSpot", "Mailchimp"]) == "From HubSpot and Mailchimp")
        #expect(tooltip(["HubSpot", "Mailchimp", "Salesforce"]) == "From HubSpot, Mailchimp and Salesforce")
        // Names without a tracker taken out say nothing.
        #expect(tooltip(["Mailchimp"], removed: 0) == nil)
    }

    @Test func namesAreJoinedTheEnglishWay() {
        #expect(PictureWords.joined([]) == "")
        #expect(PictureWords.joined(["A"]) == "A")
        #expect(PictureWords.joined(["A", "B"]) == "A and B")
        #expect(PictureWords.joined(["A", "B", "C", "D"]) == "A, B, C and D")
    }
}
