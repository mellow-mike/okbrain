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
