import Foundation
import Testing
import UsualMailDesign
import UsualMailKit

@testable import UsualMailUI

/// Settings' icon picker: every icon it offers is drawn as itself and named for VoiceOver.
@MainActor
struct InboxIconPickerTests {
    @Test func everyOfferedIconIsDrawnAsItselfAndNamed() {
        let offered = InboxIconChoice.options(current: .person).map(\.icon)
        #expect(offered.count == 14)
        // None falls back to the all-inboxes circle an unknown icon gets.
        #expect(offered.allSatisfy { Icon($0) != .allInboxes })
        #expect(Set(offered.map(Icon.init)).count == offered.count)
        let names = offered.map(InboxIconPicker.name)
        #expect(
            names == [
                "Person", "Building", "Briefcase", "House", "Shop", "Globe",
                "Plane", "Wallet", "Family", "Rocket", "School", "Heart", "Star", "Leaf",
            ])
        #expect(InboxIconPicker.name(.unknown("anchor")) == "anchor")
    }

    @Test func theFourteenMakeTwoFullRowsOfSeven() {
        #expect(InboxIconChoice.options(current: .person).count == 2 * InboxIconPicker.columns)
    }

    @Test func theEightLaterIconsAreTheDesignPackagesDrawings() {
        let later: [InboxIcon] = [.plane, .wallet, .family, .rocket, .school, .heart, .star, .leaf]
        for icon in later {
            let drawn = Icon(icon)
            // The design package's own image of the contract's name, from its catalog: no copy here.
            #expect(drawn.designed?.rawValue == icon.rawValue)
            #expect(drawn.catalog == .usualMailDesign)
            #expect(Icon.bundle.image(forResource: drawn.rawValue) == nil, "\(icon) has a copy in the app's catalog")
            // A template, so the rail's tone and the icons' colour can tint it.
            #expect(Bundle.usualMailDesign.image(forResource: drawn.rawValue)?.isTemplate == true)
        }
        // The first six stay this package's drawings.
        #expect(InboxIcon.known.prefix(6).allSatisfy { Icon($0).designed == nil })
    }
}
