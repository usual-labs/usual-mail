/**
 * The one service every interface talks to: REST, the dashboard, the chat connector and tests.
 * The server implements it. Its behaviour (trust, undo, who may do what) is in docs/contract.md and the pages it
 * names.
 */
import type { AiConnection, AiSettings, AiSettingsPatch, AiStatus } from "./ai.ts";
import type { AiUsage, AiUsageQuery } from "./ai-usage.ts";
import type { AiDisclosure } from "./ai-words.ts";
import type {
  BlockedSender,
  ActionInput,
  ActionRecord,
  ActionState,
  Actor,
  Address,
  Brief,
  BriefHighlight,
  Category,
  Counts,
  Device,
  DeviceKind,
  Draft,
  Id,
  Inbox,
  InboxIcon,
  IsoTime,
  Page,
  ProviderKind,
  Rule,
  RuleDraft,
  RuleSource,
  ServerInfo,
  Stack,
  TeachPrompt,
  Thread,
  ThreadDetail,
  TriageDecision,
  TriageItem,
  TrustLevel,
} from "./domain.ts";
import type { Owner, OwnerClaimInput, OwnerClaimStart, OwnerPasswordInput, OwnerSignInInput, RecoveryCodeAnswer } from "./owner.ts";
import type { MailEvent } from "./events.ts";
import type { FirstSyncWindow, FirstSyncWindowPatch } from "./first-sync.ts";
import type { GoogleSignIn, GoogleSignInInput, GoogleSignInStart } from "./google.ts";
import type { RemoteSearchResult, SearchAskInput, SearchAskResult, SearchQuery, SearchResult } from "./search.ts";

/** Who is calling. Built by the server from the caller's token. */
export interface Caller {
  actor: Actor;
  /** Undefined means every inbox (a person). An agent sees only these, and only where agentAccess is on. */
  inboxIds?: Id[];
}

/**
 * Lists are ordered by the whole second each item publishes, then by id, descending (the triage queue and the
 * waiting list the other way round), so a client can reproduce the order. A cursor continues right after the last
 * item of its page.
 */
export interface ListQuery {
  inboxId?: Id;
  cursor?: string;
  /** Default 50, at most 200. */
  limit?: number;
}

/** Which senders to list. Only blocked ones can be listed today. */
export interface SendersQuery extends ListQuery {
  /** Default "blocked"; anything else is `invalid`. */
  state?: "blocked";
}

/** A sender to let in without naming a thread. */
export interface AllowSenderInput {
  inboxId: Id;
  /** The sender's address; compared without case. */
  address: string;
}

export interface ConnectInboxInput {
  name: string;
  color: string;
  provider: ProviderKind;
  /** Provider-specific. See `ImapCredentials` and `GmailCredentials` in provider.ts. Stored encrypted. */
  credentials: unknown;
  trust?: TrustLevel;
  /** Default: the next of person, building and briefcase in turn, by how many inboxes there are. */
  icon?: InboxIcon;
}

/**
 * Person only, except `guide`. Setting `position` moves the inbox there and renumbers the others, which raises
 * their versions too.
 */
export type InboxPatch = Partial<Pick<Inbox, "name" | "color" | "icon" | "position" | "trust" | "guide" | "agentAccess">> & {
  paused?: boolean;
  /**
   * New credentials for the same mailbox, in the shape used to connect it. Person only. They replace the stored
   * ones whole, so the secrets are sent again with the details `Inbox.connection` shows. The server verifies them
   * with the provider before storing them. If that fails (`provider_error`), or they are for another address
   * (`invalid`), nothing in the patch is applied. On success the inbox is `connecting` until its next good sync.
   */
  credentials?: unknown;
};

export interface ActInput {
  threadIds: Id[];
  action: ActionInput;
  reason?: string;
}

export interface ActResult {
  /** One per thread the call changed or proposed to change. A thread it would not change has none. */
  records: ActionRecord[];
  /** Every thread the call named, as it is now. */
  threads: Thread[];
  /** Present when a person's correction could become a rule. */
  teach?: TeachPrompt;
}

/** One row of Handled: what was done, and to which thread. The thread may be trashed. */
export interface HandledItem {
  record: ActionRecord;
  thread: Thread;
}

export interface HandledQuery extends ListQuery {
  /** Default: "proposed" and "applied". */
  states?: ActionState[];
  /**
   * Also list silent records. Default false. REST takes it as `includeSilent=true`. A record that failed or
   * carries a note is never silent, so it is listed either way.
   */
  includeSilent?: boolean;
  /**
   * Only records that need a person's look: those that failed, or that carry an `error` or a `note`, whoever made
   * them, so a person's own refused write-back too. They come from every state unless `states` is given. Interfaces
   * use it for "what needs you". REST takes it as `attentionOnly=true`.
   */
  attentionOnly?: boolean;
}

