// Graph JSON export: the same nodes and edges as `graph_data`, saved as a
// portable file. Private notes stay out unless a trusted caller of a writable
// brain includes them. Driven through the CLI, the local API, and MCP.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createApiServer, type ApiServer } from "../src/api.ts";
import { buildVizGraph, type VizGraph } from "../src/core/viz/export.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { okb } from "./helpers.ts";

const token = "graph-export-local";
const publicIds = ["notes/other", "notes/public"];
const privateIds = ["db_only/secret", "notes/flagged"];
const privateWords = ["Folder secret", "Folder-only text", "Flagged draft", "Flag-only text"];
const nodeKeys = [
  "body", "bodyLen", "description", "generated", "id", "resource", "sources", "stale", "staleAfter",
  "status", "tags", "title", "trust", "type", "verified",
];

let root: string;
let server: ApiServer;
let readonly: ApiServer;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "okb-graph-export-"));
  await mkdir(join(root, "notes"));
  await mkdir(join(root, "db_only"));
  await writeFile(join(root, "notes", "public.md"),
    "---\ntype: note\ntitle: Public plan\ndescription: Shared\ntags: [plan]\n---\n" +
    "See [other](/notes/other.md), [flagged](/notes/flagged.md), and [secret](/db_only/secret.md).\n");
  await writeFile(join(root, "notes", "other.md"), "---\ntype: idea\ntitle: Other idea\n---\nBack to [plan](/notes/public.md).\n");
  await writeFile(join(root, "notes", "flagged.md"),
    "---\ntype: note\ntitle: Flagged draft\ndb_only: true\n---\nFlag-only text. See [plan](/notes/public.md).\n");
  await writeFile(join(root, "db_only", "secret.md"), "---\ntype: note\ntitle: Folder secret\n---\nFolder-only text.\n");
  server = createApiServer({ bundle: root, port: 0, token });
  readonly = createApiServer({ bundle: root, port: 0, token, readonly: true });
});

afterAll(async () => {
  await Promise.all([server.stop(), readonly.stop()]);
  await rm(root, { recursive: true, force: true });
});

function post(service: ApiServer, input: unknown = {}, headers: Record<string, string> = { "x-okb-token": token }) {
  return fetch(service.url + "api/op/export_graph", {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(input),
  });
}

async function exported(response: Response): Promise<VizGraph> {
  expect(response.status).toBe(200);
  return (await response.json() as { result: VizGraph }).result;
}

test("the CLI exports the existing graph schema and leaves private notes out by default", async () => {
  const summary = await okb(["--bundle", root, "export-graph"]);
  expect(summary).toMatchObject({ code: 0, stdout: "2 concepts, 2 links (use --json for the data)\n" });

  const shared = await okb(["--bundle", root, "export-graph", "--json"]);
  expect(shared.code).toBe(0);
  const graph = JSON.parse(shared.stdout) as VizGraph;
  expect(Object.keys(graph).sort()).toEqual(["edges", "nodes"]);
  expect(graph.nodes.map((node) => node.id)).toEqual(publicIds);
  for (const node of graph.nodes) expect(Object.keys(node).sort()).toEqual(nodeKeys);
  expect(graph.edges).toEqual([{ src: "notes/other", dst: "notes/public" }, { src: "notes/public", dst: "notes/other" }]);
  for (const word of privateWords) expect(shared.stdout).not.toContain(word);
  // Links to notes outside the export stay plain Markdown and add no edge.
  expect(graph.nodes[1]!.body).toContain("[other](#concept:notes%2Fother), [flagged](/notes/flagged.md), and [secret](/db_only/secret.md)");
  expect(graph).toEqual(await buildVizGraph(root, { includePrivate: false }));

  const complete = await okb(["--bundle", root, "export-graph", "--include-private", "--json"]);
  expect(complete.code).toBe(0);
  const everything = JSON.parse(complete.stdout) as VizGraph;
  expect(everything.nodes.map((node) => node.id).sort()).toEqual([...privateIds, ...publicIds].sort());
  expect(everything.edges).toContainEqual({ src: "notes/public", dst: "db_only/secret" });
  expect(everything.edges).toContainEqual({ src: "notes/flagged", dst: "notes/public" });
  // The private export is the graph the app and `okb graph-data` already use.
  expect(everything).toEqual(JSON.parse((await okb(["--bundle", root, "graph-data", "--json"])).stdout));
});

test("the app exports for the local owner and requires a writable brain for private drafts", async () => {
  const response = await post(server);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const text = await response.clone().text();
  for (const word of privateWords) expect(text).not.toContain(word);
  expect((await exported(response)).nodes.map((node) => node.id)).toEqual(publicIds);
  // Only the literal approval includes private drafts.
  expect((await exported(await post(server, { "include-private": false }))).nodes.map((node) => node.id)).toEqual(publicIds);
  for (const input of [{ "include-private": "true" }, { "include-private": 1 }, { includePrivate: true }])
    expect((await post(server, input)).status).toBe(400);

  const complete = await exported(await post(server, { "include-private": true }));
  expect(complete.nodes.map((node) => node.id).sort()).toEqual([...privateIds, ...publicIds].sort());
  expect(complete.nodes.find((node) => node.id === "notes/flagged")!.body).toContain("Flag-only text.");

  expect((await post(server, {}, { authorization: "Bearer " + token })).status).toBe(401);
  expect((await post(server, {}, { "x-okb-token": token, origin: "https://example.test" })).status).toBe(403);
  expect((await post(server, {}, { "x-okb-token": token, "content-type": "text/plain" })).status).toBe(415);

  expect((await exported(await post(readonly))).nodes.map((node) => node.id)).toEqual(publicIds);
  const refused = await post(readonly, { "include-private": true });
  expect(refused.status).toBe(403);
  expect(await refused.json()).toMatchObject({ error: "Private graph exports require a writable brain.", code: "refused" });
});

test("an untrusted MCP client receives the public export and cannot include private notes", async () => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer({ bundle: root, trusted: false }).connect(serverSide);
  const client = new Client({ name: "graph-export-test", version: "0.0.0" });
  await client.connect(clientSide);
  const textOf = (result: unknown) => ((result as { content: { text: string }[] }).content ?? []).map((part) => part.text).join("");
  try {
    const shared = await client.callTool({ name: "export_graph", arguments: {} });
    expect(shared.isError).not.toBe(true);
    expect((JSON.parse(textOf(shared)) as VizGraph).nodes.map((node) => node.id)).toEqual(publicIds);
    const refused = await client.callTool({ name: "export_graph", arguments: { "include-private": true } });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toBe("Private graph exports require a trusted caller.");
  } finally { await client.close(); }
});
