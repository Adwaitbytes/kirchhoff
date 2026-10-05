#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HttpBackend } from "./backend.ts";
import { createKirchhoffMcp } from "./server.ts";

/** stdio transport: `kirchhoff-mcp` in an agent's MCP config. stdout carries protocol only; logs go to stderr. */
const api = process.env.KIRCHHOFF_API_URL ?? "http://localhost:8080/v1";
const server = createKirchhoffMcp(new HttpBackend(api));
await server.connect(new StdioServerTransport());
console.error(`kirchhoff mcp (stdio) reading ${new URL(api).host}`);
