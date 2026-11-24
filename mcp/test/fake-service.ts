/**
 * A small in-memory MailService for the connector's tests, typed against core (fifth revision). It follows the
 * contract where the connector relies on it (who sees what, trust, proposals, categorize and who decided a category,
 * screened threads left out of every list but screening and search, Home, categories, stacks and waiting, the triage
 * queue holding only unknown threads the AI won't process, silent records and attentionOnly in Handled, the AI's
 * status for anyone and its settings for a person only, who may change which rule and which draft, rules with
 * versions and makers, a thread's drafts with sent ones that carry a note, briefs with their highlights' subjects,
 * needs_person, paging) and records every call.
 * It is a test double, not a second server: the real behaviour lives in server/.
 */
import {
  HOME_CATEGORIES,
  ServiceError,
  type ActInput,
  type ActResult,
  type AllowSenderInput,
  type BlockedSender,
  type Page,
  type SendersQuery,
  type RemoteSearchResult,
  type SearchAskInput,
  type SearchAskResult,
  type SearchQuery,
  type SearchResult,
  type ActionRecord,
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
  type Counts,
  type Device,
  type Draft,
  type DraftInput,
  type ErrorCode,
  type HandledItem,
  type HandledQuery,
  type Id,
  type Inbox,
  type ListQuery,
  type MailService,
  type Message,
  type Rule,
  type RuleDraft,
  type SampleData,
  type ThreadDetail,
  type Stack,
  type Thread,
  type TriageDecision,
  type AiConnection,
  type AiDisclosure,
  type GoogleSignIn,
  type GoogleSignInInput,
  type GoogleSignInStart,
} from "@usualmail/core";
import { NOW, newestFirst, page, sample, type Call } from "./fake-data.ts";

export { AGENT, authenticate, NARROW_AGENT, PERSON, sample, TOKENS, type Call } from "./fake-data.ts";

export class FakeMailService implements MailService {
  readonly calls: Call[] = [];
  inboxes: Inbox[];
  threads: Thread[];
  messages: Message[];
  drafts: Draft[];
  actions: ActionRecord[];
  rules: Rule[];
  briefs: Brief[];
  ai: AiSettings;
  aiState: AiStatus;
  private failures = new Map<string, Error>();
  private counter = 100;

  constructor(data: SampleData = sample()) {
    this.inboxes = data.inboxes;
    this.threads = data.threads;
    this.messages = data.messages;
    this.drafts = data.drafts;
    this.actions = data.actions;
    this.rules = data.rules;
    this.briefs = [data.brief];
    this.ai = data.ai;
    this.aiState = data.aiStatus;
  }

  /** The next call to `method` throws this. */
  failNext(method: string, code: ErrorCode | Error, message = "Refused by the fake."): void {
    this.failures.set(method, typeof code === "string" ? new ServiceError(code, message) : code);
  }

  callsTo(method: string): Call[] {
    return this.calls.filter((call) => call.method === method);
  }

  private enter(method: string, caller: Caller | undefined, args: unknown[]): void {
    this.calls.push({ method, caller, args });
    const failure = this.failures.get(method);
    if (failure) {
      this.failures.delete(method);
      throw failure;
    }
  }

  private nextId(prefix: string): Id {
    return `${prefix}_${this.counter++}`;
  }

  private sees(caller: Caller, inboxId: Id): boolean {
    if (caller.actor.kind === "person") return this.inboxes.some((inbox) => inbox.id === inboxId);
    const inbox = this.inboxes.find((item) => item.id === inboxId);
    return Boolean(inbox && inbox.agentAccess && caller.inboxIds?.includes(inboxId));
  }

  private inbox(caller: Caller, id: Id): Inbox {
    const inbox = this.inboxes.find((item) => item.id === id);
    if (!inbox || !this.sees(caller, id)) throw new ServiceError("not_found", `No inbox ${id}.`);
    return inbox;
  }

  private threadOf(caller: Caller, id: Id): Thread {
    const thread = this.threads.find((item) => item.id === id);
    if (!thread || !this.sees(caller, thread.inboxId)) throw new ServiceError("not_found", `No thread ${id}.`);
    return thread;
  }

