// `MailServer` implements core's `MailService` over the store, plus what the hosts need: start and stop,
// signing in with a token, the owner's first pairing code and attachments.

import {
  CATEGORIES,
  ServiceError,
  STACKS,
  type ActInput,
  type ActResult,
  type AllowSenderInput,
  type BlockedSender,
  type SendersQuery,
  type AiConnection,
  type AiDisclosure,
  type AiSettings,
  type AiSettingsPatch,
  type AiStatus,
  type AiUsage,
  type AiUsageQuery,
  type FirstSyncWindow,
  type FirstSyncWindowPatch,
  type Brief,
  type BriefInput,
  type Caller,
  type Category,
  type ConnectInboxInput,
  type Counts,
  type Device,
  type Draft,
  type DraftInput,
  type GoogleClientInput,
  type GoogleClientSaved,
  type GoogleSetup,
  type GoogleSignIn,
  type GoogleSignInInput,
  type GoogleSignInStart,
  type HandledItem,
  type HandledQuery,
  type Id,
  type Inbox,
  type InboxPatch,
  type ListQuery,
  type MailEvent,
  type MailService,
  type Page,
  type PairingCode,
  type PairingCodeInput,
  type PairInput,
  type PairResult,
  type RemoteSearchResult,
  type Rule,
  type RuleDraft,
  type SearchAskInput,
  type SearchAskResult,
  type SearchQuery,
  type SearchResult,
  type RuleSource,
  type ServerInfo,
  type Stack,
  type Thread,
  type ThreadDetail,
  type TriageDecision,
  type TriageItem,
} from "@usualmail/core";
import { and, eq } from "drizzle-orm";
import { applyPaymentRulesOnce, ASK_AGAIN, askAgainOnce, askDetailsAgainOnce, askEventsAgainOnce, regroupEventsOnce, remakeSnippetsOnce, type AskAgain } from "../ai/ask-again.ts";
import type { AiModelAccess } from "../ai/models.ts";
import { CostLookups } from "../ai/costs.ts";
import { AiRunner } from "../ai/runner.ts";
import * as ai from "../ai/settings.ts";
import { readUsage, startUsage } from "../ai/usage.ts";
import { Avatars, suffixListOf, type AvatarOptions } from "../avatars/service.ts";
import { attachments, messages } from "../db/index.ts";
import type { GoogleOptions } from "../google/config.ts";
import * as googleClient from "../google/setup.ts";
import * as google from "../google/sign-in.ts";
import type { CallbackPage } from "../google/store.ts";
import { upgradeStore } from "../db/upgrade.ts";
import type { Host, ServedPicture, WebPicture } from "../host.ts";
import type { ProviderRegistry } from "../providers.ts";
import { SyncEngine } from "../sync/engine.ts";
import { askSearch } from "../search/ask.ts";
import { SearchIndex } from "../search/indexer.ts";
import { searchLocal } from "../search/local.ts";
import * as remote from "../search/remote.ts";
import { sentKey } from "../sync/identity.ts";
import { errorMessage } from "../util.ts";
import * as acting from "./act.ts";
import { canSee, isPerson, loadAccessCache, mayRead } from "./access.ts";
import * as briefs from "./briefs.ts";
import { ChangeNotifier } from "./changes.ts";
import { Ctx, type ServiceOptions } from "./context.ts";
import { countsFor } from "./counts.ts";
import * as devices from "./devices.ts";
import * as drafts from "./drafts.ts";
import * as firstSync from "./first-sync.ts";
import * as inboxes from "./inboxes.ts";
import * as rules from "./rules.ts";
import * as pictures from "./pictures.ts";
import { listSenders } from "./senders.ts";
import { getInbox } from "./store.ts";
import { answerTeach } from "./teach.ts";
import * as views from "./views.ts";

