// A small stand-in for the server, written from core's route table, types and docs/contract.md (fifth revision), so
// the command's tests don't depend on the real server. It serves the routes the command uses, with the contract's
// sign-in, pairing limit (with Retry-After), error bodies and statuses, versions on inboxes, credentials checked
// before they are kept and replacing the stored ones whole, each inbox's connection without secrets, its icon,
// position and AI processing (on only with AI credentials set), `GET /v1/me`, the server's AI (stand-in-ai.ts), and
// the owner's pairing code: written to its data directory whenever no person's device is paired, written again when
// it expires, and removed once it is used.

import {
  ERROR_STATUS,
  googleSetup,
  INBOX_ICONS,
  ROUTES,
  type Device,
  type DeviceKind,
  type ErrorCode,
  type FirstSyncWindow,
  type GoogleSignIn,
  type GoogleSignInFailure,
  type GoogleSignInInfo,
  type Inbox,
  type InboxConnection,
  type RouteName,
  type ServerLogin,
} from "@usualmail/core";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { AiRefusal, StandInAi } from "./stand-in-ai.ts";

export interface Recorded {
  route: RouteName;
  method: string;
  path: string;
  body: unknown;
  /** The raw request body, to check what was sent. */
  text: string;
  authorization?: string;
}

interface Code {
  code: string;
  kind: DeviceKind;
  inboxIds?: string[];
  expiresAt: number;
  used: boolean;
  owner: boolean;
}

interface Failing {
  code: ErrorCode;
  message: string;
  retryAfter?: string;
}

