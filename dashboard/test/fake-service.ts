// A small in-memory MailService for the dashboard's tests, seeded from core/fixtures/sample.json plus made-up
// devices. It implements what the dashboard calls as docs/contract.md and its pages say, fifth revision (who may do
// what, versions, silent records and `attentionOnly` in Handled with the server's AI as an actor, credentials
// checked before they are kept and replacing the stored ones whole, the connection without secrets, an inbox's
// icon, position and AI processing (on only with AI credentials set), rules with versions and makers, and the AI's
// settings without the key, credentials replaced whole, moving to another service turning every inbox's AI off,
// history days within their limit), records every call, can be told to fail the next call to a method, and throws
// on every method the dashboard has no business calling.
import {
  AI_JOBS,
  aiDisclosure,
  INBOX_ICONS,
  ServiceError,
  type ActResult,
  type ActionRecord,
  type ActionState,
  type AiConnection,
  type AiCredentials,
  type AiDisclosure,
  type AiSettings,
  type AiSettingsPatch,
  type AiStatus,
  type AiUsage,
  type AiUsageQuery,
  type FirstSyncWindow,
  type FirstSyncWindowPatch,
  type Authenticate,
  type Caller,
  type ConnectInboxInput,
  type Device,
  type Draft,
  type GmailCredentials,
  type GoogleSignInInfo,
  type GoogleSignInInput,
  type GoogleSignInStart,
  type HandledItem,
  type HandledQuery,
  type Id,
  type ImapCredentials,
  type Inbox,
  type InboxPatch,
  type ListQuery,
  type MailService,
  type Page,
  type PairInput,
  type PairResult,
  type PairingCode,
  type PairingCodeInput,
  type Rule,
  type RuleDraft,
  type RuleSource,
  type SampleData,
  type ServerInfo,
  type TeachPrompt,
  type Thread,
  type OwnerClaimInput,
  type OwnerSignInInput,
  type OwnerPasswordInput,
} from "@usualmail/core";
import { AGENT_CODE, AGENT_TOKEN, connectionOf, GOOD_CODE, notUsed, PERSON_DEVICE, PERSON_TOKEN, SAMPLE, type Call } from "./fake-data.ts";
import { FakeOwner } from "./fake-owner.ts";

export { AGENT_CODE, AGENT_TOKEN, GOOD_CODE, PERSON_DEVICE, PERSON_TOKEN, SAMPLE } from "./fake-data.ts";

export class FakeService implements MailService {
  readonly clock = new Date(SAMPLE.now);
  readonly calls: Call[] = [];
  inboxes: Inbox[];
  threads: Thread[];
  actions: ActionRecord[];
  rules: Rule[];
  drafts: Draft[];
  devices: Device[];
  /** Token to device id. */
  tokens = new Map<string, Id>();
  /** Pairing code to what it creates. */
  codes = new Map<string, PairingCodeInput>();
  /** Set to make the next `undo` return this teach prompt. */
  teachOnUndo?: TeachPrompt;
  /** The AI's settings as a person's device gets them (never the key), and its status. */
  ai: AiSettings;
  /** The first sync's window, as `GET /v1/first-sync` answers it. */
  firstSync: FirstSyncWindow;
  aiState: AiStatus;
  /** The key the person set, kept apart as the server keeps it sealed. Never returned. */
  aiCredentials: AiCredentials | null = null;
  /** The service of the last key, remembered when it is removed. */
  #service: AiSettings["connection"];
  /** The sample's default model for each job, shown while a connection is set. */
  #defaults: Partial<Record<string, string>> = {};
  #failures = new Map<string, ServiceError>();
  #counter = 0;

