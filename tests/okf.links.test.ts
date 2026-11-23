// B23: okbrain reads and writes regular files in real folders below the
// brain's root. A symbolic link there can point anywhere on this computer, and
// a shared Git repository can deliver one, so links are refused before they
// are opened. These tests plant the links a pulled commit could contain and
// drive the real CLI, API, and MCP server.

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createApiServer, type ApiServer } from "../src/api.ts";
import { assertBundleFile, InvalidIdError } from "../src/core/okf/paths.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { okb } from "./helpers.ts";

setDefaultTimeout(30_000);

const TOKEN = "links-test-token";
const refusal = "is not a regular file in this brain";
const note = (title: string, body = "Body.") => `---\ntype: note\ntitle: ${title}\ndescription: ${title} description\n---\n${body}\n`;

// Creating a symbolic link on Windows needs a privilege that CI runners lack.
describe.skipIf(process.platform === "win32")("links inside a brain are never followed", () => {
  let root: string;
  let brain: string;
  let outside: string;
  let api: ApiServer;
  const targets = { secret: "SECRET-KEY-MATERIAL\n", shell: "export PATH=/usr/bin\n", log: "another program's file\n",
    page: "another page\n", ignore: "another ignore file\n", child: "FIRST-LINE-OF-A-PRIVATE-FILE\nmore\n" };
  const target = (name: keyof typeof targets) => join(outside, name);
  const cli = (...args: string[]) => okb(["--bundle", brain, ...args]);
  const op = (name: string, params: object) => fetch(`${api.url}api/op/${name}`, { method: "POST", body: JSON.stringify(params),
    headers: { "x-okb-token": TOKEN, "content-type": "application/json" } });
  const unchanged = async () => {
    for (const [name, text] of Object.entries(targets)) expect(await readFile(join(outside, name), "utf8")).toBe(text);
  };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "okb-links-"));
    brain = join(root, "brain");
    outside = join(root, "outside");
    await mkdir(join(brain, "notes"), { recursive: true });
    await mkdir(join(brain, "sub"));
    await mkdir(join(outside, "folder"), { recursive: true });
    for (const [name, text] of Object.entries(targets)) await writeFile(join(outside, name), text);
    await writeFile(join(outside, "folder", "diary.md"), note("Diary", "PRIVATE-OTHER-FOLDER-TEXT"));
    await writeFile(join(brain, "notes", "real.md"), note("Real", "See [the key](/notes/key.md)."));
    await writeFile(join(brain, "sub", "a.md"), note("Sub"));
    expect((await cli("index")).code).toBe(0);
    // What a collaborator's commit can add to a shared brain.
    await symlink(target("secret"), join(brain, "notes", "key.md"));
    await symlink(join(outside, "folder"), join(brain, "linked"));
    await symlink(target("child"), join(brain, "sub", "index.md"));
    api = createApiServer({ bundle: brain, token: TOKEN, port: 0 });
  });

  afterAll(async () => {
    await api.stop();
    await rm(root, { recursive: true, force: true });
  });

  test("a note that is a link, or sits behind a linked folder, cannot be read", async () => {
    for (const id of ["notes/key", "linked/diary"]) {
      const read = await cli("read", id);
      expect(read.code).toBe(2);
      expect(read.stderr).toContain(refusal);
      expect(read.stdout).toBe("");
      const response = await op("read_concept", { id });
      expect(response.status).toBe(400);
      expect(await response.text()).not.toMatch(/SECRET-KEY-MATERIAL|PRIVATE-OTHER-FOLDER-TEXT/);
    }
    // The listing never included them, and a search or a map cannot reach them either.
    expect((await cli("list")).stdout.trim().split("\n")).toEqual(["notes/real", "sub/a"]);
    expect((await cli("search", "SECRET-KEY-MATERIAL", "--keyword-only")).stdout).toContain("(no hits)");
    expect((await cli("links", "suggest", "notes/key")).code).toBe(2);
  });

  test("an MCP client cannot read through a link or make the export follow one", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "link-reader", version: "1.0.0" });
    await symlink(target("page"), join(brain, "viz.html"));
    try {
      await createMcpServer({ bundle: brain, trusted: true }).connect(serverTransport);
      await client.connect(clientTransport);
      for (const [name, args] of [
        ["read_concept", { id: "notes/key" }],
        ["read_concept", { id: "linked/diary" }],
        ["write_concept", { id: "notes/key", type: "note", title: "Key", description: "now a note" }],
        ["delete_concept", { id: "notes/key" }],
        ["export_viz", {}],
      ] as const) {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain(refusal);
        expect(JSON.stringify(result.content)).not.toMatch(/SECRET-KEY-MATERIAL|PRIVATE-OTHER-FOLDER-TEXT/);
      }
      expect(existsSync(join(brain, "notes", "key.md"))).toBe(true);
      await unchanged();
    } finally {
      await client.close().catch(() => {});
      await rm(join(brain, "viz.html"));
    }
  });

  test("a write never lands in a link's target", async () => {
    for (const args of [
      ["write", "notes/key", "--type", "note", "--title", "Key", "--description", "now a note"],
      ["write", "linked/diary", "--description", "edited"],
      ["write", "linked/new", "--type", "note", "--title", "New", "--description", "created behind a linked folder"],
      ["review", "done", "notes/key"],
      ["inbox", "read", "notes/key"],
      ["rm", "notes/key"],
    ]) {
      const result = await cli(...args);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/is not a regular file in this brain|concept not in index/);
    }
    expect(existsSync(join(outside, "folder", "new.md"))).toBe(false);
    expect(await readFile(join(outside, "folder", "diary.md"), "utf8")).toBe(note("Diary", "PRIVATE-OTHER-FOLDER-TEXT"));
    await unchanged();
  });

  test("a generated index.md or log.md that is a link stops the write before the note is saved", async () => {
    // sub/index.md is a link: nothing may be written in sub/, and the parent index must not quote its target.
    const blocked = await cli("write", "sub/a", "--description", "edited");
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toContain(`sub/index.md ${refusal}`);
    expect(await readFile(join(brain, "sub", "a.md"), "utf8")).toBe(note("Sub"));
    expect((await cli("write", "notes/real", "--description", "edited beside the link")).code).toBe(0);
    expect(await readFile(join(brain, "index.md"), "utf8")).not.toContain("FIRST-LINE-OF-A-PRIVATE-FILE");

    for (const [name, link] of [["index.md", "shell"], ["log.md", "log"]] as const) {
      const path = join(brain, name);
      const original = await readFile(path, "utf8");
      await rm(path);
      await symlink(target(link), path);
      try {
        for (const args of [["new", "note", "Top level", "a new note", "--id", "top"], ["capture", "A thought"], ["write", "notes/real", "--description", "again"]]) {
          const result = await cli(...args);
          expect(result.code).toBe(2);
          expect(result.stderr).toContain(`${name} ${refusal}`);
        }
        expect(existsSync(join(brain, "top.md"))).toBe(false);
        expect(existsSync(join(brain, "inbox"))).toBe(false);
        expect((await op("capture", { text: "A thought from the app" })).status).toBe(400);
        expect((await cli("upgrade")).code).toBe(name === "index.md" ? 2 : 0);
      } finally {
        await rm(path);
        await writeFile(path, original);
      }
    }
    await unchanged();
    // With regular files back in place the same write goes through.
    expect((await cli("new", "note", "Top level", "a new note", "--id", "top")).code).toBe(0);
    expect(await readFile(join(brain, "index.md"), "utf8")).toContain("[Top level](/top.md)");
  });

  test("the graph export and the sync's ignore file are not written through a link", async () => {
    await symlink(target("page"), join(brain, "viz.html"));
    await symlink(target("ignore"), join(brain, ".gitignore"));
    const identity = { GIT_AUTHOR_NAME: "okb-test", GIT_AUTHOR_EMAIL: "okb@test.local", GIT_COMMITTER_NAME: "okb-test",
      GIT_COMMITTER_EMAIL: "okb@test.local", GIT_CONFIG_GLOBAL: join(root, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" };
    const prior = Object.fromEntries(Object.keys(identity).map((key) => [key, process.env[key]]));
    await writeFile(identity.GIT_CONFIG_GLOBAL, "");
    Object.assign(process.env, identity);
    try {
      const exported = await cli("export-viz");
      expect(exported.code).toBe(2);
      expect(exported.stderr).toContain(`viz.html ${refusal}`);
      expect((await op("export_viz", {})).status).toBe(400);
      const synced = await cli("sync");
      expect(synced.code).toBe(1);
      expect(synced.stderr).toContain(".gitignore is not a regular file in this brain");
      await unchanged();
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(join(brain, "viz.html"));
      await rm(join(brain, ".gitignore"));
      await rm(join(brain, ".git"), { recursive: true, force: true });
    }
    expect((await cli("export-viz")).code).toBe(0);
  });

  test("okb doctor names every link", async () => {
    const report = await cli("doctor", "--json");
    const links = (JSON.parse(report.stdout) as { findings: { check: string; path: string; severity: string }[] }).findings
      .filter((finding) => finding.check === "link");
    expect(links.map(({ path, severity }) => `${severity} ${path}`)).toEqual(["warning linked", "warning notes/key.md", "warning sub/index.md"]);
  });
});

describe("assertBundleFile", () => {
  test("accepts regular files and paths that do not exist yet, and refuses a folder where a file belongs", async () => {
    const root = await mkdtemp(join(tmpdir(), "okb-plain-"));
    try {
      await mkdir(join(root, "notes", "nested.md"), { recursive: true });
      await writeFile(join(root, "notes", "a.md"), "text");
      await assertBundleFile(root, "notes/a.md");
      await assertBundleFile(root, "notes/new.md");
      await assertBundleFile(root, "new-folder/deeper/new.md");
      // A folder named like a note, and a note used as a folder.
      for (const path of ["notes/nested.md", "notes/a.md/child.md"])
        expect(assertBundleFile(root, path)).rejects.toBeInstanceOf(InvalidIdError);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
