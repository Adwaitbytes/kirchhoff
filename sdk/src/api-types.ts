/**
 * The public API contract has one source of truth: web/lib/api/types.ts, owned with the frontend.
 * The SDK re-exports it so the API, MCP server and SDK consumers compile against the same file.
 */
export * from "../../web/lib/api/types.ts";
