// Stage 3.3: the MCP server. Untrusted by default — only read ops are listed
// AND callable (hidden tools refused by name; runOp re-gates underneath);
// --trusted exposes write ops but never admin or localOnly; concept-id
// traversal is refused before any path is built. Driven through the real MCP
// SDK client over linked in-memory transports, plus the Streamable HTTP
// transport on 127.0.0.1.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createApiServer } from "../src/api.ts";
import { loadConfig, saveConfig } from "../src/core/config.ts";
import { parse } from "../src/core/okf/document.ts";
import { createMcpServer, mcpActor, mcpOps, runMcpHttp } from "../src/mcp/server.ts";
import { okb } from "./helpers.ts";

let bundle: string;

async function connect(trusted: boolean): Promise<Client> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await createMcpServer({ bundle, trusted }).connect(serverT);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientT);
  return client;
}

/** Joined text content of a callTool result (the SDK types a legacy union). */
const textOf = (r: unknown): string =>
  ((r as { content: { text: string }[] }).content ?? []).map((c) => c.text).join("");

beforeAll(async () => {
  bundle = await mkdtemp(join(tmpdir(), "okb-mcp-"));
  await writeFile(join(bundle, "index.md"), "# bundle\n");
  await mkdir(join(bundle, "notes"), { recursive: true });
  await writeFile(
    join(bundle, "notes", "alpha.md"),
    "---\ntype: note\ntitle: Alpha\ndescription: about databases\n---\nAlpha body about databases.\n",
  );
  expect((await okb(["index", "--bundle", bundle])).code).toBe(0);
});

afterAll(async () => {
  await rm(bundle, { recursive: true, force: true });
});

describe("tool surface", () => {
  test("untrusted lists read ops only; trusted adds write; admin/localOnly never", () => {
    const untrusted = mcpOps(false).map((o) => o.name);
    const trusted = mcpOps(true).map((o) => o.name);
    expect(untrusted).toContain("search");
    expect(untrusted).toContain("read_concept");
    expect(untrusted).toContain("graph_data");
    expect(untrusted).not.toContain("write_concept");
    expect(trusted).toContain("write_concept");
    expect(trusted).toContain("clip");
    for (const names of [untrusted, trusted])
      for (const admin of ["index", "rebuild", "embed", "init", "serve", "bookmarklet", "mcp"])
        expect(names).not.toContain(admin);
  });

  test("tools/list carries generated schemas from the param specs", async () => {
    const client = await connect(false);
    const { tools } = await client.listTools();
    const search = tools.find((t) => t.name === "search")!;
    expect(search.description).toContain("Search the brain");
    expect(search.inputSchema.required).toEqual(["query"]);
    expect((search.inputSchema.properties as Record<string, { type: string }>).limit!.type).toBe(
      "integer",
    );
    expect(tools.some((t) => t.name === "write_concept")).toBe(false);
    await client.close();
  });
});