export interface DraftInput {
  /** Set to change an existing draft. */
  id?: Id;
  inboxId: Id;
  threadId?: Id;
  inReplyToMessageId?: Id;
  to: Address[];
  cc?: Address[];
  bcc?: Address[];
  subject: string;
  body: string;
}

/** One inbox's part of a brief, as the caller writes it. */
export interface BriefSectionInput {
  inboxId: Id;
  summary?: string;
  /** A thread and a line each. The server adds each highlight's `subject`. */
  highlights: Array<Pick<BriefHighlight, "threadId" | "line">>;
}

export interface BriefInput {
  from: IsoTime;
  to: IsoTime;
  /** The caller supplies summaries and highlights. The server fills in the counts and the subjects. */
  sections: BriefSectionInput[];
}

export interface PairingCodeInput {
  kind: DeviceKind;
  /** Agents only. */
  inboxIds?: Id[];
}

export interface PairingCode {
  /** Short, typed by a person. Works once. */
  code: string;
  expiresAt: IsoTime;
}

export interface PairInput {
  code: string;
  /** What the person will see in the device list. */
  name: string;
}

export interface PairResult {
  /** Shown once. Sent afterwards as `Authorization: Bearer <token>`. */
  token: string;
  device: Device;
}

/**
 * Errors are thrown as `ServiceError`. REST maps `code` to an HTTP status.
 * "needs_person" means the caller is a rule or an agent and a person must do this.
 */
export type ErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "invalid"
  | "conflict"
  | "needs_person"
  | "rate_limited"
  | "provider_error"
  | "internal";

export class ServiceError extends Error {
  readonly code: ErrorCode;
  /** With "rate_limited": whole seconds to wait before trying again. REST sends it as `Retry-After`. */
  readonly retryAfter?: number;
  constructor(code: ErrorCode, message: string, options?: { retryAfter?: number }) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
    if (options?.retryAfter !== undefined) this.retryAfter = options.retryAfter;
  }
}

/** Turns a token into its caller, or null when the token is unknown or revoked. */
export type Authenticate = (token: string) => Promise<Caller | null>;

/**
 * What the server hands to an interface it mounts, such as the dashboard or the chat connector.
 * An interface package exports one function that takes this and returns a `FetchHandler`.
 */
export interface InterfaceDeps {
  service: MailService;
  authenticate: Authenticate;
  /**
   * Where the interface is mounted, for example "/mcp" or "" for the root. No trailing slash. The server passes the
   * handler every request whose path is the base path or under it, with the full URL, unstripped. `/healthz`, `/v1`
   * and everything under `/v1` always stay with REST, so no interface is mounted there.
   */
  basePath: string;
}

/** A standard web request handler. The server mounts it under `basePath`. */
export type FetchHandler = (request: Request) => Response | Promise<Response>;

export interface MailService {
  info(): Promise<ServerInfo>;

  // Inboxes. Connecting, removing and changing anything but `guide` need a person.
  listInboxes(caller: Caller): Promise<Inbox[]>;
  connectInbox(caller: Caller, input: ConnectInboxInput): Promise<Inbox>;
  updateInbox(caller: Caller, id: Id, patch: InboxPatch): Promise<Inbox>;
  /**
   * Deletes the server's copy of the inbox's mail, its rules, history, drafts and guide, and ends agents' access
   * to it. Changes nothing at the provider. Can't be undone.
   */
  removeInbox(caller: Caller, id: Id): Promise<void>;
  /** Asks for a sync now. Returns once it is queued. A paused inbox answers `conflict`. */
  syncInbox(caller: Caller, id: Id): Promise<void>;

  // Connecting Gmail by signing in with Google (docs/contract-sync.md). Person only. Google sends the person back to
  // `GET /v1/google/callback`, which only the server answers: it is no method here.
  /**
   * Starts a sign-in: to connect a new Gmail inbox, or with `inboxId` to reconnect that one in place. Answers with
   * Google's address to open. `conflict` while the host hasn't set Google sign-in up (`ServerInfo.googleSignIn`).
   */
  startGoogleSignIn(caller: Caller, input: GoogleSignInInput): Promise<GoogleSignInStart>;
  /** How a sign-in the caller's own device started stands. Any other device's answers `not_found`. */
  googleSignIn(caller: Caller, id: Id): Promise<GoogleSignIn>;

