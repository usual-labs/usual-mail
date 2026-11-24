// What the workerd tests share: the Worker built by wrangler as `wrangler deploy` builds it (the test entry in place of
// wrangler.jsonc's `main`), run in Miniflare's workerd as smoke-bundle.mjs runs the Node bundle, with Google's hosts
// routed to mail's FakeGmail in this Node process (outside the isolate, so its memory isn't the Worker's). Run from the
// repository root's `npm run check:cloudflare`.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { convertV4MiniflareOptions, Miniflare, NoOpLog, Response as MiniflareResponse, type Request as MiniflareRequest } from "miniflare";
import { FakeGmail } from "../../../mail/src/testing/index.ts";

export const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const TEST_ENTRY = "server/test/cloudflare/worker/entry.ts";
export const BASE = "https://mail.example";
export const ADDRESS = "me@mail.example";
/** A second Gmail account, for two inboxes syncing at once. */
export const SECOND_ADDRESS = "also@mail.example";
const GOOGLE_HOSTS = new Set(["oauth2.googleapis.com", "gmail.googleapis.com"]);

/** wrangler.jsonc as the tests read it: its comments taken out. */
export async function wranglerConfig(): Promise<{ compatibility_date: string; compatibility_flags: string[]; main: string }> {
  const text = await readFile(join(ROOT, "wrangler.jsonc"), "utf8");
  return JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));
}

