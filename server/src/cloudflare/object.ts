// The Durable Object that holds the whole server, as the Node process does: one `MailServer` over the object's own
// SQLite, its timers and live updates in memory, the alarm as the backstop that restarts it after an eviction or a
// deploy. Requests and alarms wait on the start (start.ts): the migrations first, then the server's creation and
// `start()`; a start that fails or is cut off is tried again a bounded number of times, never in a reset loop.

import { DurableObject } from "cloudflare:workers";
import type { GmailProviderOptions } from "@usualmail/mail/gmail";
import { sdkModelAccess } from "../ai/sdk.ts";
import { consoleLog, MemoryEventBus, systemClock, webRandom, type Host, type HostLimits } from "../host.ts";
import { SERVER_VERSION } from "../version.ts";
import { CLOUDFLARE_LIMITS } from "./limits.ts";
import { startRefusal, Starts, type Started } from "./start.ts";
import { webSources } from "./web/sources.ts";
import { checkInterfaces, providerRegistry } from "../parts.ts";
import { createApp } from "../rest/app.ts";
import { aesGcmSecrets } from "../secrets.ts";
import { MailServer } from "../service/server.ts";
import { migrateStore, openDatabase } from "./database.ts";
import type { Env } from "./env.ts";
import { OwnHosts, readPublicUrl, requestRedirectUri } from "./address.ts";
import { cloudflareGoogle, googleStartWords } from "./google.ts";
import { createOwnerCodeTable, keepOwnerCodeInTable, SpentOwnerCodes } from "./owner-code.ts";
import { AddressCounter } from "./pairing.ts";
import { CLOUDFLARE_GMAIL, cloudflareParts } from "./parts.ts";
import { personPairedIn, RequestDoor } from "./requests.ts";
import { firstSyncDays, firstSyncWords, saveFirstSyncDays, ServerTimeZone } from "./settings.ts";
import { objectSecretKey } from "./secret-key.ts";
import { AlarmTimers, BACKSTOP_MS, plainTimers } from "./timers.ts";

/** What a test entry may change (server/test/cloudflare/worker/); the deployed object always uses the defaults. */
export interface ObjectOptions {
  /** How far ahead the alarm is kept while the server has an inbox. */
  backstopMs: number;
  /** The Gmail provider's limits. */
  gmail: GmailProviderOptions;
  /** Runs the store's migrations. Default: the durable migrator. A test entry makes one slow, failing or cut off. */
  migrate?: (ctx: DurableObjectState) => Promise<void>;
  /** The host's limits on memory and stored size. Default: `CLOUDFLARE_LIMITS`. */
  limits?: HostLimits;
}

/** The running server's request handler: the REST routes, the connector and the dashboard. */
type Handler = (request: Request) => Response | Promise<Response>;

function hasInbox(sql: SqlStorage): boolean {
  return sql.exec<{ found: number }>("SELECT EXISTS (SELECT 1 FROM inboxes) AS found").one().found === 1;
}