  constructor() {
    const sample: SampleData = structuredClone(SAMPLE);
    this.inboxes = sample.inboxes;
    this.threads = sample.threads;
    this.actions = sample.actions;
    this.rules = sample.rules;
    this.drafts = sample.drafts;
    this.ai = sample.ai;
    this.#defaults = Object.fromEntries(sample.ai.jobs.map((job) => [job.job, job.defaultModel]));
    this.aiState = sample.aiStatus;
    this.firstSync = sample.firstSync;
    if (sample.ai.connection) this.aiCredentials = { ...sample.ai.connection, apiKey: "sample-key-never-shown" } as AiCredentials;
    this.devices = [
      { id: "dev_mac_1", name: "Studio Mac", kind: "person", createdAt: "2026-09-20T18:40:00Z", lastSeenAt: "2026-11-16T09:20:00Z" },
      { id: "dev_phone_1", name: "iPhone", kind: "person", createdAt: "2026-09-21T07:00:00Z" },
      { id: PERSON_DEVICE, name: "Web dashboard", kind: "person", createdAt: "2026-11-16T09:00:00Z" },
      {
        id: "dev_agent_1",
        name: "Claude Code",
        kind: "agent",
        inboxIds: ["inb_northwind", "inb_harbor"],
        createdAt: "2026-10-02T08:30:00Z",
        lastSeenAt: "2026-11-16T09:01:00Z",
      },
      { id: "dev_agent_2", name: "Hermes", kind: "agent", inboxIds: ["inb_personal"], createdAt: "2026-11-01T12:00:00Z" },
    ];
    this.tokens.set(PERSON_TOKEN, PERSON_DEVICE);
    this.tokens.set(AGENT_TOKEN, "dev_agent_1");
    this.codes.set(GOOD_CODE, { kind: "person" });
    this.codes.set(AGENT_CODE, { kind: "agent", inboxIds: ["inb_northwind"] });
  }

  // --- Test controls -------------------------------------------------------------------------

  /** The next call to `method` throws this error. */
  failNext(method: keyof MailService, error: ServiceError): void {
    this.#failures.set(method, error);
  }

  callsTo(method: keyof MailService): unknown[][] {
    return this.calls.filter((call) => call.method === method).map((call) => call.args);
  }

  /** Every method called, in order, without arguments. */
  methods(): string[] {
    return this.calls.map((call) => call.method);
  }

