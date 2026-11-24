import Foundation

extension DraftInput {
    /// A reply in a thread's own inbox: to whoever wrote the newest message the inbox didn't send, in reply to that
    /// message. If the inbox sent every message, it goes to the people the newest one went to. The subject gets
    /// "Re: " unless it has one.
    public static func reply(to detail: ThreadDetail) -> DraftInput {
        let thread = detail.thread
        let incoming = detail.messages.last { !$0.outgoing }
        let newest = incoming ?? detail.messages.last
        let to: [Address] =
            if let incoming { [incoming.from] } else { newest.map { $0.to + $0.cc } ?? thread.participants }
        let subject = newest?.subject ?? thread.subject
        return DraftInput(
            inboxId: thread.inboxId, threadId: thread.id, inReplyToMessageId: newest?.id, to: to,
            subject: replySubject(subject), body: "")
    }

    /// A reply to everyone, in the thread's own inbox: to whoever wrote the newest message the inbox didn't send and
    /// everyone that message went to, with its Cc kept as Cc. The inbox's own address (`ownAddress`) and anyone named
    /// twice are left out. If the inbox sent every message, it goes to the newest one's To, Cc kept.
    public static func replyAll(to detail: ThreadDetail, ownAddress: String?) -> DraftInput {
        var input = reply(to: detail)
        let incoming = detail.messages.last { !$0.outgoing }
        guard let answered = incoming ?? detail.messages.last else { return input }
        var named: Set<String> = ownAddress.map { [$0.lowercased()] } ?? []
        func once(_ list: [Address]) -> [Address] {
            list.filter { named.insert($0.email.lowercased()).inserted }
        }
        let to = once(incoming == nil ? answered.to : [answered.from] + answered.to)
        let cc = once(answered.cc)
        input.to = to
        input.cc = cc.isEmpty ? nil : cc
        return input
    }

    /// A saved draft, to change and save again under its own id.
    public init(editing draft: Draft) {
        self.init(
            id: draft.id, inboxId: draft.inboxId, threadId: draft.threadId,
            inReplyToMessageId: draft.inReplyToMessageId, to: draft.to, cc: draft.cc, bcc: draft.bcc,
            subject: draft.subject, body: draft.body)
    }

    /// "Re: " and the subject, unless it already starts with "Re:".
    static func replySubject(_ subject: String) -> String {
        subject.lowercased().hasPrefix("re:") ? subject : "Re: \(subject)"
    }
}
