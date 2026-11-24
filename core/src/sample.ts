/**
 * The shape of fixtures/sample.json: one small, made-up server state every interface can render. Its addresses end
 * in `.example`, and its model ids (`example/...`) are made up too: they are not the server's defaults.
 */
import type { AiSettings, AiStatus } from "./ai.ts";
import type { AiUsage } from "./ai-usage.ts";
import type { ActionRecord, Address, AttachmentMeta, BlockedSender, Brief, Counts, Draft, Inbox, IsoTime, Message, Rule, Thread } from "./domain.ts";
import type { FirstSyncWindow } from "./first-sync.ts";
import type { SearchAskResult } from "./search.ts";

export interface SampleData {
  /** The moment the sample pretends is "now". Times in it are relative to this. */
  now: string;
  /** In the inbox list's order, by `position`. */
  inboxes: Inbox[];
  threads: Thread[];
  messages: Message[];
  drafts: Draft[];
  actions: ActionRecord[];
  rules: Rule[];
  brief: Brief;
  /** As a person's device gets it: never the key. */
  ai: AiSettings;
  aiStatus: AiStatus;
  /** As a person's device gets it from `GET /v1/first-sync`. */
  firstSync: FirstSyncWindow;
  /** As a person's device gets it from `GET /v1/ai/usage?tz=Europe/Berlin`: both jobs, one model change, a cost not reported and costs partly reported. */
  aiUsage: AiUsage;
  /** As a person's device gets it: every inbox. */
  counts: Counts;
  /** As a person's device gets it from `GET /v1/senders?state=blocked`: every inbox, the newest block first. */
  blockedSenders: BlockedSender[];
  /**
   * Mail a Gmail inbox's mailbox holds from before its first sync's window, which the server doesn't hold: what demo
   * mode's search of the mailbox itself finds (docs/contract-search.md). Never in `threads` or `messages`.
   */
  olderMail: SampleOlderMail[];
  /**
   * Searches asked in a sentence (docs/contract-search.md, "Asking in a sentence"), each with what
   * `POST /v1/search/ask` answers at `now` in `tz` when demo mode's fake models read it: filters found, an amount
   * left in the text, and a sentence with nothing to turn into a filter.
   */
  searchAsks: SampleSearchAsk[];
}

/** One sentence and its answer. */
export interface SampleSearchAsk {
  question: string;
  tz: string;
  answer: SearchAskResult;
}

/** One message of older mail, as the sample's mailbox has it. Messages with the same `threadKey` are one conversation. */
export interface SampleOlderMail {
  inboxId: string;
  threadKey: string;
  from: Address;
  to: Address[];
  subject: string;
  date: IsoTime;
  text: string;
  /** Out of the mailbox's inbox. */
  archived: boolean;
  attachments?: AttachmentMeta[];
}
