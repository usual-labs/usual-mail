import SwiftUI

/// Titled sections laid flat (Home's New and Seen, Notifications' Today, Coming up and Earlier): each section's title,
/// then its rows, one item after another, so one lazy stack holds them all and the list's kept place is a row
/// (`keepsTopRow`). An empty section isn't there. An item's place in `items` is its place for the reveal's stagger
/// (`Motion.delay(at:)`), as each title and row was one place further in than the last.
struct TitledRows<Row: Identifiable> where Row.ID == String {
    enum Item: Identifiable {
        /// A section's title; `first` when nothing is above it.
        case title(String, first: Bool)
        case row(Row, section: String)

        var isTitle: Bool {
            if case .title = self { true } else { false }
        }

        /// A row that moves to another section (a mail read, from New to Seen) is another row there, going out of
        /// focus and coming in, as when each section was a stack of its own.
        var id: ListRowID {
            switch self {
            case .title(let title, _): .title(title)
            case .row(let row, let section): .row(row.id, section: section)
            }
        }
    }

    let items: [Item]

    /// The items' ids, in order.
    var ids: [ListRowID] { items.map(\.id) }

    init(_ sections: [(title: String, rows: [Row])]) {
        var items: [Item] = []
        for section in sections where !section.rows.isEmpty {
            items.append(.title(section.title, first: items.isEmpty))
            items += section.rows.map { .row($0, section: section.title) }
        }
        self.items = items
    }
}

/// `TitledRows` in a lazy stack with `scrollTargetLayout()`: each title in the sections' look (32 points from the
/// section above, as the stack's rows are 24 apart), each row as `row` makes it, each coming into focus one place
/// further into the list than the last. Each item is one view, not a choice of two: with a `switch` as its rows, a
/// list didn't come back to a kept row on its first screen (`scrollPosition(id:)`, `KeptPlaceTests`).
struct TitledRowsContent<Row: Identifiable, RowView: View>: View where Row.ID == String {
    let rows: TitledRows<Row>
    @ViewBuilder let row: (Row) -> RowView

    var body: some View {
        ForEach(Array(rows.items.enumerated()), id: \.element.id) { index, item in
            VStack(alignment: .leading, spacing: 0) {
                switch item {
                case .title(let title, let first):
                    Text(verbatim: title)
                        .font(Theme.sans(12, weight: .semibold))
                        .foregroundStyle(Theme.sectionTitle)
                        .frame(maxWidth: .infinity)
                        .accessibilityAddTraits(.isHeader)
                        .padding(.top, first ? 0 : 8)
                case .row(let shown, _):
                    row(shown)
                }
            }
            .revealOnAppear(delay: Motion.delay(at: index))
            // A title fades as its section comes and goes.
            .transition(item.isTitle ? .opacity : .blurReveal)
        }
    }
}