export class UsualMailServer extends DurableObject<Env> {
  readonly #timers: AlarmTimers;
  readonly #starts: Starts<Handler>;
  /** What first reached this instance: an alarm means it was evicted or redeployed and the backstop brought it back. */
  #firstEvent: "request" | "alarm" | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const options = this.objectOptions();
    const storage = ctx.storage;
    this.#timers = new AlarmTimers(
      { getAlarm: () => storage.getAlarm(), setAlarm: (at) => storage.setAlarm(at), hasInbox: () => hasInbox(storage.sql) },
      options.backstopMs,
      (error) => consoleLog.error("Couldn't set the server's alarm", error),
    );
    // Not inside blockConcurrencyWhile: requests and alarms wait on the start, which runs the migrations first (start.ts).
    this.#starts = new Starts(
      { storage, hasInbox: () => hasInbox(storage.sql), reset: (reason) => ctx.abort(reason), log: consoleLog },
      options.backstopMs,
      () => this.#start(options),
      () => this.#firstEvent === "alarm",
    );
  }

  /** The deployed object's options. Only a test entry overrides this. */
  protected objectOptions(): ObjectOptions {
    return { backstopMs: BACKSTOP_MS, gmail: CLOUDFLARE_GMAIL };
  }

  async #start(options: ObjectOptions): Promise<Started<Handler>> {
    const began = Date.now();
    const storage = this.ctx.storage;
    // The migrations (one synchronous transaction), then the host's own tables, before anything reads the store.
    await (options.migrate ?? ((ctx) => migrateStore(ctx.storage)))(this.ctx);
    createOwnerCodeTable(storage.sql);
    const publicUrl = readPublicUrl(this.env.USUAL_MAIL_PUBLIC_URL);
    if (publicUrl.problem) consoleLog.info(publicUrl.problem);
    const ownHosts = new OwnHosts(publicUrl.origin);
    const web = webSources(storage, (host) => ownHosts.has(host));
    // Before the server sets any timer, so a timer never overwrites the alarm being delivered now.
    await this.#timers.load();
    const parts = cloudflareParts(options.gmail);
    checkInterfaces(parts.interfaces);
    // The settings the Worker's variables give or the object's storage keeps (settings.ts, address.ts).
    const zone = new ServerTimeZone(storage.kv, this.env, consoleLog);
    const firstSync = firstSyncDays(storage.kv, this.env, consoleLog);
    const host: Host = {
      db: openDatabase(storage),
      clock: systemClock,
      scheduler: this.#timers,
      random: webRandom,
      events: new MemoryEventBus(),
      secrets: await aesGcmSecrets(objectSecretKey(storage.kv, this.env.USUAL_MAIL_SECRET_KEY, webRandom), webRandom),
      log: consoleLog,
      // The first pairing's zone, or USUAL_MAIL_TIME_ZONE; read whenever it is needed, so a pairing sets it at once.
      get timeZone() {
        return zone.current;
      },
      // Pictures from the web kept in the object's SQLite, and sites' icons, under Node's rules where Workers allow (web/).
      pictures: web.pictures,
      siteIcons: web.siteIcons,
      // Smaller batches, plans and stored messages than Node's, and search's catch-up in the background (limits.ts).
      limits: options.limits ?? CLOUDFLARE_LIMITS,
    };
    const models = sdkModelAccess();
    // Google sign-in: the client a person's device gives (sealed in storage) or the Worker's secrets; the redirect
    // address from the request being answered.
    const google = cloudflareGoogle({ kv: storage.kv, secrets: host.secrets, env: this.env, log: consoleLog, redirectUri: requestRedirectUri });
    const server = await MailServer.create(host, {
      providers: providerRegistry(parts),
      models,
      google,
      syncWindowDays: firstSync.days,
      syncWindowSetBy: firstSync.from,
      saveSyncWindowDays: async (days) => saveFirstSyncDays(storage.kv, days),
      version: SERVER_VERSION,
    });
    await server.start();
    const app = createApp(server, { scheduler: plainTimers, log: consoleLog, interfaces: parts.interfaces });
    consoleLog.info(`Usual Mail server ${SERVER_VERSION} started in its Durable Object in ${Date.now() - began} ms (Gmail only; AI through ${models.label})`);
    consoleLog.info(firstSyncWords(firstSync));
    consoleLog.info(zone.startWords());
    consoleLog.info(googleStartWords(google, publicUrl.origin, (await google.client()) !== null));

    // The owner's code in its table; one that expired while the object was evicted is removed and refused in words.
    const spent = new SpentOwnerCodes();
    await keepOwnerCodeInTable(server, storage.sql, consoleLog, spent, Date.now());
    const door = new RequestDoor({
      publicOrigin: publicUrl.origin,
      counter: new AddressCounter(() => Date.now()),
      spent,
      timeZone: zone,
      personPaired: () => personPairedIn(storage.sql),
      ownHosts,
    });

    await this.#timers.keep();
    // The start counts as done once search's catch-up, which runs after it here, has finished too (start.ts).
    return { value: (request) => door.serve(request, (forwarded) => app.fetch(forwarded)), settled: server.whenSearchCaughtUp() };
  }

  override async fetch(request: Request): Promise<Response> {
    this.#firstEvent ??= "request";
    let handle: Handler;
    try {
      handle = await this.#starts.current();
    } catch (error) {
      return startRefusal(error);
    }
    return handle(request);
  }

  override async alarm(): Promise<void> {
    if (this.#firstEvent === null) {
      this.#firstEvent = "alarm";
      consoleLog.info("The server was started by its alarm (after an eviction or a deploy).");
    }
    try {
      await this.#starts.current();
    } catch (error) {
      // The start failed or waits: the alarm is set again for the next try, never left unset while there is an inbox.
      await this.#starts.rearm(error);
      return;
    }
    this.#timers.fired();
    await this.#timers.keep();
  }
}