describe("untrusted connection (default)", () => {
  test("read ops work: search and read_concept", async () => {
    const client = await connect(false);
    const hits = await client.callTool({ name: "search", arguments: { query: "databases" } });
    expect(textOf(hits)).toContain("notes/alpha");
    const doc = await client.callTool({ name: "read_concept", arguments: { id: "notes/alpha" } });
    expect(textOf(doc)).toContain("Alpha body");
    await client.close();
  });

  test("write op is refused by name (hidden tool)", async () => {
    const client = await connect(false);
    const r = await client.callTool({
      name: "write_concept",
      arguments: { id: "notes/evil", type: "note", title: "x", description: "x" },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("unknown tool");
    await client.close();
  });

  test("id traversal is refused before any path is built", async () => {
    const client = await connect(false);
    const r = await client.callTool({
      name: "read_concept",
      arguments: { id: "../../etc/passwd" },
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("path traversal");
    await client.close();
  });

  test("bad params surface as tool errors, not crashes", async () => {
    const client = await connect(false);
    const r = await client.callTool({ name: "search", arguments: { nope: 1 } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("unknown parameter");
    await client.close();
  });
});

describe("trusted connection (--trusted)", () => {
  test("write_concept works and the bundle stays doctor-clean", async () => {
    const client = await connect(true);
    const r = await client.callTool({
      name: "write_concept",
      arguments: {
        id: "notes/via-mcp",
        type: "note",
        title: "Via MCP",
        description: "written by an agent",
      },
    });
    expect(r.isError).not.toBe(true);
    expect(textOf(r)).toContain("notes/via-mcp");
    expect((await okb(["doctor", "--bundle", bundle])).code).toBe(0);
    // Writes over MCP are attributed to the connected client (OKF §7 actor), never to a human.
    const fm = parse(await readFile(join(bundle, "notes", "via-mcp.md"), "utf8")).frontmatter;
    expect(fm.generated).toMatchObject({ by: "test-client/0.0.0" });
    await client.close();
  });

  test("mcpActor: client name/version → producer/version; junk falls back", () => {
    expect(mcpActor({ name: "Claude Desktop", version: "1.2" })).toBe("Claude-Desktop/1.2");
    expect(mcpActor({ name: "x", version: "" })).toBe("x/unknown");
    expect(mcpActor(undefined)).toBe("mcp-client/unknown");
  });
});

describe("streamable HTTP transport", () => {
  test("serves MCP on 127.0.0.1 with the same gated surface", async () => {
    const httpServer = runMcpHttp({ bundle, trusted: false, port: 0 });
    await new Promise<void>((resolve) => httpServer.once("listening", resolve));
    const addr = httpServer.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      const client = new Client({ name: "http-client", version: "0.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/`)),
      );
      const { tools } = await client.listTools();
      expect(tools.some((t) => t.name === "search")).toBe(true);
      expect(tools.some((t) => t.name === "write_concept")).toBe(false);
      const hits = await client.callTool({ name: "search", arguments: { query: "databases" } });
      expect(textOf(hits)).toContain("notes/alpha");
      await client.close();
    } finally {
      httpServer.close();
    }
  });
});

describe("app-managed MCP HTTP", () => {
  const appToken = "mcp-settings-test";
  type Connection = { url: string; auth: string; trusted: boolean; brain: string | null; mountChanged: boolean };

  function controller(url: string) {
    const endpoint = new URL("/api/mcp/http", url);
    const setup = (params?: object, mount?: string) => fetch(endpoint, {
      method: params ? "POST" : "GET",
      headers: {
        "x-okb-token": appToken,
        ...(params ? { "content-type": "application/json" } : {}),
        ...(mount ? { "x-okb-brain": mount } : {}),
      },
      body: params ? JSON.stringify(params) : undefined,
    });
    return { endpoint, setup };
  }

  async function connectHttp(connection: Connection) {
    const client = new Client({ name: "mcp-settings-client", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), {
      requestInit: { headers: { authorization: connection.auth } },
    }));
    return client;
  }

  test("starts an authenticated read-only transport, revokes it on stop, and rotates the next token", async () => {
    const api = createApiServer({ bundle, token: appToken, port: 0 });
    let client: Client | undefined;
    let stopped = false;
    try {
      const { endpoint, setup } = controller(api.url);
      expect((await fetch(endpoint)).status).toBe(401);
      expect((await fetch(endpoint, { headers: { authorization: "Bearer " + appToken } })).status).toBe(401);
      expect((await fetch(endpoint, { headers: { "x-okb-token": appToken, origin: "https://unrelated.example" } })).status).toBe(403);
      const start = await setup({ action: "start", port: 0 });
      expect(start.status).toBe(200);
      expect(start.headers.get("cache-control")).toBe("no-store");
      const { result: connection } = await start.json() as { result: Connection };
      expect(connection.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      expect(connection).toMatchObject({ trusted: false, brain: null });
      expect(connection.auth).toMatch(/^Bearer [A-Za-z0-9_-]{43}$/);
      expect((await setup({ action: "start", port: 0 })).status).toBe(409);
      expect((await fetch(connection.url)).status).toBe(401);
      expect((await fetch(connection.url, { headers: { authorization: "Bearer " + appToken } })).status).toBe(401);
      expect((await fetch(connection.url, { headers: { authorization: connection.auth, origin: "https://unrelated.example" } })).status).toBe(403);
      expect((await fetch(connection.url + "?token=" + connection.auth.slice(7))).status).toBe(404);
      client = await connectHttp(connection);
      const { tools } = await client.listTools();
      const toolNames = tools.map((tool) => tool.name);
      expect(toolNames).toContain("search");
      expect(toolNames).not.toContain("write_concept");
      expect(toolNames).not.toContain("mcp");
      expect(toolNames).not.toContain("code_run");
      const result = await client.callTool({ name: "search", arguments: { query: "databases" } });
      expect(textOf(result)).toContain("notes/alpha");
      expect((await setup({ action: "stop" })).status).toBe(200);
      await expect(fetch(connection.url)).rejects.toThrow();
      const restarted = await setup({ action: "start", port: 0 });
      const { result: second } = await restarted.json() as { result: Connection };
      expect(second.auth).not.toBe(connection.auth);
      expect((await fetch(second.url, { headers: { authorization: connection.auth } })).status).toBe(401);
      await api.stop();
      stopped = true;
      await expect(fetch(second.url)).rejects.toThrow();
    } finally {
      await client?.close();
      if (!stopped) await api.stop();
    }
  });

  test("allows explicit trusted writes only while the bound mount remains writable", async () => {
    const api = createApiServer({ bundle, token: appToken, port: 0 });
    const original = loadConfig();
    let client: Client | undefined;
    try {
      const { setup } = controller(api.url);
      const name = "mcpManagedTarget";
      const configure = (readonly: boolean) => saveConfig({
        ...original, brains: { ...original.brains, [name]: { path: bundle, readonly } },
      });
      configure(true);
      expect((await setup({ action: "start", port: 0, trusted: true }, name)).status).toBe(403);
      configure(false);
      const start = await setup({ action: "start", port: 0, trusted: true }, name);
      expect(start.status).toBe(200);
      const { result: connection } = await start.json() as { result: Connection };
      expect(connection).toMatchObject({ trusted: true, brain: name, mountChanged: false });
      client = await connectHttp(connection);
      expect((await client.listTools()).tools.some((tool) => tool.name === "write_concept")).toBe(true);
      configure(true);
      const active = await setup();
      expect(await active.json()).toMatchObject({ result: { mountChanged: true } });
      expect((await fetch(connection.url, { headers: { authorization: connection.auth } })).status).toBe(403);
      await expect(client.callTool({ name: "write_concept", arguments: { id: "notes/forbidden", body: "test" } })).rejects.toThrow();
    } finally {
      await client?.close();
      await api.stop();
      saveConfig(original);
    }
  });
});
