import { expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../src/api.ts";
import { loadConfig, saveConfig } from "../src/core/config.ts";
import { parse } from "../src/core/okf/document.ts";
import { packContext, publicHits } from "../src/core/retrieval/ask.ts";
import type { HybridHit } from "../src/core/retrieval/hybrid.ts";
import { okb } from "./helpers.ts";

// Each test here starts dozens of Git processes, which take far longer to start on Windows runners.
setDefaultTimeout(30_000);

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: process.env });
const first = "notes/[local] draft", second = "notes/turn-private", publicId = "notes/public";

test("private flags govern Git staging and generated manifests without changing existing Git history", async () => {
  const root = await mkdtemp(join(tmpdir(), "okb-note-privacy-"));
  const brain = join(root, "brain");
  const vault = join(root, "vault");
  await mkdir(brain);
  const cli = (...args: string[]) => okb(["--bundle", brain, ...args]);
  const make = (id: string, title: string, ...args: string[]) => cli("write", id, "--type", "note", "--title", title, "--description", "privacy test", ...args);
  try {
    git(brain, "init", "-q");
    git(brain, "config", "user.name", "Privacy Test");
    git(brain, "config", "user.email", "privacy@example.test");
    expect((await make(first, "Private title", "--private", "--body", "Sensitive draft.")).code).toBe(0);
    expect((await make(second, "Unpublished title")).code).toBe(0);
    const raw = await readFile(join(brain, second + ".md"), "utf8");
    expect((await cli("keep-private", second)).code).toBe(0);
    expect(parse(await readFile(join(brain, second + ".md"), "utf8")).frontmatter).toMatchObject({
      db_only: true, generated: parse(raw).frontmatter.generated,
    });
    expect((await make(publicId, "Public title")).code).toBe(0);
    // A per-note exclusion in Git's local metadata has lower precedence than .gitignore.
    // okb also excludes the exact path from its staging command.
    await writeFile(join(brain, ".gitignore"), "!/notes/*.md\n");
    const synced = await cli("sync");
    expect(synced.code).toBe(0);
    const history = git(brain, "rev-parse", "HEAD").trim();
    const tracked = git(brain, "ls-files");
    expect(tracked).toContain(publicId);
    expect(tracked).not.toContain(first);
    expect(tracked).not.toContain(second);
    for (const path of [".gitignore", "index.md", "notes/index.md", "log.md"]) {
      const shared = await readFile(join(brain, path), "utf8");
      for (const value of [first, second, "Private title", "Unpublished title"]) expect(shared).not.toContain(value);
    }
    const localExcluded = await readFile(join(brain, ".git", "info", "exclude"), "utf8");
    expect(localExcluded).toContain("/notes/\\[local\\]\\ draft.md");
    expect(localExcluded).toContain(`${second}.md`);
    expect((await cli("keep-private", publicId)).stderr).toContain("Git already tracks this note");
    expect(parse(await readFile(join(brain, publicId + ".md"), "utf8")).frontmatter.db_only).toBeUndefined();

    expect((await cli("export-markdown", vault)).code).toBe(0);
    expect(await Bun.file(join(vault, publicId + ".md")).exists()).toBe(true);
    expect(await Bun.file(join(vault, first + ".md")).exists()).toBe(false);
    expect((await cli("export-viz")).code).toBe(0);
    expect(await readFile(join(brain, "viz.html"), "utf8")).not.toContain("Private title");
    expect((await cli("export-viz", "--include-private")).code).toBe(0);
    expect(await readFile(join(brain, "viz.html"), "utf8")).toContain("Private title");

    git(brain, "add", "-f", "--", first + ".md");
    const staged = git(brain, "diff", "--cached", "--name-only");
    expect((await cli("sync")).stderr).toContain("Git tracks a private path");
    expect(git(brain, "diff", "--cached", "--name-only")).toBe(staged);
    expect(git(brain, "rev-parse", "HEAD").trim()).toBe(history);
    await rm(join(brain, first + ".md"));
    expect((await cli("sync")).stderr).toContain("Git stages a private note");
    expect(git(brain, "diff", "--cached", "--name-only")).toBe(staged);
    git(brain, "reset", "-q", "--", first + ".md");
    git(brain, "rm", "-q", "--", publicId + ".md");
    git(brain, "commit", "-q", "-m", "Remove public test note");
    expect((await make(publicId, "Reuse a former public ID", "--private")).stderr).toContain("has it in history");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the app keeps private notes local unless the operator opts into model context", async () => {
  const root = await mkdtemp(join(tmpdir(), "okb-note-privacy-app-"));
  const token = "privacy-test-token";
  const original = loadConfig();
  const modelMessages: string[] = [];
  const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    modelMessages.push(await req.text());
    return Response.json({ choices: [{ message: { content: "Fixture answer" } }] });
  } });
  saveConfig({ ...original, ai: { provider: "ollama", model: "fixture", baseUrl: `http://127.0.0.1:${model.port}` } });
  const server = createApiServer({ bundle: root, port: 0, token });
  const readonly = createApiServer({ bundle: root, port: 0, token, readonly: true });
  function post(name: string, input = {}, service = server, headers: Record<string, string> = { "x-okb-token": token }) {
    return fetch(service.url + "api/op/" + name, {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(input),
    });
  }
  try {
    const id = "notes/private-by-page";
    expect((await post("write_concept", { id, type: "note", title: "Ginkgo draft", description: "Ginkgo", body: "Ginkgo secret excerpt" })).status).toBe(200);
    expect((await post("index")).status).toBe(200);
    expect((await post("keep_private", { id }, readonly)).status).toBe(403);
    expect((await post("keep_private", { id }, server, { authorization: `Bearer ${token}` })).status).toBe(401);
    expect((await post("keep_private", { id })).status).toBe(200);
    expect((await post("search", { query: "ginkgo", "keyword-only": true })).status).toBe(200);
    expect(JSON.stringify(await (await post("focused_map", { query: "ginkgo" })).json())).not.toContain(id);
    expect(JSON.stringify(await (await post("focused_map", { query: "ginkgo", "include-private": true })).json())).toContain(id);
    expect((await post("ask", { question: "ginkgo", profile: "lean" })).status).toBe(200);
    expect(modelMessages).toHaveLength(0);
    expect((await post("ask", { question: "ginkgo", profile: "lean", "include-private": true })).status).toBe(200);
    expect(modelMessages[0]).toContain("Ginkgo secret excerpt");
    expect((await post("delete_concept", { id })).status).toBe(200);
    expect(await readFile(join(root, "log.md"), "utf8")).not.toContain("Ginkgo draft");
  } finally {
    server.stop();
    readonly.stop();
    model.stop(true);
    saveConfig(original);
    await rm(root, { recursive: true, force: true });
  }
});