  #call(method: string, args: unknown[]): void {
    this.calls.push({ method, args: structuredClone(args) });
    const failure = this.#failures.get(method);
    if (failure) {
      this.#failures.delete(method);
      throw failure;
    }
  }

  #id(prefix: string): string {
    this.#counter += 1;
    return `${prefix}_new_${this.#counter}`;
  }

  #time(): string {
    return this.clock.toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  #person(caller: Caller, what: string): void {
    if (caller.actor.kind !== "person") throw new ServiceError("needs_person", `Only a person can ${what}`);
  }

  #inbox(id: Id): Inbox {
    const inbox = this.inboxes.find((item) => item.id === id);
    if (!inbox) throw new ServiceError("not_found", "No such inbox");
    return inbox;
  }

  #deviceOf(caller: Caller): Device {
    const id = caller.actor.kind === "person" ? caller.actor.deviceId : caller.actor.kind === "agent" ? caller.actor.agentId : "";
    const device = this.devices.find((item) => item.id === id);
    if (!device) throw new ServiceError("unauthorized", "This token no longer works");
    return device;
  }

  /**
   * Checks new credentials as the server does with the provider (docs/contract.md, "Inboxes"). A password or
   * refresh token of "wrong-password" is refused with the provider's words; an IMAP login for another address is
   * `invalid`.
   */
  #verify(inbox: Inbox, credentials: unknown): void {
    if (inbox.provider === "imap") {
      const imap = credentials as ImapCredentials;
      if (!imap?.imap?.host || !imap.imap.password || !imap.smtp?.host) throw new ServiceError("invalid", "IMAP and SMTP need a server, a user and a password");
      if (imap.imap.password === "wrong-password") throw new ServiceError("provider_error", "The mail server refused the login: authentication failed");
      const address = (imap.address ?? imap.imap.user).toLowerCase();
      if (address !== inbox.address.toLowerCase()) {
        throw new ServiceError("invalid", `These details are for ${address}, not ${inbox.address}`);
      }
    } else {
      const gmail = credentials as GmailCredentials;
      if (!gmail?.clientId || !gmail.clientSecret || !gmail.refreshToken) throw new ServiceError("invalid", "Gmail needs a client ID, a client secret and a refresh token");
      if (gmail.refreshToken === "wrong-password") throw new ServiceError("provider_error", "Google refused the refresh token: invalid_grant");
    }
  }

  #result(records: ActionRecord[]): ActResult {
    const threads = records.map((record) => this.threads.find((thread) => thread.id === record.threadId)!);
    return { records, threads };
  }

  /** Turns a token into its caller, as the server's `authenticate` does. */
  authenticate: Authenticate = async (token) => {
    const deviceId = this.tokens.get(token);
    const device = this.devices.find((item) => item.id === deviceId);
    if (!device) return null;
    if (device.kind === "person") return { actor: { kind: "person", deviceId: device.id } };
    return { actor: { kind: "agent", agentId: device.id, name: device.name }, inboxIds: device.inboxIds ?? [] };
  };

  // --- What the dashboard calls ------------------------------------------------------------

  async listInboxes(caller: Caller): Promise<Inbox[]> {
    this.#call("listInboxes", [caller]);
    return structuredClone(this.inboxes);
  }

  async connectInbox(caller: Caller, input: ConnectInboxInput): Promise<Inbox> {
    this.#call("connectInbox", [caller, input]);
    this.#person(caller, "connect an inbox");
    const credentials = input.credentials as { imap?: { user: string }; address?: string };
    const inbox: Inbox = {
      id: this.#id("inb"),
      name: input.name,
      address: credentials.address ?? credentials.imap?.user ?? "mailbox@gmail.example",
      color: input.color,
      icon: input.icon ?? (["person", "building", "briefcase"] as const)[this.inboxes.length % 3]!,
      position: this.inboxes.length,
      provider: input.provider,
      connection: connectionOf(input.provider, input.credentials),
      trust: input.trust ?? "suggest",
      guide: "",
      agentAccess: false,
      status: "connecting",
      createdAt: this.#time(),
      version: 1,
    };
    this.inboxes.push(inbox);
    return structuredClone(inbox);
  }

  async updateInbox(caller: Caller, id: Id, patch: InboxPatch): Promise<Inbox> {
    this.#call("updateInbox", [caller, id, patch]);
    const inbox = this.#inbox(id);
    if (Object.keys(patch).some((key) => key !== "guide")) this.#person(caller, "change that");
    const { paused, credentials, position, ...fields } = patch;
    // New credentials are checked first; when they are refused, nothing in the patch changes.
    if (credentials !== undefined) this.#verify(inbox, credentials);
    if (fields.icon !== undefined && !(INBOX_ICONS as readonly string[]).includes(fields.icon)) throw new ServiceError("invalid", "No such icon");
    if (position !== undefined && (!Number.isInteger(position) || position < 0 || position >= this.inboxes.length)) {
      throw new ServiceError("invalid", "No such position");
    }
    Object.assign(inbox, fields);
    if (position !== undefined && position !== inbox.position) {
      // Moves it there and renumbers the others, raising the version of each that moved.
      const order = this.inboxes.filter((other) => other !== inbox).sort((a, b) => a.position - b.position);
      order.splice(position, 0, inbox);
      order.forEach((other, index) => {
        if (other.position !== index && other !== inbox) other.version += 1;
        other.position = index;
      });
      this.inboxes = order;
    }
    if (paused !== undefined) inbox.status = paused ? "paused" : "connecting";
    if (credentials !== undefined) inbox.connection = connectionOf(inbox.provider, credentials);
    if (credentials !== undefined && inbox.status !== "paused") {
      inbox.status = "connecting";
      delete inbox.statusDetail;
      delete inbox.statusReason;
    }
    inbox.version += 1;
    return structuredClone(inbox);
  }

  /** Deletes the server's copy of the inbox's mail, rules, history and drafts. Nothing at the provider. */
  async removeInbox(caller: Caller, id: Id): Promise<void> {
    this.#call("removeInbox", [caller, id]);
    this.#person(caller, "remove an inbox");
    this.#inbox(id);
    this.inboxes = this.inboxes.filter((inbox) => inbox.id !== id);
    this.threads = this.threads.filter((thread) => thread.inboxId !== id);
    this.actions = this.actions.filter((record) => record.inboxId !== id);
    this.rules = this.rules.filter((rule) => rule.inboxId !== id);
    this.drafts = this.drafts.filter((draft) => draft.inboxId !== id);
    for (const device of this.devices) if (device.inboxIds) device.inboxIds = device.inboxIds.filter((inboxId) => inboxId !== id);
  }

  async syncInbox(caller: Caller, id: Id): Promise<void> {
    this.#call("syncInbox", [caller, id]);
    if (this.#inbox(id).status === "paused") throw new ServiceError("conflict", "This inbox is paused");
  }

  async handled(caller: Caller, query: HandledQuery): Promise<Page<HandledItem>> {
    this.#call("handled", [caller, query]);
    const attention = query.attentionOnly === true;
    const states: ActionState[] = query.states ?? (attention ? ["proposed", "applied", "undone", "rejected", "failed"] : ["proposed", "applied"]);
    const limit = Math.min(query.limit ?? 50, 200);
    const start = query.cursor ? Number(query.cursor) : 0;
    // Handled holds what rules, agents and the server's AI did; what needs a look (`attentionOnly`) is anyone's, the
    // person's own refused changes included. Silent records (the AI's always, unless something went wrong) only when
    // asked; one that went wrong or carries a note is never silent. Each row carries its thread, trashed or not.
    const all = this.actions
      .filter((record) => attention || record.actor.kind === "rule" || record.actor.kind === "agent" || record.actor.kind === "ai")
      .filter((record) => states.includes(record.state))
      .filter((record) => query.includeSilent || !record.silent)
      .filter((record) => !attention || record.state === "failed" || record.error !== undefined || record.note !== undefined)
      .filter((record) => !query.inboxId || record.inboxId === query.inboxId)
      .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
    const items = all.slice(start, start + limit).map((record) => ({
      record: structuredClone(record),
      thread: structuredClone(this.threads.find((thread) => thread.id === record.threadId)!),
    }));
    return { items, ...(start + limit < all.length ? { nextCursor: String(start + limit) } : {}) };
  }

  async approve(caller: Caller, actionIds: Id[]): Promise<ActResult> {
    this.#call("approve", [caller, actionIds]);
    this.#person(caller, "approve");
    const records = actionIds.map((id) => this.actions.find((record) => record.id === id));
    if (records.some((record) => record?.state !== "proposed")) throw new ServiceError("conflict", "One of these changed since it was proposed");
    for (const record of records as ActionRecord[]) Object.assign(record, { state: "applied", at: this.#time(), undoable: true, version: record.version + 1 });
    return this.#result(records as ActionRecord[]);
  }

  async reject(caller: Caller, actionIds: Id[]): Promise<ActResult> {
    this.#call("reject", [caller, actionIds]);
    this.#person(caller, "reject");
    const records = actionIds.map((id) => this.actions.find((record) => record.id === id));
    if (records.some((record) => record?.state !== "proposed")) throw new ServiceError("conflict", "One of these isn't waiting any more");
    for (const record of records as ActionRecord[]) Object.assign(record, { state: "rejected", version: record.version + 1 });
    return this.#result(records as ActionRecord[]);
  }

  async undo(caller: Caller, actionId: Id): Promise<ActResult> {
    this.#call("undo", [caller, actionId]);
    const record = this.actions.find((item) => item.id === actionId);
    if (!record) throw new ServiceError("not_found", "No such action");
    if (record.state !== "applied" || !record.undoable) throw new ServiceError("conflict", "This can't be undone any more");
    Object.assign(record, { state: "undone", undoneAt: this.#time(), undoable: false, version: record.version + 1 });
    const thread = this.threads.find((item) => item.id === record.threadId);
    if (thread && record.action.kind === "trash") Object.assign(thread, { trashed: false, version: thread.version + 1 });
    const teach = this.teachOnUndo;
    this.teachOnUndo = undefined;
    return { ...this.#result([record]), ...(teach ? { teach } : {}) };
  }

  async listRules(caller: Caller, inboxId: Id): Promise<Rule[]> {
    this.#call("listRules", [caller, inboxId]);
    this.#inbox(inboxId);
    return structuredClone(this.rules.filter((rule) => rule.inboxId === inboxId));
  }

  async createRule(caller: Caller, draft: RuleDraft, source: RuleSource = "person"): Promise<Rule> {
    this.#call("createRule", [caller, draft, source]);
    this.#inbox(draft.inboxId);
    const rule: Rule = {
      id: this.#id("rul"), ...draft, source, enabled: source !== "agent", hits: 0, createdBy: caller.actor, createdAt: this.#time(), version: 1,
    };
    this.rules.push(rule);
    return structuredClone(rule);
  }

  async updateRule(caller: Caller, id: Id, patch: Partial<Pick<Rule, "text" | "match" | "then" | "enabled">>): Promise<Rule> {
    this.#call("updateRule", [caller, id, patch]);
    const rule = this.rules.find((item) => item.id === id);
    if (!rule) throw new ServiceError("not_found", "No such rule");
    const changed = (Object.keys(patch) as Array<keyof typeof patch>).some((key) => JSON.stringify(patch[key]) !== JSON.stringify(rule[key]));
    Object.assign(rule, patch);
    if (changed) rule.version += 1;
    return structuredClone(rule);
  }

  async deleteRule(caller: Caller, id: Id): Promise<void> {
    this.#call("deleteRule", [caller, id]);
    if (!this.rules.some((rule) => rule.id === id)) throw new ServiceError("not_found", "No such rule");
    this.rules = this.rules.filter((rule) => rule.id !== id);
  }

  async answerTeach(caller: Caller, teachId: Id, accept: boolean): Promise<Rule | null> {
    this.#call("answerTeach", [caller, teachId, accept]);
    this.#person(caller, "answer");
    if (!accept) return null;
    return this.createRule(caller, { inboxId: "inb_northwind", text: "Taught rule", match: { from: "a@b.example" }, then: [{ kind: "categorize", category: "conversation" }] }, "correction");
  }

  async listDrafts(caller: Caller, query: ListQuery): Promise<Page<Draft>> {
    this.#call("listDrafts", [caller, query]);
    const limit = Math.min(query.limit ?? 50, 200);
    const start = query.cursor ? Number(query.cursor) : 0;
    const all = this.drafts
      .filter((draft) => draft.state === "draft" || draft.state === "failed")
      .filter((draft) => !query.inboxId || draft.inboxId === query.inboxId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
    const items = structuredClone(all.slice(start, start + limit));
    return { items, ...(start + limit < all.length ? { nextCursor: String(start + limit) } : {}) };
  }

  async me(caller: Caller): Promise<Device> {
    this.#call("me", [caller]);
    return structuredClone(this.#deviceOf(caller));
  }

  async listDevices(caller: Caller): Promise<Device[]> {
    this.#call("listDevices", [caller]);
    this.#person(caller, "see devices");
    return structuredClone(this.devices);
  }

  async createPairingCode(caller: Caller, input: PairingCodeInput): Promise<PairingCode> {
    this.#call("createPairingCode", [caller, input]);
    this.#person(caller, "make a pairing code");
    const code = `CODE-${String(this.codes.size + 1).padStart(4, "0")}`;
    this.codes.set(code, input);
    return { code, expiresAt: new Date(this.clock.getTime() + 15 * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z") };
  }

  async pair(input: PairInput): Promise<PairResult> {
    this.#call("pair", [input]);
    const made = this.codes.get(input.code);
    if (!made) throw new ServiceError("unauthorized", "Unknown or expired pairing code");
    this.codes.delete(input.code);
    return this.#addDevice(input.name, made.kind, made.inboxIds);
  }

  #addDevice(name: string, kind: Device["kind"], inboxIds?: Id[]): PairResult {
    const device: Device = { id: this.#id("dev"), name, kind, ...(kind === "agent" ? { inboxIds: inboxIds ?? [] } : {}), createdAt: this.#time() };
    this.devices.push(device);
    const token = `umt_issued_${device.id}_secret`;
    this.tokens.set(token, device.id);
    return { token, device: structuredClone(device) };
  }

  // --- The owner's password (fake-owner.ts) ---------------------------------------------------------------
  readonly ownerFake = new FakeOwner({
    call: (method, args) => this.#call(method, args),
    person: (caller, what) => this.#person(caller, what),
    addPerson: (name) => this.#addDevice(name, "person"),
    personPaired: () => this.devices.some((device) => device.kind === "person"),
  });
  claimOwner = (input: OwnerClaimInput) => this.ownerFake.claimOwner(input);
  startOwnerClaim = () => this.ownerFake.startOwnerClaim();
  signInOwner = (input: OwnerSignInInput) => this.ownerFake.signInOwner(input);
  owner = (caller: Caller) => this.ownerFake.owner(caller);
  setOwnerPassword = (caller: Caller, input: OwnerPasswordInput) => this.ownerFake.setOwnerPassword(caller, input);
  requestRecoveryCode = () => this.ownerFake.requestRecoveryCode();

  async revokeDevice(caller: Caller, id: Id): Promise<void> {
    this.#call("revokeDevice", [caller, id]);
    const own = caller.actor.kind === "person" ? caller.actor.deviceId : caller.actor.kind === "agent" ? caller.actor.agentId : "";
    if (id !== own) this.#person(caller, "remove another device");
    if (!this.devices.some((device) => device.id === id)) throw new ServiceError("not_found", "No such device");
    this.devices = this.devices.filter((device) => device.id !== id);
    for (const [token, deviceId] of this.tokens) if (deviceId === id) this.tokens.delete(token);
  }

  // --- The server's AI: settings and testing are a person's; anyone may read the status -------------------

  async aiSettings(caller: Caller): Promise<AiSettings> {
    this.#call("aiSettings", [caller]);
    this.#person(caller, "see the AI's settings");
    return structuredClone(this.ai);
  }

  async updateAiSettings(caller: Caller, patch: AiSettingsPatch): Promise<AiSettings> {
    this.#call("updateAiSettings", [caller, patch]);
    this.#person(caller, "change the AI's settings");
    if (patch.credentials !== undefined) {
      const before = this.ai.connection;
      const next = patch.credentials;
      const connection = next ? (next.kind === "gateway" ? { kind: next.kind, gateway: next.gateway } : { kind: next.kind, provider: next.provider }) : undefined;
      // The service of the last key, remembered when the key is removed, as the server does.
      if (before) this.#service = before;
      const moved = Boolean(connection && this.#service && JSON.stringify(this.#service) !== JSON.stringify(connection));
      this.aiCredentials = next;
      this.ai.credentialsSet = Boolean(next);
      if (connection) this.ai.connection = connection as AiSettings["connection"];
      else delete this.ai.connection;
      // Moving to another service puts the jobs back on the defaults (unless the same patch names models); removing
      // the key keeps the models the person chose for the next key of the same service, and a new key for the same
      // service keeps them. No inbox changes: there is no per-inbox switch.
      if (moved && !patch.models) for (const job of this.ai.jobs) job.model = null;
      // The server's defaults are shown only while a connection is set.
      for (const job of this.ai.jobs) job.defaultModel = connection ? this.#defaults[job.job] ?? job.defaultModel : "";
      this.aiState = { ...this.aiState, state: next ? (next.apiKey === "refused-key" ? "key_refused" : "working") : "not_set_up", version: this.aiState.version + 1 };
    }
    for (const job of AI_JOBS) {
      const model = patch.models?.[job];
      if (model !== undefined) this.ai.jobs.find((item) => item.job === job)!.model = model;
    }
    if (patch.paused !== undefined) {
      this.ai.paused = patch.paused;
      this.aiState = { ...this.aiState, state: patch.paused ? "paused" : this.ai.credentialsSet ? "working" : "not_set_up" };
    }
    this.ai.version += 1;
    return structuredClone(this.ai);
  }

  /**
   * As the server builds them: core's words for that service, with the person's chosen models for the service set and
   * the defaults otherwise (the sample's for its service, `example/<provider>-default` for the others).
   */
  async aiDisclosure(caller: Caller, connection: AiConnection): Promise<AiDisclosure> {
    this.#call("aiDisclosure", [caller, connection]);
    this.#person(caller, "read what the AI would be sent");
    const same = JSON.stringify(connection) === JSON.stringify(this.ai.connection ?? this.#service);
    const other = connection.kind === "gateway" ? connection.gateway : connection.provider;
    const jobs = this.ai.jobs.map((job) => ({
      job: job.job,
      model: same ? job.model : null,
      defaultModel: same ? (this.#defaults[job.job] ?? job.defaultModel) : `example/${other}-default`,
    }));
    return aiDisclosure({ connection, jobs });
  }

  async aiStatus(caller: Caller): Promise<AiStatus> {
    this.#call("aiStatus", [caller]);
    return structuredClone(this.aiState);
  }

  async testAi(caller: Caller): Promise<AiStatus> {
    this.#call("testAi", [caller]);
    this.#person(caller, "test the AI");
    this.aiState = { ...this.aiState, version: this.aiState.version + 1 };
    return structuredClone(this.aiState);
  }

  async aiUsage(caller: Caller, query: AiUsageQuery): Promise<AiUsage> {
    this.#call("aiUsage", [caller, query]);
    this.#person(caller, "see the AI's usage");
    return structuredClone(SAMPLE.aiUsage);
  }

  async firstSyncWindow(caller: Caller): Promise<FirstSyncWindow> {
    this.#call("firstSyncWindow", [caller]);
    this.#person(caller, "see the first sync's window");
    return structuredClone(this.firstSync);
  }

  async updateFirstSyncWindow(caller: Caller, patch: FirstSyncWindowPatch): Promise<FirstSyncWindow> {
    this.#call("updateFirstSyncWindow", [caller, patch]);
    this.#person(caller, "change the first sync's window");
    this.firstSync = { ...this.firstSync, days: patch.days, setBy: "settings" };
    return structuredClone(this.firstSync);
  }

  // --- Not used by the dashboard ----------------------------------------------------------

  /** Google sign-in as `info` says it; available unless a test says otherwise. */
  googleInfo: GoogleSignInInfo = { available: true, redirectUri: "http://127.0.0.1:8484/v1/google/callback" };
  /** Google's address the next sign-in answers with. */
  googleUrl = "https://accounts.google.com/o/oauth2/v2/auth?client_id=owner.apps.example&state=s";

  async info(): Promise<ServerInfo> {
    this.#call("info", []);
    return { name: "usual-mail", version: "0.0.0", apiVersion: 1, googleSignIn: structuredClone(this.googleInfo), owner: this.ownerFake.info() };
  }

  /** As the server does: a person's, only when set up, a reconnect only for a Gmail inbox. */
  async startGoogleSignIn(caller: Caller, input: GoogleSignInInput): Promise<GoogleSignInStart> {
    this.#call("startGoogleSignIn", [caller, input]);
    this.#person(caller, "sign in with Google");
    if (!this.googleInfo.available) throw new ServiceError("conflict", "Google sign-in isn't set up on this server");
    if (input.inboxId !== undefined && this.#inbox(input.inboxId).provider !== "gmail") {
      throw new ServiceError("invalid", "Only a Gmail inbox can be reconnected by signing in with Google");
    }
    return { id: this.#id("gsi"), url: this.googleUrl, expiresAt: "2026-11-16T09:40:00Z" };
  }

  googleSignIn = notUsed("googleSignIn");
  home = notUsed("home");
  category = notUsed("category");
  waiting = notUsed("waiting");
  screening = notUsed("screening");
  counts = notUsed("counts");
  stack = notUsed("stack");
  thread = notUsed("thread");
  search = notUsed("search");
  searchRemote = notUsed("searchRemote");
  openRemote = notUsed("openRemote");
  askSearch = notUsed("askSearch");
  senders = notUsed("senders");
  allowSender = notUsed("allowSender");
  act = notUsed("act");
  triageQueue = notUsed("triageQueue");
  decide = notUsed("decide");
  saveDraft = notUsed("saveDraft");
  deleteDraft = notUsed("deleteDraft");
  sendDraft = notUsed("sendDraft");
  latestBrief = notUsed("latestBrief");
  brief = notUsed("brief");
  writeBrief = notUsed("writeBrief");
  subscribe = notUsed("subscribe");
}
