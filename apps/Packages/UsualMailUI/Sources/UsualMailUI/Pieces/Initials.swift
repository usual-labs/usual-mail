import Foundation

extension Avatar {
    /// A sender's initials, one or two characters (grapheme clusters), never more:
    ///
    /// - **Words** are split at spaces only, so a domain-like name is one word ("Amazon.de" is A, "x.com" X) and a
    ///   hyphenated one too ("Jean-Luc Picard" is JP). Emoji, symbols and punctuation at the start of a word are
    ///   skipped ("📦 DHL Paketankündigung" is DP, "*Sale* Store" SS), and a word with no letter or digit is left out.
    ///   An aside in brackets is left out unless nothing else is left ("Maya Kim (via Docs)" is MK).
    /// - **An address** is never read by its domain. A word with an "@" is left out when the name has other words; a
    ///   name that is only an address is read by its local part, where "+" starts a tag that is dropped, "." and "_"
    ///   separate words and "-" joins them: "maya.kim@studio.example" is MK, "no-reply@…" N, "maya+news@…" M.
    /// - **"Last, First"** reads as First Last when exactly one comma stands between parts that hold a name:
    ///   "Voigt, Christine" is CV. A part of only suffixes or titles is dropped first, never swapped in: "Smith, Jr." is
    ///   S, "Smith, John, Jr." JS. With more commas the words are read as written.
    /// - **Titles** (Dr, Prof, Mr, Mrs, Ms, Mx, Miss, Mme, Mlle, Herr, Frau, Dipl.-Ing., Dr.-Ing., Ing., Mag., Sir,
    ///   Dame; any case, with or without the dot) are left out wherever they stand: "Dr. Jacob" is J. A name of only
    ///   titles keeps them ("Dr." is D). **Suffixes** (Jr, Sr, II, III, IV, PhD, MD, Esq, and a company's Inc, LLC,
    ///   Ltd, GmbH, AG, Corp, Plc) are left out everywhere but as the first word.
    /// - **Particles** (de, del, della, der, den, di, da, du, la, le, van, von, zu, ten, ter, bin, binti, ibn, al,
    ///   el, y and the like) at the start are left out when written in lower case, since a capital first word is
    ///   usually a given name or a brand ("van Dijk" is D, "Al Gore" AG, "Y Combinator" YC). The last word is never
    ///   left out ("Da" alone is D, "Maya Le" ML), and a particle in the middle never counts anyway (the next rule).
    ///   An Arabic article joined by a hyphen (al-, el-, ad-, ar-, as-, ash-, at-, az-) gives the letter after it, in
    ///   any case: "Ahmed al-Rashid" is AR, "Al-Rashid" R; other hyphenated words keep their first letter.
    /// - **The initials** are the first letter of the first remaining word and of the last: "Maya de Kim" is MK,
    ///   "Ludwig van Beethoven" LB, "Иван Петров" ИП. A name in Chinese, Japanese or Korean script gives its first
    ///   character only ("山田太郎" and "山田 太郎" are 山): two such glyphs don't fit the 16-point circle.
    /// - **Capitals**: each letter is uppercased on its own and kept as it is when its capital is longer ("ß" stays ß,
    ///   never SS). Combining marks stay with their letter. A name with no letter or digit at all is "?".
    nonisolated static func initials(_ name: String) -> String {
        let words = NameWords.words(of: name)
        guard let first = words.first.map(NameWords.letter(of:)) else { return "?" }
        guard words.count > 1, !NameWords.isCJK(first), let last = words.last.map(NameWords.letter(of:)) else {
            return String(first)
        }
        return String([first, last])
    }
}

/// The steps behind `Avatar.initials`.
private enum NameWords {
    static let titles: Set<String> = [
        "dr", "dr-ing", "prof", "mr", "mrs", "ms", "mx", "miss", "mme", "mlle", "herr", "frau", "dipl-ing", "dipl",
        "ing", "mag", "sir", "dame",
    ]
    static let suffixes: Set<String> = [
        "jr", "sr", "ii", "iii", "iv", "phd", "md", "esq", "inc", "llc", "ltd", "gmbh", "ag", "corp", "plc",
    ]
    static let particles: Set<String> = [
        "de", "del", "della", "dei", "der", "den", "des", "di", "da", "das", "do", "dos", "du", "la", "le", "lo",
        "van", "von", "vom", "zu", "zum", "zur", "und", "ten", "ter", "bin", "binti", "bint", "ibn", "al", "el", "y",
    ]
    /// The Arabic article as it is joined to a name with a hyphen.
    static let articles: Set<String> = ["al", "el", "ad", "ar", "as", "ash", "at", "az"]

    /// The words the initials come from, in reading order, each starting with its letter or digit.
    static func words(of name: String) -> [Substring] {
        let tokens = withoutAsides(name).split(whereSeparator: \.isWhitespace)
        let rest = tokens.filter { !isAddress($0) }
        let onlyAnAddress = !rest.contains { $0.contains(where: isNameCharacter) }
        if onlyAnAddress, let address = tokens.first(where: isAddress) {
            return chosen(localWords(of: address))
        }
        return chosen(inReadingOrder(rest.joined(separator: " ")))
    }

