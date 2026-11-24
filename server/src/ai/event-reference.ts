// The reference a notification prints, as the server keeps it to join notifications about the same thing
// (docs/contract-ai.md, "Notification groups"): an order, tracking, booking, ticket or case number the model read,
// kept only when the mail writes it (separators and case aside) and it is shaped like one. Never served, never stored:
// only a hash of it (event-group.ts). Pure.

import { plainLine } from "./payment.ts";

/** How long a reference may be once separators are taken out: shorter is a house number or a year, longer is a link. */
export const REFERENCE_MIN = 5;
export const REFERENCE_MAX = 40;

/** What may stand between a reference's letters and digits as the mail writes it. */
const SEPARATOR = String.raw`[\s\-_./#:]`;
/**
 * A label a model may put before the number itself ("Order 10-55821", "Tracking number: PW 4471 2093"), in the
 * matcher's seven languages, with "no.", "nr.", "number", "#" or a colon after it, and a separator before the number
 * ("NO1234X" keeps its letters). Taken off, so one thing's mails join whether or not a label came with its number.
 */
const LABEL = new RegExp(String.raw`^(?:(?:order|booking|reservation|confirmation|tracking|shipment|parcel|package|ticket|case|reference|ref|invoice|bestellung|bestellnummer|auftrag|auftragsnummer|sendung|sendungsnummer|paket|buchung|buchungsnummer|buchungscode|vorgang|commande|réservation|suivi|colis|pedido|reserva|envío|ordine|prenotazione|spedizione|bestelling|zending|boeking|encomenda|no|nr|n°|nº)(?:\s*(?:no|nr|number|nummer|code|n°|nº)\.?)?${SEPARATOR}+)+`, "iu");
const AMOUNT = /[€$£¥]|(?<![\p{L}])(?:eur|usd|gbp|chf)(?![\p{L}])|^\d{1,3}(?:[.,' ]\d{3})*[.,]\d{2}$|^\d+[.,]\d{2}$/iu;
const DATE = /^(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[./-]\d{1,2}[./-](?:\d{2}|\d{4}))$/;
const URL = /:\/\/|^www\.|[\p{L}\d-]+\.[\p{L}]{2,}\//iu;

/**
 * The reference as the server keeps it, its letters and digits in capitals ("PW44712093"), or why not: the safe-line
 * checks (`markup`, `address`), a link (`url`), a phone number (`phone`: a leading "+"), an amount, a date, a character
 * that is neither a letter, a digit nor a separator (`shape`), `length` (5 to 40 once separators are out), `no_digit`,
 * or `not_in_text` when `text` doesn't write it with the same letters and digits in order (separators and case aside,
 * not inside a longer run of letters and digits).
 */
export function checkReference(given: string, text: string): { reference: string } | { dropped: string } {
  const line = plainLine(given.trim(), 120);
  if (!line) return { dropped: "shape" };
  if ("dropped" in line) return line;
  const value = line.line;
  if (URL.test(value)) return { dropped: "url" };
  if (value.startsWith("+")) return { dropped: "phone" };
  if (AMOUNT.test(value)) return { dropped: "amount" };
  if (DATE.test(value)) return { dropped: "date" };
  const unlabelled = value.replace(LABEL, "");
  const number = /\d/.test(unlabelled) ? unlabelled : value;
  const compact = number.replace(new RegExp(`${SEPARATOR}+`, "gu"), "");
  if (!/^[\p{L}\p{N}]+$/u.test(compact)) return { dropped: "shape" };
  if (compact.length < REFERENCE_MIN || compact.length > REFERENCE_MAX) return { dropped: "length" };
  if (!/\d/.test(compact)) return { dropped: "no_digit" };
  const written = new RegExp(`(?<![\\p{L}\\p{N}])${[...compact].join(`${SEPARATOR}*`)}(?![\\p{L}\\p{N}])`, "iu");
  if (!written.test(text)) return { dropped: "not_in_text" };
  return { reference: compact.toUpperCase() };
}
