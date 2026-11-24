/**
 * @usualmail/mcp: the connector a person's own agent uses to work on their mail, over the Model Context Protocol.
 * The server mounts `createMcp(deps)` at `deps.basePath` (normally "/mcp"). See docs/agents/mcp.md.
 */
export { createMcp } from "./handler.ts";
