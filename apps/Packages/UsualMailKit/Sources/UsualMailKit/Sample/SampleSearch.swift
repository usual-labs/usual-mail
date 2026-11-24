import Foundation

/// The sample mode's stand-in for `GET /v1/search` (`-UsualMailSample YES`, no server), so the search page can be
/// looked at: a plain reading of the bundled sample, not the server's index. Every word of the text (two characters or
/// more as a word's start, one character whole; case and accents aside) must start a word of the thread's subject,
/// senders, other people, summary, facts, attachment names or messages. The kinds, inboxes, `from`, `unread`,
/// `hasAttachment`, `after` and `before` filters hold (the dates by the thread's newest mail); other filters and typed
/// operators aren't read (an operator is two words here). Newest first, without ranking; people as the server picks
/// them. Older mail in the mailbox isn't searched. A sentence asked is answered only when it is one of the sample's
/// (`ask`).
struct SampleSearch {
    let data: SampleData

    func result(_ parameters: [String: String]) -> SearchResult {
        let text = parameters["q"] ?? ""
        let terms = Self.words(text)
        let filters = Self.filters(parameters)
        var hits: [SearchHit] = []
        for thread in data.threads where !thread.trashed && holds(filters, thread) {
            let fields = self.fields(of: thread)
            if terms.isEmpty {
                hits.append(SearchHit(thread: thread))
                continue
            }
            let matched = fields.filter { field in terms.contains { term in Self.has(term, in: field.text) } }
            let found = terms.allSatisfy { term in fields.contains { Self.has(term, in: $0.text) } }
            guard found else { continue }
            let subject = matched.first { $0.field == .subject }.map { Self.runs($0.text, terms: terms) }
            // As the server picks it: the first of body, summary, facts, attachments, people and sender that matched.
            let excerpt = Self.excerptOrder.lazy.compactMap { field in matched.first { $0.field == field } }.first.map {
                SearchExcerpt(field: $0.field, runs: Self.excerpt($0.text, terms: terms))
            }
            hits.append(
                SearchHit(
                    thread: thread,
                    match: SearchMatch(fields: matched.map(\.field), subject: subject, excerpt: excerpt)))
        }
        hits.sort { ($0.thread.lastMessageAt, $0.id) > ($1.thread.lastMessageAt, $1.id) }
        let start = min(parameters["cursor"].flatMap { Int($0.dropFirst()) } ?? 0, hits.count)
        let end = min(start + (parameters["limit"].flatMap(Int.init) ?? 50), hits.count)
        let people = start == 0 && !terms.isEmpty ? self.people(terms, inboxes: filters.inboxIds) : nil
        return SearchResult(
            items: Array(hits[start..<end]), nextCursor: end < hits.count ? "s\(end)" : nil,
            understood: SearchUnderstood(filters: filters, text: text), people: people)
    }

    static let excerptOrder: [SearchField] = [.body, .summary, .facts, .attachments, .people, .sender]

    // MARK: Filters

    static func filters(_ parameters: [String: String]) -> SearchFilters {
        let list = { (name: String) in parameters[name].map { $0.split(separator: ",").map(String.init) } }
        return SearchFilters(
            inboxIds: list("inboxIds"), kinds: list("kinds")?.map(SearchKind.init(rawValue:)), from: parameters["from"],
            hasAttachment: parameters["hasAttachment"].map { $0 == "true" },
            after: parameters["after"].flatMap(MailJSON.parseTime),
            before: parameters["before"].flatMap(MailJSON.parseTime),
            unread: parameters["unread"].map { $0 == "true" })
    }

