import Foundation
import Testing
import UsualMailKit

@testable import UsualMailUI

/// A money row shows the sender's picture only beside the sender's own organisation (2026-11-19).
struct PartyMatchTests {
    private func sender(_ name: String?, _ email: String) -> Address {
        Address(name: name, email: email)
    }

    @Test func aMarketplacesOwnRowsKeepItsLogo() {
        let marketplace = sender("Amazon.de", "auto-confirm@shop.example.de")
        #expect(PartyMatch.isSender(party: "Amazon", sender: marketplace))
        #expect(PartyMatch.isSender(party: "Amazon.de", sender: marketplace))
        #expect(PartyMatch.isSender(party: "amazon", sender: sender(nil, "payments@amazon.example")))
    }

    @Test func aRefundNamingTheMerchantIsNotTheMarketplace() {
        #expect(!PartyMatch.isSender(party: "KORVANO", sender: sender("Amazon.de", "returns@amazon.example")))
        #expect(!PartyMatch.isSender(party: "Paddle.net", sender: sender("PayPal", "service@paypal.example")))
    }

    @Test func wholeWordsFromTheStartOnly() {
        let console = sender("Quillpad Console", "billing@quillpad.example")
        #expect(PartyMatch.isSender(party: "Quillpad", sender: console))
        #expect(!PartyMatch.isSender(party: "Pad", sender: console))
        #expect(!PartyMatch.isSender(party: "Quill", sender: sender("Quillpad", "x@y.example")))
        // Case and accents aside, legal endings dropped.
        #expect(PartyMatch.isSender(party: "Zalando SE", sender: sender("Zalando Team", "info@service.example")))
        #expect(PartyMatch.isSender(party: "café crème GmbH", sender: sender("Cafe Creme", "hi@c.example")))
    }

    @Test func theDomainNamesTheSenderToo() {
        #expect(PartyMatch.domainLabel(of: "auto-confirm@amazon.de") == "amazon")
        #expect(PartyMatch.domainLabel(of: "news@mail.shop.co.uk") == "shop")
        #expect(PartyMatch.domainLabel(of: "a@localhost") == nil)
        #expect(PartyMatch.isSender(party: "Courtbook", sender: sender("Booking", "no-reply@courtbook.example")))
    }

    @Test func whenUnsureItIsNot() {
        #expect(!PartyMatch.isSender(party: "", sender: sender("Amazon", "a@amazon.example")))
        #expect(!PartyMatch.isSender(party: "A", sender: sender("A Company", "a@a.example")))
        #expect(!PartyMatch.isSender(party: "Amazon", sender: nil))
        #expect(!PartyMatch.isSender(party: "GmbH", sender: sender("GmbH Shop", "x@y.example")))
    }
}