class Refusal extends Error {
  readonly code: ErrorCode;
  /** With rate_limited: whole seconds, sent as Retry-After. */
  readonly retryAfter?: number;
  constructor(code: ErrorCode, message: string, retryAfter?: number) {
    super(message);
    this.code = code;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

export const OWNER_FILE = "owner-pairing-code";
const MINUTE = 60_000;
const time = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

export class StandIn {
  readonly devices: Array<Device & { token: string }> = [];
  readonly inboxes: Inbox[] = [];
  readonly requests: Recorded[] = [];
  /** Every credentials object `connectInbox` received, to check secrets were sent once. */
  readonly credentials: unknown[] = [];
  readonly codes: Code[] = [];
  /** The server's AI: its settings (key included, never sent back) and status. */
  readonly ai = new StandInAi(this.inboxes);
  /** The first sync's window, as `GET /v1/first-sync` answers it. */
  firstSync: FirstSyncWindow = { days: 30, setBy: "default", changeable: true };
  version = "0.0.0-stand-in";
  /** Google sign-in as `GET /v1/info` says it. */
  google: GoogleSignInInfo = { available: false, redirectUri: "http://127.0.0.1:18585/v1/google/callback", missing: ["client"] };
  /** How each sign-in ends, after `polls` answers of `waiting`: which account signed in, and connected or a failure. */
  signInPlan: { address: string; ends: "connected" | GoogleSignInFailure; polls: number } = { address: "ana@gmail.example", ends: "connected", polls: 2 };
  readonly signIns = new Map<string, { deviceId: string; input: Record<string, unknown>; polls: number; outcome?: GoogleSignIn; expiresAt: string }>();
  /** The owner's code expires as the next pairing with it arrives, and the server writes a new one at once. */
  expireOwnerCodeOnNextPair = false;
  apiVersion = 1;
  listening = false;
  #server: Server | null = null;
  #failures = new Map<RouteName, Failing[]>();
  #wrongCodes: number[] = [];
  #next = 1;
  readonly dataDir: string | undefined;
  readonly ownerFormat: "text" | "json";

  constructor(options: { dataDir?: string; ownerFormat?: "text" | "json" } = {}) {
    this.dataDir = options.dataDir;
    this.ownerFormat = options.ownerFormat ?? "text";
  }

  /**
   * Listens on 127.0.0.1. Like the real server, a store with no person's device gets a new owner code, and the first
   * sync's window (`GET /v1/first-sync`) comes from the data directory's settings.json, read at every start.
   */
  async listen(port = 0): Promise<string> {
    if (this.dataDir) {
      const file = join(this.dataDir, "settings.json");
      const days = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { syncDays?: number }).syncDays : undefined;
      this.firstSync = { days: days ?? 30, setBy: days === undefined ? "default" : "settings", changeable: true };
    }
    const server = createServer((request, response) => void this.#handle(request, response));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    this.#server = server;
    this.listening = true;
    if (this.dataDir && !this.devices.some((device) => device.kind === "person")) this.#writeOwnerCode();
    return this.url;
  }

  /** Stops at once: no new requests, open connections dropped. */
  close(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    this.listening = false;
    if (!server) return Promise.resolve();
    server.closeAllConnections();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  get url(): string {
    const address = this.#server?.address() as AddressInfo | null;
    if (!address) throw new Error("The stand-in isn't listening");
    return `http://127.0.0.1:${address.port}`;
  }

  /** The next request to this route answers with this error. */
  failNext(route: RouteName, code: ErrorCode, message = `Refused by the stand-in (${code})`, retryAfter?: string): void {
    const list = this.#failures.get(route) ?? [];
    list.push(retryAfter ? { code, message, retryAfter } : { code, message });
    this.#failures.set(route, list);
  }

  addDevice(kind: DeviceKind, name: string, inboxIds?: string[]): { device: Device; token: string } {
    const token = `umt_${randomBytes(18).toString("base64url")}`;
    const device: Device & { token: string } = {
      id: `dev_${this.#next++}`,
      name,
      kind,
      ...(inboxIds ? { inboxIds } : {}),
      createdAt: time(Date.now()),
      token,
    };
    this.devices.push(device);
    const { token: _, ...shown } = device;
    return { device: shown, token };
  }

  addInbox(fields: Partial<Inbox> & { name: string; address: string }): Inbox {
    const provider = fields.provider ?? "imap";
    const domain = fields.address.split("@").pop();
    const login = (host: string, port: number) => ({ host, port, secure: true, user: fields.address });
    const count = this.inboxes.length;
    const inbox: Inbox = {
      id: `inb_${this.#next++}`,
      color: "#285fcd",
      // A new inbox takes the next of person, building and briefcase, and comes last.
      icon: (["person", "building", "briefcase"] as const)[count % 3]!,
      position: count,
      provider,
      // What the server stored of how it is connected, without secrets.
      connection: provider === "gmail"
        ? { kind: "gmail", clientId: "stored.apps.example" }
        : { kind: "imap", imap: login(`imap.${domain}`, 993), smtp: login(`smtp.${domain}`, 465), saveSent: true },
      trust: "suggest",
      guide: "",
      agentAccess: false,
      status: "ok",
      createdAt: time(Date.now()),
      version: 1,
      ...fields,
    };
    this.inboxes.push(inbox);
    return inbox;
  }

  /** Requests to one route. */
  calls(route: RouteName): Recorded[] {
    return this.requests.filter((request) => request.route === route);
  }

  /** The owner's code now on offer, if any. */
  get ownerCode(): string | undefined {
    return this.codes.find((code) => code.owner && !code.used && code.expiresAt >= Date.now())?.code;
  }

  /**
   * As the server does whenever no person's device is paired: a new owner's code, which ends the one before it,
   * printed (here: kept) and written to the data directory. A demo-like stand-in without a data directory writes
   * no file.
   */
  #writeOwnerCode(): void {
    for (const code of this.codes) if (code.owner && !code.used) code.used = true;
    const code = this.#newCode("person", undefined, 24 * 60 * MINUTE, true);
    if (!this.dataDir) return;
    const text = this.ownerFormat === "json" ? JSON.stringify({ code: code.code, expiresAt: time(code.expiresAt) }) : code.code;
    writeFileSync(join(this.dataDir, OWNER_FILE), `${text}\n`, { mode: 0o600 });
  }

  /** The owner's code expires unused: the server makes a new one at once and writes the file again. */
  expireOwnerCode(): void {
    const current = this.codes.find((code) => code.owner && !code.used);
    if (current) current.expiresAt = Date.now() - 1;
    if (!this.devices.some((device) => device.kind === "person")) this.#writeOwnerCode();
  }

  #newCode(kind: DeviceKind, inboxIds: string[] | undefined, lifetime: number, owner = false): Code {
    const raw = randomBytes(5).toString("hex").toUpperCase();
    const code: Code = { code: `${raw.slice(0, 5)}-${raw.slice(5)}`, kind, expiresAt: Date.now() + lifetime, used: false, owner };
    if (inboxIds) code.inboxIds = inboxIds;
    this.codes.push(code);
    return code;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://stand-in");
    let text = "";
    for await (const chunk of request) text += chunk;
    const match = route(request.method ?? "GET", url.pathname);
    if (!match) return send(response, 404, { error: { code: "not_found", message: "No such route" } });
    const [name, params] = match;
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      return send(response, 400, { error: { code: "invalid", message: "The body isn't JSON" } });
    }
    const authorization = request.headers.authorization;
    this.requests.push({ route: name, method: request.method!, path: url.pathname, body, text, ...(authorization ? { authorization } : {}) });
    const failing = this.#failures.get(name)?.shift();
    if (failing) {
      const headers = failing.retryAfter !== undefined ? { "retry-after": failing.retryAfter } : undefined;
      return send(response, ERROR_STATUS[failing.code], { error: { code: failing.code, message: failing.message } }, headers);
    }
    try {
      const caller = this.#caller(ROUTES[name].auth, authorization);
      const result = name === "aiDisclosure" ? this.ai.disclosure(url.searchParams) : this.#answer(name, params, body as Record<string, unknown> | undefined, caller);
      if (result === undefined) {
        response.writeHead(204).end();
        return;
      }
      send(response, 200, result);
    } catch (caught) {
      const error = caught instanceof AiRefusal ? new Refusal(caught.code, caught.message) : caught;
      if (!(error instanceof Refusal)) throw error;
      const headers = error.retryAfter !== undefined ? { "retry-after": String(error.retryAfter) } : undefined;
      send(response, ERROR_STATUS[error.code], { error: { code: error.code, message: error.message } }, headers);
    }
  }