    private func holds(_ filters: SearchFilters, _ thread: MailThread) -> Bool {
        if let ids = filters.inboxIds, !ids.contains(thread.inboxId) { return false }
        if let kinds = filters.kinds {
            let categories = kinds.compactMap { if case .category(let category) = $0 { category } else { nil } }
            if !categories.isEmpty, !categories.contains(thread.category.listed) { return false }
            if kinds.contains(.screened), !thread.screened { return false }
            if kinds.contains(.done), !thread.done { return false }
        }
        if let unread = filters.unread, thread.unread != unread { return false }
        if let has = filters.hasAttachment, thread.hasAttachments != has { return false }
        if let after = filters.after, thread.lastMessageAt < after { return false }
        if let before = filters.before, thread.lastMessageAt >= before { return false }
        if let from = filters.from?.lowercased() {
            let senders = incoming(thread).map(\.from)
            let terms = Self.words(from)
            guard
                senders.contains(where: { sender in
                    sender.email.lowercased() == from
                        || terms.allSatisfy { Self.has($0, in: "\(sender.name ?? "") \(sender.email)") }
                })
            else { return false }
        }
        return true
    }

    // MARK: Asking

    /// The sample mode's stand-in for `POST /v1/search/ask`, which needs the server's AI: one of the sample's sentences
    /// (`searchAsks`, the same words, case and spacing aside) answers as the sample says; any other comes back as the
    /// server answers a sentence its AI couldn't help with, the sentence as typed, saying that asking needs a server.
    func ask(_ input: SearchAskInput) -> SearchAskResult {
        let question = SearchAskInput.oneLine(input.question)
        let same = { (asked: String) in SearchAskInput.oneLine(asked).lowercased() == question.lowercased() }
        if let known = data.searchAsks.first(where: { same($0.question) }) { return known.answer }
        return SearchAskResult(
            understood: SearchUnderstood(text: question), text: question, found: false, ai: .unavailable,
            detail: Self.askNeedsServer)
    }

    static let askNeedsServer = "Asking in a sentence needs your server, so this was searched as typed."

    // MARK: Fields

    private func incoming(_ thread: MailThread) -> [Message] {
        data.messages.filter { $0.threadId == thread.id && !$0.outgoing }.sorted { $0.date > $1.date }
    }

    private func fields(of thread: MailThread) -> [(field: SearchField, text: String)] {
        let messages = data.messages.filter { $0.threadId == thread.id }.sorted { $0.date > $1.date }
        let senders = incoming(thread).map { "\($0.from.name ?? "") \($0.from.email)" }
        let people = messages.flatMap { $0.to + $0.cc }.map { "\($0.name ?? "") \($0.email)" }
        let facts = [
            thread.payment?.party, thread.payment?.what, thread.event?.status, thread.event?.about,
        ].compactMap { $0 }
        let all: [(SearchField, String)] = [
            (.subject, thread.subject), (.sender, Self.unique(senders).joined(separator: ", ")),
            (.people, Self.unique(people).joined(separator: ", ")), (.summary, thread.summary ?? ""),
            (.facts, facts.joined(separator: " · ")),
            (
                .attachments,
                messages.flatMap(\.attachments).filter { !$0.inline }.map(\.filename).joined(separator: ", ")
            ),
            (
                .body,
                messages.map { $0.plainText.split(whereSeparator: \.isNewline).joined(separator: " ") }.joined(
                    separator: " ")
            ),
        ]
        return all.filter { !$0.1.isEmpty }.map { (field: $0.0, text: $0.1) }
    }

    private func people(_ terms: [String], inboxes: [String]?) -> [SearchPerson] {
        let own = Set(data.inboxes.map { $0.address.lowercased() })
        var found: [String: SearchPerson] = [:]
        for message in data.messages.sorted(by: { $0.date < $1.date }) where !message.outgoing {
            let email = message.from.email.lowercased()
            guard !own.contains(email), inboxes?.contains(message.inboxId) ?? true,
                let thread = data.threads.first(where: { $0.id == message.threadId }), !thread.trashed,
                terms.allSatisfy({ Self.has($0, in: "\(message.from.name ?? "") \(email)") })
            else { continue }
            var person = found[email] ?? SearchPerson(email: email, threads: 0, lastMessageAt: message.date)
            person.name = message.from.name ?? person.name
            person.lastMessageAt = max(person.lastMessageAt, message.date)
            found[email] = person
        }
        for email in Array(found.keys) {
            let threads = Set(
                data.messages.filter {
                    !$0.outgoing && $0.from.email.lowercased() == email && (inboxes?.contains($0.inboxId) ?? true)
                }.map(\.threadId))
            found[email]?.threads = data.threads.filter { threads.contains($0.id) && !$0.trashed }.count
        }
        return found.values.sorted { ($0.threads, $0.lastMessageAt) > ($1.threads, $1.lastMessageAt) }
            .prefix(5).map { $0 }
    }

