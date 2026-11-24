// The fake models' answer to a search asked in a sentence (docs/contract-search.md, "Asking in a sentence"), for demo
// mode, the development-only switch and tests: a few English turns of phrase read by rule, so the same sentence always
// gets the same answer. It reads only what a real model is sent: the question in the data block and today's date in
// the server's words. No model, no network.

import type { ObjectRequest } from "./models.ts";

const KINDS: Array<[RegExp, string]> = [
  [/\b(?:invoices?|bills?)\b/i, "invoice"], [/\breceipts?\b/i, "receipt"], [/\bnewsletters?\b/i, "newsletter"],
  [/\bnotifications?\b/i, "notification"], [/\b(?:one-time|sign-in|verification) codes?\b/i, "otp"],
  [/\bconversations?\b/i, "conversation"], [/\barchived\b/i, "done"], [/\bscreened\b/i, "screened"],
];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
/** A name as a sentence writes it: one or two capitalised words, or an address or domain. */
const NAME = String.raw`((?:[\p{Lu}][\p{L}\p{N}'-]*(?: [\p{Lu}][\p{L}\p{N}'-]*)?)|[\p{L}\p{N}._%+-]*@?[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+)`;
const FILLER = /\b(?:the|a|an|all|any|my|me|i|show|find|search|for|mails?|e-?mails?|messages?|where|which|that|who|with|in|of|and|got|received|sent|wrote|please)\b/gi;

const pad = (n: number) => String(n).padStart(2, "0");
const day = (date: Date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;

/** The filters a few English sentences ask for, in the shape the request asks (every field present, null when not said). */
export function guessFilters(request: Pick<ObjectRequest, "instructions" | "data">): unknown {
  const line = request.data.split("\n")[1] ?? "{}";
  let left = String((JSON.parse(line) as { question?: unknown }).question ?? "");
  const today = new Date(`${/Today is \w+ (\d{4}-\d{2}-\d{2})\./.exec(request.instructions)?.[1] ?? "1970-01-01"}T00:00:00Z`);
  const take = (pattern: RegExp): RegExpExecArray | null => {
    const found = pattern.exec(left);
    if (found) left = `${left.slice(0, found.index)} ${left.slice(found.index + found[0].length)}`;
    return found;
  };
  const at = (year: number, month: number, date: number) => day(new Date(Date.UTC(year, month, date)));
  const [y, m, d] = [today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()];
  const monday = d - ((today.getUTCDay() + 6) % 7);

  let after: string | null = null;
  let before: string | null = null;
  const since = take(new RegExp(String.raw`\bsince (${MONTHS.join("|")})\b`, "i"));
  if (since) {
    const month = MONTHS.indexOf(since[1]!.toLowerCase());
    after = at(month > m ? y - 1 : y, month, 1);
  } else if (take(/\blast month\b/i)) [after, before] = [at(y, m - 1, 1), at(y, m, 1)];
  else if (take(/\bthis month\b/i)) after = at(y, m, 1);
  else if (take(/\blast week\b/i)) [after, before] = [at(y, m, monday - 7), at(y, m, monday)];
  else if (take(/\bthis week\b/i)) after = at(y, m, monday);
  else if (take(/\byesterday\b/i)) [after, before] = [at(y, m, d - 1), at(y, m, d)];
  else if (take(/\btoday\b/i)) after = at(y, m, d);
  else if (take(/\blast year\b/i)) [after, before] = [at(y - 1, 0, 1), at(y, 0, 1)];
  else if (take(/\bthis year\b/i)) after = at(y, 0, 1);

  const exclude = take(/\b(?:but not|except|without)(?: the| any)? (?!attachments?\b)([\p{L}\p{N}-]+)/iu)?.[1] ?? null;
  const without = take(/\bwithout (?:an? |any )?attachments?\b/i);
  const attached = !without && take(/\b(?:with )?(?:an? )?(?:attachments?|attached|pdfs?|files?|photos?|documents?)\b/i);
  const unread = take(/\bunread\b/i) ? true : take(/\b(?:already )?read\b/i) ? false : null;
  const kinds = KINDS.filter(([pattern]) => take(pattern)).map(([, kind]) => kind);
  const from = take(new RegExp(String.raw`\bfrom ${NAME}`, "u"))?.[1] ?? take(new RegExp(String.raw`\b${NAME} (?:sent|wrote)\b`, "u"))?.[1] ?? null;
  const to = take(new RegExp(String.raw`\b(?:sent )?to ${NAME}`, "u"))?.[1] ?? null;
  const subject = take(/\b(?:with |whose )?(?:the )?subject (?:line )?(?:is |says |holds )?"?([^"]+?)"?$/i)?.[1]?.trim() ?? null;
  const text = left.replace(FILLER, " ").replace(/[?!.,;]+(?=\s|$)/g, " ").replace(/\s+/g, " ").trim();
  return {
    kinds: kinds.length ? kinds : null,
    from,
    to,
    subject,
    hasAttachment: without ? false : attached ? true : null,
    unread,
    after,
    before,
    exclude: exclude ? [exclude] : null,
    text: text || null,
  };
}
