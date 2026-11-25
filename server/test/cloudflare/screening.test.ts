// Senders let in without the AI on the Cloudflare host (docs/contract.md, "Letting a sender in"; the owner's decision of
// 2026-11-25), in workerd against the fake Gmail outside the isolate: a colleague at the inbox's own domain whose mail
// Gmail's own checker proved (its Authentication-Results on top) is let in and isn't screened; one whose From nothing
// proved is screened. The same shared code as Node's (src/sync/let-in.ts); the AI's part of the gate is shared too and
// tested on Node, since this host's tests have no fake models.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { plainMessage } from "../../../mail/src/testing/index.ts";
import { ADDRESS, connectGmail, startServer, until, type TestServer } from "./harness.ts";

let server: TestServer;
let token = "";

before(async () => {
  server = await startServer();
  token = (await server.pair()).token;
});

after(async () => {
  await server?.stop();
});

/** Gmail's own checker's result on top: an aligned DMARC pass for the From domain. */
const PROVED = "mx.google.com; dkim=pass header.i=@mail.example header.s=s1 header.b=AbCd1234; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=mail.example";

test("a colleague proved by Gmail is let in; a From nothing proved is screened", async () => {
  const inbox = await connectGmail(server, token);
  await until("the first sync", async () => (await server.call("GET", "/v1/inboxes", undefined, token)).body[0]?.status === "ok");
  await server.fake.deliver(plainMessage({ from: "Ann <ann@mail.example>", to: ADDRESS, subject: "Colleague proved", body: "Lunch on Friday?", headers: { "Authentication-Results": PROVED } }).raw);
  await server.fake.deliver(plainMessage({ from: "Bo <bo@mail.example>", to: ADDRESS, subject: "Colleague unproved", body: "Lunch on Friday?" }).raw);
  assert.equal((await server.call("POST", `/v1/inboxes/${inbox.id}/sync`, undefined, token)).status, 204);
  const items = await until("both threads", async () => {
    const found = (await server.call("GET", "/v1/search?q=colleague", undefined, token)).body.items as Array<{ subject: string; screened: boolean }> | undefined;
    return found?.length === 2 ? found : null;
  });
  const screened = Object.fromEntries(items.map((item) => [item.subject, item.screened]));
  assert.deepEqual(screened, { "Colleague proved": false, "Colleague unproved": true });
  const list = await server.call("GET", "/v1/screening", undefined, token);
  assert.deepEqual(list.body.items.map((item: { subject: string }) => item.subject), ["Colleague unproved"]);
});
