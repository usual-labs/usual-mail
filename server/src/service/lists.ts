// What each list holds (docs/contract.md, "Lists"), as SQL the lists and the counts share, so a count is always the
// length of its list. Every list leaves out trashed threads and threads gone from the mailbox; every list but search
// and the screening list leaves out screened ones.

import type { Category, Stack } from "@usualmail/core";
import { and, eq, gt, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { HOME_CATEGORIES } from "@usualmail/core";
import { threads } from "../db/index.ts";

export const visible = (): SQL => and(eq(threads.trashed, false), eq(threads.removed, false))!;

/** No come-back time ahead: a snoozed thread is out of sight until it comes back (only waiting and search hold it). */
const notWaiting = (now: number): SQL => or(isNull(threads.comeBackAt), lte(threads.comeBackAt, now))!;

/** In no list but search and the screening list while its sender isn't let in, and done threads are in none. */
const listed = (): SQL => and(eq(threads.screened, false), eq(threads.done, false))!;

/**
 * Home: conversations and undecided threads that aren't done, aren't on a stack and aren't waiting. Notifications have
 * their own list (the owner's decision of 2026-11-19, replacing that of 2026-11-18).
 */
export function homeWhere(now: number): SQL {
  return and(
    listed(),
    inArray(threads.category, [...HOME_CATEGORIES]),
    isNull(threads.stack),
    notWaiting(now),
  )!;
}

/** What Home sorts by: the later of the newest message and a come-back time that has passed. */
export const homeOrder = sql<number>`max(${threads.lastMessageAt}, coalesce(${threads.comeBackAt}, 0))`;

/**
 * What a category's list holds of a thread in it: not screened, not done, and not waiting to come back (the owner's
 * decision of 2026-11-20; stacked threads stay). The counts group it by category.
 */
export function categoryListed(now: number): SQL {
  return and(listed(), notWaiting(now))!;
}

/** A category's list, or several merged: threads in them that aren't done or waiting, stacked ones included. */
export function categoryWhere(category: Category | readonly Category[], now: number): SQL {
  const names = typeof category === "string" ? [category] : [...category];
  return and(categoryListed(now), inArray(threads.category, names))!;
}

/** A stack's list. A thread on a stack is never done. */
export function stackWhere(stack: Stack): SQL {
  return and(eq(threads.screened, false), eq(threads.stack, stack))!;
}

/** Waiting: a come-back time still ahead, not done. */
export function waitingWhere(now: number): SQL {
  return and(listed(), gt(threads.comeBackAt, now))!;
}

/** The screening list: screened threads that aren't done. */
export function screeningWhere(): SQL {
  return and(eq(threads.screened, true), eq(threads.done, false))!;
}

/** The triage queue's threads: undecided, nobody decided them, not done, not screened. The AI's part is the caller's. */
export function undecidedWhere(): SQL {
  return and(eq(threads.category, "unknown"), isNull(threads.categorizedBy), eq(threads.done, false), eq(threads.screened, false))!;
}
