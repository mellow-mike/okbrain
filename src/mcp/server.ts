// MCP server (3.3): "my agent can use my brain." A thin adapter generated
// over the ops contract, like the CLI and local API — tool list and schemas
// come from the same param specs, so surfaces can't drift. Trust is
// fail-closed (CLAUDE.md invariant 3): connections are untrusted by default,
// exposing read ops only; `--trusted` opts one server instance into write
// ops. Admin and localOnly ops never appear on this surface, hidden tools
// are also refused by name, and runOp re-checks scope underneath — three
// layers, each fail-closed. Filesystem confinement is the ops' own:
// concept ids reject traversal segments before any path is built.
//
// operations.ts imports this file for the `mcp` op, so nothing here may
// touch an operations.ts binding at module top level (ESM cycle).

import { createServer, type Server as HttpServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { openLocalContext } from "../core/context.ts";
import { operations, runOp, type Operation } from "../core/operations.ts";
import { hostAllowed } from "../core/serve-token.ts";

export interface McpOptions {
  bundle: string;
  /** Expose write ops to this connection. Never set for remote clients. */
  trusted: boolean;
  /** Serving a read-only brain mount: write ops refused even when trusted. */
  readonly?: boolean;
}

/** The MCP tool surface: no admin, no localOnly; write only when trusted. */
export const mcpOps = (trusted: boolean): Operation[] =>
  operations.filter(
    (o) => !o.localOnly && o.scope !== "admin" && (trusted || o.scope === "read"),
  );

const toolOf = (op: Operation) => ({
  name: op.name,
  description: op.summary,
  inputSchema: {
    type: "object" as const,
    properties: Object.fromEntries(
      op.params.map((p) => [
        p.name,
        { type: p.type === "int" ? "integer" : p.type, description: p.description },
      ]),
    ),
    required: op.params.filter((p) => p.required).map((p) => p.name),
  },
});

export function createMcpServer(opts: McpOptions): Server {
  const server = new Server(
    { name: "okbrain", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: mcpOps(opts.trusted).map(toolOf),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const op = mcpOps(opts.trusted).find((o) => o.name === req.params.name);
    if (!op)
      return {
        content: [{ type: "text", text: `unknown tool: ${req.params.name}` }],
        isError: true,
      };
    const local = openLocalContext(opts.bundle, opts.trusted, opts.readonly === true);
    try {
      const result = await runOp(op, local.ctx, req.params.arguments ?? {});
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return {
        content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
        isError: true,
      };
    } finally {
      local.close();
    }
  });
  return server;
}

/** stdio transport: stdout carries only protocol JSON (logs go to stderr). */
export async function runMcpStdio(opts: McpOptions): Promise<void> {
  await createMcpServer(opts).connect(new StdioServerTransport());
}

/**
 * Streamable HTTP transport, stateless (a fresh server+transport pair per
 * request): binds 127.0.0.1 only and Host-checks like the local API. No
 * token — the default surface is read-only; `--trusted` is a deliberate,
 * local decision.
 */
export function runMcpHttp(opts: McpOptions & { port: number }): HttpServer {
  let port = opts.port; // resolved after listen (0 = ephemeral, for tests)
  const httpServer = createServer(async (req, res) => {
    if (!hostAllowed(req.headers.host ?? null, port)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "host not allowed (localhost only)" }));
      return;
    }
    const server = createMcpServer(opts);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      // An async throw here would otherwise be an unhandled rejection with the
      // socket left hanging — answer with a plain 500 instead.
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      if (!res.writableEnded)
        res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
  });
  httpServer.listen(opts.port, "127.0.0.1", () => {
    const addr = httpServer.address();
    if (typeof addr === "object" && addr) port = addr.port;
  });
  return httpServer;
}
