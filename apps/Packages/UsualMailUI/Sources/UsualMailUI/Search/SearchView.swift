import SwiftUI
import UsualMailKit

/// The search page (docs/contract-search.md), in the wide card with the tabs hidden, as on the classic inbox: a field
/// with the focus, the chips, then the results as the person types (`SearchModel`): People first, then the threads
/// found on the classic inbox's lines with the matched words strong and the quiet word for where each lives, more on
/// scroll; then older mail in Gmail on a button (`RemoteSearchSection`). Before anything is typed, the operators in a
/// quiet line; with nothing found, "Nothing found". At the field's right end, Ask (`SearchAskButton`, ⌘↩) sends the
/// sentence to the server's AI; its answer fills the field and the chips and searches, and a quiet line says what
/// happened when it didn't help (`SearchAskNote`), offering the AI settings when the AI isn't set up.
///
/// Keys (`SearchKeys`): the arrows move the selection through the rows, Enter opens the selected row (or the first
/// thread), Esc clears the field and the filters, and a second Esc leaves, back to the stack it opened over, as it was.
/// They are the window's key equivalents, so they work while the field has the focus; the page's back capsule then
/// leaves only on a click (`TopBar`).
struct SearchView: View {
    @Bindable var model: SearchModel
    /// The active profile: the mail stack's when search is over it, else nil for every inbox.
    let inboxId: String?
    /// Rises when ⌘K asks for the field again.
    let focusRequest: Int
    let open: (String) -> Void
    let leave: () -> Void
    /// Settings, on its AI tab: the offer when asking needs the AI set up.
    let openAISettings: () -> Void
    @Environment(MailStore.self) private var store
    @FocusState private var fieldFocused: Bool
    @State private var keys = SearchKeys()

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            field
            SearchChipsRow(model: model)
            // A failed search says why below; the same words aren't said twice.
            SearchAskNote(outcome: askFailedWithSearch ? nil : model.askOutcome, openAISettings: openAISettings)
            results
        }
        .animation(Motion.reveal, value: model.askOutcome)
        .padding(.top, 18)
        .background { keyEquivalents }
        .revealOnAppear()
        .onAppear {
            model.service = store
            model.inboxes = store.lists.inboxes
            model.scope = inboxId
            // Back from a mail read from the results: ask again, as it may have changed.
            if model.requested != nil { model.refresh() }
            Task { fieldFocused = true }
        }
        .onChange(of: inboxId) { _, id in model.scope = id }
        .onChange(of: store.lists.inboxes) { _, inboxes in model.inboxes = inboxes }
        .onChange(of: focusRequest) { fieldFocused = true }
        .onChange(of: rows) { _, rows in keys.keep(in: rows) }
    }

    private var askFailedWithSearch: Bool {
        if case .failed = model.askOutcome, case .failed = model.phase { true } else { false }
    }

    private var rows: [SearchRow] {
        SearchKeys.rows(
            people: model.people, hits: model.hits, remote: model.remote.status == .answered ? model.remote.hits : [])
    }

    // MARK: The field

    private var field: some View {
        HStack(spacing: 8) {
            Icon.search.view(size: 14, tint: Theme.secondary)
            TextField("Search", text: $model.text, prompt: Text("Search every inbox"))
                .textFieldStyle(.plain)
                .font(Theme.sans(12))
                .foregroundStyle(Theme.ink)
                .focused($fieldFocused)
                .accessibilityLabel("Search")
            if model.phase == .searching && !model.isAsking {
                ProgressView().controlSize(.mini)
            }
            SearchAskButton(model: model)
        }
        .padding(.leading, 12)
        .padding(.trailing, 5)
        .frame(height: 32)
        .background(.white, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.hairline, lineWidth: 1))
        .padding(.horizontal, Theme.pageInset)
    }

    // MARK: The results

    private var results: some View {
        let dates = MailDate(now: store.now)
        let inboxes = store.lists.inboxes
        return ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    switch model.phase {
                    case .idle:
                        quiet(SearchWords.hint).padding(.top, 8)
                    case .failed(let words):
                        quiet(words).padding(.top, 8)
                    case .searching, .answered:
                        EmptyView()
                    }
                    if !model.people.isEmpty {
                        title("People")
                        ForEach(model.people) { person in
                            SearchPersonRow(person: person, selected: keys.selected == .person(person.email)) {
                                choose(person)
                            }
                            .id(SearchRow.person(person.email))
                        }
                    }
                    if !model.hits.isEmpty {
                        if !model.people.isEmpty { title("Mail") }
                        ForEach(model.hits) { hit in
                            SearchHitRow(
                                hit: hit, inbox: inboxes.first { $0.id == hit.thread.inboxId }, dates: dates,
                                now: store.now, selected: keys.selected == .thread(hit.id)
                            ) {
                                open(hit.id)
                            } act: { action in
                                // The undo strip says what happened; the results are asked again to show it.
                                Task {
                                    await store.perform(action, on: [hit.id])
                                    model.refresh()
                                }
                            }
                            .id(SearchRow.thread(hit.id))
                            .onAppear { if hit.id == model.hits.last?.id { model.loadMore() } }
                        }
                        if model.isLoadingMore {
                            ProgressView().controlSize(.small).frame(maxWidth: .infinity).padding(.vertical, 8)
                        }
                    } else if model.phase == .answered && model.people.isEmpty {
                        Text(SearchWords.nothingFound)
                            .font(Theme.sans(12))
                            .foregroundStyle(Theme.sectionTitle)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                    }
                    // Older mail: only once the local answer for what is typed is in, never as the person types.
                    if model.phase == .answered, model.offersRemote || model.remote.status != .offered {
                        RemoteSearchSection(model: model, dates: dates, selected: keys.selected, open: open)
                    }
                }
                .padding(.horizontal, Theme.pageInset)
                .padding(.bottom, 16)
            }
            .scrollIndicators(.never)
            .onChange(of: keys.selected) { _, row in
                if let row { withAnimation(Motion.move) { proxy.scrollTo(row) } }
            }
        }
    }

    private func title(_ words: String) -> some View {
        Text(words)
            .font(Theme.sans(12, weight: .semibold))
            .foregroundStyle(Theme.sectionTitle)
            .accessibilityAddTraits(.isHeader)
            .padding(.top, 12)
            .padding(.bottom, 4)
    }

    private func quiet(_ words: String) -> some View {
        Text(verbatim: words)
            .font(Theme.sans(10))
            .foregroundStyle(Theme.time)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Keys

    /// The arrows, Enter and Esc as the window's key equivalents, which come before the field's own handling of them.
    private var keyEquivalents: some View {
        ZStack {
            Button("") { keys.down(in: rows) }.keyboardShortcut(.downArrow, modifiers: [])
            Button("") { keys.up(in: rows) }.keyboardShortcut(.upArrow, modifiers: [])
            Button("") { enter() }.keyboardShortcut(.return, modifiers: [])
            Button("") { escape() }.keyboardShortcut(.cancelAction)
        }
        .buttonStyle(.plain)
        .opacity(0)
        .frame(width: 0, height: 0)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func enter() {
        switch keys.target(in: rows) {
        case .person(let email):
            if let person = model.people.first(where: { $0.email == email }) { choose(person) }
        case .thread(let id):
            open(id)
        case .remote(let id):
            guard let hit = model.remote.hits.first(where: { $0.id == id }) else { return }
            Task { if let thread = await model.open(hit) { open(thread) } }
        case nil:
            break
        }
    }

    private func escape() {
        switch SearchKeys.escape(hasQuery: model.hasQuery) {
        case .clear:
            keys.selected = nil
            model.clear()
            fieldFocused = true
        case .leave:
            leave()
        }
    }

    private func choose(_ person: SearchPerson) {
        keys.selected = nil
        model.choose(person)
        fieldFocused = true
    }
}