test("sync refuses an upstream tree that would collide with a local private note", async () => {
  const root = await mkdtemp(join(tmpdir(), "okb-private-sync-remote-"));
  const brain = join(root, "brain"), remote = join(root, "remote.git"), peer = join(root, "peer");
  await mkdir(brain);
  const cli = (...args: string[]) => okb(["--bundle", brain, ...args]);
  const identity = (cwd: string) => {
    git(cwd, "config", "user.name", "Privacy Test");
    git(cwd, "config", "user.email", "privacy@example.test");
  };
  try {
    git(root, "init", "-q", "--bare", remote);
    git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
    git(brain, "init", "-q");
    git(brain, "symbolic-ref", "HEAD", "refs/heads/main");
    identity(brain);
    git(brain, "remote", "add", "origin", remote);
    expect((await cli("sync")).code).toBe(0);
    git(root, "clone", "-q", remote, peer);
    identity(peer);
    expect((await cli("write", "coincidence", "--type", "note", "--title", "Only on this device", "--description", "Private", "--private")).code).toBe(0);
    const localPath = join(brain, "coincidence.md");
    const local = await readFile(localPath, "utf8");
    await writeFile(join(peer, "coincidence.md"), "Public file with the same name.\n");
    git(peer, "add", "coincidence.md");
    git(peer, "commit", "-q", "-m", "Add a public note on the peer");
    git(peer, "push", "-q");
    expect((await cli("sync")).stderr).toContain("An upstream file conflicts with a local private note");
    expect(await readFile(localPath, "utf8")).toBe(local);
    expect(git(brain, "ls-files")).not.toContain("coincidence.md");
    expect(git(peer, "show", "HEAD:coincidence.md")).toBe("Public file with the same name.\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("provider context packing checks the same note snapshot it uses for titles and excerpts", async () => {
  const root = await mkdtemp(join(tmpdir(), "okb-privacy-packing-"));
  const note = join(root, "source.md");
  const stale: HybridHit = { id: "source", title: "Old title", description: "Old description", score: 1, sources: ["keyword"], snippet: "Old excerpt" };
  try {
    await writeFile(note, "---\ntype: note\ntitle: New title\n---\nNew excerpt\n");
    const candidates = await publicHits(root, [stale]);
    expect(candidates).toEqual([stale]);
    const opts = { includePrivate: false };
    expect((await packContext(root, candidates, 1000, opts)).blocks).toEqual(["[source] New title\nNew excerpt"]);
    await writeFile(note, "---\ntype: note\ndb_only: true\n---\nLocal only\n");
    expect((await packContext(root, candidates, 1000, opts)).blocks).toEqual([]);
    await writeFile(note, "---\ntype: [unclosed\n---\nUnreadable metadata\n");
    expect((await packContext(root, candidates, 1000, opts)).blocks).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
