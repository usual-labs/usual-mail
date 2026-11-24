// Starts the built bundle (dist/server.mjs) itself, as the Docker image and `usual-mail init --mode node` do, on a
// scratch data directory, and checks it end to end over HTTP: /healthz, the owner's code file, pairing, the
// dashboard and the connector, and an IMAP inbox on a test IMAP and SMTP server in this process (connect, sync,
// send). Bundling can break code that runs fine from source (a dynamic require, a file read at run time), so
// `npm run check` runs this after `npm run build`. Exits non-zero with the reason when anything fails.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const hoodiecrow = require("hoodiecrow-imap");
const { SMTPServer } = require("smtp-server");
// USUAL_MAIL_BUNDLE names another built file to test, such as one in an image's layout.
const bundle = process.env.USUAL_MAIL_BUNDLE || fileURLToPath(new URL("../dist/server.mjs", import.meta.url));
const USER = "me@mail.example";
const PASSWORD = "smoke-password";

const dataDir = await mkdtemp(join(tmpdir(), "usual-mail-smoke-"));
const imap = hoodiecrow({
  plugins: ["ENABLE", "CONDSTORE", "IDLE", "SPECIAL-USE", "NAMESPACE", "UIDPLUS", "MOVE", "ID", "UNSELECT", "LITERALPLUS"],
  storage: { INBOX: {}, "": { separator: "/", folders: { Archive: { "special-use": "\\Archive" }, Sent: { "special-use": "\\Sent" }, Trash: { "special-use": "\\Trash" } } } },
  users: { [USER]: { password: PASSWORD } },
});
await new Promise((resolve) => imap.listen(0, "127.0.0.1", resolve));
let sent = 0;
const smtp = new SMTPServer({
  disabledCommands: ["STARTTLS"], authOptional: true, logger: false,
  onAuth: (_auth, _session, callback) => callback(null, { user: USER }),
  onData(stream, _session, callback) {
    stream.on("data", () => {});
    stream.on("end", () => { sent++; callback(); });
  },
});
await new Promise((resolve) => smtp.listen(0, "127.0.0.1", resolve));

