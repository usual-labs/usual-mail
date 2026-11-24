// What the connector's fake service starts from: the callers and their tokens, the sample, and paging helpers that
// don't need its state. Split from fake-service.ts to keep that file to its behaviour.
import { readFileSync } from "node:fs";
import type { Caller, ListQuery, Page, SampleData, Thread } from "@usualmail/core";

export interface Call {
  method: string;
  caller: Caller | undefined;
  args: unknown[];
}

export const AGENT: Caller = {
  actor: { kind: "agent", agentId: "dev_agent_1", name: "Test Agent" },
  inboxIds: ["inb_northwind", "inb_harbor"],
};
export const NARROW_AGENT: Caller = {
  actor: { kind: "agent", agentId: "dev_agent_2", name: "Narrow Agent" },
  inboxIds: ["inb_harbor"],
};
export const PERSON: Caller = { actor: { kind: "person", deviceId: "dev_mac" } };

export const TOKENS: Record<string, Caller> = {
  "umt_agent": AGENT,
  "umt_narrow": NARROW_AGENT,
  "umt_person": PERSON,
};

export function sample(): SampleData {
  return JSON.parse(readFileSync(new URL("../../core/fixtures/sample.json", import.meta.url), "utf8")) as SampleData;
}

export const NOW = "2026-11-16T09:30:00Z";

export function page<T>(items: T[], query: ListQuery): Page<T> {
  const start = query.cursor ? Number(query.cursor) : 0;
  const size = Math.min(query.limit ?? 50, 200);
  const slice = items.slice(start, start + size);
  return start + size < items.length ? { items: slice, nextCursor: String(start + size) } : { items: slice };
}

export const newestFirst = (a: Thread, b: Thread) => b.lastMessageAt.localeCompare(a.lastMessageAt) || b.id.localeCompare(a.id);

export async function authenticate(token: string): Promise<Caller | null> {
  return TOKENS[token] ?? null;
}
