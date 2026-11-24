// What the end-to-end tests share: the real server (store, service, REST) with real mail providers behind it, a
// person signed in over REST, and small helpers for REST calls. The mail servers they talk to are in
// imap-server.ts (an in-process IMAP server and SMTP sink) and mail's fake of Gmail's API.

import assert from "node:assert/strict";
import type { MailEvent, ProviderFactory, ProviderKind } from "@usualmail/core";
import { aesGcmSecrets, FakeModels, MailServer, MemoryEventBus, ProviderRegistry, webRandom, type Host, type MailServerOptions } from "../../src/index.ts";
import { openDatabase } from "../../src/node/db.ts";
import { createApp } from "../../src/rest/app.ts";
import { ManualClock } from "../../src/testing/index.ts";

export const HOUR = 60 * 60_000;
export const DAY = 24 * HOUR;

// Bodies are checked field by field, so they are loosely typed here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export interface CallOptions {
  token?: string | null;
  body?: unknown;
  text?: string;
}

export interface World {
  server: MailServer;
  /** The host the server runs on: its store and its sealing. */
  host: Host;
  clock: ManualClock;
  /** The fake models the server's AI reaches. Nothing real is ever called. */
  models: FakeModels;
  errors: string[];
  /** Everything the server logged as information. */
  infos: string[];
  personToken: string;
  /** A REST call. `token` defaults to the person's. `text` is sent as the body as it is, instead of `body` as JSON. */
  call(method: string, path: string, options?: CallOptions): Promise<{ status: number; body: Json; headers: Headers }>;
  /** A REST call that must answer 200 or 204. */
  ok(method: string, path: string, options?: CallOptions): Promise<Json>;
  /** A request exactly as given (headers, a stream body, another host in the address), to the REST app. */
  fetch(input: string, init?: RequestInit): Promise<Response>;
  /** Waits until no sync, write-back or come-back work is queued or running. */
  idle(): Promise<void>;
  /** POST /v1/inboxes/:id/sync, then waits for it. */
  sync(inboxId: string): Promise<void>;
  /** An agent's token, made the only way there is: a person's agent pairing code, paired. */
  agent(inboxIds: string[], name?: string): Promise<string>;
  /** The thread with this subject, done or not, through search. */
  thread(subject: string, token?: string): Promise<Json>;
  /** Every event the token's device hears from now on, as the event stream would carry it. */
  listen(token: string): Promise<{ events: MailEvent[]; stop(): void }>;
  close(): Promise<void>;
}

/** A started server whose providers are the given factories, on a fresh store, with a person paired over REST. */
export async function startWorld(
  providers: Partial<Record<ProviderKind, ProviderFactory>>,
  options: Partial<Omit<MailServerOptions, "providers" | "models">> = {},
): Promise<World> {
  const store = await openDatabase(":memory:");
  // Real mail servers stamp real times, so the clock starts now and only moves when a test moves it.
  const clock = new ManualClock(Math.floor(Date.now() / 1000) * 1000);
  const errors: string[] = [];
  const infos: string[] = [];
  const host: Host = {
    db: store.db,
    clock,
    scheduler: clock,
    random: webRandom,
    events: new MemoryEventBus(),
    secrets: await aesGcmSecrets(webRandom.bytes(32), webRandom),
    log: { info: (message) => infos.push(message), error: (message, error) => errors.push(`${message} ${error ?? ""}`.trim()) },
  };
  const registry = new ProviderRegistry();
  for (const [kind, factory] of Object.entries(providers) as Array<[ProviderKind, ProviderFactory]>) registry.register(kind, factory);
  const models = new FakeModels();
  const server = await MailServer.create(host, { ...options, providers: registry, models });
  await server.start();
  const app = createApp(server, { scheduler: clock, log: host.log });

  const call: World["call"] = async (method, path, options = {}) => {
    const headers: Record<string, string> = {};
    const token = options.token === undefined ? world.personToken : options.token;
    if (token) headers.authorization = `Bearer ${token}`;
    const sent = options.text ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined);
    if (sent !== undefined) headers["content-type"] = "application/json";
    const res = await app.request(path, { method, headers, ...(sent !== undefined && { body: sent }) });
    if (!res.headers.get("content-type")?.includes("json")) return { status: res.status, body: new Uint8Array(await res.arrayBuffer()), headers: res.headers };
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  };
  const world: World = {
    server,
    host,
    clock,
    models,
    errors,
    infos,
    personToken: "",
    call,
    fetch: async (input, init) => app.request(input, init),
    async ok(method, path, options) {
      const res = await call(method, path, options);
      assert.ok(res.status === 200 || res.status === 204, `${method} ${path}: ${res.status} ${JSON.stringify(res.body)}`);
      return res.body;
    },
    idle: () => server.whenIdle(),
    async sync(inboxId) {
      await world.ok("POST", `/v1/inboxes/${inboxId}/sync`);
      await server.whenIdle();
    },
    async agent(inboxIds, name = "Test Agent") {
      const code = await world.ok("POST", "/v1/pairing-codes", { body: { kind: "agent", inboxIds } });
      return (await world.ok("POST", "/v1/pair", { token: null, body: { code: code.code, name } })).token;
    },
    async thread(subject, token) {
      const page = await world.ok("GET", `/v1/search?q=${encodeURIComponent(subject)}&limit=200`, { token });
      const found = page.items.find((thread: Json) => thread.subject === subject);
      assert.ok(found, `a thread "${subject}"`);
      return found;
    },
    async listen(token) {
      const caller = await server.authenticate(token);
      assert.ok(caller, "a known token");
      const events: MailEvent[] = [];
      const stop = server.subscribe(caller, (event) => events.push(JSON.parse(JSON.stringify(event)) as MailEvent));
      return { events, stop };
    },
    async close() {
      await server.stop();
      store.close();
    },
  };
  const owner = (await server.ownerPairingCode())!;
  world.personToken = (await world.ok("POST", "/v1/pair", { token: null, body: { code: owner.code, name: "Test Mac" } })).token;
  return world;
}