/** Builds the Worker as `wrangler deploy` does (its build step included) into a new folder; `entry` replaces `main`. */
export async function buildWorker(entry?: string): Promise<{ dir: string; script: string; output: string }> {
  const dir = await mkdtemp(join(tmpdir(), "usual-mail-cf-build-"));
  const result = spawnSync(join(ROOT, "node_modules/.bin/wrangler"), ["deploy", ...(entry ? [entry] : []), "--dry-run", "--outdir", dir], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  const output = `${result.stdout}${result.stderr}`;
  if (result.status !== 0) throw new Error(`wrangler couldn't build the Worker:\n${output}`);
  const script = (await readdir(dir)).find((name) => name.endsWith(".js"));
  if (!script) throw new Error(`wrangler wrote no script to ${dir}:\n${output}`);
  return { dir, script: join(dir, script), output };
}

export interface Answer {
  status: number;
  headers: Headers;
  body: any;
}

export interface TestServer {
  mf: Miniflare;
  /** Gmail for `ADDRESS`. */
  fake: FakeGmail;
  /** Gmail for `SECOND_ADDRESS`, with its own refresh token. */
  second: FakeGmail;
  /** The most `messages.get` and `attachments.get` requests in flight at once, across both accounts. */
  peakMessageRequests(): number;
  /** Every request to Google's hosts: which account, when it started, and its path (with the query). */
  requestLog: Array<{ account: FakeGmail; at: number; path: string }>;
  /** Every line the Worker logged, in order. */
  logs: string[];
  /** Addresses the Worker fetched outside Google's two hosts (each refused). */
  outside: string[];
  /** A REST call over https; JSON answers parsed. */
  call(method: string, path: string, body?: unknown, token?: string, headers?: Record<string, string>): Promise<Answer>;
  /** One statement on the object's SQLite (the test entry's hook, as Data Studio). */
  sql<T = Record<string, unknown>>(query: string, ...params: unknown[]): Promise<T[]>;
  /** Resets the object (the test entry's hook), as an eviction does. */
  evict(): Promise<void>;
  /** Pairs with the owner's code read from its table and answers the token. */
  pair(): Promise<{ code: string; token: string }>;
  /** Lines logged since `from` (an index into `logs`). */
  logged(pattern: RegExp, from?: number): string[];
  stop(): Promise<void>;
}

/** What a test file may give its server. */
export interface StartOptions {
  /** The Worker's variables and secrets (USUAL_MAIL_PUBLIC_URL, USUAL_MAIL_TIME_ZONE, …). */
  bindings?: Record<string, string>;
  /** A fake Google (OAuth and Gmail) that answers Google's hosts instead of the two FakeGmail accounts. */
  google?: { fetch: (input: string, init: RequestInit) => Promise<Response> };
  /** Fake web hosts (pictures, sites, DNS-over-HTTPS) for any other host they answer; the rest is refused (web-hosts.ts). */
  web?: (request: MiniflareRequest) => Promise<MiniflareResponse | undefined>;
}

/** Starts the built test Worker in Miniflare, with a FakeGmail for each account behind Google's hosts. */
export async function startServer(options: StartOptions = {}): Promise<TestServer> {
  const config = await wranglerConfig();
  const build = await buildWorker(TEST_ENTRY);
  const fake = new FakeGmail({ address: ADDRESS });
  const second = new FakeGmail({ address: SECOND_ADDRESS, refreshToken: "second-refresh-token" });
  const logs: string[] = [];
  const outside: string[] = [];
  const requestLog: TestServer["requestLog"] = [];
  let inFlight = 0;
  let peak = 0;
  // The token endpoint by the refresh token sent; the API by the access token each fake handed out.
  const accountOf = (url: URL, headers: Headers, body: string | undefined): FakeGmail => {
    if (url.hostname === "oauth2.googleapis.com") {
      const refresh = new URLSearchParams(body ?? "").get("refresh_token") ?? "";
      return second.acceptsRefreshToken(refresh) ? second : fake;
    }
    const token = (headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    return second.holdsAccessToken(token) ? second : fake;
  };
  // Miniflare 5 takes its own shape; its converter takes the long-documented one (and leaves the dev registry off).
  const mf = new Miniflare(convertV4MiniflareOptions({
    log: new NoOpLog(),
    // wrangler bundles everything into one module; workerd provides node:* (nodejs_compat) and cloudflare:workers.
    modules: [{ type: "ESModule", path: build.script }],
    modulesRoot: build.dir,
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
    durableObjects: { SERVER: { className: "UsualMailServer", useSQLite: true } },
    ...(options.bindings && { bindings: options.bindings }),
    handleStructuredLogs: (log) => logs.push(log.message),
    // The Worker's own fetches: Google's token and Gmail addresses go to the fake; anything else is refused and noted.
    outboundService: async (request) => {
      const url = new URL(request.url);
      if (!GOOGLE_HOSTS.has(url.hostname)) {
        const answer = await options.web?.(request);
        if (answer) return answer;
        outside.push(url.href);
        return new MiniflareResponse("Refused by the test", { status: 502 });
      }
      const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
      if (options.google) {
        requestLog.push({ account: fake, at: Date.now(), path: `${url.pathname}${url.search}` });
        const answer = await options.google.fetch(url.href, { method: request.method, headers: Object.fromEntries(request.headers), ...(body !== undefined && { body }) });
        return new MiniflareResponse(await answer.arrayBuffer(), { status: answer.status, headers: Object.fromEntries(answer.headers) });
      }
      const account = accountOf(url, request.headers as unknown as Headers, body);
      const counted = request.method === "GET" && /\/messages\/[^/]+(\/attachments\/[^/]+)?$/.test(url.pathname);
      requestLog.push({ account, at: Date.now(), path: `${url.pathname}${url.search}` });
      if (counted) peak = Math.max(peak, ++inFlight);
      try {
        const answer = await account.fetch(url.href, { method: request.method, headers: Object.fromEntries(request.headers), ...(body !== undefined && { body }) });
        return new MiniflareResponse(await answer.arrayBuffer(), { status: answer.status, headers: Object.fromEntries(answer.headers) });
      } finally {
        if (counted) inFlight--;
      }
    },
  }));
  await mf.ready;

  const call: TestServer["call"] = async (method, path, body, token, headers = {}) => {
    const response = await mf.dispatchFetch(path.startsWith("http") ? path : BASE + path, {
      method,
      headers: { ...(token && { authorization: `Bearer ${token}` }), ...(body !== undefined && { "content-type": "application/json" }), ...headers },
      ...(body !== undefined && { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    const text = await response.text();
    const json = text && response.headers.get("content-type")?.includes("json");
    return { status: response.status, headers: response.headers as unknown as Headers, body: json ? JSON.parse(text) : text };
  };
  const sql: TestServer["sql"] = async (query, ...params) => {
    const answer = await call("POST", "/__test/sql", { query, params });
    if (answer.status !== 200) throw new Error(`SQL failed: ${JSON.stringify(answer.body)}`);
    return answer.body;
  };
  const server: TestServer = {
    mf,
    fake,
    second,
    peakMessageRequests: () => peak,
    requestLog,
    logs,
    outside,
    call,
    sql,
    async evict() {
      // The reset fails the request that asked for it; the next request or alarm makes a new object.
      await mf.dispatchFetch(`${BASE}/__test/evict`, { method: "POST" }).then((response) => response.arrayBuffer(), () => undefined);
    },
    async pair() {
      const [row] = await sql<{ code: string }>("SELECT code FROM owner_pairing_code");
      if (!row) throw new Error("No owner's code waits in owner_pairing_code");
      const paired = await call("POST", "/v1/pair", { code: row.code, name: "Workerd test" });
      if (paired.status !== 200) throw new Error(`Pairing failed: ${paired.status} ${JSON.stringify(paired.body)}`);
      return { code: row.code, token: paired.body.token };
    },
    logged(pattern, from = 0) {
      return logs.slice(from).filter((line) => pattern.test(line));
    },
    async stop() {
      await mf.dispose();
      await rm(build.dir, { recursive: true, force: true });
    },
  };
  return server;
}

/** Waits until `test` gives a truthy value, polling every 100 ms. */
export async function until<T>(what: string, test: () => Promise<T | undefined | null | false> | T | undefined | null | false, timeoutMs = 20_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await Promise.resolve().then(test).catch(() => undefined);
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Connects a Gmail inbox for a fake's account through REST, as an app does with credentials given by hand. */
export async function connectGmail(server: TestServer, token: string, account: FakeGmail = server.fake): Promise<{ id: string }> {
  const name = account === server.fake ? "Work" : "Home";
  const connected = await server.call("POST", "/v1/inboxes", { name, color: "#2F6FED", provider: "gmail", credentials: account.credentials }, token);
  if (connected.status !== 200) throw new Error(`Connecting Gmail failed: ${connected.status} ${JSON.stringify(connected.body)}`);
  return connected.body;
}

/** The workerd process Miniflare started for this test file, for its memory. */
export function workerdPid(): number {
  const children = execFileSync("pgrep", ["-P", String(process.pid)], { encoding: "utf8" }).trim().split(/\s+/).map(Number);
  for (const pid of children) {
    const command = execFileSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8" }).trim();
    if (command.endsWith("workerd")) return pid;
  }
  throw new Error("Can't find the workerd process");
}

/** A process's resident memory in bytes. */
export function residentBytes(pid: number): number {
  return Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim()) * 1024;
}
