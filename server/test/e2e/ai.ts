// What the end-to-end tests of the server's AI share: a made-up key, fake models that answer by subject, and checks
// that the key appears nowhere a person, an agent or a log could read it. No real model is called.

import assert from "node:assert/strict";
import { dataItems, type FakeModels } from "../../src/index.ts";
import type { Json, World } from "./world.ts";

/** Made up. It reaches only the fake models. */
export const KEY = "vck_e2e-made-up-key-7d3f9b2a6c1e";

/** What the fake categorize job answers for each subject; anything else is a conversation. */
export const ANSWERS: Record<string, string> = {
  "Earlier conversation": "conversation",
  "November cupping notes": "newsletter",
  "Invoice 7": "notification",
  "Invoice 9": "notification",
  "Your sign-in code": "otp",
  "Pricing?": "conversation",
};

/** The subject in a request's data block. */
export function subjectOf(data: string): string {
  return String(dataItems(data)[0]?.subject ?? "");
}

export function program(models: FakeModels): void {
  models.choose = (request) => ANSWERS[subjectOf(request.data)] ?? "conversation";
  models.write = (request) => `About ${subjectOf(request.data).toLowerCase()}`;
}

/**
 * Turns the AI on through REST: the key through the gateway, which processes every inbox's mail. Saved while paused,
 * so its own test can be told from the mail it then processes.
 */
export async function turnAiOn(w: World, inboxId: string): Promise<Json> {
  const settings = await w.ok("PATCH", "/v1/ai", { body: { credentials: { kind: "gateway", gateway: "vercel", apiKey: KEY }, paused: true } });
  assert.deepEqual([settings.credentialsSet, settings.connection], [true, { kind: "gateway", gateway: "vercel" }]);
  assert.ok(!("apiKey" in settings) && !JSON.stringify(settings).includes(KEY), "the settings never carry the key");
  // Saving the key tested it at once: one small request per job, with no mail in it.
  assert.deepEqual(w.models.requests.map((r) => r.kind), ["choose", "write"]);
  for (const request of w.models.requests) assert.equal(subjectOf(request.request.data), "A test from Usual Mail", "the test sends no mail");
  w.models.requests.length = 0;
  await w.ok("PATCH", "/v1/ai", { body: { paused: false } });
  assert.equal((await w.ok("GET", "/v1/ai/status")).state, "working");
  await w.idle();
  return (await w.ok("GET", "/v1/inboxes")).find((inbox: Json) => inbox.id === inboxId);
}

/** No part of the key, of eight characters or more, in this text. */
export function assertNoKey(text: string, what: string): void {
  for (let start = 0; start + 8 <= KEY.length; start++) {
    assert.ok(!text.includes(KEY.slice(start, start + 8)), `${what}: holds part of the key`);
  }
}

/** Every route a person or an agent reads the AI or the mail through, and every event, without the key. */
export async function assertKeyNowhere(w: World, inboxId: string, agent: string, events: unknown[][]): Promise<void> {
  const person = [
    "/v1/ai", "/v1/ai/status", "/v1/inboxes", "/v1/home", "/v1/counts", "/v1/screening", "/v1/triage", "/v1/me",
    "/v1/handled?includeSilent=true&states=proposed,applied,undone,rejected,failed", `/v1/inboxes/${inboxId}/rules`,
  ];
  for (const path of person) assertNoKey(JSON.stringify(await w.ok("GET", path)), `GET ${path}`);
  assertNoKey(JSON.stringify(await w.ok("POST", "/v1/ai/test")), "POST /v1/ai/test");
  for (const path of ["/v1/ai/status", "/v1/inboxes", "/v1/home", "/v1/counts", "/v1/handled?includeSilent=true"]) {
    assertNoKey(JSON.stringify(await w.ok("GET", path, { token: agent })), `an agent's GET ${path}`);
  }
  const settings = await w.call("GET", "/v1/ai", { token: agent });
  assert.deepEqual([settings.status, settings.body.error.code], [403, "needs_person"], "an agent never sees the settings");
  const refused = await w.call("PATCH", "/v1/ai", { body: { credentials: { kind: "gateway", gateway: KEY, apiKey: KEY } } });
  assert.equal(refused.status, 400);
  assertNoKey(JSON.stringify(refused.body), "a refused settings change");
  for (const [index, list] of events.entries()) assertNoKey(JSON.stringify(list), `events heard by listener ${index}`);
  assertNoKey(JSON.stringify([w.infos, w.errors]), "the server's log");
}
