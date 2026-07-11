// Stage 1.5: git sync. All repos are temp dirs; push/pull run against a local
// bare repo (file path remote) so CI never touches the network. Git identity
// and config are pinned via env so developer/CI global config can't leak in.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inDbOnlyDir } from "../src/core/okf/paths.ts";
import { writeConcept } from "../src/core/okf/write.ts";
import { SyncError, syncBundle, syncStatus } from "../src/core/sync.ts";
import { okb } from "./helpers.ts";

let base: string;
const dir = async (name: string): Promise<string> => {
  const d = join(base, name);
  await mkdir(d, { recursive: true });
  return d;
};
const g = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

const ENV_KEYS = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
] as const;
let saved: Record<string, string | undefined>;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "okb-sync-"));
  const gcfg = join(base, "gitconfig");
  await writeFile(gcfg, "", "utf8");
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: "okb-test",
    GIT_AUTHOR_EMAIL: "okb@test.local",
    GIT_COMMITTER_NAME: "okb-test",
    GIT_COMMITTER_EMAIL: "okb@test.local",
    GIT_CONFIG_GLOBAL: gcfg, // isolate from developer/CI global config
    GIT_CONFIG_NOSYSTEM: "1",
  });
});

afterAll(async () => {
  for (const k of ENV_KEYS)
    saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]!);
  await rm(base, { recursive: true, force: true });
});

const NOTE = "---\ntype: note\ntitle: Pub\ndescription: public note\n---\nBody.\n";

describe("syncBundle", () => {
  test("initializes, seeds ignore/attributes, and commits; reruns are no-ops", async () => {
    const root = await dir("b1");
    await writeFile(join(root, "note.md"), NOTE, "utf8");

    const first = await syncBundle(root);
    expect(first.initialized).toBe(true);
    expect(first.seeded).toEqual([".gitignore", ".gitattributes"]);
    expect(first.committed).not.toBeNull();
    expect(first.pushed).toBe(false);
    expect(await readFile(join(root, ".gitignore"), "utf8")).toContain(".okb/");
    expect(await readFile(join(root, ".gitattributes"), "utf8")).toContain(
      "* text=auto eol=lf",
    );

    const s = await syncStatus(root);
    expect(s).toEqual({
      repo: true,
      branch: "main",
      dirty: 0,
      remote: null,
      ahead: null,
      behind: null,
    });

    // Derived and private paths are invisible to git: nothing new to commit.
    await mkdir(join(root, ".okb"), { recursive: true });
    await writeFile(join(root, ".okb", "index.db"), "db", "utf8");
    await writeFile(join(root, "viz.html"), "<html>", "utf8");
    await mkdir(join(root, "db_only"), { recursive: true });
    await writeFile(join(root, "db_only", "x.md"), NOTE, "utf8");
    const second = await syncBundle(root);
    expect(second).toMatchObject({ initialized: false, seeded: [], committed: null });
    expect(g(root, "ls-files")).toBe(".gitattributes\n.gitignore\nnote.md\n");
  });

  test("existing .gitignore is preserved; missing lines appended exactly once", async () => {
    const root = await dir("b2");
    await writeFile(join(root, ".gitignore"), "custom/\n.okb/\n", "utf8");
    await syncBundle(root);
    const after = await readFile(join(root, ".gitignore"), "utf8");
    expect(after.startsWith("custom/\n.okb/\n")).toBe(true);
    expect(after).toContain("/viz.html");
    expect(after).toContain("db_only/");
    await syncBundle(root);
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe(after);
  });

  test("commits new changes with a custom message", async () => {
    const root = await dir("b3");
    await writeFile(join(root, "note.md"), NOTE, "utf8");
    await syncBundle(root);
    await writeFile(join(root, "note.md"), NOTE + "\nMore.\n", "utf8");
    const r = await syncBundle(root, "custom message");
    expect(r.committed).not.toBeNull();
    expect(g(root, "log", "-1", "--format=%s")).toBe("custom message\n");
  });

  test("pushes to and pulls from a local bare remote (multi-device flow)", async () => {
    const root = await dir("b4");
    const bare = join(base, "b4-remote.git");
    g(base, "init", "--bare", bare);
    g(bare, "symbolic-ref", "HEAD", "refs/heads/main"); // default branch, like a forge remote
    await writeFile(join(root, "note.md"), NOTE, "utf8");
    await syncBundle(root); // create the repo, then attach the remote
    g(root, "remote", "add", "origin", bare);

    const pushRun = await syncBundle(root);
    expect(pushRun.pushed).toBe(true);
    expect(g(bare, "rev-parse", "main").trim()).toHaveLength(40);

    // "Other device": clone, add a concept, push back.
    const other = join(base, "b4-other");
    g(base, "clone", bare, other);
    await writeFile(join(other, "elsewhere.md"), NOTE, "utf8");
    g(other, "add", "-A");
    g(other, "commit", "-m", "from the other device");
    g(other, "push");

    const pullRun = await syncBundle(root);
    expect(pullRun.pulled).toBe(true);
    expect(pullRun.pushed).toBe(true);
    expect(existsSync(join(root, "elsewhere.md"))).toBe(true);
  });

  test("refuses a bundle nested inside another git repository", async () => {
    const outer = await dir("b5");
    g(outer, "init");
    const inner = await dir("b5/brain");
    await expect(syncBundle(inner)).rejects.toThrow(SyncError);
    await expect(syncBundle(inner)).rejects.toThrow(/inside another git repository/);
  });

  test(".gitattributes pins LF in the working tree even under core.autocrlf=true", async () => {
    const root = await dir("b6");
    await writeFile(join(root, "note.md"), NOTE, "utf8");
    await syncBundle(root);
    g(root, "config", "core.autocrlf", "true"); // what Git-for-Windows defaults to
    await unlink(join(root, "note.md"));
    g(root, "checkout", "--", ".");
    expect(await readFile(join(root, "note.md"), "utf8")).not.toContain("\r");
  });
});

