# Apps: the search page (2026-11-20)

The Mac app's search page, over the server's search ([contract-search.md](../contract-search.md),
[server-search.md](server-search.md)). The rest of the app is in [apps.md](apps.md); what was seen running is in
[apps-runs.md](apps-runs.md). Built at the owner's request ("do step 1 and 2 first"), then step 3, asking in a sentence.

## Data layer (UsualMailKit)

- **Models:** `Models/Search.swift` (`SearchResult`, `SearchHit` = the full thread plus an optional `match` with
  `fields`, a highlighted `subject` and an `excerpt` of plain `Run`s; `SearchUnderstood`; `SearchPerson`) and
  `Models/RemoteSearch.swift` (`RemoteSearchResult`, `RemoteHit`, each inbox's state: `ok`, `unsupported`, `paused`,
  `needs_sign_in`, `provider_error`). `Models/BlockedSender.swift` decodes the sample's `blockedSenders`; Settings' Blocked
  tab shows them ([apps.md](apps.md)).
- **Calls:** `API/APIClient+Search.swift`: `GET /v1/search`, `GET /v1/search/remote` with the same parameters, `POST
  /v1/search/remote/:id/open` returning `ThreadDetail`. `tz` is always sent.
- **`SearchModel`** (`Store/SearchModel.swift`, `+Remote.swift`, `SearchText.swift`): owns the text, the chips and the
  profile's scope. It starts at 2 characters, waits 150 ms after typing, cancels the request before, and shows only the
  newest answer (a generation number checked after every await). It pages on `nextCursor`. Once a space follows an
  operator the server understood, the operator moves from the text into a chip without asking again. Remote search
  runs only from its button; a `rate_limited` answer waits out `Retry-After` (a minute without one). `SearchService`
  (`MailStore+Search.swift`) is the server or the sample.
- **Sample mode** searches the bundled sample in the app with a simple word-start match (`Sample/SampleSearch.swift`);
  operators and older mail need a server.

## The page (UsualMailUI `Search/`)

- **Opening and leaving** (the stacks of 2026-11-20, [apps.md](apps.md) Navigation): the rail's magnifier or ⌘K, from
  any stack, over it, leaving that stack's state untouched. The card widens, the field has focus, and "← {page}" names
  where the person was; it and the second Esc (the first clears the field and the chips) return there exactly. A mail
  opened from search goes back to the results. During search the magnifier is tinted and pressing it again returns to
  the results; a stack's button leaves search for that stack; a profile chosen meanwhile keeps search open in that
  profile, the mail stack underneath. Search's scope is the mail stack's profile over it, every inbox elsewhere.
- **Rows** (`SearchRows.swift`): the Inbox page's compact rows with the matched words in semibold, drawn from the runs
  as plain text (never parsed as markup), and a quiet word for where the mail lives (`SearchWords.swift`): Archived,
  Screening, Snoozed, To reply, Pinned, Home, Feed, Receipts, Notifications, and Inbox for one-time codes. An excerpt
  from somewhere other than the mail's text is labelled Summary, Details, Attachment, To or From. More load on scroll.
- **People** come first as a section; clicking one sets `from` to their address and clears the text.
- **Chips** (`SearchChips.swift`): a toggle for each category plus Screening and Archived (`done`); the server's
  understood filters show as removable chips.
- **Older mail** (`SearchRemote.swift`): "Search older mail in Gmail" after the local results, never while typing; IMAP
  inboxes and any that answer `unsupported` are left out. Each inbox's state shows: paused; sign in again (a sheet with
  the shared Google step, `SignInAgainSheet`, as `Shell/AddGmail.swift`; while the server has no Google client it
  shows the guided set-up of [apps-onboarding.md](apps-onboarding.md)); or the provider's error with Try again. Opening a hit brings the
  conversation in and shows the mail page; a done one offers "Move to Inbox".
- **Keyboard** (`SearchKeys.swift`): up and down move through people, mail and older mail; Enter opens the selection,
  or the first thread found.

## Ask in a sentence (step 3, 2026-11-20)

- **What it is:** the person writes a sentence and, only on an explicit action, the server's AI turns it into the
  filters typed operators give (`POST /v1/search/ask`: the sentence on one line, the profile's inbox, the device's
  time zone; the server sends the AI only the sentence and today's date). Kit: `Models/SearchAsk.swift`,
  `Store/SearchModel+Ask.swift`; page: `Search/SearchAsk.swift`.
- **The control:** a small glass capsule at the field's right end, the free set's `sparkles` and "Ask", ⌘↩; Enter still
  opens the selection. Disabled for an empty field, over 200 characters, while asking, or until a 429's `Retry-After`
  passes. Its tooltip (to its left) and VoiceOver hint carry the privacy line: "Ask in a sentence (⌘↩). Only the
  sentence goes to your AI service, never your mail."
- **While asking:** a small spinner and "Asking…"; the field stays editable and any change cancels the sentence; the
  typed search is dropped meanwhile, and only the newest answer counts (the same generation number).
- **An answer** replaces the field and the filters with what the server understood: its text, the kind toggles and
  the other filters as chips (dates as one period chip, "1–31 Oct 2026", `before` exclusive; an amount stays in the
  text), then one ordinary search. Removing a chip is an ordinary search; nothing is asked again.
- **Outcomes**, as a quiet line under the chips: none when understood; "Searched as typed"; AI not set up, with an "AI
  settings…" link to Settings' AI tab; the server's `detail` (paused, key refused, model not found, out of credit,
  unavailable); "try again shortly" on a 429. Every case still searches.
- **Sample mode** answers the sample's five `searchAsks` (matched ignoring case and spacing); any other sentence reads
  "Asking in a sentence needs your server, so this was searched as typed." The sample search applies `after`/`before`.

## Not verified

Typing, clicks, focus, the key handling, ⌘K, Ask, ⌘↩ and its progress are covered by tests of the models only (no pointer or keyboard in the
sessions). Whether an operator moving into a chip disturbs the caret while typing is the owner's to try.
