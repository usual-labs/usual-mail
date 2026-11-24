/**
 * Serving an attachment by the id the parser gave it (its position among the message's attachments), by the same way
 * the message was stored, so the position is read the way it was numbered:
 *
 * - With no size limit (`largeMessageBytes` Infinity, Node's default): the raw form and the parser, as always.
 * - With a limit: the minimal form first (20 units). A message at or under the limit was stored from the raw form and
 *   is served from it. One over it (or of unknown size) was stored from the full form: the full form again (60), the
 *   same rebuild with the same decisions (full.ts, `serve`), every part marked, and the part at that position downloaded
 *   alone through `messages.attachments.get` (20), streamed (download.ts), or taken from the full form's own bytes.
 *
 * A part the rebuild wrote empty, or a position that names nothing, answers "The message has no such attachment."
 */
import type { GmailClient } from "./client.ts";
import { downloadAttachment } from "./download.ts";
import { getFull, rebuildFull, typeOf } from "./full.ts";
import { getMinimal, getRaw, overLimit, type MessageLimits } from "./messages.ts";
import type { GmailPart } from "./payload.ts";
import { attachmentBytes, attachmentContent, attachmentIndex } from "../message/parse.ts";

const CALENDAR = new Set(["text/calendar", "application/ics"]);
const GONE = "Gmail no longer has this message.";
const NO_SUCH = "The message has no such attachment.";

export function gmailAttachment(client: GmailClient, ref: string, attachmentId: string, limits: MessageLimits): Promise<Uint8Array> {
  return limits.gate.run(async () => {
    const limit = limits.largeMessageBytes;
    if (Number.isFinite(limit)) {
      const minimal = await getMinimal(client, ref);
      if (!minimal) throw new Error(GONE);
      if (overLimit(minimal, limit)) return fromFullForm(client, ref, attachmentId, limit);
    }
    const raw = await getRaw(client, ref);
    if (!raw?.raw) throw new Error(GONE);
    const content = await attachmentContent(Buffer.from(raw.raw, "base64url"), attachmentId);
    if (!content) throw new Error(NO_SUCH);
    return content;
  });
}

async function fromFullForm(client: GmailClient, ref: string, attachmentId: string, budget: number): Promise<Uint8Array> {
  const index = attachmentIndex(attachmentId);
  if (index === undefined) throw new Error(NO_SUCH);
  const full = await getFull(client, ref);
  if (!full) throw new Error(GONE);
  const { rebuilt, emptied } = await rebuildFull(client, full, { budget, serve: true });
  const content = (await attachmentBytes(rebuilt.bytes))[index];
  if (!content) throw new Error(NO_SUCH);
  const part = rebuilt.partOf(content);
  // Every part but a forwarded message is marked in this rebuild, so unmarked content is a forwarded message's own
  // bytes, as Gmail gave them or as they were downloaded.
  if (!part) return content;
  if (emptied.has(part)) throw new Error(NO_SUCH);
  let bytes: Uint8Array;
  if (part.body?.data) bytes = Buffer.from(part.body.data, "base64url");
  else if (part.body?.attachmentId) bytes = await downloadAttachment(client, ref, part.body.attachmentId, part.body.size);
  else if (!part.body?.size && !part.parts?.length) bytes = new Uint8Array(0);
  // A forwarded message Gmail only expanded, with neither its bytes nor an id for them: nothing true to serve.
  else throw new Error(NO_SUCH);
  return CALENDAR.has(typeOf(part)) ? asParserReadsIt(part, bytes) : bytes;
}

/**
 * A calendar invite as the parser gives it for the raw form: read as text in its charset and written as UTF-8 with LF
 * line ends (postal-mime normalises them), so both forms serve the same bytes.
 */
async function asParserReadsIt(part: GmailPart, bytes: Uint8Array): Promise<Uint8Array> {
  const type = part.headers?.find((h) => h.name?.toLowerCase() === "content-type")?.value ?? typeOf(part);
  const lines = Buffer.from(bytes).toString("base64").match(/.{1,76}/g) ?? [];
  const message = [`Content-Type: ${type.replace(/[\r\n]+/g, " ")}`, "Content-Disposition: attachment", "Content-Transfer-Encoding: base64", "", ...lines, ""].join("\r\n");
  return (await attachmentBytes(message))[0] ?? bytes;
}
