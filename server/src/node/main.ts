// The Node entry point: `node src/node/main.ts` from source, or `node dist/server.mjs` after `npm run build`.
// A SQLite file and a key file in the data directory; live updates and timers from this process; providers
// and interfaces from `parts.ts`.

import { serve } from "@hono/node-server";
import sample from "@usualmail/core/fixtures/sample.json" with { type: "json" };
import type { SampleData } from "@usualmail/core";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderOptions } from "@usualmail/core";
import { FakeModels } from "../ai/fake.ts";
import type { GoogleOptions } from "../google/config.ts";
import type { AiModelAccess } from "../ai/models.ts";
import { sdkModelAccess } from "../ai/sdk.ts";
import { DEMO_SUFFIXES, demoModels, demoProviders, seedSample, seedSamplePictures } from "../demo/seed.ts";
import { consoleLog, MemoryEventBus, systemClock, webRandom, type Host } from "../host.ts";
import { SERVER_VERSION } from "../index.ts";
import { checkInterfaces, providerRegistry } from "../parts.ts";
import { createApp } from "../rest/app.ts";
import { aesGcmSecrets } from "../secrets.ts";
import { MailServer } from "../service/server.ts";
import { readConfig, USAGE } from "./config.ts";
import { firstSyncDays, firstSyncWords, saveFirstSyncDays } from "./settings.ts";
import { fakeAuthorizationUrl, fakeGoogleFetch, googleClientSource, redirectUriFor, saveGoogleClientFile, savedGoogleClient } from "./google.ts";
import { openDatabase } from "./db.ts";
import { loadSecretKey, nodeScheduler } from "./host.ts";
import { ownerCodeLines, ownerCodePath, readOwnerCode, removeOwnerCode, writeOwnerCode } from "./owner-code.ts";
import { parts } from "./parts.ts";
import { DiskPictureSource } from "./pictures/cache.ts";
import { NodeSiteIcons } from "./avatars/site.ts";
import { SENDER_PICTURES_OFF, senderPicturesOn } from "../avatars/service.ts";
import { SHIPPED_SUFFIXES, SHIPPED_SUFFIXES_SOURCE } from "../avatars/shipped.ts";

let config;
try {
  config = readConfig(process.argv.slice(2), process.env);
  checkInterfaces(parts.interfaces);
} catch (error) {
  console.error(`${(error as Error).message}\n\n${USAGE}`);
  process.exit(2);
}
if (config.help) {
  console.log(USAGE);
  process.exit(0);
}