    /// The first letter of a word, uppercased unless its capital is longer than one character; after an Arabic
    /// article joined by a hyphen, the letter that follows it.
    static func letter(of word: Substring) -> Character {
        var word = word
        if let hyphen = word.firstIndex(of: "-"), articles.contains(word[..<hyphen].lowercased()),
            let start = word[word.index(after: hyphen)...].firstIndex(where: isNameCharacter)
        {
            word = word[start...]
        }
        guard let letter = word.first else { return "?" }
        let capital = String(letter).uppercased()
        return capital.count == 1 ? Character(capital) : letter
    }

    /// Han, kana and Hangul.
    static func isCJK(_ character: Character) -> Bool {
        guard let scalar = character.unicodeScalars.first else { return false }
        if scalar.properties.isIdeographic { return true }
        switch scalar.value {
        case 0x1100...0x11FF, 0x3040...0x30FF, 0x3130...0x318F, 0x31F0...0x31FF, 0xA960...0xA97F, 0xAC00...0xD7FF,
            0xFF66...0xFFDC:
            return true
        default: return false
        }
    }

    /// A letter or a digit that can stand for a word. Not an emoji (a keycap "1️⃣" included), a symbol, punctuation,
    /// a combining mark on its own, a modifier letter such as "ʻ" or an invisible filler.
    static func isNameCharacter(_ character: Character) -> Bool {
        let scalars = character.unicodeScalars
        guard let scalar = scalars.first, !scalar.properties.isDefaultIgnorableCodePoint,
            !scalars.contains(where: { $0 == "\u{FE0F}" || $0 == "\u{20E3}" })
        else { return false }
        switch scalar.properties.generalCategory {
        case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .otherLetter, .decimalNumber: return true
        default: return false
        }
    }

    /// The name without asides in brackets, unless nothing would be left.
    private static func withoutAsides(_ name: String) -> String {
        var kept = ""
        var depth = 0
        for character in name {
            if character == "(" || character == "[" {
                depth += 1
                kept.append(" ")
            } else if (character == ")" || character == "]") && depth > 0 {
                depth -= 1
                kept.append(" ")
            } else if depth == 0 {
                kept.append(character)
            }
        }
        return kept.contains(where: isNameCharacter) ? kept : name
    }

    /// A word with a letter or digit before its last "@".
    private static func isAddress(_ token: Substring) -> Bool {
        guard let at = token.lastIndex(of: "@") else { return false }
        return token[..<at].contains(where: isNameCharacter)
    }

    /// An address's local part as words: a "+" tag dropped, split at "." and "_".
    private static func localWords(of address: Substring) -> [Substring] {
        let local = address[..<(address.lastIndex(of: "@") ?? address.endIndex)]
        let untagged = local.prefix { $0 != "+" }
        let kept = untagged.contains(where: isNameCharacter) ? untagged : local
        return kept.split { $0 == "." || $0 == "_" }
    }

    /// The words with "Last, First" turned round: comma-separated parts without a name (only suffixes or titles) are
    /// dropped, and when exactly two remain the second comes first.
    private static func inReadingOrder(_ text: String) -> [Substring] {
        let parts = text.split(separator: ",").map { $0.split(whereSeparator: \.isWhitespace) }
        let named = parts.filter { $0.contains(where: isNameWord) }
        if named.count == 2 { return named[1] + named[0] }
        return (named.isEmpty ? parts : named).flatMap { $0 }
    }

    /// Titles, then suffixes after the first word, then particles written in lower case at the start, left out.
    private static func chosen(_ tokens: [Substring]) -> [Substring] {
        var words = tokens.compactMap(trimmed)
        let untitled = words.filter { !titles.contains(plain($0)) }
        if !untitled.isEmpty { words = untitled }
        if let first = words.first {
            words = [first] + words.dropFirst().filter { !suffixes.contains(plain($0)) }
        }
        while words.count > 1, let first = words.first, first.first?.isLowercase == true,
            particles.contains(plain(first))
        {
            words.removeFirst()
        }
        return words
    }

    private static func isNameWord(_ token: Substring) -> Bool {
        guard let word = trimmed(token) else { return false }
        let key = plain(word)
        return !titles.contains(key) && !suffixes.contains(key)
    }

    /// The word from its first letter or digit, or nil without one.
    private static func trimmed(_ token: Substring) -> Substring? {
        token.firstIndex(where: isNameCharacter).map { token[$0...] }
    }

    /// The word as the lists above spell it: lower case, letters, digits and inner hyphens only ("Dipl.-Ing." is
    /// "dipl-ing", "Ph.D." "phd").
    private static func plain(_ word: Substring) -> String {
        let kept = word.lowercased().filter { $0.isLetter || $0.isNumber || $0 == "-" }
        return kept.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    }
}
