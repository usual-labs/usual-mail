/** The shared provider contract, run against the Gmail provider talking to the fake Gmail API. */
import { createGmailProvider } from "../../src/index.ts";
import { DEFAULT_NAMES } from "../../src/names.ts";
import { FakeGmail, providerContract } from "../../src/testing/index.ts";

providerContract("Gmail against the fake API", async () => {
  const address = "me@mail.example";
  const fake = new FakeGmail({ address });
  const provider = createGmailProvider(fake.credentials, { fetch: fake.fetch, quotaPerSecond: 1_000_000 });
  return {
    provider,
    address,
    deliver: async (raw) => {
      await fake.deliver(raw);
    },
    removeExternally: async (messageId) => {
      const message = fake.mailbox.findByMessageId(messageId);
      if (!message) throw new Error(`No message ${messageId} in the fake mailbox`);
      fake.mailbox.delete(message.id);
    },
    loseSyncPlace: async () => {
      fake.expireHistory();
    },
    // A Gmail filter that skips the inbox, labels a pile, or sends to spam.
    deliverFiled: async (raw, to) => {
      const name = to === "archive" || to === "spam" ? undefined : DEFAULT_NAMES[to];
      const label = name && ([...fake.mailbox.labels.values()].find((l) => l.name === name) ?? fake.mailbox.createLabel(name, {}));
      await fake.deliver(raw, ["UNREAD", ...(to === "spam" ? ["SPAM"] : []), ...(label ? [label.id] : [])]);
      return true;
    },
    // "Not spam" in Gmail: SPAM off, INBOX on.
    takeOutOfSpam: async (messageId) => {
      const message = fake.mailbox.findByMessageId(messageId);
      if (!message) throw new Error(`No message ${messageId} in the fake mailbox`);
      fake.mailbox.modify(message, ["INBOX"], ["SPAM"]);
    },
    secrets: [fake.clientSecret, fake.refreshToken],
    close: () => provider.close(),
  };
});
