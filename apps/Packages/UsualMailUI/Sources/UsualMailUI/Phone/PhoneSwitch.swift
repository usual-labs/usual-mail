import UsualMailKit

/// What the iPhone's switcher, the capsule in the middle of its top row, says of where the window is (the owner's
/// concept of 2026-11-20: "a drop down selector, which would include all the inboxes and also all the other pages"):
/// in the mail stack, the profile, an inbox by its address, or every inbox; in another stack, that page. Search is
/// over a stack and Settings has its own button, so under either it still names the stack. Its menu's rows are the
/// Mac rail's: the profiles, then To reply, Pinned, Snoozed and the Inbox page.
struct PhoneSwitch: Equatable {
    let icon: Icon
    let title: String

    static let allInboxes = "All inboxes"

    /// The pages in the menu under the profiles, in the rail's order.
    static let pages: [Place] = [.toReply, .pinned, .snoozed, .inbox]

    /// The capsule for `nav`, among `inboxes`. A profile whose inbox is gone reads as every inbox until the window
    /// catches up.
    static func label(nav: Navigation, inboxes: [Inbox]) -> PhoneSwitch {
        switch nav.stackPlace.destination {
        case .mail, nil:
            if let id = nav.profile, let inbox = inboxes.first(where: { $0.id == id }) {
                return PhoneSwitch(icon: Icon(inbox.icon), title: inbox.address.isEmpty ? inbox.name : inbox.address)
            }
            return PhoneSwitch(icon: .allInboxes, title: allInboxes)
        default:
            return PhoneSwitch(icon: nav.stackPlace.icon, title: nav.stackPlace.title)
        }
    }

    /// The menu's "Add a Gmail account", short enough for one line.
    static let addGmail = "Add Gmail"

    /// The most characters a menu row's words keep on one line. The system's menu takes no line limit and wraps a
    /// long address (owner's words of 2026-11-24: "dont let the items wrap, do ellipsis"); in the simulator it wrapped
    /// an address of 18 characters after 17.
    static let menuLength = 16

    /// `text` as a menu row shows it: as it is when it fits, else its start and its end with an ellipsis between, the
    /// end kept longer, so an address keeps its domain: "someon…y.example".
    static func menuTitle(_ text: String, length: Int = menuLength) -> String {
        guard text.count > length, length > 2 else { return text }
        let kept = length - 1
        let head = kept * 2 / 5
        return String(text.prefix(head)) + "…" + String(text.suffix(kept - head))
    }

    /// Whether the menu ticks `page`: the stack showing, under search too.
    static func ticks(_ page: Place, nav: Navigation) -> Bool {
        nav.stackPlace == page
    }
}