export interface MailServerOptions extends ServiceOptions {
  providers: ProviderRegistry;
  /** How the server's AI reaches models: the AI SDK in a normal run, a fake in tests and demo mode. */
  models: AiModelAccess;
  /** Google sign-in for Gmail: the host's Google client and the server's own address. Absent: not available. */
  google?: GoogleOptions;
  /** Which of the AI's own filings are asked again, once per store (`ASK_AGAIN` unless set; tests name others). */
  askAgain?: AskAgain;
  /** Sender pictures: the Public Suffix List (the shipped one unless set) and, for tests, the queue's limits. */
  avatars?: AvatarOptions;
}

export interface AttachmentFile {
  data: Uint8Array;
  filename: string;
  mimeType: string;
  inline: boolean;
}

export class MailServer implements MailService {
  readonly #ctx: Ctx;
  readonly #engine: SyncEngine;
  readonly #changes: ChangeNotifier;
  readonly #runner: AiRunner;
  readonly #costs: CostLookups;
  readonly #avatars: Avatars;
  readonly #search: SearchIndex;

  private constructor(ctx: Ctx, engine: SyncEngine, avatars: AvatarOptions) {
    this.#ctx = ctx;
    this.#engine = engine;
    this.#changes = new ChangeNotifier(ctx, (work) => engine.track(work));
    this.#runner = new AiRunner(ctx, (work) => engine.track(work));
    ctx.changes = this.#changes;
    ctx.aiQueue = this.#runner;
    this.#costs = new CostLookups(ctx, (work) => engine.track(work));
    ctx.costLookups = this.#costs;
    ctx.background = (work) => engine.track(work);
    this.#avatars = new Avatars(ctx, avatars, (work) => engine.track(work));
    this.#search = new SearchIndex(ctx, (work) => engine.track(work));
  }

  /** Builds the service over a migrated store. Call `start()` to begin syncing. */
  static async create(host: Host, options: MailServerOptions): Promise<MailServer> {
    const ctx = new Ctx(host, options.providers, options.models, options);
    ctx.google = options.google ?? null;
    const engine = new SyncEngine(ctx);
    ctx.hooks = engine.hooks();
    await upgradeStore(ctx);
    // Before demo mode seeds its sample and before the AI's queue starts: the store's own threads, once.
    await ctx.lock.run(async () => { await askAgainOnce(ctx, options.askAgain ?? ASK_AGAIN); await askDetailsAgainOnce(ctx); await askEventsAgainOnce(ctx); await applyPaymentRulesOnce(ctx, suffixListOf(options.avatars ?? {})); await remakeSnippetsOnce(ctx); await regroupEventsOnce(ctx); });
    await loadAccessCache(ctx);
    await inboxes.fillConnections(ctx);
    return new MailServer(ctx, engine, options.avatars ?? {});
  }

