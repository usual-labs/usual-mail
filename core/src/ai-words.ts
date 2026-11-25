/**
 * What leaves the server for each of the AI's jobs, once: the numbers and names the server builds its requests with,
 * and the words every interface shows a person before it saves an AI key, which is their consent to every inbox's mail
 * going to that service (docs/contract-ai.md, "What leaves the server"). The server builds requests only from the fields named in `AI_SENT_FIELD_WORDS`, and its tests fail on
 * any other, so the words a person reads stay exactly true.
 */
import type { AiConnection, AiGateway, AiJob, AiJobSetting, AiProvider } from "./ai.ts";

/** The most of one message's text the categorize job sends. */
export const CATEGORIZE_TEXT_LIMIT = 4_000;
/** The most of a subject any job sends (0.1.3: a subject had no limit, and a long one was read under the server's lock). */
export const SUBJECT_LIMIT = 1_000;
/** The most text, over all of a thread's messages, the summarize job sends. */
export const SUMMARIZE_TEXT_LIMIT = 8_000;
/** The longest summary the server keeps. */
export const SUMMARY_LIMIT = 200;
/** How the summarize job names a sender who gave no name. Never their address. */
export const NAMELESS_SENDER = "someone";
/** How the summarize job names the mailbox's own messages. */
export const OWN_SENDER = "you";
/** What stands in a summarize request for an email address in the subject or a message's text. */
export const ADDRESS_STAND_IN = "[address]";

/** Each gateway's and provider's name, as a person reads it. */
export const AI_SERVICE_NAMES: Record<AiGateway | AiProvider, string> = {
  vercel: "Vercel's AI Gateway",
  openai: "OpenAI",
  anthropic: "Anthropic",
};

/** "Vercel's AI Gateway", "OpenAI", "Anthropic". */
export function aiServiceName(connection: AiConnection): string {
  return AI_SERVICE_NAMES[connection.kind === "gateway" ? connection.gateway : connection.provider];
}

/** 4000 as "4,000". */
function thousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Every field a job's request carries about mail, with the words that name it. A categorize request carries one item
 * with these fields (`from` holds `name` and `email`); a summarize request carries `subject` first, then one item per
 * message with `from` and `text`. Nothing else about mail is ever sent.
 */
export const AI_SENT_FIELD_WORDS = {
  categorize: {
    subject: `the subject (at most ${thousands(SUBJECT_LIMIT)} characters)`,
    from: "the newest incoming message's sender name and address",
    listId: "its List-Id",
    machineSent: "whether it looks machine-sent",
    text:
      "that message's text (made from its HTML when it has no text part or only a short stub of one), with each link " +
      `cut to its site and invisible characters, padding and long divider lines taken out, at most ${thousands(CATEGORIZE_TEXT_LIMIT)} characters`,
  },
  summarize: {
    subject: `the subject (at most ${thousands(SUBJECT_LIMIT)} characters)`,
    text:
      "the text of the thread's messages from the newest back, with links cut to their site and invisible characters " +
      `taken out, at most ${thousands(SUMMARIZE_TEXT_LIMIT)} characters in all`,
    from: `each with its sender's name ("${NAMELESS_SENDER}" when the sender gave none, "${OWN_SENDER}" for your own)`,
    sent: "the day it was sent (its weekday and date where the server runs)",
  },
} as const satisfies Record<AiJob, Record<string, string>>;

/**
 * The one field a search asked in a sentence carries (docs/contract-search.md, "Asking in a sentence"): the sentence.
 * Nothing about mail, senders or inboxes goes with it.
 */
export const AI_ASK_FIELD_WORDS = {
  question: "the sentence as you wrote it",
} as const;

const C = AI_SENT_FIELD_WORDS.categorize;
const S = AI_SENT_FIELD_WORDS.summarize;

