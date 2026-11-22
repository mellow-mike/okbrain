import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { randomBytes } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { DEFAULT_MCP_PORT, hostAllowed, tokenMatches } from "../core/serve-token.ts";
import { createMcpServer, type McpOptions } from "./server.ts";

type Mount = { bundle: string; brain: string | null; readonly: boolean };
const endpoint = "/mcp";

export class ManagedMcpHttpError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

async function handleMcpRequest(req: Request, port: number, token: string, opts: McpOptions): Promise<Response> {
  const headers = { "cache-control": "no-store" };
  const refuse = (status: number, error: string, extra?: Record<string, string>) =>
    Response.json({ error }, { status, headers: { ...headers, ...extra } });
  const origin = req.headers.get("origin");
  if (!hostAllowed(req.headers.get("host"), port) || (origin !== null
    && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`)) {
    return refuse(403, "MCP HTTP accepts only local hosts and origins.");
  }
  const url = new URL(req.url);
  if (url.pathname !== endpoint || url.search) return refuse(404, "MCP endpoint not found.");
  const auth = /^Bearer (\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? null;
  if (!tokenMatches(auth, token)) return refuse(401, "A valid MCP HTTP bearer token is required.", { "www-authenticate": "Bearer" });
  if (opts.mountAllowed?.() === false) return refuse(403, "The brain mount changed. Restart its MCP listener.");
  // Stateless JSON-RPC over Streamable HTTP. Clients may open an optional
  // standalone SSE subscription; advertise that this listener uses POST only.
  if (req.method !== "POST") return refuse(405, "Method not allowed.", { allow: "POST" });
  const server = createMcpServer(opts);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(req);
    response.headers.set("cache-control", "no-store");
    return response;
  } catch {
    return refuse(500, "MCP request failed.");
  } finally {
    await server.close();
  }
}

/** The listener owned by one local app process. */
export class ManagedMcpHttp {
  #server?: Bun.Server<undefined>;
  #closing?: Promise<void>;
  #running?: {
    url: string; auth: string; trusted: boolean; brain: string | null; bundle: string; mountAllowed: () => boolean;
  };

  status() {
    if (!this.#running) return null;
    const { mountAllowed, ...connection } = this.#running;
    return { ...connection, mountChanged: !mountAllowed() };
  }

  start(body: Record<string, unknown>, mount: Mount, currentMount: () => Mount) {
    if (this.#server || this.#closing) throw new ManagedMcpHttpError("Stop the current MCP listener before starting another.", 409);
    const port = body.port ?? DEFAULT_MCP_PORT;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535)
      throw new ManagedMcpHttpError("Enter a local TCP port from 0 to 65535.");
    if (body.trusted !== undefined && typeof body.trusted !== "boolean")
      throw new ManagedMcpHttpError("Choose whether to allow trusted writes.");
    const trusted = body.trusted === true;
    if (trusted && mount.readonly) throw new ManagedMcpHttpError("This brain mount is read-only.", 403);
    let bundle: string;
    try {
      bundle = realpathSync(mount.bundle);
      if (!statSync(bundle).isDirectory()) throw new Error();
    } catch {
      throw new ManagedMcpHttpError("The selected brain folder is unavailable.", 409);
    }
    const mountAllowed = (): boolean => {
      try {
        const current = currentMount();
        return (!trusted || !current.readonly) && current.bundle === mount.bundle && realpathSync(current.bundle) === bundle;
      } catch {
        return false;
      }
    };
    const token = randomBytes(32).toString("base64url");
    const options = { bundle, readonly: mount.readonly, trusted, mountAllowed };
    try {
      const server = Bun.serve({
        port, hostname: "127.0.0.1",
        fetch: (req, listener) => handleMcpRequest(req, listener.port!, token, options),
      });
      this.#server = server;
      this.#running = {
        url: `http://127.0.0.1:${server.port}${endpoint}`,
        auth: `Bearer ${token}`, trusted, bundle, brain: mount.brain, mountAllowed,
      };
      return this.status();
    } catch (error) {
      if ((error as { code?: string }).code === "EADDRINUSE")
        throw new ManagedMcpHttpError("That local TCP port is already in use.", 409);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.#closing) return this.#closing;
    if (!this.#server) return;
    this.#running = undefined;
    this.#closing = this.#server.stop(true);
    try {
      await this.#closing;
    } finally {
      this.#server = undefined;
      this.#closing = undefined;
    }
  }
}