  /** Re-reads what the service caches from the store, after something wrote to it directly (the demo). */
  async reload(): Promise<void> {
    await loadAccessCache(this.#ctx);
  }

  /**
   * Starts syncing every inbox that isn't paused, and the come-back timer. First, a draft still `sending` was cut off
   * by a stop: it fails, saying it may have gone out.
   */
  async start(): Promise<void> {
    await this.#ctx.lock.run(() => drafts.failStoppedSends(this.#ctx));
    await this.#ctx.lock.run(() => drafts.pruneSentIds(this.#ctx));
    // Since when the AI's usage is kept (the first start with it), and hours older than 90 days dropped.
    await this.#ctx.lock.run(() => startUsage(this.#ctx));
    await this.#changes.start();
    // Search's index follows what is stored before syncing starts: at a first start it is built here.
    await this.#search.start();
    await this.#engine.start();
    this.#runner.start();
    this.#costs.start();
    this.#avatars.start();
  }

  stop(): Promise<void> {
    this.#ctx.ownerCode?.cancelExpiry?.();
    this.#ctx.ownerCode = null;
    this.#runner.stop();
    this.#costs.stop();
    this.#avatars.stop();
    this.#search.stop();
    this.#changes.stop();
    return this.#engine.stop();
  }

  /**
   * Resolves once search's index has caught up with what was stored at the start: at once on Node, whose `start()`
   * waits for it; after the background catch-up on a host with `searchInBackground` (Cloudflare).
   */
  whenSearchCaughtUp(): Promise<void> {
    return this.#search.current();
  }

  /** Resolves once no sync, write-back or come-back work is queued or running. */
  whenIdle(): Promise<void> {
    return this.#engine.idle();
  }

  authenticate(token: string): Promise<Caller | null> {
    return devices.authenticate(this.#ctx, token);
  }

  /**
   * A new pairing code for the owner, or null once a person's device is paired. Earlier owner codes stop working,
   * so only the newest one printed works. Tests use it; a host uses `keepOwnerCode`.
   */
  ownerPairingCode(): Promise<PairingCode | null> {
    return this.#ctx.lock.run(() => devices.ownerPairingCode(this.#ctx));
  }

  /**
   * Keeps an owner's pairing code whenever no person's device is paired: at start, when the code expires unused,
   * and after the last person's device is removed, so the owner is never locked out. `listener` hears the current
   * code at once (null when a person's device is paired), each new code, and null once a person pairs; `made` says
   * whether the code was made just now. `kept` is the code the host still holds from an earlier start (its file):
   * while it is valid and unused it is kept rather than replaced, and heard with `made` false. The host prints a code
   * only when it is made and, as an ordinary process, writes it to its file.
   */
  keepOwnerCode(listener: devices.OwnerCodeListener, options: { kept?: string } = {}): Promise<void> {
    return this.#ctx.lock.run(() => devices.keepOwnerCode(this.#ctx, listener, options));
  }

  async fetchAttachment(caller: Caller, messageId: Id, attachmentId: Id): Promise<AttachmentFile> {
    const ctx = this.#ctx;
    const message = await ctx.db.select().from(messages).where(eq(messages.id, messageId)).get();
    const inbox = message && await getInbox(ctx, message.inboxId);
    if (!message || !inbox || !mayRead(caller, inbox)) throw new ServiceError("not_found", "No such message");
    inboxes.assertNotPaused(inbox, "fetch attachments from its mailbox");
    const file = await ctx.db.select().from(attachments)
      .where(and(eq(attachments.messageId, messageId), eq(attachments.id, attachmentId))).get();
    if (!file) throw new ServiceError("not_found", "No such attachment");
    try {
      const provider = await ctx.hooks.provider(inbox.id);
      const data = await provider.fetchAttachment(message.ref, file.providerId);
      return { data, filename: file.filename, mimeType: file.mimeType, inline: file.inline };
    } catch (error) {
      throw new ServiceError("provider_error", `The mailbox didn't hand over the attachment: ${errorMessage(error)}`);
    }
  }

  /** A picture from the web a message shows, for a person's device (docs/contract.md, "Pictures from the web"). */
  fetchPicture(caller: Caller, messageId: Id, pictureId: string): Promise<ServedPicture> {
    return pictures.fetchPicture(this.#ctx, caller, messageId, pictureId);
  }

  /** A kept sender picture, for a person's device (docs/contract-avatars.md). */
  fetchAvatar(caller: Caller, id: string): Promise<WebPicture> {
    return this.#avatars.picture(caller, id);
  }

  async info(): Promise<ServerInfo> {
    return { name: "usual-mail", version: this.#ctx.options.version, apiVersion: 1, googleSignIn: await google.googleSignInInfo(this.#ctx) };
  }

  // --- Inboxes -------------------------------------------------------------------------------------------

  listInboxes(caller: Caller): Promise<Inbox[]> {
    return inboxes.listInboxes(this.#ctx, caller);
  }

  connectInbox(caller: Caller, input: ConnectInboxInput): Promise<Inbox> {
    return inboxes.connectInbox(this.#ctx, caller, input);
  }

  updateInbox(caller: Caller, id: Id, patch: InboxPatch): Promise<Inbox> {
    return inboxes.updateInbox(this.#ctx, caller, id, patch);
  }

  removeInbox(caller: Caller, id: Id): Promise<void> {
    return inboxes.removeInbox(this.#ctx, caller, id);
  }

  syncInbox(caller: Caller, id: Id): Promise<void> {
    return inboxes.syncInbox(this.#ctx, caller, id);
  }

  // --- Google sign-in ------------------------------------------------------------------------------------

  startGoogleSignIn(caller: Caller, input: GoogleSignInInput): Promise<GoogleSignInStart> {
    return google.startGoogleSignIn(this.#ctx, caller, input);
  }

  async googleSignIn(caller: Caller, id: Id): Promise<GoogleSignIn> {
    return google.googleSignIn(this.#ctx, caller, id);
  }

  /** Google sent the person's browser back to the callback: what the page says. No caller: the browser has no token. */
  finishGoogleSignIn(query: URLSearchParams): Promise<CallbackPage> {
    return google.finishGoogleSignIn(this.#ctx, query);
  }

  /** Person only: setting the host's Google client up (`GET /v1/google/setup`). Served here, not a `MailService` method. */
  googleSetup(caller: Caller): Promise<GoogleSetup> {
    return googleClient.googleSetup(this.#ctx, caller);
  }

  /** Person only: gives the server its Google client (`PUT /v1/google/client`). Served here, not a `MailService` method. */
  setGoogleClient(caller: Caller, input: GoogleClientInput): Promise<GoogleClientSaved> {
    return googleClient.setGoogleClient(this.#ctx, caller, input);
  }

  // --- Views ---------------------------------------------------------------------------------------------

  home(caller: Caller, query: ListQuery): Promise<Page<Thread>> {
    return views.home(this.#ctx, caller, query);
  }

  /** One category's list, or several merged into one in the normal order, with cursors that run across them. */
  async category(caller: Caller, category: Category | readonly Category[], query: ListQuery): Promise<Page<Thread>> {
    const names: readonly string[] = typeof category === "string" ? [category] : category;
    if (!Array.isArray(names) || names.length === 0) throw new ServiceError("invalid", "Name at least one category");
    for (const name of names) {
      if (!(CATEGORIES as readonly string[]).includes(name)) throw new ServiceError("invalid", `No category called ${String(name).slice(0, 40)}`);
    }
    return views.category(this.#ctx, caller, [...new Set(names)] as Category[], query);
  }

  async stack(caller: Caller, stack: Stack, query: ListQuery): Promise<Page<Thread>> {
    if (!(STACKS as readonly string[]).includes(stack)) throw new ServiceError("invalid", `No stack called ${stack}`);
    return views.stack(this.#ctx, caller, stack, query);
  }

  waiting(caller: Caller, query: ListQuery): Promise<Page<Thread>> {
    return views.waiting(this.#ctx, caller, query);
  }

  screening(caller: Caller, query: ListQuery): Promise<Page<Thread>> {
    return views.screening(this.#ctx, caller, query);
  }

  /** Every count of every inbox the caller may see, at the counts' latest version. */
  async counts(caller: Caller): Promise<Counts> {
    const { inboxes: all, version } = await this.#ctx.lock.run(() => this.#changes.counts());
    return countsFor(this.#ctx, caller, all, version);
  }

  handled(caller: Caller, query: HandledQuery): Promise<Page<HandledItem>> {
    return views.handled(this.#ctx, caller, query);
  }

  thread(caller: Caller, id: Id): Promise<ThreadDetail> {
    return views.threadDetail(this.#ctx, caller, id);
  }

  search(caller: Caller, query: SearchQuery): Promise<SearchResult> {
    return searchLocal(this.#ctx, caller, query, this.#search);
  }

  searchRemote(caller: Caller, query: SearchQuery): Promise<RemoteSearchResult> {
    return remote.searchRemote(this.#ctx, caller, query);
  }

  openRemote(caller: Caller, id: Id): Promise<ThreadDetail> {
    return remote.openRemote(this.#ctx, caller, id);
  }

  askSearch(caller: Caller, input: SearchAskInput): Promise<SearchAskResult> {
    return askSearch(this.#ctx, caller, input);
  }

  // --- Actions -------------------------------------------------------------------------------------------

  senders(caller: Caller, query: SendersQuery): Promise<Page<BlockedSender>> {
    return listSenders(this.#ctx, caller, query);
  }

  allowSender(caller: Caller, input: AllowSenderInput): Promise<ActResult> {
    return acting.allowSender(this.#ctx, caller, input);
  }

  act(caller: Caller, input: ActInput): Promise<ActResult> {
    return acting.act(this.#ctx, caller, input);
  }

  undo(caller: Caller, actionId: Id): Promise<ActResult> {
    return acting.undo(this.#ctx, caller, actionId);
  }

  approve(caller: Caller, actionIds: Id[]): Promise<ActResult> {
    return acting.approve(this.#ctx, caller, actionIds);
  }

  reject(caller: Caller, actionIds: Id[]): Promise<ActResult> {
    return acting.reject(this.#ctx, caller, actionIds);
  }

  // --- Rules ---------------------------------------------------------------------------------------------

  listRules(caller: Caller, inboxId: Id): Promise<Rule[]> {
    return rules.listRules(this.#ctx, caller, inboxId);
  }

  createRule(caller: Caller, draft: RuleDraft, source?: RuleSource): Promise<Rule> {
    return this.#ctx.lock.run(() => rules.createRule(this.#ctx, caller, draft, source));
  }

  updateRule(caller: Caller, id: Id, patch: Partial<Pick<Rule, "text" | "match" | "then" | "enabled">>): Promise<Rule> {
    return this.#ctx.lock.run(() => rules.updateRule(this.#ctx, caller, id, patch));
  }

  deleteRule(caller: Caller, id: Id): Promise<void> {
    return this.#ctx.lock.run(() => rules.deleteRule(this.#ctx, caller, id));
  }

  answerTeach(caller: Caller, teachId: Id, accept: boolean): Promise<Rule | null> {
    return this.#ctx.lock.run(() => answerTeach(this.#ctx, caller, teachId, accept));
  }

  // --- Triage --------------------------------------------------------------------------------------------

  async triageQueue(caller: Caller, query: { inboxId?: Id; limit?: number }): Promise<TriageItem[]> {
    const status = await this.aiStatus(caller);
    return views.triageQueue(this.#ctx, caller, query, status.state === "working");
  }

  decide(caller: Caller, decisions: TriageDecision[]): Promise<ActResult> {
    return acting.decide(this.#ctx, caller, decisions);
  }

  // --- Drafts --------------------------------------------------------------------------------------------

  listDrafts(caller: Caller, query: ListQuery): Promise<Page<Draft>> {
    return drafts.listDrafts(this.#ctx, caller, query);
  }

  saveDraft(caller: Caller, input: DraftInput): Promise<Draft> {
    return this.#ctx.lock.run(() => drafts.saveDraft(this.#ctx, caller, input));
  }

  deleteDraft(caller: Caller, id: Id): Promise<void> {
    return this.#ctx.lock.run(() => drafts.deleteDraft(this.#ctx, caller, id));
  }

  async sendDraft(caller: Caller, id: Id): Promise<Draft> {
    const ctx = this.#ctx;
    const { draft, message } = await ctx.lock.run(() => drafts.startSending(ctx, caller, id));
    let outcome: { error: unknown } | { note?: string; sentKey?: string };
    try {
      const sent = await (await ctx.hooks.provider(draft.inboxId)).send(message);
      outcome = { sentKey: await sentKey(message, sent.messageId), ...(sent.note && { note: sent.note }) };
    } catch (error) {
      outcome = { error };
    }
    const result = await ctx.lock.run(() => drafts.finishSending(ctx, draft, outcome));
    // The sent message joins its thread at the next sync.
    if (result.state === "sent") ctx.hooks.requestSync(draft.inboxId);
    return result;
  }

  // --- The server's AI ------------------------------------------------------------------------------------

  aiSettings(caller: Caller): Promise<AiSettings> {
    return ai.aiSettings(this.#ctx, caller);
  }

  updateAiSettings(caller: Caller, patch: AiSettingsPatch): Promise<AiSettings> {
    return ai.updateAiSettings(this.#ctx, caller, patch);
  }

  /** Anyone may read it. Never anything about the key. */
  aiStatus(_caller: Caller): Promise<AiStatus> {
    return this.#ctx.lock.run(() => this.#changes.status());
  }

  aiDisclosure(caller: Caller, connection: AiConnection): Promise<AiDisclosure> {
    return ai.aiDisclosureFor(this.#ctx, caller, connection);
  }

  testAi(caller: Caller): Promise<AiStatus> {
    return ai.testAi(this.#ctx, caller, () => this.aiStatus(caller));
  }

  aiUsage(caller: Caller, query: AiUsageQuery = {}): Promise<AiUsage> {
    return readUsage(this.#ctx, caller, query);
  }

  // --- The first sync's window ---------------------------------------------------------------------------

  async firstSyncWindow(caller: Caller): Promise<FirstSyncWindow> {
    return firstSync.firstSyncWindow(this.#ctx, caller);
  }

  updateFirstSyncWindow(caller: Caller, patch: FirstSyncWindowPatch): Promise<FirstSyncWindow> {
    return firstSync.updateFirstSyncWindow(this.#ctx, caller, patch);
  }

  // --- Briefs --------------------------------------------------------------------------------------------

  latestBrief(caller: Caller): Promise<Brief | null> {
    return briefs.latestBrief(this.#ctx, caller);
  }

  brief(caller: Caller, id: Id): Promise<Brief> {
    return briefs.brief(this.#ctx, caller, id);
  }

  writeBrief(caller: Caller, input: BriefInput): Promise<Brief> {
    return this.#ctx.lock.run(() => briefs.writeBrief(this.#ctx, caller, input));
  }

  // --- Devices -------------------------------------------------------------------------------------------

  me(caller: Caller): Promise<Device> {
    return devices.me(this.#ctx, caller);
  }

  listDevices(caller: Caller): Promise<Device[]> {
    return devices.listDevices(this.#ctx, caller);
  }

  createPairingCode(caller: Caller, input: PairingCodeInput): Promise<PairingCode> {
    return this.#ctx.lock.run(() => devices.createPairingCode(this.#ctx, caller, input));
  }

  pair(input: PairInput): Promise<PairResult> {
    return this.#ctx.lock.run(() => devices.pair(this.#ctx, input));
  }

  revokeDevice(caller: Caller, id: Id): Promise<void> {
    return this.#ctx.lock.run(() => devices.revokeDevice(this.#ctx, caller, id));
  }

  // --- Events --------------------------------------------------------------------------------------------

  subscribe(caller: Caller, onEvent: (event: MailEvent) => void): () => void {
    return this.#ctx.host.events.subscribe((event) => {
      if (!this.#mayHear(caller, event)) return;
      // Counts go out for every inbox; each receiver gets only the inboxes it may see, and their sum.
      if (event.type === "counts.changed") onEvent({ type: "counts.changed", counts: countsFor(this.#ctx, caller, event.counts.inboxes, event.counts.version) });
      else onEvent(event);
    });
  }

  #mayHear(caller: Caller, event: MailEvent): boolean {
    const ctx = this.#ctx;
    switch (event.type) {
      case "counts.changed":
      case "ai.status.changed":
        return true;
      case "ai.settings.changed":
        return isPerson(caller);
      case "sender.changed":
        return isPerson(caller) && canSee(ctx, caller, event.inboxId);
      case "inbox.changed":
        return canSee(ctx, caller, event.inbox.id);
      case "inbox.removed":
        return isPerson(caller) || (caller.inboxIds?.includes(event.inboxId) ?? false);
      case "thread.changed":
        return canSee(ctx, caller, event.thread.inboxId);
      case "action.recorded":
        return canSee(ctx, caller, event.record.inboxId);
      case "draft.changed":
        return canSee(ctx, caller, event.draft.inboxId);
      case "rule.changed":
        return canSee(ctx, caller, event.rule.inboxId);
      case "thread.removed":
      case "draft.removed":
      case "rule.removed":
      case "triage.pending":
        return canSee(ctx, caller, event.inboxId);
      case "brief.ready":
        return isPerson(caller) || (ctx.briefInboxes.get(event.briefId)?.some((id) => canSee(ctx, caller, id)) ?? false);
    }
  }
}
