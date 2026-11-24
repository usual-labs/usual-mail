import Foundation
import Testing
import UsualMailKit

@testable import UsualMailUI

/// A sender's initials and colour (`Avatar`): the rules in `Avatar.initials`, case by case, and a colour that stays
/// with a sender across their threads.
struct AvatarTests {
    /// Cases from before the rules changed that still hold.
    static let stillTrue: [(String, String)] = [
        ("Maya Kim", "MK"), ("Fieldnotes", "F"), ("maya@studio.example", "M"), ("maya kim", "MK"),
    ]

    /// A domain never gives a letter: a domain-like name is one word, and an address is read by its local part, where
    /// "+" starts a tag that is dropped, "." and "_" separate words and "-" joins them.
    static let domainsAndAddresses: [(String, String)] = [
        ("Amazon.de", "A"), ("foo.io", "F"), ("x.com", "X"), ("Amazon.de Kundenservice", "AK"),
        ("maya.kim@studio.example", "MK"), ("info@venue.example", "I"), ("no-reply@music.example", "N"),
        ("maya_kim@studio.example", "MK"), ("maya+news@studio.example", "M"), ("jean-luc.picard@studio.example", "JP"),
        ("MAYA.KIM@STUDIO.EXAMPLE", "MK"), ("<maya.kim@studio.example>", "MK"), ("dr.jacob.weiss@clinic.example", "JW"),
        ("Maya Kim <maya@studio.example>", "MK"), ("Maya Kim maya.kim@studio.example", "MK"),
    ]

    /// Titles go wherever they stand, in any case, with or without the dot; a name of only titles keeps them.
    static let titles: [(String, String)] = [
        ("Dr. Jacob", "J"), ("Dr. Jacob Weiss", "JW"), ("Dr Jacob Weiss", "JW"), ("dr. jacob weiss", "JW"),
        ("DR. JACOB WEISS", "JW"), ("Prof. Dr. Anna Berg", "AB"), ("Mr. John Smith", "JS"), ("Mrs Jane Smith", "JS"),
        ("Ms. Jane Smith", "JS"), ("Mx Sam Lee", "SL"), ("Herr Max Müller", "MM"), ("Frau Erika Mustermann", "EM"),
        ("Dipl.-Ing. Max Müller", "MM"), ("Dipl.-Ing Max Müller", "MM"), ("Ing. Jan Novák", "JN"),
        ("Mag. Eva Huber", "EH"), ("Sir Paul Smith", "PS"), ("Dame Judi Dench", "JD"), ("Dr.", "D"),
    ]

    /// Particles before the surname go: at the start only in lower case, never as the last word. "al-", "el-" and the
    /// article's other spellings joined by a hyphen give the letter after the hyphen.
    static let particles: [(String, String)] = [
        ("Maya de Kim", "MK"), ("Ludwig van Beethoven", "LB"), ("van Dijk", "D"), ("Da", "D"), ("da", "D"),
        ("de la Cruz", "C"), ("van der Berg", "B"), ("von Trapp", "T"), ("bin Salman", "S"), ("al Rashid", "R"),
        ("Dr. van Dijk", "D"), ("Pedro Sánchez y Pérez", "PP"), ("Maya Le", "ML"),
        // A capital first word is a given name or a brand, not a particle.
        ("Al Gore", "AG"), ("Van Morrison", "VM"), ("Y Combinator", "YC"),
        ("al-Rashid", "R"), ("Al-Rashid", "R"), ("Ahmed al-Rashid", "AR"), ("Mona el-Sayed", "MS"),
        ("Salah ad-Din", "SD"), ("Jean-Luc Picard", "JP"), ("Kim Da-Hye", "KD"),
    ]

    /// "Last, First" reads as First Last with exactly one comma between parts that hold a name; a part of only suffixes
    /// is dropped, never swapped in. Suffixes go everywhere but as the first word.
    static let commasAndSuffixes: [(String, String)] = [
        ("Voigt, Christine", "CV"), ("Kim,Maya", "MK"), ("Петров, Иван", "ИП"), ("Beethoven, Ludwig van", "LB"),
        ("Weiss, Dr. Jacob", "JW"), ("Smith, Jr.", "S"), ("Smith, John, Jr.", "JS"), ("John Smith, Jr.", "JS"),
        ("Kim, Maya, PhD", "MK"), ("Maya Kim, MD", "MK"), ("Kim, Maya, Lee", "KL"), ("Kim,", "K"),
        ("Smith Jr.", "S"), ("John Smith III", "JS"), ("Jr.", "J"), ("Acme, Inc.", "A"), ("Example GmbH", "E"),
        ("Deutsche Bahn AG", "DB"),
    ]

    /// Emoji, symbols and punctuation at the start of a name or a word are skipped; asides in brackets are left out;
    /// a letter whose capital is longer stays as it is.
    static let glyphs: [(String, String)] = [
        ("📦 DHL Paketankündigung", "DP"), ("*Sale* Store", "SS"), ("Maya Kim 🎉", "MK"), ("\"Maya Kim\"", "MK"),
        ("— Maya Kim", "MK"), ("Barnes & Noble", "BN"), ("1️⃣ Deals", "D"), ("37signals", "3"),
        ("Maya Kim (via Docs)", "MK"), ("Kim, Maya [Studio]", "MK"), ("(Docs)", "D"), ("Anna Maria Lopez", "AL"),
        ("ß", "ß"), ("ßtudio", "ß"), ("ﬁona lee", "ﬁL"), ("Straße Kim", "SK"),
    ]

