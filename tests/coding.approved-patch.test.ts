import { expect, test } from "bun:test";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { Database } from "bun:sqlite";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createApiServer } from "../src/api.ts";
import { approvedPatchFiles, approvedPatchState, patchDigest, patchPaths, withPreparedPatch } from "../src/core/coding/approved-patch.ts";
import { ensureExtensionCapableSqlite } from "../src/core/engine/custom-sqlite.ts";

const target = "src/example.ts";
const original = "export const answer = 1;\n";
const proposed = "export const answer = 2;\n";
type PatchReceipt = { id: string; applied: string; reused: boolean };

function diff(path = target) {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${original}+${proposed}`;
}

function addDiff(path: string, mode = "100644", content = "export const added = true;\n") {
  const header = `diff --git a/${path} b/${path}\nnew file mode ${mode}\n`;
  if (!content) return header + "index 0000000..e69de29\n";
  const lines = content.slice(0, -1).split("\n");
  return header + `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n` + lines.map((line) => `+${line}\n`).join("");
}

async function fixture(action: (workspace: string, git: (...args: string[]) => string) => Promise<void>) {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "okb-patch-test-")));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: workspace });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString();
  };
  try {
    await mkdir(join(workspace, dirname(target)), { recursive: true });
    await writeFile(join(workspace, target), original, { mode: 0o644 });
    git("init", "--quiet");
    git("add", "--", target);
    return await action(workspace, git);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

test("previews an exact patch without touching files and applies only to the worktree", async () => {
  await fixture(async (workspace, git) => {
    const stage = git("ls-files", "--stage");
    await withPreparedPatch(workspace, ["src"], diff(), async ({ files, apply }) => {
      expect(files).toHaveLength(1);
      expect(files[0]?.path).toBe(target);
      expect(await readFile(join(workspace, target), "utf8")).toBe(original);
      expect(await approvedPatchState(workspace, ["src"], files)).toBe("before");
      await apply();
      expect(await approvedPatchState(workspace, ["src"], files)).toBe("after");
    });
    expect(await readFile(join(workspace, target), "utf8")).toBe(proposed);
    expect(git("ls-files", "--stage")).toBe(stage);
    expect(git("diff", "--", target)).toContain("+export const answer = 2;");
  });
});

test("adds a new executable and an empty file with no changes to the real index", async () => {
  await fixture(async (workspace, git) => {
    const executable = "src/new/nested/check.txt";
    const empty = "src/empty.md";
    const text = "approved executable contents\n";
    const index = join(workspace, ".git", "index");
    const oldIndex = await readFile(index);
    const patch = addDiff(executable, "100755", text) + addDiff(empty, "100644", "");
    expect(patchPaths(patch)).toEqual([executable, empty]);
    const receipts = await withPreparedPatch(workspace, ["src"], patch, async ({ files, apply }) => {
      expect(files).toEqual([
        { path: executable, mode: "100755", before: null, after: patchDigest(text) },
        { path: empty, mode: "100644", before: null, after: patchDigest("") },
      ]);
      expect(await approvedPatchState(workspace, ["src"], files)).toBe("before");
      await expect(stat(join(workspace, "src", "new"))).rejects.toThrow();
      await expect(approvedPatchFiles(workspace, ["src"], files)).rejects.toThrow("no longer matches");
      if (process.platform === "win32") await apply();
      else {
        const previousMask = process.umask(0o077);
        try { await apply(); }
        finally { process.umask(previousMask); }
      }
      return files;
    });
    expect(await readFile(index)).toEqual(oldIndex);
    expect(git("ls-files", "--", executable, empty)).toBe("");
    if (process.platform !== "win32") {
      expect((await stat(join(workspace, executable))).mode & 0o777).toBe(0o700);
      expect((await stat(join(workspace, empty))).mode & 0o777).toBe(0o600);
    }
    expect(await approvedPatchState(workspace, ["src"], receipts)).toBe("after");
    expect((await approvedPatchFiles(workspace, ["src"], receipts)).map(({ bytes }) => Buffer.from(bytes).toString())).toEqual([text, ""]);
    git("add", "--", empty);
    await expect(approvedPatchFiles(workspace, ["src"], receipts)).rejects.toThrow("conflicts with the Git index");
  });
});

test("a mixed patch detects a partial write and rejects a new file that appears after preview", async () => {
  await fixture(async (workspace, git) => {
    const added = "src/added.ts";
    const file = join(workspace, added);
    const index = git("ls-files", "--stage");
    await withPreparedPatch(workspace, ["src"], diff() + addDiff(added), async ({ files, apply }) => {
      expect(await approvedPatchState(workspace, ["src"], files)).toBe("before");
      await writeFile(file, "export const added = true;\n", { mode: 0o644 });
      expect(await approvedPatchState(workspace, ["src"], files)).toBe("different");
      await expect(apply()).rejects.toThrow("worktree changed");
      expect(await readFile(join(workspace, target), "utf8")).toBe(original);
      await rm(file);
      await apply();
      expect(await approvedPatchState(workspace, ["src"], files)).toBe("after");
      await rm(file);
      expect(await approvedPatchState(workspace, ["src"], files)).toBe("different");
    });
    expect(git("ls-files", "--stage")).toBe(index);
  });
});

test("new files cannot replace worktree entries, indexed aliases, or indexed parent or child paths", async () => {
  await fixture(async (workspace, git) => {
    const path = "src/Other.ts";
    await writeFile(join(workspace, path), original);
    await expect(withPreparedPatch(workspace, ["src"], addDiff(path), async () => {})).rejects.toThrow("already exists");
    await expect(withPreparedPatch(workspace, ["src"], addDiff(path.toLowerCase()), async () => {})).rejects.toThrow("different letter case");
    git("add", "--", path);
    await rm(join(workspace, path));
    for (const candidate of [path.toLowerCase(), path + "/child.ts", "src"]) {
      await expect(withPreparedPatch(workspace, ["."], addDiff(candidate), async () => {})).rejects.toThrow("conflicts with the Git index");
    }
  });
});

test("captures only the exact applied and unchanged patch bytes for publication", async () => {
  await fixture(async (workspace, git) => {
    const file = join(workspace, target);
    const extra = join(workspace, "src/unrelated.ts");
    await writeFile(extra, "Unrelated worktree changes stay separate.\n");
    git("add", "--", "src/unrelated.ts");
    const stage = git("ls-files", "--stage");
    const receipts = await withPreparedPatch(workspace, ["src"], diff(), async ({ files, apply }) => {
      await expect(approvedPatchFiles(workspace, ["src"], files)).rejects.toThrow("no longer matches");
      await apply();
      return files;
    });
    const captured = await approvedPatchFiles(workspace, ["src"], receipts);
    expect(captured).toEqual([{
      path: target, mode: "100644", before: patchDigest(original), after: patchDigest(proposed),
      bytes: Buffer.from(proposed),
    }]);
    expect(git("ls-files", "--stage")).toBe(stage);
    expect(await readFile(extra, "utf8")).toBe("Unrelated worktree changes stay separate.\n");
    await writeFile(file, proposed + "// later edit\n");
    expect(captured[0]!.bytes).toEqual(Buffer.from(proposed));
    await expect(approvedPatchFiles(workspace, ["src"], receipts)).rejects.toThrow("no longer matches");
  });
});

test("applied patch capture rejects invalid receipts, changed Git mode, and out-of-scope files", async () => {
  await fixture(async (workspace, git) => {
    const receipts = await withPreparedPatch(workspace, ["src"], diff(), async ({ files, apply }) => {
      await apply();
      return files;
    });
    const [file] = receipts;
    for (const invalid of [
      [],
      [{ ...file!, path: "../outside.ts" }],
      [{ ...file!, before: "bad hash" }],
      [{ ...file!, after: patchDigest(original) }],
      [{ ...file!, mode: "120000" }],
      [...receipts, { ...file!, path: "SRC/example.ts" }],
    ]) {
      await expect(approvedPatchFiles(workspace, ["src"], invalid)).rejects.toThrow("receipt is invalid");
    }
    await expect(approvedPatchFiles(workspace, ["other"], receipts)).rejects.toThrow("outside the permitted patch scope");
    git("update-index", "--chmod=+x", "--", target);
    if (process.platform !== "win32") await chmod(join(workspace, target), 0o755);
    await expect(approvedPatchFiles(workspace, ["src"], receipts)).rejects.toThrow("no longer matches");
  });
});

test("rejects stale bytes, untracked and out-of-scope files, and invalid hunks", async () => {
  await fixture(async (workspace) => {
    const file = join(workspace, target);
    const changed = original + "// changed after preview\n";
    await withPreparedPatch(workspace, ["src"], diff(), async ({ apply }) => {
      await writeFile(file, changed);
      await expect(apply()).rejects.toThrow("worktree changed");
    });
    expect(await readFile(file, "utf8")).toBe(changed);
    await expect(withPreparedPatch(workspace, ["wrong"], diff(), async () => {})).rejects.toThrow("outside the permitted patch scope");
    await writeFile(join(workspace, "src", "other.ts"), original, { mode: 0o644 });
    await expect(withPreparedPatch(workspace, ["src"], diff("src/other.ts"), async () => {})).rejects.toThrow("must be tracked");
    await expect(withPreparedPatch(workspace, ["src"], diff().replace("answer = 1", "answer = 3"), async () => {})).rejects.toThrow("could not apply");
  });
});

test("rejects malformed paths and Git metadata for more than ordinary text edits", () => {
  for (const invalid of [
    diff("../outside.ts"), diff("src/.env"), diff("src/COM1.ts"),
    addDiff("src/.git"), addDiff("src/.GI~1/config"), addDiff("src/A/x") + addDiff("src/a/y"),
    diff().replace("+++ b/src/example.ts", "+++ b/other.ts"),
    diff().replace("--- a/src/example.ts\n", "old mode 100644\nnew mode 100755\n--- a/src/example.ts\n"),
    diff().replace("--- a/src/example.ts\n", "new file mode 100644\n--- /dev/null\n"),
    diff().replace("@@ -1 +1 @@", "@@ -1,2 +1 @@"),
  ]) expect(() => patchPaths(invalid)).toThrow();
});

test.skipIf(process.platform === "win32")("rejects files replaced by worktree symlinks", async () => {
  await fixture(async (workspace) => {
    const originalPath = join(workspace, target);
    const linked = join(workspace, "target.ts");
    const receipts = await withPreparedPatch(workspace, ["src"], diff(), async ({ files, apply }) => {
      await apply();
      return files;
    });
    await writeFile(linked, proposed, { mode: 0o644 });
    await rm(originalPath);
    await symlink(linked, originalPath);
    await expect(withPreparedPatch(workspace, ["src"], diff(), async () => {})).rejects.toThrow("ordinary tracked UTF-8 file");
    await expect(approvedPatchFiles(workspace, ["src"], receipts)).rejects.toThrow("ordinary tracked UTF-8 file");
    expect(await readFile(linked, "utf8")).toBe(proposed);
    const outside = join(workspace, "outside-scope");
    await mkdir(outside);
    await symlink(outside, join(workspace, "src", "redirect"));
    await expect(withPreparedPatch(workspace, ["src"], addDiff("src/redirect/new.ts"), async () => {})).rejects.toThrow("symlink");
    await expect(stat(join(outside, "new.ts"))).rejects.toThrow();
  });
});

test("coding API gates patch approval to the owner and recovers a prepared mixed receipt on restart", async () => {
  await fixture(async (workspace, git) => {
    const stage = join(workspace, target);
    const newPath = "src/create-on-approval.ts";
    const index = git("ls-files", "--stage");
    const models = createModels();
    const faux = fauxProvider({ provider: "openai", models: [{ id: "patch-fixture" }] });
    models.setProvider(faux.provider);
    const token = "local-operator-test";
    const stateDir = join(workspace, ".fixture-state");
    const settings = { bundle: workspace, port: 0, token, coding: { models, stateDir } };
    let server = createApiServer(settings);
    const request = (path: string, data?: unknown, member?: string) => fetch(new URL(`api/coding${path}`, server.url), {
      method: data === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", ...(member ? { authorization: `Bearer ${member}` } : { "x-okb-token": token }) },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    async function api<T>(path: string, data?: unknown): Promise<T> {
      const response = await request(path, data);
      const json = await response.json() as { result: T; error?: string };
      if (!response.ok) throw new Error(json.error ?? String(response.status));
      return json.result;
    }
    try {
      const project = await api<{ id: string }>("/projects", { workspace, title: "Patch fixture", scopes: ["src"], provider: "openai", model: "patch-fixture" });
      const prefix = `/projects/${project.id}`;
      const member = await api<{ token: string }>(`${prefix}/members`, { name: "member" });
      const source = { source: "files", files: [] };
      const selected = await api<{ id: string }>(`${prefix}/preview`, source);
      const identity = { session: "main", requestId: "patch-1" };
      faux.setResponses([fauxAssistantMessage("Review this one-line change.")]);
      await api(`${prefix}/run`, { ...source, ...identity, approved: true, previewId: selected.id, prompt: "Review a change." });
      const deadline = Date.now() + 4_000;
      for (;;) {
        const status = (await api<{ run: { status: string } }>(`${prefix}/inspect`, identity)).run.status;
        if (status !== "running" || Date.now() > deadline) { expect(status).toBe("done"); break; }
        await Bun.sleep(20);
      }
      const patch = { ...identity, diff: diff() + addDiff(newPath) };
      expect((await request(`${prefix}/patch-preview`, patch)).status).toBe(409);
      await api(`${prefix}/review`, { ...identity, decision: "accepted" });
      expect((await request(`${prefix}/patch-preview`, patch, member.token)).status).toBe(403);
      const first = await api<{ id: string }>(`${prefix}/patch-preview`, patch);
      expect(await readFile(stage, "utf8")).toBe(original);
      expect((await request(`${prefix}/patch-apply`, { ...patch, previewId: first.id })).status).toBe(400);
      await writeFile(stage, "// unrelated later edit\n" + original);
      expect((await request(`${prefix}/patch-apply`, { ...patch, approved: true, previewId: first.id })).status).toBe(409);
      expect(await readFile(stage, "utf8")).toContain("unrelated later edit");
      await writeFile(stage, original);
      const selectedPatch = await api<{ id: string }>(`${prefix}/patch-preview`, patch);
      const approved = { ...patch, approved: true, previewId: selectedPatch.id };
      expect((await request(`${prefix}/patch-apply`, { ...approved, diff: diff().replace("answer = 2", "answer = 3") })).status).toBe(409);
      const applied = await api<{ applied: string }>(`${prefix}/patch-apply`, approved);
      expect(await readFile(stage, "utf8")).toBe(proposed);
      expect(await readFile(join(workspace, newPath), "utf8")).toBe("export const added = true;\n");
      expect(git("ls-files", "--stage")).toBe(index);
      expect(applied.applied).toMatch(/^\d{4}-/u);
      await server.stop();

      // Recreate the durable state left when the process exits after the worktree
      // write and before the catalog marks it applied.
      ensureExtensionCapableSqlite();
      {
        using catalog = new Database(join(stateDir, "projects.sqlite"));
        catalog.exec("UPDATE applied_patches SET status = 'prepared', applied = NULL");
        catalog.exec("DELETE FROM audit WHERE kind = 'patch_applied'");
      }
      server = createApiServer(settings);
      const recovered = await api<PatchReceipt>(`${prefix}/patch-apply`, approved);
      expect(recovered).toMatchObject({ id: selectedPatch.id, reused: true });
      expect(git("ls-files", "--stage")).toBe(index);
      await writeFile(stage, original);
      expect(await api<PatchReceipt>(`${prefix}/patch-apply`, approved)).toEqual(recovered);
      expect(await readFile(stage, "utf8")).toBe(original);
      const audit = await api<{ kind: string }[]>(`${prefix}/audit`);
      expect(audit.filter((event) => event.kind.startsWith("patch_")).map((event) => event.kind)).toEqual(["patch_applied", "patch_approved"]);
      expect(JSON.stringify(audit)).not.toContain(proposed.trim());
    } finally { await server.stop(); }
  });
}, 15_000);
