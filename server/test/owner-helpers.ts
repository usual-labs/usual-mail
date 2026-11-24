// What the owner's tests share: a server nobody has paired with or claimed, keeping its owner's code as a host does,
// with the client address each call comes from (`Host.clientAddress`) set by the test; and Google's token endpoint.

import assert from "node:assert/strict";
import { ServiceError, type PairingCode } from "@usualmail/core";
import { aesGcmSecrets, FakeModels, MailServer, MemoryEventBus, ProviderRegistry, webRandom, type Host } from "../src/index.ts";
import type { GoogleClient, GoogleFetch } from "../src/google/config.ts";
import { openDatabase } from "../src/node/db.ts";
import type { OwnerCodeKind } from "../src/service/devices.ts";
import { ManualClock } from "../src/testing/index.ts";
import { START } from "./helpers.ts";

export const PASSWORD = "correct horse battery";
export const CLIENT: GoogleClient = { clientId: "owner-client.apps.googleusercontent.example", clientSecret: "GOCSPX-test-secret" };
export const REDIRECT = "http://127.0.0.1:8484/v1/google/callback";
export const MINUTE = 60_000;

export const code = (error: unknown) => (error instanceof ServiceError ? error.code : String(error));

export interface Heard {
  code: PairingCode | null;
  made: boolean;
  kind: OwnerCodeKind;
}

export interface Fresh {
  server: MailServer;
  clock: ManualClock;
  heard: Heard[];
  infos: string[];
  /** The address the next calls come from; null: none known, as outside a request. */
  client: { address: string | null };
  db: Host["db"];
  close: () => void;
}

/** A server nobody has paired with or claimed, keeping its owner's code as a host does. */
export async function fresh(options: { ownerEmail?: string; googleFetch?: GoogleFetch } = {}): Promise<Fresh> {
  const store = await openDatabase(":memory:");
  const clock = new ManualClock(START);
  const infos: string[] = [];
  const client = { address: null as string | null };
  const host: Host = {
    db: store.db,
    clock,
    scheduler: clock,
    random: webRandom,
    events: new MemoryEventBus(),
    secrets: await aesGcmSecrets(webRandom.bytes(32), webRandom),
    log: { info: (message) => infos.push(message), error: (message) => infos.push(`ERROR ${message}`) },
    clientAddress: () => client.address,
  };
  const server = await MailServer.create(host, {
    providers: new ProviderRegistry(),
    models: new FakeModels(),
    ...(options.ownerEmail !== undefined && { ownerEmail: options.ownerEmail }),
    ...(options.googleFetch && {
      google: { client: async () => CLIENT, redirectUri: () => REDIRECT, fetch: options.googleFetch, authorizationUrl: "https://accounts.google.example/o/oauth2/v2/auth" },
    }),
  });
  await server.start();
  const heard: Heard[] = [];
  await server.keepOwnerCode((code, made, kind) => heard.push({ code, made, kind }));
  return { server, clock, heard, infos, client, db: store.db, close: () => { void server.stop().finally(() => store.close()); } };
}

let open: Fresh[] = [];

/** `fresh`, closed by `closeAll` (each test file's afterEach). */
export async function make(options?: Parameters<typeof fresh>[0]): Promise<Fresh> {
  const f = await fresh(options);
  open.push(f);
  return f;
}

export function closeAll(): void {
  for (const f of open) f.close();
  open = [];
}

/** Google's token endpoint, answering an ID token for `email`. */
export function googleFor(email: string, verified = true): GoogleFetch {
  return async (input) => {
    const url = String(input);
    assert.ok(url.startsWith("https://oauth2.googleapis.com/token"), url);
    const claims = { iss: "https://accounts.google.com", aud: CLIENT.clientId, exp: Date.parse(START) / 1000 + 3600, email, email_verified: verified };
    const idToken = `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
    return Response.json({ access_token: "at", id_token: idToken, scope: "openid https://www.googleapis.com/auth/userinfo.email" });
  };
}
