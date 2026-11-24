// U+0000 in text a person or an agent gives the server: libSQL reads a stored text back only up to its first U+0000, so
// a draft holding one lost everything after it (and so did the mail it sent). It is taken out before it is stored.
// Mail from a mailbox loses it in the parser (mail/src/message/parse.ts).

import assert from "node:assert/strict";
import { test } from "node:test";
import { makeServer } from "./helpers.ts";

test("U+0000 is taken out of a draft's subject and body, so nothing after it is lost", async () => {
  const t = await makeServer();
  try {
    const { inbox } = await t.connect({ address: "me@nul.example" });
    const saved = await t.server.saveDraft(t.person, { inboxId: inbox.id, to: [{ email: "bo@people.example" }], subject: "Sub\u0000ject", body: "Before the NUL.\u0000After the NUL." });
    assert.deepEqual({ subject: saved.subject, body: saved.body }, { subject: "Subject", body: "Before the NUL.After the NUL." });
    const [listed] = (await t.server.listDrafts(t.person, { inboxId: inbox.id })).items;
    assert.deepEqual({ subject: listed!.subject, body: listed!.body }, { subject: "Subject", body: "Before the NUL.After the NUL." }, "read back from the store whole");
  } finally {
    await t.close();
  }
});
