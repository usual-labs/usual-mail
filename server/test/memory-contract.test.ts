// The server's in-memory mailbox, held to mail's provider contract suite, so the stand-in the server's tests
// use behaves like the real providers. It runs in the shapes that send `changed`: like IMAP (one folder per message,
// so a screened message keeps no category), with and without renames on a move, and like Gmail (labels, so a
// screened message keeps its category's label).

import { attachmentContent, parseMessage } from "@usualmail/mail";
import { providerContract } from "@usualmail/mail/testing";
import type { ProviderPlacement } from "@usualmail/core";
import { MemoryMailbox, type MemoryMailboxOptions } from "../src/testing/index.ts";

const shapes: Array<[string, Partial<MemoryMailboxOptions>]> = [
  ["IMAP-like, flag and placement changes in changed", { sendChanges: true }],
  ["IMAP-like, changed, and a new ref on every move", { sendChanges: true, renameOnMove: true }],
  ["Gmail-like, labels, changed", { kind: "gmail", sendChanges: true }],
];

for (const [name, shape] of shapes) {
  providerContract(`MemoryMailbox (${name})`, async () => {
    const mailbox = new MemoryMailbox({ address: "me@memory.example", ...shape });
    const provider = mailbox.provider();
    const deliver = async (raw: string, placement?: Partial<ProviderPlacement>) => {
      const { fromSelf, ...parsed } = await parseMessage(raw, { ownAddresses: [mailbox.address] });
      const attachments = await Promise.all(parsed.attachments.map(async (file) => {
        const data = await attachmentContent(raw, file.id);
        return data ? { ...file, data } : file;
      }));
      mailbox.deliver({ ...parsed, attachments, seen: false, outgoing: fromSelf, ...(placement && { placement }) });
    };
    return {
      provider,
      address: mailbox.address,
      // The raw message is parsed by mail's own parser, so the fields are what a real provider would send.
      deliver: (raw) => deliver(raw),
      deliverFiled: async (raw, to) => {
        await deliver(raw, to === "spam" ? { inInbox: false, spam: true }
          : to === "archive" ? { inInbox: false }
          : to === "screening" ? { inInbox: false, screened: true }
          : { inInbox: false, category: to });
        return true;
      },
      removeExternally: async (messageId) => {
        const message = mailbox.messages().find((m) => m.messageId === messageId);
        if (!message) throw new Error(`No message ${messageId}`);
        mailbox.remove(message.ref);
      },
      takeOutOfSpam: async (messageId) => {
        const message = mailbox.messages().find((m) => m.messageId === messageId);
        if (!message) throw new Error(`No message ${messageId}`);
        mailbox.update(message.ref, { placement: { spam: false, inInbox: true } });
      },
      loseSyncPlace: async () => mailbox.loseCursor(),
      close: () => provider.close(),
    };
  });
}
