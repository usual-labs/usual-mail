import Foundation

// The gallery's content: core/fixtures/sample.json with every label already written by the generator, so the
// SwiftUI and HTML galleries show the same words. The values are in Generated/GallerySample.swift.

struct GalleryContent: Sendable {
    let inboxes: [GalleryInbox]
    let brief: GalleryBrief
    let rows: [GalleryRow]
    let reasons: [GalleryReason]
    let typeSamples: [UsualTextRole: String]
}

struct GalleryInbox: Identifiable, Sendable {
    let name: String
    let address: String
    /// Inbox.color as the fixture stores it.
    let stored: String
    /// The hat the generator matched it to. `UsualHat.matching(hex:)` must agree; a test checks.
    let hat: String
    /// Inbox.icon: its icon in the profile switch.
    let icon: UsualIcon
    let trust: String
    let trustIcon: UsualIcon
    let attention: String?
    var id: String { address }
}

struct GalleryBrief: Sendable {
    let title: String
    let period: String
    let writtenBy: String
    let sections: [GalleryBriefSection]
}

struct GalleryBriefSection: Identifiable, Sendable {
    let hat: String
    let inbox: String
    let summary: String?
    let highlights: [GalleryHighlight]
    let counts: String
    var id: String { inbox }
}

struct GalleryHighlight: Identifiable, Sendable {
    let line: String
    let subject: String
    var id: String { line }
}

struct GalleryRow: Identifiable, Sendable {
    let id: String
    let hat: String
    let inbox: String
    let sender: String
    let subject: String
    /// The thread's summary, or its snippet while it has none.
    let snippet: String
    let time: String
    let messageCount: Int
    let unread: Bool
    let attachment: Bool
    let done: Bool
    /// The thread's category, as lists name it.
    let category: String
    let stack: String?
    let stackIcon: UsualIcon?
    let comeBack: String?
    let selected: Bool
}

struct GalleryReason: Identifiable, Sendable {
    let id: String
    let hat: String
    let inbox: String
    let subject: String
    let icon: UsualIcon
    let actor: String
    let action: String
    let reason: String?
    let time: String
    /// An ActionRecord state: applied, proposed, undone, rejected or failed.
    let state: String
    let undoable: Bool
}
