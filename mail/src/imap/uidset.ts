/**
 * Compact UID sets in IMAP sequence-set form: [1,2,3,7,9,10] is "1:3,7,9:10". Used inside the cursor and
 * in commands, so long mailboxes stay short.
 */

export function encodeUids(uids: Iterable<number>): string {
  const sorted = [...new Set(uids)].filter((uid) => Number.isSafeInteger(uid) && uid > 0).sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0];
  let prev = start;
  for (let i = 1; i <= sorted.length; i++) {
    const uid = sorted[i];
    if (uid !== undefined && prev !== undefined && uid === prev + 1) {
      prev = uid;
      continue;
    }
    if (start !== undefined && prev !== undefined) parts.push(start === prev ? `${start}` : `${start}:${prev}`);
    start = uid;
    prev = uid;
  }
  return parts.join(",");
}

/** Throws on anything that isn't a plain UID set, so a damaged cursor is noticed. */
export function decodeUids(set: string): number[] {
  if (!set) return [];
  const out: number[] = [];
  for (const part of set.split(",")) {
    const match = /^(\d+)(?::(\d+))?$/.exec(part);
    if (!match) throw new Error(`Bad UID set: ${part}`);
    const a = Number(match[1]);
    const b = match[2] === undefined ? a : Number(match[2]);
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 1 || b < a) throw new Error(`Bad UID range: ${part}`);
    if (b - a > 10_000_000) throw new Error(`UID range too large: ${part}`);
    for (let uid = a; uid <= b; uid++) out.push(uid);
  }
  return out;
}

export function uidSetSize(set: string): number {
  if (!set) return 0;
  let size = 0;
  for (const part of set.split(",")) {
    const [a, b] = part.split(":").map(Number);
    size += b === undefined ? 1 : b - (a ?? b) + 1;
  }
  return size;
}
