/**
 * The REST surface. One route per `MailService` method; bodies are that method's input and output types.
 * docs/contract.md has the table of bodies, statuses, query parameters (`includeSilent=true`, `attentionOnly=true`)
 * and who may call what. `:category` is one of `CATEGORIES`, or several of them joined by commas (`invoice,receipt`)
 * for one merged list; `:stack` is one of `STACKS`; anything else is `invalid`.
 */
import type { ErrorCode } from "./service.ts";

export const API_VERSION = 1;

/** "none": no token. "person": a person's device. "any": a person's device or an agent. */
export type RouteAuth = "none" | "person" | "any";

export interface Route {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** `:name` marks a path parameter. */
  path: string;
  auth: RouteAuth;
  /** The `MailService` method it calls. */
  calls: string;
}

export const ROUTES = {
  health: { method: "GET", path: "/healthz", auth: "none", calls: "-" },
  info: { method: "GET", path: "/v1/info", auth: "none", calls: "info" },

  pair: { method: "POST", path: "/v1/pair", auth: "none", calls: "pair" },
  me: { method: "GET", path: "/v1/me", auth: "any", calls: "me" },
  listDevices: { method: "GET", path: "/v1/devices", auth: "person", calls: "listDevices" },
  createPairingCode: { method: "POST", path: "/v1/pairing-codes", auth: "person", calls: "createPairingCode" },
  revokeDevice: { method: "DELETE", path: "/v1/devices/:id", auth: "any", calls: "revokeDevice" },

  /** No token: an unclaimed server's first visitor (or, with an owner email, Google's proof) becomes its owner. */
  claimOwner: { method: "POST", path: "/v1/owner/claim", auth: "none", calls: "claimOwner" },
  /** No token: Google's address, to prove the host's owner email before claiming. */
  startOwnerClaim: { method: "POST", path: "/v1/owner/claim/google", auth: "none", calls: "startOwnerClaim" },
  /** No token: the owner's password pairs the caller's device. */
  signInOwner: { method: "POST", path: "/v1/owner/sign-in", auth: "none", calls: "signInOwner" },
  owner: { method: "GET", path: "/v1/owner", auth: "person", calls: "owner" },
  setOwnerPassword: { method: "PUT", path: "/v1/owner/password", auth: "person", calls: "setOwnerPassword" },
  /** No token: a recovery code, made where the host keeps the owner's code, never in the answer. */
  requestRecoveryCode: { method: "POST", path: "/v1/owner/recovery-code", auth: "none", calls: "requestRecoveryCode" },

  listInboxes: { method: "GET", path: "/v1/inboxes", auth: "any", calls: "listInboxes" },
  connectInbox: { method: "POST", path: "/v1/inboxes", auth: "person", calls: "connectInbox" },
  updateInbox: { method: "PATCH", path: "/v1/inboxes/:id", auth: "any", calls: "updateInbox" },
  removeInbox: { method: "DELETE", path: "/v1/inboxes/:id", auth: "person", calls: "removeInbox" },
  syncInbox: { method: "POST", path: "/v1/inboxes/:id/sync", auth: "any", calls: "syncInbox" },

  startGoogleSignIn: { method: "POST", path: "/v1/google/sign-ins", auth: "person", calls: "startGoogleSignIn" },
  googleSignIn: { method: "GET", path: "/v1/google/sign-ins/:id", auth: "person", calls: "googleSignIn" },
  /** Where Google sends the person's browser back. Answers with a page, not JSON. */
  googleCallback: { method: "GET", path: "/v1/google/callback", auth: "none", calls: "-" },
  /**
   * Person only: setting up the host's Google client (`GoogleSetup`): the browser agent's prompt with the redirect
   * address filled in, the manual steps, what is missing, and whether a device may give the client. Served by the
   * server itself, not a `MailService` method.
   */
  googleSetup: { method: "GET", path: "/v1/google/setup", auth: "person", calls: "-" },
  /**
   * Person only: gives the server its Google client. The body is the JSON file Google Cloud's console downloads for a
   * Web application client, as it is (at most `GOOGLE_CLIENT_FILE_MAX_BYTES`); `?replace=true` replaces a client the
   * server has. Answers `GoogleClientSaved`, never the secret. Served by the server itself, not a `MailService` method.
   */
  setGoogleClient: { method: "PUT", path: "/v1/google/client", auth: "person", calls: "-" },

  home: { method: "GET", path: "/v1/home", auth: "any", calls: "home" },
  category: { method: "GET", path: "/v1/categories/:category", auth: "any", calls: "category" },
  stack: { method: "GET", path: "/v1/stacks/:stack", auth: "any", calls: "stack" },
  waiting: { method: "GET", path: "/v1/waiting", auth: "any", calls: "waiting" },
  screening: { method: "GET", path: "/v1/screening", auth: "any", calls: "screening" },
  counts: { method: "GET", path: "/v1/counts", auth: "any", calls: "counts" },
  handled: { method: "GET", path: "/v1/handled", auth: "any", calls: "handled" },
  thread: { method: "GET", path: "/v1/threads/:id", auth: "any", calls: "thread" },
  search: { method: "GET", path: "/v1/search", auth: "any", calls: "search" },
  /** Person only: the mailbox itself searched for older mail the server doesn't hold. Nothing is stored. */
  searchRemote: { method: "GET", path: "/v1/search/remote", auth: "person", calls: "searchRemote" },
  /** Person only: one remote result brought into the store, answered as a `ThreadDetail`. */
  openRemote: { method: "POST", path: "/v1/search/remote/:id/open", auth: "person", calls: "openRemote" },
  /**
   * Person only: a search asked in a sentence, turned into filters by the server's AI. It searches nothing and
   * answers no mail; the client then calls `search` with what it answers.
   */
  askSearch: { method: "POST", path: "/v1/search/ask", auth: "person", calls: "askSearch" },
  attachment: {
    method: "GET",
    path: "/v1/messages/:id/attachments/:attachmentId",
    auth: "any",
    calls: "-",
  },
  /** A picture from the web the message's HTML shows (`picturePath`): its bytes, fetched once and then cached. */
  picture: {
    method: "GET",
    path: "/v1/messages/:id/pictures/:pictureId",
    auth: "person",
    calls: "-",
  },
  /**
   * A sender picture (`Avatar.picture`, `avatarPath`): a PNG, JPEG or WebP the server keeps, never fetched for the
   * asking. `not_found` once it is gone.
   */
  avatar: { method: "GET", path: "/v1/avatars/:id", auth: "person", calls: "-" },

  /** Person only: the blocked senders, `?state=blocked` with the lists' `inboxId`, `limit` and `cursor`. */
  senders: { method: "GET", path: "/v1/senders", auth: "person", calls: "senders" },
  /** Person only: lets a sender in by `{ inboxId, address }`, as `allow_sender` on one of their threads would. */
  allowSender: { method: "POST", path: "/v1/senders/allow", auth: "person", calls: "allowSender" },

  act: { method: "POST", path: "/v1/actions", auth: "any", calls: "act" },
  undo: { method: "POST", path: "/v1/actions/:id/undo", auth: "any", calls: "undo" },
  approve: { method: "POST", path: "/v1/actions/approve", auth: "person", calls: "approve" },
  reject: { method: "POST", path: "/v1/actions/reject", auth: "person", calls: "reject" },

  listRules: { method: "GET", path: "/v1/inboxes/:id/rules", auth: "any", calls: "listRules" },
  createRule: { method: "POST", path: "/v1/inboxes/:id/rules", auth: "any", calls: "createRule" },
  updateRule: { method: "PATCH", path: "/v1/rules/:id", auth: "any", calls: "updateRule" },
  deleteRule: { method: "DELETE", path: "/v1/rules/:id", auth: "any", calls: "deleteRule" },
  answerTeach: { method: "POST", path: "/v1/teach/:id", auth: "person", calls: "answerTeach" },

  triageQueue: { method: "GET", path: "/v1/triage", auth: "any", calls: "triageQueue" },
  decide: { method: "POST", path: "/v1/triage/decisions", auth: "any", calls: "decide" },

  listDrafts: { method: "GET", path: "/v1/drafts", auth: "any", calls: "listDrafts" },
  saveDraft: { method: "POST", path: "/v1/drafts", auth: "any", calls: "saveDraft" },
  deleteDraft: { method: "DELETE", path: "/v1/drafts/:id", auth: "any", calls: "deleteDraft" },
  sendDraft: { method: "POST", path: "/v1/drafts/:id/send", auth: "person", calls: "sendDraft" },

  aiSettings: { method: "GET", path: "/v1/ai", auth: "person", calls: "aiSettings" },
  updateAiSettings: { method: "PATCH", path: "/v1/ai", auth: "person", calls: "updateAiSettings" },
  aiStatus: { method: "GET", path: "/v1/ai/status", auth: "any", calls: "aiStatus" },
  /** `?gateway=vercel`, `?provider=openai` or `?provider=anthropic`: the words to show before saving a key for it. */
  aiDisclosure: { method: "GET", path: "/v1/ai/disclosure", auth: "person", calls: "aiDisclosure" },
  testAi: { method: "POST", path: "/v1/ai/test", auth: "person", calls: "testAi" },
  aiUsage: { method: "GET", path: "/v1/ai/usage", auth: "person", calls: "aiUsage" },

  firstSyncWindow: { method: "GET", path: "/v1/first-sync", auth: "person", calls: "firstSyncWindow" },
  updateFirstSyncWindow: { method: "PATCH", path: "/v1/first-sync", auth: "person", calls: "updateFirstSyncWindow" },

  latestBrief: { method: "GET", path: "/v1/briefs/latest", auth: "any", calls: "latestBrief" },
  brief: { method: "GET", path: "/v1/briefs/:id", auth: "any", calls: "brief" },
  writeBrief: { method: "POST", path: "/v1/briefs", auth: "any", calls: "writeBrief" },

  events: { method: "GET", path: "/v1/events", auth: "any", calls: "subscribe" },
} as const satisfies Record<string, Route>;

export type RouteName = keyof typeof ROUTES;

/**
 * The dashboard's pages that other interfaces may link to, under the server's root (the dashboard is mounted
 * there). Only these; every other dashboard path may change.
 */
export const DASHBOARD_PATHS = {
  /** One inbox's page: its state, connection, trust, agent access and guide. */
  inbox: "/inboxes/:id",
  /**
   * Setting up an unclaimed server. The server's Google callback sends the browser here with `?proof=<proof>` once
   * Google proved the host's owner email (docs/contract.md, "The owner's password").
   */
  claim: "/claim",
} as const;

/** Every error response has this body. A `rate_limited` answer also has a `Retry-After` header in seconds. */
export interface ApiErrorBody {
  error: { code: ErrorCode; message: string };
}

/** The HTTP status for each error code. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  invalid: 400,
  conflict: 409,
  needs_person: 403,
  rate_limited: 429,
  provider_error: 502,
  internal: 500,
};