    /// Nothing to take a letter from: the neutral "?".
    static let neutral: [String] = ["", "   ", "🎉", "***", "@", "🇩🇪 ✈️", "ㅤ", "(  )"]

    /// Other scripts: CJK gives one character, other spaced names the first and last, marks stay with their letter.
    static let scripts: [(String, String)] = [
        ("山田太郎", "山"), ("김민준", "김"), ("王小明", "王"), ("山田 太郎", "山"), ("김 민준", "김"), ("やまだ たろう", "や"),
        ("Иван Петров", "ИП"), ("иван петров", "ИП"), ("محمد علي", "مع"), ("דוד לוי", "דל"),
        ("Γιώργος Παπαδόπουλος", "ΓΠ"), ("γιώργος παπαδόπουλος", "ΓΠ"), ("राहुल शर्मा", "राश"),
        ("e\u{301}mile zola", "E\u{301}Z"), ("Émile Zola", "ÉZ"), ("Øyvind Åsen", "ØÅ"), ("łukasz nowak", "ŁN"),
    ]

    static let all = stillTrue + domainsAndAddresses + titles + particles + commasAndSuffixes + glyphs + scripts

    @Test(arguments: stillTrue) func casesFromBeforeStillHold(name: String, initials: String) {
        #expect(Avatar.initials(name) == initials)
    }

    @Test(arguments: domainsAndAddresses) func aDomainNeverGivesALetter(name: String, initials: String) {
        #expect(Avatar.initials(name) == initials)
    }

    @Test(arguments: titles) func titlesAreSkipped(name: String, initials: String) {
        #expect(Avatar.initials(name) == initials)
    }

    @Test(arguments: particles) func particlesBeforeTheSurnameAreSkipped(name: String, initials: String) {
        #expect(Avatar.initials(name) == initials)
    }

    @Test(arguments: commasAndSuffixes) func lastCommaFirstReadsAsFirstLast(name: String, initials: String) {
        #expect(Avatar.initials(name) == initials)
    }

    @Test(arguments: glyphs) func symbolsAreSkippedAndCapitalsNeverGrow(name: String, initials: String) {
        #expect(Avatar.initials(name) == initials)
    }

    @Test(arguments: neutral) func aNameWithoutLettersOrDigitsIsAQuestionMark(name: String) {
        #expect(Avatar.initials(name) == "?")
    }

    @Test(arguments: scripts) func otherScriptsKeepWorking(name: String, initials: String) {
        #expect(Avatar.initials(name) == initials)
    }

    /// One or two characters (grapheme clusters), whatever the name.
    @Test(arguments: all.map(\.0) + neutral) func neverMoreThanTwoGlyphs(name: String) {
        let initials = Avatar.initials(name)
        #expect((1...2).contains(initials.count))
    }

    @Test func combiningMarksStayWithTheirLetter() {
        let initials = Avatar.initials("e\u{301}mile zola")
        #expect(initials.count == 2)
        #expect(initials.unicodeScalars.map(\.value) == [0x45, 0x301, 0x5A])
        #expect(Avatar.initials("राहुल").unicodeScalars.map(\.value) == [0x930, 0x93E])
    }

    // MARK: The colour

    @MainActor @Test func aSenderKeepsTheirColoursWhateverTheCaseOfTheAddress() {
        #expect(Avatar.colors(for: "maya@studio.example") == Avatar.colors(for: "MAYA@studio.example"))
        let used = Set(
            SampleData.bundled.threads.flatMap(\.participants).map {
                Avatar.palette.firstIndex(of: Avatar.colors(for: $0.email))!
            })
        #expect(used.count > 1)
    }

    @Test func aSenderWithAnAddressIsColouredByIt() {
        let lunch = thread("thr_a", subject: "Lunch", from: Address(name: "Maya Kim", email: "Maya@Studio.example"))
        #expect(key(lunch) == "maya@studio.example")
        // Without participants, the thread's own sender address.
        let bare = MailThread(
            id: "thr_b", inboxId: "inb_1", subject: "Hi", lastMessageAt: .now, sender: "maya@x.example")
        #expect(key(bare) == "maya@x.example")
    }

    @MainActor @Test func aSenderWithoutAnAddressKeepsOneColourByName() {
        let lunch = thread("thr_a", subject: "Lunch on Friday", from: Address(name: "Maya Kim", email: ""))
        let dinner = thread("thr_b", subject: "Dinner", from: Address(name: "MAYA KIM", email: " "))
        #expect(key(lunch) == "maya kim")
        #expect(key(lunch) == key(dinner))
        #expect(Avatar.colors(for: key(lunch)) == Avatar.colors(for: key(dinner)))
    }

    @MainActor @Test func withNeitherAddressNorNameTheSubjectNeverTheId() {
        let lunch = MailThread(id: "thr_a", inboxId: "inb_1", subject: "Lunch", lastMessageAt: .now)
        let nameless = thread("thr_b", subject: "Lunch", from: Address(email: ""))
        #expect(key(lunch) == "lunch")
        #expect(key(nameless) == "lunch")
        #expect(Avatar.colors(for: key(lunch)) == Avatar.colors(for: key(nameless)))
    }

    private func thread(_ id: String, subject: String, from sender: Address) -> MailThread {
        MailThread(id: id, inboxId: "inb_1", subject: subject, participants: [sender], lastMessageAt: .now)
    }

    /// The key as Home, Screening and the feed pass it.
    private func key(_ thread: MailThread) -> String {
        Avatar.key(for: HomeWords.sender(of: thread, inbox: nil), in: thread)
    }
}