  #caller(auth: "none" | "person" | "any", authorization: string | undefined): (Device & { token: string }) | null {
    if (auth === "none") return null;
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    const device = this.devices.find((d) => d.token === token);
    if (!device) throw new Refusal("unauthorized", "Sign in with a paired device's token");
    if (auth === "person" && device.kind !== "person") throw new Refusal("needs_person", "A person must do this");
    return device;
  }

  #visible(caller: Device | null): Inbox[] {
    if (!caller || caller.kind === "person") return this.inboxes;
    return this.inboxes.filter((inbox) => caller.inboxIds?.includes(inbox.id) && inbox.agentAccess);
  }

  #inbox(caller: Device | null, id: string): Inbox {
    const inbox = this.#visible(caller).find((i) => i.id === id);
    if (!inbox) throw new Refusal("not_found", "No such inbox");
    return inbox;
  }

  #answer(name: RouteName, params: Record<string, string>, body: Record<string, unknown> | undefined, caller: Device | null): unknown {
    switch (name) {
      case "health":
        return { ok: true };
      case "info":
        return { name: "usual-mail", version: this.version, apiVersion: this.apiVersion, googleSignIn: this.google };
      case "startGoogleSignIn":
        return this.#startSignIn(caller!, body ?? {});
      case "googleSignIn":
        return this.#signIn(caller!, params.id!);
      case "googleSetup":
        return googleSetup(this.google, { source: this.google.available ? "saved" : "none", changeable: true });
      case "pair":
        return this.#pair(body);
      case "me": {
        const { token: _, ...device } = caller as Device & { token: string };
        return device;
      }
      case "listDevices":
        return this.devices.map(({ token: _, ...device }) => device);
      case "createPairingCode": {
        const kind = body?.kind;
        if (kind !== "person" && kind !== "agent") throw new Refusal("invalid", "kind must be person or agent");
        const inboxIds = body?.inboxIds as string[] | undefined;
        if (kind === "agent") {
          if (!inboxIds?.length) throw new Refusal("invalid", "An agent needs inboxIds");
          for (const id of inboxIds) if (!this.inboxes.some((inbox) => inbox.id === id)) throw new Refusal("not_found", `No inbox ${id}`);
        }
        const code = this.#newCode(kind, kind === "agent" ? inboxIds : undefined, 15 * MINUTE);
        return { code: code.code, expiresAt: time(code.expiresAt) };
      }
      case "revokeDevice": {
        const index = this.devices.findIndex((device) => device.id === params.id);
        if (caller!.kind !== "person" && params.id !== caller!.id) throw new Refusal("needs_person", "Only a person may revoke another device");
        if (index < 0) throw new Refusal("not_found", "No such device");
        this.devices.splice(index, 1);
        // No person's device left: a new owner's code at once, so the owner is never locked out.
        if (!this.devices.some((device) => device.kind === "person")) this.#writeOwnerCode();
        return undefined;
      }
      case "listInboxes":
        return this.#visible(caller);
      case "connectInbox":
        return this.#connect(body);
      case "updateInbox": {
        const inbox = this.#inbox(caller, params.id!);
        const keys = Object.keys(body ?? {});
        if (caller!.kind !== "person" && keys.some((key) => key !== "guide")) throw new Refusal("needs_person", "Only a person may change that");
        for (const key of keys) {
          if (!["name", "color", "icon", "position", "trust", "guide", "agentAccess", "paused", "credentials"].includes(key)) {
            throw new Refusal("invalid", `Unknown field ${key}`);
          }
        }
        const patch = body as Partial<Inbox> & { paused?: boolean; credentials?: unknown };
        if (patch.icon !== undefined && !(INBOX_ICONS as readonly string[]).includes(patch.icon)) throw new Refusal("invalid", `No icon ${patch.icon}`);
        if (patch.position !== undefined && (!Number.isInteger(patch.position) || patch.position < 0 || patch.position >= this.inboxes.length)) {
          throw new Refusal("invalid", `position must be from 0 to ${this.inboxes.length - 1}`);
        }
        // New credentials are checked with the provider first; when that fails, nothing in the patch changes.
        if (patch.credentials !== undefined) {
          this.credentials.push(patch.credentials);
          const address = this.#verify(inbox.provider, patch.credentials);
          if (address && address.toLowerCase() !== inbox.address.toLowerCase()) {
            throw new Refusal("invalid", `These details are for ${address}, not ${inbox.address}`);
          }
          // They replace the stored ones whole; what isn't secret can be shown again.
          inbox.connection = connectionOf(inbox.provider, patch.credentials);
          if (inbox.status !== "paused") inbox.status = "connecting";
          delete inbox.statusDetail;
        }
        if (patch.name !== undefined) inbox.name = patch.name;
        if (patch.color !== undefined) inbox.color = patch.color;
        if (patch.trust !== undefined) inbox.trust = patch.trust;
        if (patch.guide !== undefined) inbox.guide = patch.guide;
        if (patch.agentAccess !== undefined) inbox.agentAccess = patch.agentAccess;
        if (patch.icon !== undefined) inbox.icon = patch.icon;
        if (patch.position !== undefined) this.#move(inbox, patch.position);
        if (patch.paused === true) inbox.status = "paused";
        // Resumed, it is connecting until its next good sync.
        if (patch.paused === false && inbox.status === "paused") inbox.status = "connecting";
        inbox.version += 1;
        return inbox;
      }
      case "removeInbox": {
        const inbox = this.#inbox(caller, params.id!);
        this.inboxes.splice(this.inboxes.indexOf(inbox), 1);
        // Removing one closes the gap.
        this.inboxes.forEach((other, index) => {
          if (other.position !== index) {
            other.position = index;
            other.version += 1;
          }
        });
        return undefined;
      }
      case "aiSettings":
        return this.ai.settings();
      case "updateAiSettings":
        return this.ai.update(body ?? {});
      case "aiStatus":
        return this.ai.status();
      case "testAi":
        return this.ai.test();
      case "firstSyncWindow":
        return this.firstSync;
      case "syncInbox":
        this.#inbox(caller, params.id!);
        return undefined;
      default:
        throw new Refusal("internal", `${name} isn't in the stand-in`);
    }
  }

  /** Starts a Google sign-in as the server does: a person's, only when set up, with Google's address to open. */
  #startSignIn(caller: Device, body: Record<string, unknown>): unknown {
    if (!this.google.available) throw new Refusal("conflict", "Google sign-in isn't set up on this server: its host hasn't given it a Google OAuth client");
    for (const key of Object.keys(body)) if (!["inboxId", "name", "color", "icon"].includes(key)) throw new Refusal("invalid", `Unknown field ${key}`);
    if (body.inboxId !== undefined) {
      const inbox = this.#inbox(caller, String(body.inboxId));
      if (inbox.provider !== "gmail") throw new Refusal("invalid", "Only a Gmail inbox can be reconnected by signing in with Google");
    }
    const id = `gsi_${this.#next++}`;
    const expiresAt = time(Date.now() + 10 * MINUTE);
    this.signIns.set(id, { deviceId: caller.id, input: body, polls: this.signInPlan.polls, expiresAt });
    const state = randomBytes(32).toString("base64url");
    return { id, url: `https://accounts.google.com/o/oauth2/v2/auth?client_id=owner-client.apps.example&state=${state}`, expiresAt };
  }

  /** How a sign-in stands: waiting for a few answers, then as `signInPlan` says. Only the device that started it. */
  #signIn(caller: Device, id: string): GoogleSignIn {
    const signIn = this.signIns.get(id);
    if (!signIn || signIn.deviceId !== caller.id) throw new Refusal("not_found", "No such Google sign-in");
    if (signIn.outcome) return signIn.outcome;
    if (signIn.polls-- > 0) return { id, state: "waiting", expiresAt: signIn.expiresAt, ...(signIn.input.inboxId ? { inboxId: String(signIn.input.inboxId) } : {}) };
    const { address, ends } = this.signInPlan;
    const target = signIn.input.inboxId ? this.inboxes.find((inbox) => inbox.id === signIn.input.inboxId) : this.inboxes.find((inbox) => inbox.address === address && inbox.provider === "gmail");
    if (ends !== "connected") {
      signIn.outcome = { id, state: "failed", failure: ends, message: `The sign-in failed: ${ends}. Start again in Usual Mail.`, expiresAt: signIn.expiresAt };
    } else if (target) {
      if (signIn.input.inboxId && target.address !== address) {
        signIn.outcome = { id, state: "failed", failure: "wrong_account", inboxId: target.id, message: `You signed in as ${address}, but this inbox is ${target.address}.`, expiresAt: signIn.expiresAt };
      } else {
        target.connection = { kind: "gmail", clientId: "owner-client.apps.example", signIn: "google" };
        if (target.status !== "paused") target.status = "connecting";
        delete target.statusDetail;
        target.version += 1;
        signIn.outcome = { id, state: "connected", inboxId: target.id, reconnected: true, message: `${address} is reconnected.`, expiresAt: signIn.expiresAt };
      }
    } else {
      const inbox = this.addInbox({
        name: typeof signIn.input.name === "string" ? signIn.input.name : address,
        address,
        color: typeof signIn.input.color === "string" ? signIn.input.color : "#5A697C",
        provider: "gmail",
        connection: { kind: "gmail", clientId: "owner-client.apps.example", signIn: "google" },
        status: "connecting",
        ...(typeof signIn.input.icon === "string" ? { icon: signIn.input.icon as Inbox["icon"] } : {}),
      });
      signIn.outcome = { id, state: "connected", inboxId: inbox.id, reconnected: false, message: `Gmail is connected: ${address}.`, expiresAt: signIn.expiresAt };
    }
    return signIn.outcome;
  }

  #pair(body: Record<string, unknown> | undefined): unknown {
    const now = Date.now();
    this.#wrongCodes = this.#wrongCodes.filter((at) => now - at < 10 * MINUTE);
    if (this.#wrongCodes.length >= 10) {
      const wait = Math.ceil((this.#wrongCodes[0]! + 10 * MINUTE - now) / 1000);
      throw new Refusal("rate_limited", `Too many wrong pairing codes. Try again in ${wait} seconds`, wait);
    }
    const name = typeof body?.name === "string" ? body.name : "";
    if (this.expireOwnerCodeOnNextPair && this.codes.some((c) => c.owner && c.code === body?.code)) {
      this.expireOwnerCodeOnNextPair = false;
      this.expireOwnerCode();
    }
    const code = this.codes.find((c) => c.code === body?.code);
    if (!code || code.used || code.expiresAt < now) {
      this.#wrongCodes.push(now);
      throw new Refusal("unauthorized", "Wrong, used or expired pairing code");
    }
    if (!name) throw new Refusal("invalid", "name is required");
    code.used = true;
    if (code.owner && this.dataDir) rmSync(join(this.dataDir, OWNER_FILE), { force: true });
    const { device, token } = this.addDevice(code.kind, name, code.inboxIds);
    return { token, device };
  }

  /** Moves an inbox to a position and renumbers the others, raising the version of each one that moved. */
  #move(inbox: Inbox, position: number): void {
    const order = this.inboxes.filter((other) => other !== inbox);
    order.splice(position, 0, inbox);
    this.inboxes.splice(0, this.inboxes.length, ...order);
    this.inboxes.forEach((other, index) => {
      if (other.position !== index) {
        other.position = index;
        if (other !== inbox) other.version += 1;
      }
    });
  }

  #connect(body: Record<string, unknown> | undefined): Inbox {
    const { name, color, provider, credentials, trust, icon, ...rest } = (body ?? {}) as Record<string, any>;
    if (typeof name !== "string" || !name) throw new Refusal("invalid", "name is required");
    if (typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color)) throw new Refusal("invalid", "color must be #RRGGBB");
    if (provider !== "imap" && provider !== "gmail") throw new Refusal("invalid", "provider must be imap or gmail");
    if (icon !== undefined && !(INBOX_ICONS as readonly string[]).includes(icon)) throw new Refusal("invalid", `No icon ${icon}`);
    for (const key of Object.keys(rest)) throw new Refusal("invalid", `Unknown field ${key}`);
    this.credentials.push(credentials);
    const address = this.#verify(provider, credentials) ?? "owner@gmail.example";
    return this.addInbox({
      name,
      address,
      color,
      provider,
      connection: connectionOf(provider, credentials),
      trust: trust ?? "suggest",
      status: "connecting",
      agentAccess: false,
      ...(icon ? { icon } : {}),
    });
  }

  /**
   * Checks credentials as the server does with the provider, in the shape `connectInbox` takes. Returns the address
   * the mailbox says it is (IMAP), or undefined when the fake can't tell (Gmail). A password of "wrong-password"
   * is refused with the provider's words.
   */
  #verify(provider: string, credentials: any): string | undefined {
    if (provider === "imap") {
      const imap = credentials?.imap;
      const smtp = credentials?.smtp;
      for (const part of [imap, smtp]) {
        if (!part?.host || !Number.isInteger(part.port) || typeof part.secure !== "boolean" || !part.user || !part.password) {
          throw new Refusal("invalid", "IMAP and SMTP need host, port, secure, user and password");
        }
      }
      if (imap.password === "wrong-password") throw new Refusal("provider_error", "The IMAP server refused the login");
      return credentials.address ?? imap.user;
    }
    if (!credentials?.clientId || !credentials?.clientSecret || !credentials?.refreshToken) {
      throw new Refusal("invalid", "Gmail needs clientId, clientSecret and refreshToken");
    }
    if (credentials.refreshToken === "wrong-password") throw new Refusal("provider_error", "Google refused the refresh token");
    return undefined;
  }
}

/** What the server keeps of credentials to show again: never a password, secret or token. */
function connectionOf(provider: string, credentials: any): InboxConnection {
  if (provider === "gmail") return { kind: "gmail", clientId: credentials.clientId };
  const login = ({ host, port, secure, user }: ServerLogin) => ({ host, port, secure, user });
  return { kind: "imap", imap: login(credentials.imap), smtp: login(credentials.smtp), saveSent: credentials.saveSent ?? true };
}

function route(method: string, path: string): [RouteName, Record<string, string>] | null {
  for (const [name, spec] of Object.entries(ROUTES) as Array<[RouteName, (typeof ROUTES)[RouteName]]>) {
    if (spec.method !== method) continue;
    const keys: string[] = [];
    const pattern = new RegExp(`^${spec.path.replace(/:(\w+)/g, (_, key: string) => (keys.push(key), "([^/]+)"))}$`);
    const found = pattern.exec(path);
    if (found) return [name, Object.fromEntries(keys.map((key, i) => [key, decodeURIComponent(found[i + 1]!)]))];
  }
  return null;
}

function send(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
}
