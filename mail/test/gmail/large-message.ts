/**
 * A message of about 30 MB for the large-message tests: text in quoted-printable (flowed), HTML in Latin-1 with an
 * inline picture, a 22.5 MB attachment, a calendar invite with CRLF lines, a forwarded message read inline with its
 * own attachment, and a forwarded message as an attachment. Made-up `.example` addresses only.
 */
import { randomBytes } from "node:crypto";
import type { MailProvider, ProviderMessage } from "@usualmail/core";
import { createGmailProvider, type GmailProviderOptions } from "../../src/gmail/index.ts";
import { everyByte, FakeGmail, plainMessage, syncAll, TINY_PNG } from "../../src/testing/index.ts";

export const ADDRESS = "me@mail.example";

const organisationalDomain = (domain: string) => domain.split(".").slice(-2).join(".");

/** A Gmail provider on the fake, asking for Gmail's word on the From domain, with quota to spare. */
export function provider(fake: FakeGmail, options: GmailProviderOptions = {}): MailProvider {
  return createGmailProvider(fake.credentials, { fetch: fake.fetch, quotaPerSecond: 1_000_000_000, authentication: { organisationalDomain }, ...options });
}

/** Every message one first sync sends, by ref. */
export async function synced(p: MailProvider): Promise<Map<string, ProviderMessage>> {
  return (await syncAll(p, null)).messages;
}

/** The message reads since request `from`: the form asked for, or `attachments.get`. */
export const gets = (fake: FakeGmail, from = 0) =>
  fake.requests.slice(from).filter((r) => r.path.startsWith("/messages/")).map((r) => (r.path.includes("/attachments/") ? "attachments.get" : `get ${r.query.get("format") ?? "full"}`));

export const INVITE = ["BEGIN:VCALENDAR", "VERSION:2.0", "METHOD:REQUEST", "BEGIN:VEVENT", "SUMMARY:Plans", "DTSTART:20261120T100000Z", "END:VEVENT", "END:VCALENDAR", "", ""].join("\r\n");

export function base64Lines(bytes: Uint8Array): string {
  const text = Buffer.from(bytes).toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < text.length; i += 76) lines.push(text.slice(i, i + 76));
  return lines.join("\r\n");
}

export function largeMessage(footageBytes = Math.round(22.5 * 1024 * 1024)): { raw: Buffer; footage: Buffer } {
  const footage = randomBytes(footageBytes);
  const html = Buffer.from('<p>Grüße aus Köln, <b>das Video</b> hängt an.</p><img src="cid:logo@people.example" alt="Logo">', "latin1");
  const earlier = plainMessage({ from: "Cy <cy@people.example>", to: ADDRESS, subject: "Old notes", body: "Old notes, attached." }).raw;
  const lines = [
    "From: =?utf-8?Q?M=C3=BCller=2C_Ann?= <ann@people.example>",
    `To: Me <${ADDRESS}>, bo@people.example`,
    "Cc: Cy <cy@people.example>",
    "Reply-To: replies@people.example",
    "Subject: =?utf-8?B?UGzDpG5lIOKAkyBkYXMgVmlkZW8=?=",
    "Date: Tue, 17 Nov 2026 10:00:00 +0000",
    "Message-ID: <big-1@people.example>",
    "In-Reply-To: <earlier@people.example>",
    "References: <first@people.example>\r\n <earlier@people.example>",
    "List-Id: Plans <plans.people.example>",
    "List-Unsubscribe: <mailto:leave@people.example>",
    "Authentication-Results: mx.google.com;\r\n       dkim=pass header.i=@people.example;\r\n       dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=people.example",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="mixed-b"',
    "",
    "--mixed-b",
    'Content-Type: multipart/alternative; boundary="alt-b"',
    "",
    "--alt-b",
    "Content-Type: text/plain; charset=utf-8; format=flowed",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Hallo,=20",
    "sch=C3=B6ne Gr=C3=BC=C3=9Fe aus K=C3=B6ln, mit einer langen Zeile, die weich umbro=",
    "chen wurde. ",
    "Das Video h=C3=A4ngt an.",
    "--alt-b",
    'Content-Type: multipart/related; boundary="rel-b"',
    "",
    "--rel-b",
    "Content-Type: text/html; charset=iso-8859-1",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(html),
    "--rel-b",
    'Content-Type: image/png; name="logo.png"',
    "Content-Transfer-Encoding: base64",
    "Content-ID: <logo@people.example>",
    'Content-Disposition: inline; filename="logo.png"',
    "",
    base64Lines(TINY_PNG),
    "--rel-b--",
    "--alt-b--",
    "--mixed-b",
    'Content-Type: application/octet-stream; name="footage.bin"',
    "Content-Transfer-Encoding: base64",
    'Content-Disposition: attachment; filename="footage.bin"',
    "",
    base64Lines(footage),
    "--mixed-b",
    'Content-Type: text/calendar; charset=utf-8; method=REQUEST; name="invite.ics"',
    "Content-Transfer-Encoding: base64",
    'Content-Disposition: attachment; filename="invite.ics"',
    "",
    base64Lines(Buffer.from(INVITE)),
    "--mixed-b",
    "Content-Type: message/rfc822",
    "",
    "From: Bo <bo@people.example>",
    "To: Ann <ann@people.example>",
    "Subject: The earlier plan",
    "Date: Mon, 16 Nov 2026 09:00:00 +0000",
    "Message-ID: <inner-1@people.example>",
    'Content-Type: multipart/mixed; boundary="inner-b"',
    "",
    "--inner-b",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "The earlier plan, forwarded.",
    "--inner-b",
    'Content-Type: application/pdf; name="plan.pdf"',
    "Content-Transfer-Encoding: base64",
    "Content-Disposition: attachment; filename*=utf-8''%E2%82%AC%20plan.pdf",
    "",
    base64Lines(everyByte(8)),
    "--inner-b--",
    "--mixed-b",
    'Content-Type: message/rfc822; name="old.eml"',
    'Content-Disposition: attachment; filename="old.eml"',
    "",
    earlier.replace(/\r\n$/, ""),
    "--mixed-b--",
    "",
  ];
  return { raw: Buffer.from(lines.join("\r\n"), "utf8"), footage };
}
