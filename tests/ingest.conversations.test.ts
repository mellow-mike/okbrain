import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { extractTargets, normalizeLinks } from "../src/core/graph/links.ts";
import { classifyTargets } from "../src/core/graph/typed-edges.ts";
import { importConversations } from "../src/core/ingest/conversations.ts";
import { listConcepts, readConceptPermissive } from "../src/core/okf/bundle.ts";
import { idToAbsPath } from "../src/core/okf/paths.ts";
import { writeConcept } from "../src/core/okf/write.ts";
import { buildVizGraph, exportViz, rewireLinks } from "../src/core/viz/export.ts";

const fixture = (provider: string): string => join(import.meta.dir, "fixtures", `${provider}-conversations.json`);
let root: string;

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "okb-conversations-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

test("preview and import the selected ChatGPT branch without publicly indexing transcript metadata", async () => {
  const input = { provider: "chatgpt", path: fixture("chatgpt") } as const;
  const dryRun = await importConversations(root, { ...input, dryRun: true });
  expect(dryRun).toEqual({ imported: [], planned: [expect.stringMatching(/^db_only\/conversations\/chatgpt\/[a-f0-9]{64}$/)], skipped: [] });
  expect(await readdir(root)).toEqual([]);

  const [id] = dryRun.planned as [string];
  expect(await importConversations(root, input)).toEqual({ imported: [id], planned: [], skipped: [] });
  expect(await listConcepts(root)).toEqual([id]);
  const { doc, raw } = await readConceptPermissive(root, id);
  expect(doc.frontmatter).toMatchObject({
    title: "Library planning",
    type: "conversation",
    status: "draft",
    sources: [{
      id: "export",
      resource: "chatgpt-export:conversation",
      conversation_id: "e9cca8e5-c08d-498f-877a-dcaac3d76056",
      created_at: "2024-08-19T16:00:00.000Z",
      last_modified: "2024-08-19T17:00:00.000Z",
    }],
  });
  expect(doc.body).toContain("I am planning a neighborhood library.");
  expect(doc.body).toContain("[local history](../../history.md)");
  expect(doc.body).toContain("\n~~~~\nMake space");
  expect(doc.body).not.toMatch(/Discarded response|Hidden message|asset_pointer/);
  expect(extractTargets(id, doc.body)).toEqual([]);
  expect(classifyTargets(id, doc.body)).toEqual([]);
  expect(rewireLinks(id, doc.body, new Set(["db_only/history"]))).toBe(doc.body);
  expect(await readFile(join(root, "index.md"), "utf8")).not.toMatch(/Library planning|db_only/);
  expect((await readdir(root)).sort()).toEqual(["db_only", "index.md"]);

  const manual = raw.replace("Library planning", "Edited library planning");
  await writeFile(idToAbsPath(root, id), manual);
  expect(await importConversations(root, input)).toEqual({
    imported: [],
    planned: [],
    skipped: [{ row: 1, id, reason: "concept already exists" }],
  });
  expect(await readFile(idToAbsPath(root, id), "utf8")).toBe(manual);
});

test("CLI imports into an existing search index and HTML omits private drafts by default", async () => {
  let stdout = "";
  let stderr = "";
  const cli = async (...args: string[]) => {
    stdout = stderr = "";
    const code = await runCli(["--bundle", root, "--json", ...args], {
      out: (text) => { stdout += text; },
      err: (text) => { stderr += text; },
    });
    expect(stderr).toBe("");
    expect(code).toBe(0);
    return JSON.parse(stdout);
  };
  await cli("index");
  const result = await cli("import-conversations", fixture("chatgpt"), "--provider", "chatgpt");
  expect(result.imported).toHaveLength(1);
  const [id] = result.imported;
  expect(await cli("search", "neighborhood library", "--profile", "lean")).toMatchObject([{ id }]);
  expect((await buildVizGraph(root)).nodes[0]?.id).toBe(id);
  const safeExport = await exportViz(root);
  expect(safeExport.nodes).toBe(0);
  expect(await readFile(safeExport.path, "utf8")).not.toContain("neighborhood library");
  const privateExport = await cli("export-viz", "--include-private");
  expect(privateExport.nodes).toBe(1);
  expect(await readFile(privateExport.path, "utf8")).toContain("neighborhood library");
});

test("import Claude text blocks and report bad and duplicate rows without disclosing content", async () => {
  const [conversation] = JSON.parse(await readFile(fixture("claude"), "utf8"));
  const path = join(root, "archive.json");
  await writeFile(path, JSON.stringify([conversation, null, conversation, { uuid: "empty", chat_messages: [] }]));
  const result = await importConversations(root, { provider: "claude", path });
  expect(result.imported).toHaveLength(1);
  const [id] = result.imported as [string];
  expect(result.skipped).toEqual([
    { row: 2, reason: "invalid conversation record" },
    { row: 3, id, reason: "duplicate conversation in export" },
    { row: 4, reason: "conversation has no visible text messages" },
  ]);
  const { doc } = await readConceptPermissive(root, id);
  expect(doc.frontmatter).toMatchObject({ title: "Reading group discussion", tags: ["conversation", "claude"] });
  expect(doc.body).toContain("Which books did the reading group choose?");
  expect(doc.body).toContain("The group chose two books.\n\nThe list is in your reading notes.");
  expect(doc.body).not.toMatch(/duplicate fallback|Private model thinking|Unimported attachment/);
});

test("reject invalid exports and symlink destinations before writing any transcripts", async () => {
  const path = join(root, "archive.json");
  await writeFile(path, '{"password": "private secret"');
  await expect(importConversations(root, { provider: "chatgpt", path })).rejects.toThrow("conversation export is invalid JSON");
  expect(await readdir(root)).toEqual(["archive.json"]);
  if (process.platform !== "win32") {
    await symlink(root, join(root, "db_only"));
    await expect(importConversations(root, { provider: "chatgpt", path: fixture("chatgpt") })).rejects.toThrow("destination must be a directory inside the bundle");
  }
});

test("concurrent create-only writes allow one creator", async () => {
  const input = { id: "note", type: "note", title: "A note", description: "A draft" };
  const options = { createOnly: true };
  const results = await Promise.all([
    writeConcept(root, { ...input, body: "First content" }, options),
    writeConcept(root, { ...input, body: "Second content" }, options),
  ]);
  expect(results.filter((result) => result.created)).toHaveLength(1);
  expect((await readConceptPermissive(root, "note")).doc.body).toMatch(/^(First|Second) content\n$/);
});

test("fenced examples are never rewritten even near an unclosed link", () => {
  const body = "[unclosed](\n~~~md\n## Cites\n[inside](other.md)\n~~~\n)\n\n[actual](note.md)";
  expect(normalizeLinks("notes/transcript", body)).toBe(body.replace("(note.md)", "(/notes/note.md)"));
  expect(extractTargets("notes/transcript", body)).toEqual(["notes/note"]);
  expect(classifyTargets("notes/transcript", body)).toEqual([{ dst: "notes/note", rel: null }]);
});
