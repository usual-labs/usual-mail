import Foundation
import SwiftUI
import Testing
import UsualMailKit

@testable import UsualMailUI

/// A mail page's chosen button reads as chosen over the wallpaper, light or dark (the coordinator's brief of
/// 2026-11-20, from the owner's capture at 1512 × 982: a mail opened from To reply, its reply-later button, "Remove
/// from To reply", was 206 214 217 in its padding over the sky against its neighbours' 214–217 223 226, darker and all
/// but the same). It is lit as the rail's current button and the chosen tab are (`GlassControl.lit`): white at
/// `RailLook.lit` under clear glass, its icon in the design's dark ink. On the real `TopBar` at the card's width in the
/// design's window, drawn offscreen (`Picture`: glass flat, without the lens) over the flat sky and hill colours of
/// `RailChosenTests`. Over the hills the others are as drawn: tinted 30%, 209; the chosen one lit, 237, its icon 14 to
/// 1. When its glass was tinted 70% instead, that tint lightened every glass in the row to 253, the chosen one's too.
/// Over the sky this renderer draws the others' tinted glass at 251, 30 levels lighter than the screen, so nothing
/// could stand 25 above it there; the chosen one is held to the others as the capture shows them.
@MainActor
struct BarChosenTests {
    static let now = MailJSON.parseTime("2026-11-18T10:00:00Z")!
    /// The unchosen buttons' padding over the sky in the owner's capture.
    static let skyOnScreen = Pixel(red: 216, green: 223, blue: 226).luma

    /// Each button that can be chosen, with a mail it is chosen for and the place the mail is opened from:
    /// "Remove from To reply", "Unpin", "Unsnooze" and, on search's results, "Move to Inbox".
    static let chosen: [(action: BarAction, mail: MailThread, place: Place)] = [
        (.replyLater, mail(stack: .replyLater), .toReply),
        (.pin, mail(stack: .setAside), .pinned),
        (.snooze, mail(comeBackAt: now.addingTimeInterval(3600)), .snoozed),
        (.archive, mail(done: true), .search),
    ]

    @Test func theChosenBarButtonStandsOutOverTheSkyAndTheHills() throws {
        Theme.registerFonts()
        for (name, ground) in TabChosenTests.grounds {
            for (action, mail, place) in Self.chosen {
                let what = "\(action) over the \(name)"
                try #require(action.button(for: mail, now: Self.now).chosen, "\(what): not chosen")
                let picture = try Picture(of: bar(place, mail: mail, ground: ground))
                // The back capsule, then the mail's five buttons.
                let capsules = TabChosenTests.capsules(in: picture)
                try #require(capsules.count == 1 + BarAction.mailActions.count, "\(what): \(capsules)")
                let index = 1 + (BarAction.mailActions.firstIndex(of: action) ?? 0)
                let lit = capsules[index]
                let fill = picture.luma(inPaddingOf: lit)
                for (other, capsule) in capsules.enumerated() where other != index {
                    let drawn = picture.luma(inPaddingOf: capsule)
                    let plain = name == "sky" ? Self.skyOnScreen : drawn
                    if name == "sky" { #expect(drawn - plain > 20, "\(what): capsule \(other) drawn \(drawn)") }
                    #expect(
                        fill - plain >= TabChosenTests.margin, "\(what): capsule \(other) \(plain), the chosen \(fill)")
                }
                let icon = picture.contrast(in: TabChosenTests.icon(of: lit), against: lit)
                #expect(icon >= TabChosenTests.iconContrast, "\(what): its icon \(icon) to 1")
            }
        }
    }

    /// The real top row at the card's width in the design's window, `mail` open from `place`, over `ground`.
    private func bar(_ place: Place, mail: MailThread, ground: Color) -> some View {
        TopBar(
            place: .constant(place), screeningCount: 0, mail: mail, now: Self.now, back: {}, act: { _ in }
        )
        .frame(width: RailChosenTests.layout.center)
        .padding(TabChosenTests.inset)
        .background(ground)
    }

    private static func mail(stack: Stack? = nil, comeBackAt: Date? = nil, done: Bool = false) -> MailThread {
        MailThread(
            id: "thr_x", inboxId: "inb_northwind", subject: "Lease", lastMessageAt: now, done: done, stack: stack,
            comeBackAt: comeBackAt)
    }
}