let output = "";
const server = spawn(process.execPath, [bundle, "--data-dir", dataDir, "--port", "0"], {
  env: { ...process.env, USUAL_MAIL_POLL_SECONDS: "5", USUAL_MAIL_SECRET_KEY: "", USUAL_MAIL_GOOGLE_CLIENT_ID: "", USUAL_MAIL_GOOGLE_CLIENT_SECRET: "", USUAL_MAIL_PUBLIC_URL: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (chunk) => (output += chunk));
server.stderr.on("data", (chunk) => (output += chunk));
let gone = false;
const exited = new Promise((resolve) => server.on("exit", (code, signal) => {
  gone = true;
  resolve({ code, signal });
}));

/** Starts the bundle on `dir`, waits until it answers and has said what it says about the owner's code. */
async function startOnce(dir, env = {}) {
  let said = "";
  const child = spawn(process.execPath, [bundle, "--data-dir", dir, "--port", "0"], {
    env: { ...process.env, USUAL_MAIL_SECRET_KEY: "", USUAL_MAIL_GOOGLE_CLIENT_ID: "", USUAL_MAIL_GOOGLE_CLIENT_SECRET: "", USUAL_MAIL_PUBLIC_URL: "", USUAL_MAIL_SYNC_DAYS: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => (said += chunk));
  child.stderr.on("data", (chunk) => (said += chunk));
  const ended = new Promise((resolve) => child.on("exit", resolve));
  const end = Date.now() + 20_000;
  let base = "";
  while (!base || !/Pair your first device|is waiting/.test(said)) {
    if (child.exitCode !== null) throw new Error(`The bundle exited at start: ${said}`);
    if (Date.now() > end) throw new Error(`The bundle didn't start: ${said}`);
    const port = /on http:\/\/127\.0\.0\.1:(\d+)/.exec(said)?.[1];
    if (port) base = `http://127.0.0.1:${port}`;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return {
    base,
    output: () => said,
    async stop() {
      child.kill("SIGTERM");
      await ended;
    },
  };
}

async function until(what, test, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await test().catch(() => undefined);
    if (value) return value;
    if (gone) throw new Error(`The bundle exited while waiting for ${what}`);
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

let failure;
try {
  const port = await until("the bundle to say where it listens", async () => /on http:\/\/127\.0\.0\.1:(\d+)/.exec(output)?.[1]);
  const base = `http://127.0.0.1:${port}`;
  let token = "";
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(token && { authorization: `Bearer ${token}` }), ...(body !== undefined && { "content-type": "application/json" }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text };
  };
  const expect = (what, condition) => {
    if (!condition) throw new Error(what);
  };

  await until("/healthz", async () => (await fetch(`${base}/healthz`)).ok);
  const code = (await readFile(join(dataDir, "owner-pairing-code"), "utf8")).trim();
  const paired = await call("POST", "/v1/pair", { code, name: "Smoke test" });
  expect(`pairing with the owner's code: ${paired.status}`, paired.status === 200);
  token = paired.body.token;
  await until("the owner's code file to go once used", async () => !(await readFile(join(dataDir, "owner-pairing-code")).then(() => true, () => false)));

  expect("GET /sign-in answers from the dashboard", (await call("GET", "/sign-in")).status === 200);
  const ai = await call("GET", "/v1/ai/status");
  expect(`the AI's status before a key is set: ${JSON.stringify(ai.body)}`, ai.status === 200 && ai.body.state === "not_set_up");
  expect("the bundle reaches models through the AI SDK, not a fake", /AI through AI SDK/.test(output));
  // Without a Google client the server says Google sign-in is off, and knows its own loopback address for it.
  const info = await call("GET", "/v1/info");
  const google = info.body.googleSignIn;
  expect(`Google sign-in off without a client: ${JSON.stringify(google)}`,
    google?.available === false && google.redirectUri === `${base}/v1/google/callback` && google.missing?.join() === "client");
  expect("the start line says Google sign-in is off", /Google sign-in is off: no Google client/.test(output));
  const mcp = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  expect(`POST /mcp without a token is 401 from the connector, not ${mcp.status}`, mcp.status === 401);

  // An HTML message with a picture at a private address and a tracker: the bundle's picture pass, tracker list and
  // fetcher are checked below without reaching the network (a private address is refused before any connection).
  const html = `<p>Hello.</p><img src="http://10.0.0.5/smoke.png" alt="Smoke"><img src="https://emltrk.com/v2/smoke" alt="">`;
  const raw = `From: Dana <dana@lumen.example>\r\nTo: ${USER}\r\nSubject: Smoke\r\nMessage-ID: <smoke@lumen.example>\r\nDate: ${new Date().toUTCString()}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n`;
  imap.appendMessage("INBOX", [], new Date(), raw);
  const login = { host: "127.0.0.1", secure: false, user: USER, password: PASSWORD };
  const connected = await call("POST", "/v1/inboxes", {
    name: "Smoke", color: "#2F6FED", provider: "imap",
    credentials: { imap: { ...login, port: imap.address().port }, smtp: { ...login, port: smtp.server.address().port } },
  });
  expect(`connecting an IMAP inbox: ${JSON.stringify(connected.body)}`, connected.status === 200);
  expect("the inbox shows how it is connected, without the password",
    connected.body.connection?.imap?.host === "127.0.0.1" && !JSON.stringify(connected.body).includes(PASSWORD));
  await until("the first sync", async () => (await call("GET", "/v1/inboxes")).body[0]?.status === "ok");
  const thread = (await call("GET", "/v1/search?q=Smoke")).body.items[0];
  expect("the mailbox's message synced", thread?.subject === "Smoke");
  // Search's FTS5 index in the bundle's own libSQL: a word's start finds it, and says where it matched.
  const typed = (await call("GET", "/v1/search?q=smo")).body;
  expect("search finds a word as it is typed", typed.items[0]?.id === thread.id && typed.items[0]?.match?.fields?.[0] === "subject");
  // A search asked in a sentence, with no AI key: nothing is sent anywhere, and the sentence stands as typed.
  const asked = await call("POST", "/v1/search/ask", { question: "is:unread smoke" });
  expect(`a sentence asked without an AI key is the sentence as typed: ${JSON.stringify(asked.body)}`,
    asked.status === 200 && asked.body.ai === "not_set_up" && asked.body.found === false && asked.body.understood?.unread === true && asked.body.text === "smoke");
  const [message] = (await call("GET", `/v1/threads/${thread.id}`)).body.messages;
  const picture = /src="(\/v1\/messages\/[^"]+\/pictures\/[\w-]+)"/.exec(message?.html ?? "")?.[1];
  expect(`the message's picture points at the picture route, the tracker taken out: ${JSON.stringify(message)}`,
    picture && !message.html.includes("emltrk") && JSON.stringify(message.remotePictures) === JSON.stringify({ shown: 1, trackersRemoved: 1, trackers: ["Litmus"] }));
  // Refused by the rules before any connection, and remembered as refused: served as a blank GIF.
  const fetched = await fetch(base + picture, { headers: { authorization: `Bearer ${token}` } });
  const bytes = new Uint8Array(await fetched.arrayBuffer());
  expect(`a picture at a private address is served blank, not fetched: ${fetched.status} ${fetched.headers.get("content-type")} ${bytes.length} bytes`,
    fetched.status === 200 && fetched.headers.get("content-type") === "image/gif" && bytes.length === 42);
  const draft = await call("POST", "/v1/drafts", { inboxId: connected.body.id, threadId: thread.id, to: [{ email: "dana@lumen.example" }], subject: "Re: Smoke", body: "Hi." });
  const result = await call("POST", `/v1/drafts/${draft.body.id}/send`);
  expect(`sending over SMTP: ${JSON.stringify(result.body)}`, result.body.state === "sent" && sent === 1);
} catch (error) {
  failure = error;
} finally {
  server.kill("SIGTERM");
  const { code, signal } = await exited;
  if (!failure && code !== 0) failure = new Error(`The bundle exited with ${code ?? signal}`);
  await new Promise((resolve) => imap.close(resolve));
  await new Promise((resolve) => smtp.close(resolve));
  await rm(dataDir, { recursive: true, force: true });
}
// The development-only fake models can't be switched on by accident: off this machine the bundle refuses to start.
if (!failure) {
  const refused = spawn(process.execPath, [bundle, "--demo", "--dev-fake-ai", "--host", "0.0.0.0", "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
  let said = "";
  refused.stderr.on("data", (chunk) => (said += chunk));
  const code = await new Promise((resolve) => refused.on("exit", (exitCode) => resolve(exitCode)));
  if (code === 0 || !/dev-fake-ai is for development on this machine only/.test(said)) {
    failure = new Error(`--dev-fake-ai on 0.0.0.0 should be refused, not exit ${code} saying ${said}`);
  }
}
// So can't the fake Google.
if (!failure) {
  const refused = spawn(process.execPath, [bundle, "--demo", "--dev-fake-google", "http://127.0.0.1:9", "--host", "0.0.0.0", "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
  let said = "";
  refused.stderr.on("data", (chunk) => (said += chunk));
  const code = await new Promise((resolve) => refused.on("exit", (exitCode) => resolve(exitCode)));
  if (code === 0 || !/dev-fake-google is for development on this machine only/.test(said)) {
    failure = new Error(`--dev-fake-google on 0.0.0.0 should be refused, not exit ${code} saying ${said}`);
  }
}
// The owner's code is printed once, when it is made: a second start that finds it still waiting keeps it and says
// where its file is, without printing it, so the log never repeats it.
if (!failure) {
  const dir = await mkdtemp(join(tmpdir(), "usual-mail-smoke-restart-"));
  let said = "";
  try {
    const first = await startOnce(dir);
    said = first.output();
    let code = "";
    for (let i = 0; i < 100 && !code; i++) {
      code = (await readFile(join(dir, "owner-pairing-code"), "utf8").catch(() => "")).trim();
      if (!code) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!code || !first.output().includes(code)) throw new Error("the first start should print the owner's code it made");
    if (!/first sync takes the last 30 days of mail \(the default\)/.test(first.output())) throw new Error("the first start should say a first sync takes 30 days by default");
    await first.stop();
    // The first sync's days, saved in the data directory as `usual-mail init` and `sync-days` save them.
    await writeFile(join(dir, "settings.json"), `${JSON.stringify({ syncDays: 7 })}\n`, { mode: 0o600 });
    const second = await startOnce(dir);
    said = second.output();
    if (second.output().includes(code)) throw new Error("a second start printed the owner's code again");
    if (!/owner's pairing code made at an earlier start is waiting/.test(second.output()) || !second.output().includes(join(dir, "owner-pairing-code"))) {
      throw new Error("a second start should say the owner's code waits, and where its file is");
    }
    const paired = await fetch(`${second.base}/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: "Smoke test" }) });
    if (paired.status !== 200) throw new Error(`the kept owner's code should still pair, not answer ${paired.status}`);
    const { token } = await paired.json();
    const window = await (await fetch(`${second.base}/v1/first-sync`, { headers: { authorization: `Bearer ${token}` } })).json();
    if (window.days !== 7 || window.setBy !== "settings" || !/first sync takes the last 7 days of mail \(.*settings\.json\)/.test(second.output())) {
      throw new Error(`a plain start should take the first sync's days from settings.json, not ${window.days} (${window.setBy})`);
    }
    // A person changes the window while the server runs: kept in settings.json, owner-only, read again at a start.
    const changed = await fetch(`${second.base}/v1/first-sync`, {
      method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ days: 5 }),
    });
    const file = join(dir, "settings.json");
    const kept = JSON.parse(await readFile(file, "utf8"));
    if (changed.status !== 200 || (await changed.json()).days !== 5 || kept.syncDays !== 5 || ((await stat(file)).mode & 0o777) !== 0o600) {
      throw new Error("PATCH /v1/first-sync should keep the new days in settings.json, readable only by its owner");
    }
    await second.stop();
  } catch (error) {
    failure = error;
    output = said;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
// The image installs only what dist/runtime.package.json names next to the bundle: it must be the bundle's
// run-time dependencies, nothing a build needs.
if (!failure && !process.env.USUAL_MAIL_BUNDLE) {
  const runtime = JSON.parse(await readFile(new URL("../dist/runtime.package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  const names = Object.keys(runtime.dependencies ?? {});
  const wrong = names.filter((name) => runtime.dependencies[name] !== lock.packages?.[`node_modules/${name}`]?.version);
  if (names.join() !== "libsql" || wrong.length) {
    failure = new Error(`dist/runtime.package.json should name only libsql at the lockfile's version, not ${JSON.stringify(runtime.dependencies)}`);
  }
}
if (failure) {
  console.error(`The bundle failed its smoke test: ${failure.message}\n--- its output ---\n${output}`);
  process.exit(1);
}
console.log("The bundle started on a scratch data directory, answered /healthz, paired, served the dashboard and connector, reported the AI and Google sign-in not set up, synced, searched and sent through IMAP and SMTP, served a message's pictures through the picture route with its tracker taken out and a private address served blank unfetched, refused the development-only fake models and fake Google off this machine, and at a second start kept the owner's code without printing it, took the first sync's days from settings.json and kept a person's new days there.");
