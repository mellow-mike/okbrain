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
import { isActor } from "../core/okf/document.ts";
import { operations, runOp, type Operation } from "../core/operations.ts";
import { hostAllowed } from "../core/serve-token.ts";
import { VERSION } from "../core/version.ts";

export interface McpOptions {
  bundle: string;
  brain?: string;
  /** Expose write ops to this connection. Never set for remote clients. */
  trusted: boolean;
  /** Serving a read-only brain mount: write ops refused even when trusted. */
  readonly?: boolean;
  mountAllowed?: () => boolean;
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

/**
 * Writes over MCP are attributed to the connected client in the OKF actor
 * convention (`<producer>/<version>`, §7) — an agent's edits must never read
 * as a human's. Falls back to a generic agent actor when the client is coy.
 */
export function mcpActor(client: { name?: string; version?: string } | undefined): string {
  const name = (client?.name ?? "").replace(/[\s/:]+/g, "-");
  const version = (client?.version ?? "").replace(/\s+/g, "-");
  const actor = `${name || "mcp-client"}/${version || "unknown"}`;
  return isActor(actor) ? actor : "mcp-client/unknown";
}

export function createMcpServer(opts: McpOptions): Server {
  const server = new Server(
    { name: "okbrain", version: VERSION },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: opts.mountAllowed?.() === false ? [] : mcpOps(opts.trusted && !opts.readonly).map(toolOf),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (opts.mountAllowed?.() === false)
      return { content: [{ type: "text", text: "The brain mount changed. Restart its MCP listener." }], isError: true };
    const op = mcpOps(opts.trusted && !opts.readonly).find((o) => o.name === req.params.name);
    if (!op)
      return {
        content: [{ type: "text", text: `unknown tool: ${req.params.name}` }],
        isError: true,
      };
    const local = openLocalContext(
      opts.bundle,
      opts.trusted,
      opts.readonly === true,
      mcpActor(server.getClientVersion()),
    );
    local.ctx.brain = opts.brain;
    try {
      const result = await runOp(op, local.ctx, req.params.arguments ?? {});
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return {
        content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
        isError: true,
      };
    } finally {
      await local.close();
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
 * request): binds 127.0.0.1 only and validates Host and Origin. The separate
 * app-managed listener uses an ephemeral bearer token.
 */
export function runMcpHttp(opts: McpOptions & { port: number }): HttpServer {
  let port = opts.port; // resolved after listen (0 = ephemeral, for tests)
  const httpServer = createServer(async (req, res) => {
    const refuse = (status: number, message: string) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: message }));
    };
    const origin = req.headers.origin;
    if (!hostAllowed(req.headers.host ?? null, port) || (origin !== undefined
      && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`)) {
      refuse(403, "MCP HTTP accepts only local hosts and origins.");
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