  // Views. The contract's "Lists" table defines each.
  /** Conversation and unknown threads that are let in, not done, on no stack and not waiting. */
  home(caller: Caller, query: ListQuery): Promise<Page<Thread>>;
  /**
   * Threads in a category that are let in, not done and not waiting to come back, stacked ones included. Given several categories,
   * one merged list in the normal order, whose cursors run across all of them (REST: `invoice,receipt`).
   */
  category(caller: Caller, category: Category | readonly Category[], query: ListQuery): Promise<Page<Thread>>;
  stack(caller: Caller, stack: Stack, query: ListQuery): Promise<Page<Thread>>;
  /** Threads whose come-back time is ahead, soonest first. */
  waiting(caller: Caller, query: ListQuery): Promise<Page<Thread>>;
  /** Screened threads that are not done. */
  screening(caller: Caller, query: ListQuery): Promise<Page<Thread>>;
  /** How many threads each list holds, per inbox the caller may see and in all. */
  counts(caller: Caller): Promise<Counts>;
  /**
   * What rules, agents and the server's AI did or propose, newest first. Silent records (the AI's always, unless
   * something went wrong) only with `includeSilent`. With `attentionOnly`, what needs a look, a person's own records
   * included.
   */
  handled(caller: Caller, query: HandledQuery): Promise<Page<HandledItem>>;
  thread(caller: Caller, id: Id): Promise<ThreadDetail>;
  /**
   * Search over what the server holds (docs/contract-search.md): full text with Gmail's common operators, filters,
   * ranked by relevance with recency as a strong tie-break (newest first for filters alone); done, screened and
   * blocked senders' threads included, trashed ones not. Agents search the inboxes they may see.
   */
  search(caller: Caller, query: SearchQuery): Promise<SearchResult>;
  /**
   * Person only: the same search sent to each inbox's mailbox itself, for mail the server doesn't hold. Nothing found
   * is stored. Each inbox says how it answered (an IMAP inbox: `unsupported`). `rate_limited` beyond the limit.
   */
  searchRemote(caller: Caller, query: SearchQuery): Promise<RemoteSearchResult>;
  /**
   * Person only: brings one remote result's conversation into the store from the mailbox, placed as the mailbox has
   * it, and answers with it. A thread already held is returned as it is. Writes nothing to the mailbox.
   */
  openRemote(caller: Caller, id: Id): Promise<ThreadDetail>;
  /**
   * A search asked in a sentence, turned into the filters and text `search` takes by the server's AI (the summarize
   * job's model; docs/contract-search.md, "Asking in a sentence"). Person only. It searches nothing and returns no
   * mail. Only the sentence and today's date go to the AI service, nothing from the mailbox. Whatever the AI does,
   * the answer is a search that can be run: the sentence as typed when the AI isn't working (`ai` says why) or
   * found nothing. `rate_limited` beyond a few a minute per device.
   */
  askSearch(caller: Caller, input: SearchAskInput): Promise<SearchAskResult>;

  /**
   * Person only (`needs_person` for an agent): the senders blocked in the inboxes the caller may see, the newest
   * block first (by the whole second of `blockedAt`, then inbox and address, descending).
   */
  senders(caller: Caller, query: SendersQuery): Promise<Page<BlockedSender>>;
  /**
   * Person only: lets a sender in by address, exactly as `allow_sender` on one of their threads does, and recorded
   * the same way on their newest thread that isn't trashed or gone (so it shows in Handled and can be undone). The
   * result holds that record (none when nothing changed, or when the sender has no such thread left: then they are
   * let in without a record) and the threads it changed.
   */
  allowSender(caller: Caller, input: AllowSenderInput): Promise<ActResult>;

  // Actions.
  act(caller: Caller, input: ActInput): Promise<ActResult>;
  undo(caller: Caller, actionId: Id): Promise<ActResult>;
  /** Person only: apply proposals. All of them or none. */
  approve(caller: Caller, actionIds: Id[]): Promise<ActResult>;
  /** Person only: turn proposals down. */
  reject(caller: Caller, actionIds: Id[]): Promise<ActResult>;

  // Rules: what an inbox has learned. Each change sends `rule.changed`, a deletion `rule.removed`.
  listRules(caller: Caller, inboxId: Id): Promise<Rule[]>;
  createRule(caller: Caller, draft: RuleDraft, source?: RuleSource): Promise<Rule>;
  updateRule(caller: Caller, id: Id, patch: Partial<Pick<Rule, "text" | "match" | "then" | "enabled">>): Promise<Rule>;
  deleteRule(caller: Caller, id: Id): Promise<void>;
  /** Person only. Accepting creates the rule; declining returns null. */
  answerTeach(caller: Caller, teachId: Id, accept: boolean): Promise<Rule | null>;

  // Triage: unknown threads nobody has decided and the server's AI won't, for an agent or the person to sort.
  triageQueue(caller: Caller, query: { inboxId?: Id; limit?: number }): Promise<TriageItem[]>;
  decide(caller: Caller, decisions: TriageDecision[]): Promise<ActResult>;

