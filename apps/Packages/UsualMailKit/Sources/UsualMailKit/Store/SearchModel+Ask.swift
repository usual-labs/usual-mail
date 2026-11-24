import Foundation

/// What came of a sentence asked of search (docs/contract-search.md, "Asking in a sentence"), beside the search it
/// led to. Every outcome but a cancelled ask ends in an ordinary search.
public enum SearchAskOutcome: Hashable, Sendable {
    /// The AI turned the sentence into filters: they show as chips, the rest of it in the field.
    case understood
    /// The AI answered but found nothing to filter by: the sentence was searched as typed.
    case searchedAsTyped
    /// The server's AI isn't set up: the sentence was searched as typed, and the AI's settings are offered.
    case aiNotSetUp
    /// The AI wasn't asked or didn't answer (paused, its key refused, its model unknown, out of credit, unavailable):
    /// the sentence was searched as typed; why, in the server's words when it gave them.
    case aiDidNotAnswer(AiState, detail: String?)
    /// Too many sentences this minute (`rate_limited`): the sentence was searched as typed, and Ask waits `seconds`
    /// (its `Retry-After`).
    case tooMany(seconds: Int)
    /// The server refused the sentence (`invalid`: empty or too long), in its words; what is typed was searched.
    case refused(String)
    /// Asking failed otherwise (no connection, the server's error), in words; what is typed was searched.
    case failed(String)
}

extension SearchModel {
    /// Whether Ask can be pressed: the field holds a sentence of 1 to 200 characters, none is on its way, and the
    /// server hasn't asked to wait.
    public var canAsk: Bool {
        !isAsking && askWaitsUntil == nil && SearchAskInput.accepts(SearchAskInput.oneLine(text))
    }

    /// What Ask sends: the sentence on one line, the profile's inbox (none for every inbox) and this device's time
    /// zone. Nothing else: the server sends the AI only the sentence and today's date.
    public var askInput: SearchAskInput {
        SearchAskInput(question: SearchAskInput.oneLine(text), inboxIds: scope.map { [$0] }, tz: timeZone())
    }

    /// Ask, on the person's explicit action only (the button or ⌘↩), never as they type: one request to the server's
    /// AI for the sentence in the field. The search being typed is dropped meanwhile; whatever the person changes next
    /// cancels the sentence (`changed`), and an answer for anything but the latest is dropped (the same `generation`
    /// typed searches use). The answer then shows as an ordinary search (`show`). Returns the request, for tests.
    @discardableResult
    public func ask() -> Task<Void, Never>? {
        guard canAsk, let service else { return nil }
        let input = askInput
        generation += 1
        let current = generation
        running?.cancel()
        running = nil
        askOutcome = nil
        isAsking = true
        asking = Task {
            do {
                let answer = try await service.askSearch(input)
                guard current == generation, isAsking else { return }
                show(answer)
            } catch {
                guard current == generation, isAsking, !(error is CancellationError) else { return }
                failedToAsk(error)
            }
        }
        return asking
    }

    /// An answer replaces the field and the filters with what the server understood (its text, and its kinds, from,
    /// to, subject, attachment, unread, after and before as chips; the profile stays the scope), then searches them
    /// at once as any search: `GET /v1/search` with `q` = its text and those filters.
    func show(_ answer: SearchAskResult) {
        finishAsking()
        var filters = answer.understood.filters
        filters.inboxIds = nil
        if filters.kinds?.isEmpty == true { filters.kinds = nil }
        batching = true
        text = answer.text
        self.filters = filters
        chosenPerson = nil
        batching = false
        changed(typing: false, force: true)
        askOutcome = Self.outcome(of: answer)
    }

    /// The sentence couldn't be asked: what is typed is searched as it stands, and why is said. Too many sentences
    /// (`rate_limited`) waits out `Retry-After` (a minute without one) before Ask can be pressed again.
    func failedToAsk(_ error: any Error) {
        finishAsking()
        let outcome: SearchAskOutcome
        if let seconds = Self.waitSeconds(error) {
            waitToAsk(seconds)
            outcome = .tooMany(seconds: seconds)
        } else if let apiError = error as? APIError, apiError.code == .invalid {
            outcome = .refused(Self.words(for: error))
        } else {
            outcome = .failed(Self.words(for: error))
        }
        changed(typing: false, force: true)
        askOutcome = outcome
    }

    /// What an answer's state means for the page.
    static func outcome(of answer: SearchAskResult) -> SearchAskOutcome {
        switch answer.ai {
        case .working: answer.found ? .understood : .searchedAsTyped
        case .notSetUp: .aiNotSetUp
        default: .aiDidNotAnswer(answer.ai, detail: answer.detail)
        }
    }

    /// Any change the person makes: what the last sentence said goes, and a sentence on its way is cancelled. True
    /// when one was, so what is shown now is searched (the search before it was dropped).
    @discardableResult
    func stopAsking() -> Bool {
        askOutcome = nil
        guard isAsking else { return false }
        asking?.cancel()
        finishAsking()
        return true
    }

    private func finishAsking() {
        isAsking = false
        asking = nil
    }

    /// Waits as long as the server said, then Ask can be pressed again.
    private func waitToAsk(_ seconds: Int) {
        let until = clock().addingTimeInterval(TimeInterval(seconds))
        askWaitsUntil = until
        askWaiting?.cancel()
        let sleep = self.sleep
        askWaiting = Task {
            do { try await sleep(.seconds(seconds)) } catch { return }
            if askWaitsUntil == until { askWaitsUntil = nil }
        }
    }
}
