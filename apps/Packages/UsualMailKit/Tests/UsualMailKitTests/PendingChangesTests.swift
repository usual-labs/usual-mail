import Foundation
import Testing

@testable import UsualMailKit

/// A number with a version, standing in for a thread or a record.
private struct Counter: Versioned, Equatable {
    var value: Int
    var version: Int
}

struct PendingChangesTests {
    private let add1: @Sendable (Counter) -> Counter = { Counter(value: $0.value + 1, version: $0.version) }
    private let double: @Sendable (Counter) -> Counter = { Counter(value: $0.value * 2, version: $0.version) }

    @Test func showsChangesOnTopOfTheServersCopy() {
        var pending = PendingChanges<Counter>()
        let a = UUID()
        let b = UUID()
        #expect(pending.add(add1, to: "x", current: Counter(value: 10, version: 1), token: a).value == 11)
        #expect(pending.add(double, to: "x", current: Counter(value: 11, version: 1), token: b).value == 22)
        #expect(pending.serverSent(Counter(value: 20, version: 2), for: "x") == Counter(value: 42, version: 2))
        #expect(pending.serverSent(Counter(value: 5, version: 1), for: "y") == Counter(value: 5, version: 1))
        #expect(pending.ids == ["x"])
    }

    @Test func anOlderServerCopyIsIgnored() {
        var pending = PendingChanges<Counter>()
        let a = UUID()
        _ = pending.add(add1, to: "x", current: Counter(value: 10, version: 3), token: a)
        #expect(pending.serverSent(Counter(value: 99, version: 2), for: "x") == Counter(value: 11, version: 3))
    }

    @Test func anAcceptedChangeTakesTheServersAnswer() {
        var pending = PendingChanges<Counter>()
        let a = UUID()
        _ = pending.add(add1, to: "x", current: Counter(value: 10, version: 1), token: a)
        // The server answers with the thing as it is now, which may differ from what the app expected.
        #expect(pending.accepted(a, for: "x", copy: Counter(value: 12, version: 2)) == Counter(value: 12, version: 2))
        #expect(!pending.isPending("x"))
        #expect(pending.accepted(a, for: "x", copy: nil) == nil)
        #expect(pending.serverSent(Counter(value: 30, version: 3), for: "x").value == 30)
    }

    @Test func anAnswerOlderThanAnEventKeepsTheEvent() {
        var pending = PendingChanges<Counter>()
        let a = UUID()
        _ = pending.add(add1, to: "x", current: Counter(value: 10, version: 1), token: a)
        _ = pending.serverSent(Counter(value: 50, version: 3), for: "x")  // an event after the action
        #expect(pending.accepted(a, for: "x", copy: Counter(value: 11, version: 2)) == Counter(value: 50, version: 3))
    }

    @Test func withoutACopyTheChangeJoinsTheConfirmedOne() {
        var pending = PendingChanges<Counter>()
        let a = UUID()
        _ = pending.add(add1, to: "x", current: Counter(value: 10, version: 1), token: a)
        #expect(pending.accepted(a, for: "x", copy: nil) == Counter(value: 11, version: 1))
    }

    @Test func aRefusedChangeIsDroppedAndTheRestStay() {
        var pending = PendingChanges<Counter>()
        let a = UUID()
        let b = UUID()
        _ = pending.add(add1, to: "x", current: Counter(value: 10, version: 1), token: a)
        _ = pending.add(double, to: "x", current: Counter(value: 11, version: 1), token: b)
        #expect(pending.refused(a, for: "x")?.value == 20)
        #expect(pending.isPending("x"))
        #expect(pending.refused(b, for: "x")?.value == 10)
        #expect(!pending.isPending("x"))
    }

    @Test func forgettingDropsEverything() {
        var pending = PendingChanges<Counter>()
        let a = UUID()
        _ = pending.add(add1, to: "x", current: Counter(value: 10, version: 1), token: a)
        pending.forget("x")
        #expect(pending.refused(a, for: "x") == nil)
        #expect(pending.ids.isEmpty)
    }
}