  // Drafts. Anyone with access may write one. An agent may change or delete only a draft an agent wrote
  // (`needs_person` otherwise). Only a person may send.
  /** Drafts in state `draft` or `failed`. */
  listDrafts(caller: Caller, query: ListQuery): Promise<Page<Draft>>;
  saveDraft(caller: Caller, input: DraftInput): Promise<Draft>;
  deleteDraft(caller: Caller, id: Id): Promise<void>;
  /**
   * A paused inbox sends nothing: `conflict`. A draft left `sending` by a stop is `failed` after the next start,
   * saying it may have gone out.
   */
  sendDraft(caller: Caller, id: Id): Promise<Draft>;

  // The server's AI. Settings and testing are person only; anyone may read the status.
  /** The settings, without the key: only whether credentials are set. */
  aiSettings(caller: Caller): Promise<AiSettings>;
  /** New credentials, models or pause. Credentials are stored, then tested at once. */
  updateAiSettings(caller: Caller, patch: AiSettingsPatch): Promise<AiSettings>;
  aiStatus(caller: Caller): Promise<AiStatus>;
  /**
   * What saving a key for `connection` would send, and to whom, built by core's `aiDisclosure` with the models that
   * would do each job for that service (the person's chosen ones for the service already set, otherwise its
   * defaults). Person only; works with no credentials set, since it is shown before a key is saved.
   */
  aiDisclosure(caller: Caller, connection: AiConnection): Promise<AiDisclosure>;
  /** Sends one small request per job's model, with no mail in it, and answers with the status that follows. */
  testAi(caller: Caller): Promise<AiStatus>;
  /**
   * What the AI used of the person's account: today, the last 7 days and the last 30 days in the time zone asked for,
   * by job and model. Person only. An unknown time zone is `invalid`.
   */
  aiUsage(caller: Caller, query: AiUsageQuery): Promise<AiUsage>;

  // The first sync's window: how many days of mail a new inbox's first sync takes. Person only.
  firstSyncWindow(caller: Caller): Promise<FirstSyncWindow>;
  /**
   * Sets the window and keeps it where the server keeps its settings; it applies at once, with no restart. An inbox
   * connected afterwards takes that many days. A first sync still in progress fetches nothing older than a smaller
   * window (what it already fetched stays); a larger one changes no inbox already connected, since fetching more would
   * be a new first sync. `invalid` outside 1 to `FIRST_SYNC_MAX_DAYS`; `conflict` while the environment sets it or
   * where the host keeps no settings (`changeable` false). The same number changes nothing.
   */
  updateFirstSyncWindow(caller: Caller, patch: FirstSyncWindowPatch): Promise<FirstSyncWindow>;

  // Briefs.
  latestBrief(caller: Caller): Promise<Brief | null>;
  brief(caller: Caller, id: Id): Promise<Brief>;
  writeBrief(caller: Caller, input: BriefInput): Promise<Brief>;

  // The owner's password (docs/contract.md, "The owner's password"). Claiming, signing in and asking for a recovery
  // code need no caller; the rest need a person.
  /**
   * Makes the caller the owner of an unclaimed server and pairs its device as a person's. `conflict` once the server
   * has a password or a person's device; `forbidden` without Google's proof when the host named the owner's email.
   */
  claimOwner(input: OwnerClaimInput): Promise<PairResult>;
  /**
   * Starts Sign in with Google to prove the host's owner email, before claiming. `conflict` when the server can't be
   * claimed that way, or Google sign-in isn't set up.
   */
  startOwnerClaim(): Promise<OwnerClaimStart>;
  /** Pairs the caller's device as a person's with the owner's password. Wrong passwords count as wrong pairing codes. */
  signInOwner(input: OwnerSignInInput): Promise<PairResult>;
  owner(caller: Caller): Promise<Owner>;
  setOwnerPassword(caller: Caller, input: OwnerPasswordInput): Promise<Owner>;
  /** Makes a recovery code where the host keeps the owner's code; never answers the code itself. */
  requestRecoveryCode(): Promise<RecoveryCodeAnswer>;

  // Devices and agents. Person only, except `pair`, which needs no caller, `me`, and revoking oneself.
  /** The device the caller's token belongs to, a person's or an agent's. */
  me(caller: Caller): Promise<Device>;
  listDevices(caller: Caller): Promise<Device[]>;
  /** A code of kind "agent", for chosen inboxes, is the only way to make an agent's token. */
  createPairingCode(caller: Caller, input: PairingCodeInput): Promise<PairingCode>;
  /** A wrong, used or expired code is `unauthorized`. Too many tries is `rate_limited`, with `retryAfter`. */
  pair(input: PairInput): Promise<PairResult>;
  /** A person may revoke any device. Any caller may revoke itself, which ends its own token. */
  revokeDevice(caller: Caller, id: Id): Promise<void>;

  /** Calls back for every event the caller may see. Returns a function that stops it. */
  subscribe(caller: Caller, onEvent: (event: MailEvent) => void): () => void;
}