    // MARK: Words

    /// Folded: lower case, accents off, ß as ss.
    static func fold(_ text: String) -> String {
        text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil).replacingOccurrences(
            of: "ß", with: "ss")
    }

    /// The text's words, folded.
    static func words(_ text: String) -> [String] {
        fold(text).split { !$0.isLetter && !$0.isNumber }.map(String.init)
    }

    /// Whether a word of `text` starts with `term` (two characters or more), or is it (one character).
    static func has(_ term: String, in text: String) -> Bool {
        words(text).contains { matches(term, $0) }
    }

    static func matches(_ term: String, _ word: String) -> Bool {
        term.count >= 2 ? word.hasPrefix(term) : word == term
    }

    /// The text cut into words and what is between them, the words a term matches marked.
    static func runs(_ text: String, terms: [String]) -> [SearchRun] {
        var runs: [SearchRun] = []
        var piece = ""
        var inWord = false
        func flush() {
            guard !piece.isEmpty else { return }
            let match = inWord && terms.contains { matches($0, fold(piece)) }
            if let last = runs.last, last.match == match {
                runs[runs.count - 1].text += piece
            } else {
                runs.append(SearchRun(piece, match: match))
            }
            piece = ""
        }
        for character in text {
            let word = character.isLetter || character.isNumber
            if word != inWord { flush() }
            inWord = word
            piece.append(character)
        }
        flush()
        return runs
    }

    /// About 200 characters around the first match, cut ends marked "…".
    static func excerpt(_ text: String, terms: [String]) -> [SearchRun] {
        let all = runs(text, terms: terms)
        guard let first = all.firstIndex(where: \.match) else { return all }
        let before = all[..<first].map(\.text).joined()
        let start = before.count > 60 ? "…" + String(before.suffix(60)) : before
        var runs = [SearchRun(start)] + all[first...]
        var length = 0
        for (index, run) in runs.enumerated() {
            length += run.text.count
            if length > 200 {
                runs[index].text = String(run.text.prefix(run.text.count - (length - 200))) + "…"
                runs = Array(runs[...index])
                break
            }
        }
        return runs.filter { !$0.text.isEmpty }
    }

    private static func unique(_ values: [String]) -> [String] {
        var seen = Set<String>()
        return values.filter { seen.insert($0.lowercased()).inserted }
    }
}

/// The sample mode's transport: `GET /v1/search` and `POST /v1/search/ask` answered from the sample (`SampleSearch`),
/// everything else offline, as the sample reads.
struct SampleTransport: HTTPTransport {
    let data: SampleData

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        guard let url = request.url else { throw URLError(.notConnectedToInternet) }
        let body: Data
        switch (request.httpMethod, url.path) {
        case ("GET", "/v1/search"):
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            let parameters = Dictionary(items.map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { _, last in last })
            body = try MailJSON.encoder().encode(SampleSearch(data: data).result(parameters))
        case ("POST", "/v1/search/ask"):
            let input = try MailJSON.decoder().decode(SearchAskInput.self, from: request.httpBody ?? Data())
            body = try MailJSON.encoder().encode(SampleSearch(data: data).ask(input))
        default:
            throw URLError(.notConnectedToInternet)
        }
        let response = HTTPURLResponse(
            url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        return (body, response)
    }

    func stream(for request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, any Error>) {
        throw URLError(.notConnectedToInternet)
    }
}