  /** Threads the caller may see, never trashed ones; screened ones only for search and the screening list. */
  private visible(caller: Caller, query: { inboxId?: Id | undefined }, withScreened = false): Thread[] {
    if (query.inboxId) this.inbox(caller, query.inboxId);
    return this.threads
      .filter((thread) => this.sees(caller, thread.inboxId) && !thread.trashed)
      .filter((thread) => withScreened || !thread.screened)
      .filter((thread) => !query.inboxId || thread.inboxId === query.inboxId);
  }

  private personOnly(caller: Caller, what: string): void {
    if (caller.actor.kind !== "person") throw new ServiceError("needs_person", `Only a person may ${what}.`);
  }

  private ruleOf(caller: Caller, id: Id): Rule {
    const rule = this.rules.find((item) => item.id === id);
    if (!rule || !this.sees(caller, rule.inboxId)) throw new ServiceError("not_found", `No rule ${id}.`);
    return rule;
  }

  async info() {
    return { name: "usual-mail" as const, version: "0.0.0", apiVersion: 1 as const, googleSignIn: { available: false, missing: ["client" as const, "address" as const] }, owner: { password: true, claimable: false } };
  }

  // The connector never asks for the words shown before a key is saved: only a person may (docs/contract-ai.md).
  async aiDisclosure(caller: Caller, _connection: AiConnection): Promise<AiDisclosure> {
    this.enter("aiDisclosure", caller, []);
    this.personOnly(caller, "read what the AI would be sent");
    throw new Error("The connector never asks for the AI's disclosure");
  }

  // The connector never starts or follows a Google sign-in: only a person may (docs/contract-sync.md).
  async startGoogleSignIn(caller: Caller, _input: GoogleSignInInput): Promise<GoogleSignInStart> {
    this.enter("startGoogleSignIn", caller, []);
    this.personOnly(caller, "sign in with Google");
    throw new Error("The connector never starts a Google sign-in");
  }

  async googleSignIn(caller: Caller, _id: Id): Promise<GoogleSignIn> {
    this.enter("googleSignIn", caller, []);
    this.personOnly(caller, "ask about a Google sign-in");
    throw new Error("The connector never asks about a Google sign-in");
  }

  async listInboxes(caller: Caller) {
    this.enter("listInboxes", caller, []);
    return this.inboxes.filter((inbox) => this.sees(caller, inbox.id));
  }
  async connectInbox(caller: Caller, input: unknown): Promise<Inbox> {
    this.enter("connectInbox", caller, [input]);
    this.personOnly(caller, "connect an inbox");
    throw new ServiceError("invalid", "The fake can't connect inboxes.");
  }
  async updateInbox(caller: Caller, id: Id, patch: Partial<Inbox>) {
    this.enter("updateInbox", caller, [id, patch]);
    const inbox = this.inbox(caller, id);
    if (Object.keys(patch).some((key) => key !== "guide")) this.personOnly(caller, "change that");
    Object.assign(inbox, patch);
    return inbox;
  }
  async removeInbox(caller: Caller, id: Id) {
    this.enter("removeInbox", caller, [id]);
    this.personOnly(caller, "remove an inbox");
  }
  async syncInbox(caller: Caller, id: Id) {
    this.enter("syncInbox", caller, [id]);
    this.inbox(caller, id);
  }

