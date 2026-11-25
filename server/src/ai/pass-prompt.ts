// The screening gate's one question (docs/contract-ai.md, "What leaves the server" and "Mail is untrusted input to a
// model"): for machine-sent mail from a sender who isn't let in, after the AI categorized it, whether it is one of the
// kinds of mail that may skip Screening. Asked only when the server's own check could let it through (gate.ts,
// `worthAsking`), at most once per categorize, on the categorize job's model, with exactly what the categorize request
// carried. A decision model answers it on the gateway; a language model through structured output limited to the
// options. The answer alone lets nothing through: the server checks the kind itself (gate.ts, `screeningPass`).

import type { DecidedCategory, ScreeningPass } from "@usualmail/core";
import { askableKinds } from "./gate.ts";
import type { ChoiceRequest } from "./models.ts";
import { categorizeItem, dataBlock, dataNotice, type CategorizeInput } from "./prompt.ts";

/** The answer that is none of the kinds. */
export const NO_PASS = "none";

/** Each kind a model may be asked about, with what it means: the server's words, never mail. */
export const PASS_OPTIONS: Record<Exclude<ScreeningPass, "code">, string> = {
  sign_in: "A link or button to sign in or log in, sent because someone asked to sign in (a magic link).",
  email_confirmation: "A link to confirm or verify an email address, or to activate a new account, sent after signing "
    + "up or changing the address.",
  security: "A security alert about the reader's own account: a new sign-in or device, \"was this you?\", a password, "
    + "two-step verification or recovery setting changed, or suspicious activity.",
  account: "A password reset link, or a notice that the reader's own account changed: its email address or plan changed, "
    + "the account was deleted, or a data export is ready.",
  order: "A receipt, an order confirmation, or a shipping or delivery update for something the reader ordered.",
  booking: "A booking the reader made: a flight, train, hotel, ticket or appointment confirmation or its update.",
  payment: "A payment or bank alert about the reader's own account or card: a failed payment, a card charged, a "
    + "subscription renewal, or a fraud check.",
};

const NONE_DESCRIPTION = "None of these: marketing, a newsletter, an offer, a nudge to buy, upgrade or finish signing up, "
  + "mail written by a person, or anything else.";

/** What the question asks, around the data block whose id it names. */
export function passInstructions(id: string): string {
  return [
    "Decide whether this automatic email is one of these notices a service sends about something the reader did or owns.",
    dataNotice(id),
    "Choose exactly one. Choose none unless it clearly is one of them; mail that sells, advertises or asks for a reply is none.",
  ].join(" ");
}

/**
 * The question for mail the AI put in `category`: the kinds that may be in it, then none; null when no kind may be.
 * `input` is what the categorize request carried.
 */
export function passRequest(model: string, input: CategorizeInput, category: DecidedCategory, id: string): ChoiceRequest | null {
  const kinds = askableKinds(category);
  if (kinds.length === 0) return null;
  return {
    model,
    instructions: passInstructions(id),
    data: dataBlock([categorizeItem(input)], id),
    options: [...kinds.map((kind) => ({ value: kind, description: PASS_OPTIONS[kind] })), { value: NO_PASS, description: NONE_DESCRIPTION }],
  };
}

/** The kind the answer names when it is one of the request's own options, or null (none, or anything else). */
export function acceptPass(answer: string | null, request: ChoiceRequest): ScreeningPass | null {
  if (answer === null || answer === NO_PASS || !request.options.some((option) => option.value === answer)) return null;
  return answer as ScreeningPass;
}