/** What each job sends, and what is never sent, as sentences. The same for every inbox and service. */
export const AI_SENT_WORDS = {
  categorize: `${C.subject}; ${C.from}, ${C.listId} and ${C.machineSent}; and ${C.text}.`,
  summarize:
    `${S.subject}, and ${S.text}, ${S.from} and ${S.sent}. Any email address in the subject or the text is replaced with ` +
    `${ADDRESS_STAND_IN}, so no address is sent. Never for a one-time code. For a receipt or an invoice the same is ` +
    "sent, and in place of a summary the AI is asked who the money goes to or came from, how much, whether it is " +
    "paid, will be charged or is to be paid, whether it is a refund, when it is due or charged and what it was for. " +
    "For a notification the same is sent, and with the summary the AI is asked what happened, about what, and when.",
  ask:
    `only when you ask search in a sentence, and only then: ${AI_ASK_FIELD_WORDS.question}, with today's date and ` +
    "weekday, to be turned into search filters. Nothing from your mail goes with it: no message, no sender's name or " +
    "address, no inbox's name or address. What you type into the search field otherwise is never sent.",
  never:
    "attachments or their names, HTML, remote pictures, who else a message was sent or copied to, any credentials, " +
    "an inbox's guide, rules, anything from a sender you blocked, spam, or threads that are done or in the trash. " +
    "Testing the AI sends no mail.",
} as const;

/**
 * The words an interface shows before it saves an AI key (or one for another service): what leaves the server and to
 * whom. Saving the key is the person's consent, for every inbox connected to the server, now and later. The server
 * builds them (`GET /v1/ai/disclosure`) with this file's `aiDisclosure`, and every interface shows what it answers, so
 * they can't differ.
 */
export interface AiDisclosure {
  /** The service the mail goes to: "Vercel's AI Gateway". */
  service: string;
  /**
   * A whole sentence: "Saving this key sends the mail of every inbox connected to this server, now and later, out of
   * your server to Vercel's AI Gateway, which passes it on to the company that runs each model (categorize: …;
   * summarize: …)." The models are named when the builder is given them, as the server always does.
   */
  destination: string;
  /** "Vercel's AI Gateway's own terms then apply to what it receives." */
  terms: string;
  /** "For each thread the AI processes, the server sends:" */
  lead: string;
  /** To categorize it, to summarize it, to search by a sentence, and never, in that order. */
  sent: Array<{ label: string; words: string }>;
  /** What it works through: new mail as it arrives, then all the synced mail that isn't done. */
  history: string;
}

/**
 * What leaves the server and to whom, for a key for `connection`, with `jobs` the models that would do each job there
 * (the server passes the person's chosen models for the service already set, otherwise that service's defaults).
 * Without `jobs` the words name no models.
 */
export function aiDisclosure(input: { connection: AiConnection; jobs?: readonly AiJobSetting[] }): AiDisclosure {
  const service = aiServiceName(input.connection);
  const model = (job: AiJob) => {
    const setting = input.jobs?.find((item) => item.job === job);
    return setting?.model ?? setting?.defaultModel ?? "";
  };
  const models = input.jobs ? ` (categorize: ${model("categorize")}; summarize: ${model("summarize")})` : "";
  const gateway = input.connection.kind === "gateway";
  return {
    service,
    destination:
      `Saving this key sends the mail of every inbox connected to this server, now and later, out of your server to ${service}` +
      (gateway ? `, which passes it on to the company that runs each model${models}.` : `${models}.`),
    terms: `${service}'s own terms then apply to what it receives.`,
    lead: "For each thread the AI processes, the server sends:",
    sent: [
      { label: "To categorize it", words: AI_SENT_WORDS.categorize },
      { label: "To summarize it", words: AI_SENT_WORDS.summarize },
      { label: "To search by a sentence", words: AI_SENT_WORDS.ask },
      { label: "Never", words: AI_SENT_WORDS.never },
    ],
    history: "It processes new mail as it arrives, then every thread of each inbox's synced mail that isn't done, newest first.",
  };
}
