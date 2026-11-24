/** What every tool module needs: the caller's service, argument schemas, and an error guard. */
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { Caller, MailService } from "@usualmail/core";
import * as z from "zod";
import { errorResult } from "../errors.ts";

export interface ToolContext {
  service: MailService;
  /** Always an agent: the connector refuses other tokens before any tool runs. */
  caller: Caller;
}

export const id = (what: string) => z.string().min(1).max(200).describe(what);

export const cursor = z
  .string()
  .max(500)
  .optional()
  .describe("Leave out for the first page. Pass the nextCursor of the previous page to get the next one.");

export const limit = (fallback: number, max: number) =>
  z
    .number()
    .int()
    .min(1)
    .max(max)
    .optional()
    .describe(`How many to return. Default ${fallback}, at most ${max}.`);

/** Runs a tool body and turns anything it throws into a useful tool error, never a protocol error. */
export function guard<A>(run: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return await run(args);
    } catch (error) {
      return errorResult(error);
    }
  };
}

export const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;
export const WRITES = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
