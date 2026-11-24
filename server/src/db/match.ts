// Text matches without LIKE (docs/agents/decisions.md, 2026-11-21): a Durable Object's SQLite refuses a LIKE or GLOB
// pattern over 50 bytes when it evaluates one against a row, and a pattern made from a name, a word or a domain can be
// longer (one around a word of 16 CJK characters already is). These match as a LIKE with every wildcard escaped did:
// the text literally, ASCII letters in either case and no other letters (SQLite's `lower`, like its LIKE, folds ASCII
// only). Like a LIKE with a leading wildcard, they never use an index. LIKE stays for constant patterns of the code's own.

import { sql, type AnyColumn, type SQL } from "drizzle-orm";

/** `expression LIKE '%text%'`, `text` taken literally. */
export function contains(expression: AnyColumn | SQL, text: string): SQL {
  return sql`instr(lower(${expression}), lower(${text})) > 0`;
}

/** `expression LIKE '%text'`, `text` taken literally. */
export function endsWith(expression: AnyColumn | SQL, text: string): SQL {
  // `substr` with -0 gives the whole value; LIKE '%' (one byte, constant) matches anything but NULL.
  if (text === "") return sql`${expression} LIKE '%'`;
  return sql`substr(lower(${expression}), -length(${text})) = lower(${text})`;
}