const random = webRandom;
let url = ":memory:";
let key = random.bytes(32);
if (!config.demo) {
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const file = join(config.dataDir, "usual-mail.db");
  // Created empty and owner-only first, so SQLite's -wal and -shm files take the same permissions.
  await writeFile(file, "", { mode: 0o600, flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  url = `file:${file}`;
  key = await loadSecretKey(config.dataDir, config.secretKey, random);
}
// How many days of mail a new inbox's first sync takes: USUAL_MAIL_SYNC_DAYS, else the data directory's settings.json.
let firstSync;
try {
  firstSync = await firstSyncDays(config.syncWindowDays, config.demo ? null : config.dataDir);
} catch (error) {
  console.error((error as Error).message);
  process.exit(2);
}
const store = await openDatabase(url);
const host: Host = {
  db: store.db,
  clock: systemClock,
  scheduler: nodeScheduler,
  random,
  events: new MemoryEventBus(),
  secrets: await aesGcmSecrets(key, random),
  log: consoleLog,
  // The machine's own time zone, or the one TZ names (a host that sets none, as many containers, gives UTC).
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  // Pictures from the web that messages show, fetched when first opened and kept in <data-dir>/pictures. Demo mode
  // fetches nothing: its sample mail is made up.
  ...(!config.demo && { pictures: new DiskPictureSource({ dir: join(config.dataDir, "pictures") }) }),
  // Sender pictures from organisations' own sites, under the same rules; kept in the store. Demo mode fetches nothing.
  ...(!config.demo && { siteIcons: new NodeSiteIcons() }),
};

const demo = config.demo ? demoProviders(() => host.clock.now()) : null;
// The server's AI: fake models in demo mode and behind the development-only switch; the AI SDK otherwise.
let models: AiModelAccess = sdkModelAccess();
if (config.demo) models = demoModels(sample as SampleData);
else if (config.devFakeAi) {
  models = new FakeModels({
    label: "development fake models",
    defaults: { categorize: "dev-fake/categorize", summarize: "dev-fake/summarize" },
    // On the gateway, the fake knows its two models' kinds, so choosing one for the other job fails the test in words.
    kinds: { "dev-fake/categorize": "decision", "dev-fake/summarize": "language" },
  });
  console.log("DEVELOPMENT ONLY: --dev-fake-ai is on. The AI answers from fake models; no AI service is called.");
}
// Google sign-in: the host's client from the environment or <data-dir>/google-client.json, read when needed (a
// person's device may write the file through PUT /v1/google/client); the redirect address from the settings and the
// port the server listens on. Never in demo mode.
let listeningPort = config.port;
const redirectUri = () => redirectUriFor(config, listeningPort);
const fakeGoogle = config.devFakeGoogle;
const googleFetch = fakeGoogle ? fakeGoogleFetch(fakeGoogle) : undefined;
const google: GoogleOptions | undefined = config.demo ? undefined : {
  client: googleClientSource({ dataDir: config.dataDir, env: config.googleClient, log: consoleLog, redirectUri }),
  redirectUri,
  clientFromEnvironment: config.googleClient !== null,
  saveClient: (file) => saveGoogleClientFile(config.dataDir, file),
  savedClient: savedGoogleClient(config.dataDir),
  ...(fakeGoogle && googleFetch && { authorizationUrl: fakeAuthorizationUrl(fakeGoogle), fetch: googleFetch }),
};
const providers = demo?.providers ?? providerRegistry(parts);
if (googleFetch) {
  // The Gmail provider reaches the fake too: its token and API addresses go through the same rewriting.
  const gmail = providers.get("gmail");
  if (gmail) providers.register("gmail", (credentials, options) => gmail(credentials, { ...options, fetch: googleFetch } as ProviderOptions));
  console.log(`DEVELOPMENT ONLY: --dev-fake-google is on. Google's sign-in, token and Gmail addresses go to ${fakeGoogle}; nothing reaches Google.`);
}
const server = await MailServer.create(host, {
  providers,
  google,
  models,
  pollIntervalMs: config.pollIntervalMs,
  syncWindowDays: firstSync.days,
  syncWindowSetBy: firstSync.from,
  // A person may change the window while the server runs; it is kept in settings.json. Not in demo mode.
  ...(!config.demo && { saveSyncWindowDays: (days: number) => saveFirstSyncDays(config.dataDir, days) }),
  version: SERVER_VERSION,
  // Demo mode keeps the sample as it is: only new mail goes to the (fake) AI.
  aiHistory: !config.demo,
  // Demo mode's made-up mail is all at .example domains: its own list, so its sample pictures show.
  ...(config.demo && { avatars: { suffixes: DEMO_SUFFIXES } }),
});
if (demo) {
  const data = sample as SampleData;
  // Whole seconds, so the shifted times look like the sample's.
  const shift = Math.floor((host.clock.now() - Date.parse(data.now)) / 1000) * 1000;
  await seedSample(host, demo, data, shift);
  await seedSamplePictures(host, data);
  await server.reload();
}
await server.start();

const app = createApp(server, { scheduler: nodeScheduler, log: consoleLog, interfaces: parts.interfaces });
const listening = Promise.withResolvers<void>();
const http = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  listeningPort = info.port;
  const where = config.demo ? "demo mode, sample data in memory" : `data in ${config.dataDir}`;
  console.log(`Usual Mail server ${SERVER_VERSION} on http://${config.host}:${info.port} (${where}; AI through ${models.label})`);
  listening.resolve();
});
await listening.promise;
console.log(firstSyncWords(firstSync, config.dataDir));
if (!SHIPPED_SUFFIXES) console.log(SENDER_PICTURES_OFF);
else if (!config.demo) console.log(senderPicturesOn(SHIPPED_SUFFIXES_SOURCE));
if (google) {
  const info = await server.info();
  const sign = info.googleSignIn;
  console.log(sign.available
    ? `Google sign-in is available; Google sends people back to ${sign.redirectUri}.`
    : `Google sign-in is off: ${(sign.missing ?? []).map((part) => (part === "client" ? "no Google client (usual-mail google set)" : "no public address (--public-url)")).join(" and ")}.`);
}

// The owner's code, whenever no person's device is paired: at start, when it expires unused, and after the last
// person's device is removed. A code is printed once, when it is made; outside demo mode it is also written to
// <data-dir>/owner-pairing-code for the usual-mail command, and the file goes once a person's device pairs. A later
// start that finds the file's code still waiting keeps it and says where the file is, without printing the code, so
// the log never repeats it. Demo mode writes nothing to disk.
let files: Promise<void> = Promise.resolve();
const ownerFile = config.demo ? null : ownerCodePath(config.dataDir);
const kept = config.demo ? null : await readOwnerCode(config.dataDir);
await server.keepOwnerCode((code, made) => {
  for (const line of ownerCodeLines(code, made, ownerFile)) console.log(line);
  if (config.demo || (code && !made)) return;
  const dataDir = config.dataDir;
  files = files
    .then(() => (code ? writeOwnerCode(dataDir, code.code) : removeOwnerCode(dataDir)))
    .catch((error) => consoleLog.error("Couldn't update the owner's pairing code file", error));
}, kept ? { kept } : {});
await files;

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    http.close();
    void server.stop().finally(() => {
      store.close();
      process.exit(0);
    });
  });
}