  async home(caller: Caller, query: ListQuery) {
    this.enter("home", caller, [query]);
    const items = this.visible(caller, query).filter(
      (t) => (HOME_CATEGORIES as readonly string[]).includes(t.category) && !t.done && !t.stack && !(t.comeBackAt && t.comeBackAt > NOW),
    );
    return page(items.sort(newestFirst), query);
  }
  /** One category's list, or several merged into one, as the contract says. */
  async category(caller: Caller, category: Category | readonly Category[], query: ListQuery) {
    this.enter("category", caller, [category, query]);
    const names: readonly Category[] = typeof category === "string" ? [category] : category;
    return page(this.visible(caller, query).filter((t) => names.includes(t.category) && !t.done).sort(newestFirst), query);
  }
  async stack(caller: Caller, stack: Stack, query: ListQuery) {
    this.enter("stack", caller, [stack, query]);
    return page(this.visible(caller, query).filter((t) => t.stack === stack).sort(newestFirst), query);
  }
  async waiting(caller: Caller, query: ListQuery) {
    this.enter("waiting", caller, [query]);
    const items = this.visible(caller, query).filter((t) => t.comeBackAt && t.comeBackAt > NOW && !t.done);
    return page(items.sort((a, b) => a.comeBackAt!.localeCompare(b.comeBackAt!) || a.id.localeCompare(b.id)), query);
  }
  async screening(caller: Caller, query: ListQuery) {
    this.enter("screening", caller, [query]);
    return page(this.visible(caller, query, true).filter((t) => t.screened && !t.done).sort(newestFirst), query);
  }
  async counts(caller: Caller): Promise<Counts> {
    this.enter("counts", caller, []);
    throw new ServiceError("internal", "The connector doesn't use counts.");
  }
  async handled(caller: Caller, query: HandledQuery) {
    this.enter("handled", caller, [query]);
    const attention = query.attentionOnly === true;
    const states = query.states ?? (attention ? ["proposed", "applied", "undone", "rejected", "failed"] : ["proposed", "applied"]);
    // Rules' and agents' records; with attentionOnly anyone's, the person's own refused changes included. Silent
    // records only when asked. A record that failed or carries a note is never silent. Each row carries its thread,
    // trashed or not.
    const items: HandledItem[] = this.actions
      .filter((record) => (attention || record.actor.kind !== "person") && states.includes(record.state) && this.sees(caller, record.inboxId))
      .filter((record) => query.includeSilent || !record.silent)
      .filter((record) => !attention || record.state === "failed" || record.error !== undefined || record.note !== undefined)
      .filter((record) => !query.inboxId || record.inboxId === query.inboxId)
      .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))
      .map((record) => ({ record, thread: this.threadOf(caller, record.threadId) }));
    return page(items, query);
  }
  async thread(caller: Caller, id: Id) {
    this.enter("thread", caller, [id]);
    const thread = this.threadOf(caller, id);
    return {
      thread,
      messages: this.messages.filter((m) => m.threadId === id).sort((a, b) => a.date.localeCompare(b.date)),
      // Unsent drafts, and sent ones with a note (the sample's are within the day they are kept).
      drafts: this.drafts.filter((d) => d.threadId === id && (d.state !== "sent" || d.note !== undefined)),
    };
  }
  /** A substring search (the server's is full text): enough for the connector's own behaviour. */
  async search(caller: Caller, query: SearchQuery): Promise<SearchResult> {
    this.enter("search", caller, [query]);
    const q = (query.q ?? "").toLowerCase();
    const scope = query.inboxIds?.[0] === undefined ? {} : { inboxId: query.inboxIds[0] };
    const items = this.visible(caller, { ...scope, ...(query.cursor && { cursor: query.cursor }), ...(query.limit && { limit: query.limit }) }, true).filter((t) =>
      [t.subject, t.snippet, t.summary ?? "", ...t.participants.map((p) => `${p.name ?? ""} ${p.email}`)].some((s) => s.toLowerCase().includes(q)),
    );
    const listed = page(items.sort(newestFirst), { ...(query.cursor && { cursor: query.cursor }), ...(query.limit && { limit: query.limit }) });
    return { ...listed, understood: { text: query.q ?? "" } };
  }
  async searchRemote(caller: Caller, query: SearchQuery): Promise<RemoteSearchResult> {
    this.enter("searchRemote", caller, [query]);
    throw new ServiceError("needs_person", "Only a person can search the mailbox itself");
  }
  async askSearch(caller: Caller, input: SearchAskInput): Promise<SearchAskResult> {
    this.enter("askSearch", caller, [input]);
    throw new ServiceError("needs_person", "Only a person can ask search in a sentence");
  }
  async openRemote(caller: Caller, id: Id): Promise<ThreadDetail> {
    this.enter("openRemote", caller, [id]);
    throw new ServiceError("needs_person", "Only a person can bring mail in from the mailbox");
  }
  // The blocked senders are a person's: no tool reads them or lets a sender in by address.
  async senders(caller: Caller, query: SendersQuery): Promise<Page<BlockedSender>> {
    this.enter("senders", caller, [query]);
    throw new ServiceError("needs_person", "Only a person can see the blocked senders");
  }
  async allowSender(caller: Caller, input: AllowSenderInput): Promise<ActResult> {
    this.enter("allowSender", caller, [input]);
    throw new ServiceError("needs_person", "Only a person can let a sender in by address");
  }

  private record(caller: Caller, thread: Thread, action: ActionRecord["action"], reason: string | undefined): ActionRecord {
    const inbox = this.inboxes.find((item) => item.id === thread.inboxId)!;
    const proposed =
      caller.actor.kind !== "person" && (inbox.trust === "suggest" || action.kind === "trash" || action.kind === "block_sender");
    const record: ActionRecord = {
      id: this.nextId("act"),
      threadId: thread.id,
      inboxId: thread.inboxId,
      action,
      actor: caller.actor,
      ...(reason ? { reason } : {}),
      state: proposed ? "proposed" : "applied",
      at: NOW,
      undoable: !proposed,
      // Applied alone by a rule or an agent in an act_silently inbox: silent. Never a proposal, never a person.
      silent: !proposed && caller.actor.kind !== "person" && inbox.trust === "act_silently",
      version: 1,
    };
    if (!proposed) {
      if (action.kind === "done") Object.assign(thread, { done: true, stack: undefined });
      if (action.kind === "categorize") {
        thread.category = action.category;
        // A one-time code is never held back by screening and never summarized.
        if (action.category === "otp") {
          thread.screened = false;
          delete thread.summary;
        }
      }
      if (action.kind === "stack") Object.assign(thread, { stack: action.stack, done: false });
      if (action.kind === "trash") thread.trashed = true;
    }
    // A categorize sets who decided, by name too, also when it is only proposed.
    if (action.kind === "categorize") Object.assign(thread, { categorizedBy: caller.actor.kind === "person" ? "person" : "agent", categorizedByActor: caller.actor });
    thread.version += 1;
    this.actions.push(record);
    return record;
  }

  async act(caller: Caller, input: ActInput): Promise<ActResult> {
    this.enter("act", caller, [input]);
    const threads = input.threadIds.map((id) => this.threadOf(caller, id));
    const records = threads.map((thread) => this.record(caller, thread, input.action, input.reason));
    return { records, threads };
  }
  async undo(caller: Caller, actionId: Id): Promise<ActResult> {
    this.enter("undo", caller, [actionId]);
    const record = this.actions.find((item) => item.id === actionId);
    if (!record || !this.sees(caller, record.inboxId)) throw new ServiceError("not_found", `No action ${actionId}.`);
    const inbox = this.inboxes.find((item) => item.id === record.inboxId)!;
    if (caller.actor.kind !== "person" && (inbox.trust === "suggest" || ["trash", "block_sender"].includes(record.action.kind))) {
      throw new ServiceError("needs_person", "Only a person may undo this.");
    }
    if (record.state !== "applied" || !record.undoable) throw new ServiceError("conflict", "It can't be undone now.");
    Object.assign(record, { state: "undone", undoneAt: NOW, undoable: false, version: record.version + 1 });
    const thread = this.threadOf(caller, record.threadId);
    if (record.action.kind === "trash") thread.trashed = false;
    return { records: [record], threads: [thread] };
  }
  async approve(caller: Caller, actionIds: Id[]): Promise<ActResult> {
    this.enter("approve", caller, [actionIds]);
    this.personOnly(caller, "approve");
    return { records: [], threads: [] };
  }
  async reject(caller: Caller, actionIds: Id[]): Promise<ActResult> {
    this.enter("reject", caller, [actionIds]);
    this.personOnly(caller, "reject");
    return { records: [], threads: [] };
  }

  async listRules(caller: Caller, inboxId: Id) {
    this.enter("listRules", caller, [inboxId]);
    this.inbox(caller, inboxId);
    return this.rules.filter((rule) => rule.inboxId === inboxId);
  }
  async createRule(caller: Caller, draft: RuleDraft, source?: Rule["source"]) {
    this.enter("createRule", caller, [draft, source]);
    this.inbox(caller, draft.inboxId);
    const agent = caller.actor.kind !== "person";
    const rule: Rule = {
      id: this.nextId("rul"), ...draft, source: agent ? "agent" : (source ?? "person"), enabled: !agent, hits: 0, createdBy: caller.actor, createdAt: NOW, version: 1,
    };
    this.rules.push(rule);
    return rule;
  }
  /**
   * An agent may change or delete only rules an agent made, and never turn one on. Changing the match or then of an
   * enabled agent rule switches it off; changing only its text leaves it on.
   */
  async updateRule(caller: Caller, id: Id, patch: Partial<Pick<Rule, "text" | "match" | "then" | "enabled">>): Promise<Rule> {
    this.enter("updateRule", caller, [id, patch]);
    const rule = this.ruleOf(caller, id);
    if (caller.actor.kind !== "person") {
      if (rule.source !== "agent") throw new ServiceError("needs_person", "Only a person may change a rule a person made.");
      if (patch.enabled === true) throw new ServiceError("needs_person", "Only a person may turn a rule on.");
      if ((patch.match !== undefined || patch.then !== undefined) && rule.enabled) rule.enabled = false;
    }
    Object.assign(rule, patch);
    rule.version += 1;
    return rule;
  }
  async deleteRule(caller: Caller, id: Id) {
    this.enter("deleteRule", caller, [id]);
    const rule = this.ruleOf(caller, id);
    if (caller.actor.kind !== "person" && rule.source !== "agent") {
      throw new ServiceError("needs_person", "Only a person may delete a rule a person made.");
    }
    this.rules = this.rules.filter((item) => item.id !== id);
  }
  async answerTeach(caller: Caller, teachId: Id, accept: boolean) {
    this.enter("answerTeach", caller, [teachId, accept]);
    this.personOnly(caller, "answer a teach prompt");
    return null;
  }

  /**
   * Unknown threads nobody has decided, not done, that the AI won't process: the AI isn't working (the server also
   * holds those whose AI answer was dropped, which the sample doesn't model). Since 2026-11-18 the AI's history is all
   * synced mail, so age is no reason. Screened threads are in no list but screening.
   */
  async triageQueue(caller: Caller, query: { inboxId?: Id; limit?: number }) {
    this.enter("triageQueue", caller, [query]);
    const aiWont = (_thread: Thread) => this.aiState.state !== "working";
    return this.visible(caller, query)
      .filter((thread) => thread.category === "unknown" && !thread.categorizedBy && !thread.done && aiWont(thread))
      .sort((a, b) => a.lastMessageAt.localeCompare(b.lastMessageAt))
      .slice(0, query.limit ?? 50)
      .map((thread) => ({
        thread,
        latest: this.messages.filter((m) => m.threadId === thread.id).sort((a, b) => b.date.localeCompare(a.date))[0]!,
      }));
  }
  async decide(caller: Caller, decisions: TriageDecision[]): Promise<ActResult> {
    this.enter("decide", caller, [decisions]);
    const threads = decisions.map((decision) => this.threadOf(caller, decision.threadId));
    const records: ActionRecord[] = [];
    decisions.forEach((decision, index) => {
      const thread = threads[index]!;
      // A category that changes is a categorize, recorded; either way the agent (or person) has decided it.
      const record = thread.category === decision.category ? undefined : this.record(caller, thread, { kind: "categorize", category: decision.category }, decision.reason);
      if (record) records.push(record);
      Object.assign(thread, { categorizedBy: caller.actor.kind === "person" ? "person" : "agent", categorizedByActor: caller.actor });
      Object.assign(thread, { reason: decision.reason, ...(decision.need ? { need: decision.need } : {}) });
      if (decision.done && (!record || record.state === "applied")) thread.done = true;
    });
    return { records, threads };
  }

  // The server's AI: anyone may read its status; its settings and testing are a person's.
  async aiSettings(caller: Caller): Promise<AiSettings> {
    this.enter("aiSettings", caller, []);
    this.personOnly(caller, "see the AI's settings");
    return this.ai;
  }
  async updateAiSettings(caller: Caller, patch: AiSettingsPatch): Promise<AiSettings> {
    this.enter("updateAiSettings", caller, [patch]);
    this.personOnly(caller, "change the AI's settings");
    return this.ai;
  }
  async aiStatus(caller: Caller): Promise<AiStatus> {
    this.enter("aiStatus", caller, []);
    return this.aiState;
  }
  async testAi(caller: Caller): Promise<AiStatus> {
    this.enter("testAi", caller, []);
    this.personOnly(caller, "test the AI");
    return this.aiState;
  }

  async aiUsage(caller: Caller, query: AiUsageQuery): Promise<AiUsage> {
    this.enter("aiUsage", caller, [query]);
    this.personOnly(caller, "see the AI's usage");
    return { since: NOW, timeZone: query.tz ?? "UTC", periods: { today: [], last7Days: [], last30Days: [] } };
  }

  async firstSyncWindow(caller: Caller): Promise<FirstSyncWindow> {
    this.enter("firstSyncWindow", caller, []);
    this.personOnly(caller, "see the first sync's window");
    return { days: 30, setBy: "settings", changeable: true };
  }

  async updateFirstSyncWindow(caller: Caller, patch: FirstSyncWindowPatch): Promise<FirstSyncWindow> {
    this.enter("updateFirstSyncWindow", caller, [patch]);
    this.personOnly(caller, "change the first sync's window");
    return { days: patch.days, setBy: "settings", changeable: true };
  }

  async listDrafts(caller: Caller, query: ListQuery) {
    this.enter("listDrafts", caller, [query]);
    if (query.inboxId) this.inbox(caller, query.inboxId);
    const drafts = this.drafts
      .filter((draft) => this.sees(caller, draft.inboxId) && (draft.state === "draft" || draft.state === "failed"))
      .filter((draft) => !query.inboxId || draft.inboxId === query.inboxId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
    return page(drafts, query);
  }
  async saveDraft(caller: Caller, input: DraftInput) {
    this.enter("saveDraft", caller, [input]);
    this.inbox(caller, input.inboxId);
    const existing = input.id ? this.drafts.find((draft) => draft.id === input.id) : undefined;
    if (input.id && !existing) throw new ServiceError("not_found", `No draft ${input.id}.`);
    if (existing) this.mayChange(caller, existing, "change");
    if (existing && existing.state !== "draft" && existing.state !== "failed") throw new ServiceError("conflict", `This draft is ${existing.state}.`);
    const draft: Draft = {
      id: existing?.id ?? this.nextId("drf"),
      inboxId: input.inboxId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.inReplyToMessageId ? { inReplyToMessageId: input.inReplyToMessageId } : {}),
      to: input.to,
      cc: input.cc ?? [],
      bcc: input.bcc ?? [],
      subject: input.subject,
      body: input.body,
      createdBy: existing?.createdBy ?? caller.actor,
      state: "draft",
      updatedAt: NOW,
      version: (existing?.version ?? 0) + 1,
    };
    this.drafts = [...this.drafts.filter((item) => item.id !== draft.id), draft];
    return draft;
  }
  /** Anyone with access to the draft's inbox may delete it, but an agent only a draft an agent wrote. */
  async deleteDraft(caller: Caller, id: Id) {
    this.enter("deleteDraft", caller, [id]);
    const draft = this.drafts.find((item) => item.id === id);
    if (!draft || !this.sees(caller, draft.inboxId)) throw new ServiceError("not_found", `No draft ${id}.`);
    this.mayChange(caller, draft, "delete");
    this.drafts = this.drafts.filter((item) => item.id !== id);
  }
  /** An agent may change or delete only a draft an agent wrote; a person any. */
  private mayChange(caller: Caller, draft: Draft, what: string): void {
    if (caller.actor.kind !== "person" && draft.createdBy.kind !== "agent") {
      throw new ServiceError("needs_person", `Only a person may ${what} a draft a person wrote.`);
    }
  }
  async sendDraft(caller: Caller, id: Id): Promise<Draft> {
    this.enter("sendDraft", caller, [id]);
    this.personOnly(caller, "send");
    throw new ServiceError("invalid", "The fake doesn't send.");
  }

  async latestBrief(caller: Caller) {
    this.enter("latestBrief", caller, []);
    const brief = [...this.briefs].reverse().find((item) => item.sections.some((s) => this.sees(caller, s.inboxId)));
    return brief ? { ...brief, sections: brief.sections.filter((s) => this.sees(caller, s.inboxId)) } : null;
  }
  async brief(caller: Caller, id: Id) {
    this.enter("brief", caller, [id]);
    const brief = this.briefs.find((item) => item.id === id && item.sections.some((s) => this.sees(caller, s.inboxId)));
    if (!brief) throw new ServiceError("not_found", `No brief ${id}.`);
    return { ...brief, sections: brief.sections.filter((s) => this.sees(caller, s.inboxId)) };
  }
  async writeBrief(caller: Caller, input: BriefInput) {
    this.enter("writeBrief", caller, [input]);
    const brief: Brief = {
      id: this.nextId("brf"),
      createdAt: NOW,
      from: input.from,
      to: input.to,
      // The server fills in the counts (silent records left out) and each highlight's subject.
      sections: input.sections
        .filter((section) => this.sees(caller, section.inboxId))
        .map((section) => ({
          ...section,
          counts: { conversation: 1 },
          highlights: section.highlights.map((highlight) => ({
            ...highlight,
            subject: this.threads.find((thread) => thread.id === highlight.threadId)?.subject ?? "",
          })),
        })),
      writtenBy: caller.actor,
    };
    this.briefs.push(brief);
    return brief;
  }

  async me(caller: Caller): Promise<Device> {
    this.enter("me", caller, []);
    if (caller.actor.kind === "agent") {
      return { id: caller.actor.agentId, name: caller.actor.name, kind: "agent", inboxIds: caller.inboxIds ?? [], createdAt: NOW };
    }
    if (caller.actor.kind === "person") return { id: caller.actor.deviceId, name: "Mac", kind: "person", createdAt: NOW };
    throw new ServiceError("unauthorized", "No device.");
  }
  async listDevices(caller: Caller) {
    this.enter("listDevices", caller, []);
    this.personOnly(caller, "list devices");
    return [];
  }
  async createPairingCode(caller: Caller, input: unknown) {
    this.enter("createPairingCode", caller, [input]);
    this.personOnly(caller, "create a pairing code");
    return { code: "000000", expiresAt: NOW };
  }
  async pair(input: unknown): Promise<never> {
    this.enter("pair", undefined, [input]);
    throw new ServiceError("unauthorized", "Wrong code.");
  }
  async revokeDevice(caller: Caller, id: Id) {
    this.enter("revokeDevice", caller, [id]);
  }
  // The owner's password: the connector offers none of it.
  async claimOwner(input: unknown): Promise<never> {
    this.enter("claimOwner", undefined, [input]);
    throw new ServiceError("conflict", "Already claimed.");
  }
  async startOwnerClaim(): Promise<never> {
    this.enter("startOwnerClaim", undefined, []);
    throw new ServiceError("conflict", "Already claimed.");
  }
  async signInOwner(input: unknown): Promise<never> {
    this.enter("signInOwner", undefined, [input]);
    throw new ServiceError("unauthorized", "Wrong password.");
  }
  async owner(caller: Caller) {
    this.enter("owner", caller, []);
    this.personOnly(caller, "see the owner's account");
    return { email: null, password: true };
  }
  async setOwnerPassword(caller: Caller, input: unknown) {
    this.enter("setOwnerPassword", caller, [input]);
    this.personOnly(caller, "set the owner's password");
    return { email: null, password: true };
  }
  async requestRecoveryCode() {
    this.enter("requestRecoveryCode", undefined, []);
    return { kind: "recovery" as const, expiresAt: NOW };
  }
  subscribe(caller: Caller) {
    this.enter("subscribe", caller, []);
    return () => {};
  }
}