describe("db_only privacy", () => {
  test("db_only concepts never reach committed index.md, log.md, or git", async () => {
    const root = await dir("b7");
    await writeConcept(root, {
      id: "notes/pub",
      type: "note",
      title: "Pub",
      description: "public note",
      body: "Body.",
    });
    await writeConcept(root, {
      id: "db_only/secret",
      type: "note",
      title: "Secret Plan",
      description: "private",
      body: "Hidden.",
    });

    expect(await readFile(join(root, "index.md"), "utf8")).not.toContain("db_only");
    expect(await readFile(join(root, "log.md"), "utf8")).not.toContain("Secret Plan");
    // Its own (uncommitted) index still lists it for local browsing.
    expect(await readFile(join(root, "db_only", "index.md"), "utf8")).toContain(
      "Secret Plan",
    );

    await syncBundle(root);
    const tracked = g(root, "ls-files");
    expect(tracked).toContain("notes/pub.md");
    expect(tracked).not.toContain("db_only");
  });

  test("inDbOnlyDir means under a db_only directory, not named db_only", () => {
    expect(inDbOnlyDir("db_only/x")).toBe(true);
    expect(inDbOnlyDir("a/db_only/b")).toBe(true);
    expect(inDbOnlyDir("db_only")).toBe(false); // a root file db_only.md is public
    expect(inDbOnlyDir("notes/db_only_ish")).toBe(false);
  });
});

describe("okb sync (CLI)", () => {
  test("--status --json reports a plain directory as repo:false", async () => {
    const root = await dir("b8");
    const r = await okb(["sync", "--status", "--json", "--bundle", root]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).repo).toBe(false);
  });

  test("sync then status through the CLI", async () => {
    const root = await dir("b9");
    await writeFile(join(root, "note.md"), NOTE, "utf8");
    const r = await okb(["sync", "--bundle", root]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("committed");
    expect(r.stdout).toContain("no remote configured");
    const s = await okb(["sync", "--status", "--bundle", root]);
    expect(s.code).toBe(0);
    expect(s.stdout).toContain("on main");
  });
});
