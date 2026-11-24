import type { LibSQLDatabase } from "drizzle-orm/libsql";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import * as schema from "./schema.ts";

export * from "./schema.ts";
export { schema };

/**
 * Drizzle over SQLite: a libSQL file (or memory) on Node; D1 or a Durable Object's SQLite later on
 * Cloudflare. The service never opens an interactive transaction, since D1 has none; statements that must
 * land together go through `batch`.
 */
export type Database = BaseSQLiteDatabase<"async", unknown, typeof schema> & {
  batch: LibSQLDatabase<typeof schema>["batch"];
};

export type InboxRow = typeof schema.inboxes.$inferSelect;
export type ThreadRow = typeof schema.threads.$inferSelect;
export type MessageRow = typeof schema.messages.$inferSelect;
export type AttachmentRow = typeof schema.attachments.$inferSelect;
export type ActionRow = typeof schema.actions.$inferSelect;
export type RuleRow = typeof schema.rules.$inferSelect;
export type DraftRow = typeof schema.drafts.$inferSelect;
export type BriefRow = typeof schema.briefs.$inferSelect;
export type DeviceRow = typeof schema.devices.$inferSelect;
export type TeachRow = typeof schema.teachPrompts.$inferSelect;
export type ServerStateRow = typeof schema.serverState.$inferSelect;
export type AvatarSiteRow = typeof schema.avatarSites.$inferSelect;
