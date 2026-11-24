/** Reading mail: one thread in full, search, and the lists (Home, a category, a stack, waiting, screening). */
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/server";
import { CATEGORIES, SEARCH_KINDS, STACKS, type Category, type Inbox, type ListQuery, type Page, type Stack, type Thread } from "@usualmail/core";
import * as z from "zod";
import { DATA_NOTICE, toolResult } from "../boundary.ts";
import { invalid } from "../errors.ts";
import { draftItem, messageItem, offsetCursor, TEXT_LIMITS, threadSummary } from "../format.ts";
import { threadRows } from "../ui/structured.ts";
import { THREADS_VIEW_URI } from "../ui/views.ts";
import { cursor, guard, id, limit, READ_ONLY, type ToolContext } from "./shared.ts";

const VIEWS = ["home", ...CATEGORIES, ...STACKS, "waiting", "screening"] as const;
type View = (typeof VIEWS)[number];

const MORE = "There is more: call again with `cursor` set to the nextCursor in the last data line.";

function listOf(context: ToolContext, view: View, query: ListQuery): Promise<Page<Thread>> {
  const { service, caller } = context;
  if (view === "home") return service.home(caller, query);
  if (view === "waiting") return service.waiting(caller, query);
  if (view === "screening") return service.screening(caller, query);
  if ((CATEGORIES as readonly string[]).includes(view)) return service.category(caller, view as Category, query);
  return service.stack(caller, view as Stack, query);
}

function pageData<T>(items: T[], nextCursor: string | undefined): unknown[] {
  return nextCursor ? [...items, { nextCursor }] : items;
}

