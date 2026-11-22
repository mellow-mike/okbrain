import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { patchDigest, type ApprovedPatchFile } from "../src/core/coding/approved-patch.ts";
import {
  githubBranchRef, githubCreatePatchCommit, githubCreatePatchRef, githubPreparePatchBranch,
} from "../src/core/coding/github-branch.ts";
import type { GitHubFetch } from "../src/core/coding/github.ts";

const repository = "example-org/product";
const token = "fixture-branch-token";
const baseSha = "1".repeat(40);
const baseTree = "2".repeat(40);
const subTree = "3".repeat(40);
const newTree = "4".repeat(40);
const newSubTree = "5".repeat(40);
const newCommit = "6".repeat(40);
const branch = "okbrain/reviewed";

function blobId(bytes: Uint8Array) {
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

const fixtures = [
  { path: "src/main.ts", mode: "100644", before: "const value = 1;\n", after: "const value = 42;\n" },
  { path: "src/runner.ts", mode: "100755", before: "#!/usr/bin/env bun\nexit(1);\n", after: "#!/usr/bin/env bun\nexit(0);\n" },
] as const;
const files: ApprovedPatchFile[] = fixtures.map(({ path, mode, before, after }) => ({
  path, mode, before: patchDigest(before), after: patchDigest(after), bytes: Buffer.from(after),
}));

function fileEntry(file: typeof fixtures[number], text: string) {
  return {
    path: file.path.split("/").at(-1), mode: file.mode, type: "blob",
    sha: blobId(Buffer.from(text)), size: Buffer.byteLength(text),
  };
}

function tree(sha: string, rows: unknown[]) {
  return Response.json({ sha, truncated: false, tree: rows });
}

function directory(sha: string) {
  return { path: "src", mode: "040000", type: "tree", sha };
}

function ref(name: string, sha: string, status = 200) {
  return Response.json({ ref: `refs/heads/${name}`, object: { type: "commit", sha } }, { status });
}

function fixtureTransport(overrides: Partial<Record<string, () => Response>> = {}) {
  const events: string[] = [];
  const bodies = new Map<string, unknown[]>();
  let head: string | null = null;
  const expectedEntries = fixtures.map((file) => fileEntry(file, file.after));
  const transport: GitHubFetch = async (url, options) => {
    expect(url.origin).toBe("https://api.github.com");
    expect(url.pathname.startsWith(`/repos/${repository}/git/`)).toBe(true);
    expect(url.search).toBe("");
    expect(options.redirect).toBe("error");
    expect(new Headers(options.headers).get("authorization")).toBe(`Bearer ${token}`);
    const path = url.pathname.slice(`/repos/${repository}/git`.length);
    const method = options.method;
    const key = `${method} ${path}`;
    events.push(key);
    const body = typeof options.body === "string" ? JSON.parse(options.body) : undefined;
    if (body) bodies.set(path, [...(bodies.get(path) ?? []), body]);
    if (overrides[key]) return overrides[key]();
    switch (key) {
      case "GET /ref/heads/main": return ref("main", baseSha);
      case `GET /ref/heads/${branch}`: return head ? ref(branch, head) : new Response(null, { status: 404 });
      case `GET /commits/${baseSha}`: return Response.json({ sha: baseSha, tree: { sha: baseTree } });
      case `GET /trees/${baseTree}`: return tree(baseTree, [directory(subTree)]);
      case `GET /trees/${subTree}`: return tree(subTree, fixtures.map((file) => fileEntry(file, file.before)));
      case `GET /trees/${newTree}`: return tree(newTree, [directory(newSubTree)]);
      case `GET /trees/${newSubTree}`: return tree(newSubTree, expectedEntries);
      case "POST /blobs": {
        expect(body.encoding).toBe("base64");
        const bytes = Buffer.from(body.content as string, "base64");
        return Response.json({ sha: blobId(bytes) }, { status: 201 });
      }
      case "POST /trees": return Response.json({ sha: newTree, truncated: true }, { status: 201 });
      case "POST /commits": return Response.json({
        sha: newCommit, message: body.message, parents: [{ sha: baseSha }], tree: { sha: newTree },
      }, { status: 201 });
      case "POST /refs": {
        if (head) return new Response(null, { status: 422 });
        head = body.sha;
        return ref(branch, body.sha, 201);
      }
    }
    for (const file of fixtures) {
      const { sha, size } = fileEntry(file, file.before);
      if (key === `GET /blobs/${sha}`) return Response.json({
        sha, size, encoding: "base64", content: Buffer.from(file.before).toString("base64") + "\n",
      });
    }
    throw new Error(`Unexpected fixture request ${key}`);
  };
  return { transport, events, bodies };
}

test("binds exact base bytes and publishes only the reviewed blobs to a new GitHub ref", async () => {
  const { transport, events, bodies } = fixtureTransport();
  const base = await githubPreparePatchBranch(repository, "main", files, token, transport);
  expect(base).toEqual({ baseSha, baseTree });
  expect(events.filter((key) => key === `GET /trees/${subTree}`)).toHaveLength(1);
  expect(events.some((key) => key.startsWith("POST"))).toBe(false);
  expect(await githubBranchRef(repository, branch, token, transport)).toBeNull();
  expect(await githubCreatePatchCommit(repository, { ...base, message: "Apply approved edits", files }, token, transport))
    .toBe(newCommit);
  await githubCreatePatchRef(repository, branch, newCommit, token, transport);
  expect(await githubBranchRef(repository, branch, token, transport)).toBe(newCommit);

  expect(bodies.get("/blobs")).toEqual(fixtures.map(({ after }) => ({
    content: Buffer.from(after).toString("base64"), encoding: "base64",
  })));
  expect(bodies.get("/trees")).toEqual([{
    base_tree: baseTree,
    tree: fixtures.map((file) => ({ path: file.path, type: "blob", mode: file.mode, sha: blobId(Buffer.from(file.after)) })),
  }]);
  expect(bodies.get("/commits")).toEqual([{ message: "Apply approved edits", parents: [baseSha], tree: newTree }]);
  expect(bodies.get("/refs")).toEqual([{ ref: `refs/heads/${branch}`, sha: newCommit }]);
  await expect(githubCreatePatchRef(repository, branch, newCommit, token, transport)).rejects.toMatchObject({ status: 409 });
  expect(events.some((key) => /^(PATCH|DELETE)/.test(key))).toBe(false);
});

test("rejects mismatched starting bytes, file modes and head identities before a branch write", async () => {
  const stale = fixtureTransport();
  await expect(githubPreparePatchBranch(repository, "main", [{ ...files[0]!, before: patchDigest("foreign") }], token, stale.transport))
    .rejects.toThrow("approved starting bytes");
  expect(stale.bodies.size).toBe(0);
  await expect(githubPreparePatchBranch(repository, "main", [{ ...files[0]!, mode: "100755" }], token, stale.transport))
    .rejects.toThrow("file or mode");

  const wrong = fixtureTransport({ [`GET /ref/heads/${branch}`]: () => ref(branch + "-other", newCommit) });
  await expect(githubBranchRef(repository, branch, token, wrong.transport)).rejects.toThrow("different branch reference");
  expect(wrong.bodies.size).toBe(0);
  await expect(githubBranchRef("example-org/..", branch, token, wrong.transport)).rejects.toThrow("bound GitHub repository");
  await expect(githubBranchRef(repository, "../main", token, wrong.transport)).rejects.toThrow("valid branch names");
  expect(wrong.events).toHaveLength(1);
});

test("rejects changed staged bytes and an unexpected remote tree or parent before creating a ref", async () => {
  const original = fixtureTransport();
  const commit = { baseSha, baseTree, message: "Apply approved edits", files };
  await expect(githubCreatePatchCommit(repository, {
    ...commit, files: [{ ...files[0]!, bytes: Buffer.from("modified after approval") }],
  }, token, original.transport)).rejects.toThrow("captured bytes");
  expect(original.events).toEqual([]);

  const wrongTree = fixtureTransport({
    [`GET /trees/${newSubTree}`]: () => tree(newSubTree, fixtures.map((file) => fileEntry(file, file.before))),
  });
  await expect(githubCreatePatchCommit(repository, commit, token, wrongTree.transport)).rejects.toThrow("different file changes");
  expect(wrongTree.bodies.has("/commits")).toBe(false);

  const wrongParent = fixtureTransport({
    "POST /commits": () => Response.json({
      sha: newCommit, message: commit.message, parents: [{ sha: subTree }], tree: { sha: newTree },
    }, { status: 201 }),
  });
  await expect(githubCreatePatchCommit(repository, commit, token, wrongParent.transport)).rejects.toThrow("differs from the approved branch");
  expect(wrongParent.bodies.has("/refs")).toBe(false);
});