export function registerThreadTools(server: McpServer, context: ToolContext): void {
  const { service, caller } = context;

  server.registerTool(
    "read_thread",
    {
      title: "Read a thread",
      description:
        "Reads one thread in full: its category and who decided it, whether it is screened, Usual Mail's summary, " +
        "where it is and why, its messages oldest first, and any draft replies. Long " +
        "threads come in pages: the first page has the newest messages; pass nextCursor for older ones. Long " +
        `messages are cut and marked truncated. ${DATA_NOTICE}`,
      inputSchema: z.object({
        threadId: id("The thread, from another Usual Mail result."),
        cursor,
        limit: limit(5, 20),
      }),
      annotations: READ_ONLY,
    },
    guard(async ({ threadId, cursor: from, limit: count }) => {
      const skip = offsetCursor(from);
      if (skip === undefined) return invalid("cursor is not one this tool gave out.");
      const detail = await service.thread(caller, threadId);
      const size = count ?? 5;
      const end = Math.max(0, detail.messages.length - skip);
      const start = Math.max(0, end - size);
      const messages = detail.messages.slice(start, end).map((message) => messageItem(message, TEXT_LIMITS.thread));
      const nextCursor = start > 0 ? String(skip + size) : undefined;
      return toolResult({
        lead:
          `Thread with ${detail.messages.length} message${detail.messages.length === 1 ? "" : "s"}; this page has ` +
          `${messages.length}, oldest first, and ${detail.drafts.length} draft${detail.drafts.length === 1 ? "" : "s"}.`,
        data: pageData([threadSummary(detail.thread), ...messages, ...detail.drafts.map(draftItem)], nextCursor),
        ...(nextCursor ? { next: "Older messages: call again with `cursor` set to the nextCursor in the last data line." } : {}),
      });
    }),
  );

  server.registerTool(
    "search_threads",
    {
      title: "Search threads",
      description:
        "Searches everything Usual Mail holds of the inboxes this agent may see, done (archived) and screened mail " +
        "included: subjects, senders and recipients, every message's text, summaries, payment details and " +
        "notification events, and attachment names. Words match as word starts, case and accents aside; \"quoted " +
        "phrases\" word for word; -word leaves a word out; Gmail's from:, to:, subject:, has:attachment, is:unread, " +
        "is:read, before: and after: (YYYY/MM/DD) work in q too. Filters may be given alone, without q. Results rank " +
        "matches in the subject or sender first, then by relevance with newer mail ahead; each says where it matched " +
        "and gives a short excerpt. It never searches the mailbox itself for older mail. Use it to find earlier mail " +
        `from the same sender or about the same thing before deciding. ${DATA_NOTICE}`,
      inputSchema: z.object({
        q: z.string().max(200).optional().describe("Text to look for, operators included. Optional when a filter is given."),
        inboxId: id("Only this inbox. Leave out for all of this agent's inboxes.").optional(),
        kinds: z.array(z.enum(SEARCH_KINDS)).max(SEARCH_KINDS.length).optional()
          .describe("Only these categories (any of them); 'screened' and 'done' each narrow to screened or done (archived) threads."),
        from: z.string().max(320).optional().describe("A sender's address, a domain, or a word of their name."),
        to: z.string().max(320).optional().describe("A recipient's address, a domain, or a word of their name (To and Cc)."),
        hasAttachment: z.boolean().optional(),
        unread: z.boolean().optional(),
        after: z.string().max(40).optional().describe("Only threads whose newest mail is at or after this ISO time."),
        before: z.string().max(40).optional().describe("Only threads whose newest mail is before this ISO time."),
        cursor,
        limit: limit(20, 50),
      }),
      annotations: READ_ONLY,
    },
    guard(async ({ inboxId, cursor: from, limit: count, ...filters }) => {
      const page = await service.search(caller, {
        ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined)),
        ...(inboxId ? { inboxIds: [inboxId] } : {}),
        ...(from ? { cursor: from } : {}),
        limit: count ?? 20,
      });
      const items = page.items.map((hit) => ({
        ...threadSummary(hit),
        ...(hit.match && {
          matchedIn: hit.match.fields,
          ...(hit.match.excerpt && { excerpt: hit.match.excerpt.runs.map((run) => run.text).join("") }),
        }),
      }));
      return toolResult({
        lead: `${page.items.length} thread${page.items.length === 1 ? "" : "s"} found${page.nextCursor ? " on this page" : ""}.`,
        data: pageData(items, page.nextCursor),
        ...(page.nextCursor ? { next: MORE } : {}),
      });
    }),
  );

  registerAppTool(
    server,
    "list_threads",
    {
      title: "List threads",
      description:
        "Lists one view, newest first. home: what needs the person: conversations and threads nobody has " +
        "categorized yet, not done, not stacked, not waiting to come back. A category (conversation, newsletter, " +
        "invoice, receipt, notification, otp, unknown): its threads that aren't done or waiting to come back, stacked " +
        "ones included (a waiting thread is only in waiting and search until it comes back). reply_later, set_aside: the person's stacks. waiting: threads hidden until a come-back time, " +
        "soonest first. screening: threads from senders the person hasn't let in. Every view but screening leaves " +
        "screened threads out. Each thread carries Usual Mail's summary when its AI wrote one, and a receipt or an " +
        "invoice its payment details (party, amount in the currency's minor units, refund, state: paid, scheduled or " +
        "due, dueDate, what), and a notification its event (status, about, when: a date with an optional time " +
        "window, the mail's local time; and group: the same opaque string on notifications of one inbox about the same " +
        "thing (a parcel, an order, a booking or an appointment); each thread is still listed on its own), each " +
        "checked by Usual Mail against the mail. Use it to see what " +
        "is waiting before writing a brief. In chat apps that show interfaces, the list appears as rows the person " +
        `can mark done or put on Reply later. ${DATA_NOTICE}`,
      inputSchema: z.object({
        view: z.enum(VIEWS).optional().describe("Which list. Default home."),
        inboxId: id("Only this inbox. Leave out for all of this agent's inboxes.").optional(),
        cursor,
        limit: limit(20, 50),
      }),
      annotations: READ_ONLY,
      _meta: { ui: { resourceUri: THREADS_VIEW_URI } },
    },
    guard(async ({ view, inboxId, cursor: from, limit: count }) => {
      const which: View = view ?? "home";
      const [page, inboxes] = await Promise.all([
        listOf(context, which, { ...(inboxId ? { inboxId } : {}), ...(from ? { cursor: from } : {}), limit: count ?? 20 }),
        service.listInboxes(caller),
      ]);
      const byId = new Map<string, Inbox>(inboxes.map((inbox) => [inbox.id, inbox]));
      return toolResult({
        lead: `${page.items.length} thread${page.items.length === 1 ? "" : "s"} in this view${page.nextCursor ? " on this page" : ""}.`,
        data: pageData(
          page.items.map((thread) => ({ ...threadSummary(thread), inboxName: byId.get(thread.inboxId)?.name })),
          page.nextCursor,
        ),
        ...(page.nextCursor ? { next: MORE } : {}),
        structured: threadRows(which, page, byId, inboxId !== undefined || inboxes.length === 1),
      });
    }),
  );
}
