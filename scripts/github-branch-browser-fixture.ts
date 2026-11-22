import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { GitHubFetch } from "../src/core/coding/github.ts";

const blobSha = (content: string) => createHash("sha1")
  .update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest("hex");

/** Simulate GitHub's Git objects and pull request endpoints without making live writes. */
export function githubBranchBrowserFixture(path: string, before: string, after: string) {
  const repository = "fixture-owner/project";
  const base = "main";
  const head = "okbrain/browser-review";
  const baseSha = "1".repeat(40);
  const baseTree = "2".repeat(40);
  const branchTree = "3".repeat(40);
  const commitSha = "4".repeat(40);
  const branchToken = "github_pat_browserBranchTokenFixture0001";
  const pullToken = "github_pat_browserPullTokenFixture000001";
  const message = "Apply browser review changes";
  const writes: string[] = [];
  const repoPath = `/repos/${repository}`;
  const ref = (name: string, sha: string) => ({ ref: `refs/heads/${name}`, object: { type: "commit", sha } });
  const tree = (sha: string, content: string) => ({
    sha, truncated: false,
    tree: [{ path, mode: "100644", type: "blob", sha: blobSha(content), size: Buffer.byteLength(content) }],
  });
  let published = false;
  const fetch: GitHubFetch = async (url, options) => {
    assert.equal(url.origin, "https://api.github.com");
    assert.ok(url.pathname.startsWith(repoPath + "/"));
    assert.equal(options.redirect, "error");
    const action = url.pathname.slice(repoPath.length);
    const token = action.startsWith("/git/") ? branchToken : pullToken;
    assert.equal(new Headers(options.headers).get("authorization"), `Bearer ${token}`);
    if (options.method === "GET") {
      switch (action) {
        case `/git/ref/heads/${base}`: return Response.json(ref(base, baseSha));
        case `/git/ref/heads/${head}`: return published
          ? Response.json(ref(head, commitSha)) : Response.json({}, { status: 404 });
        case `/git/commits/${baseSha}`: return Response.json({ sha: baseSha, tree: { sha: baseTree } });
        case `/git/trees/${baseTree}`: return Response.json(tree(baseTree, before));
        case `/git/trees/${branchTree}`: return Response.json(tree(branchTree, after));
        case `/git/blobs/${blobSha(before)}`: return Response.json({
          sha: blobSha(before), encoding: "base64", content: Buffer.from(before).toString("base64"), size: Buffer.byteLength(before),
        });
        case "/pulls":
          assert.equal(published, true);
          assert.deepEqual([url.searchParams.get("base"), url.searchParams.get("head")], [base, `fixture-owner:${head}`]);
          return Response.json([]);
      }
    } else {
      assert.equal(options.method, "POST");
      writes.push(action);
      const body = JSON.parse(String(options.body)) as Record<string, unknown>;
      const created = { status: 201 };
      switch (action) {
        case "/git/blobs":
          assert.deepEqual(body, { content: Buffer.from(after).toString("base64"), encoding: "base64" });
          return Response.json({ sha: blobSha(after) }, created);
        case "/git/trees":
          assert.deepEqual(body, { base_tree: baseTree, tree: [{ path, mode: "100644", type: "blob", sha: blobSha(after) }] });
          return Response.json({ ...tree(branchTree, after), truncated: true, tree: [] }, created);
        case "/git/commits":
          assert.deepEqual(body, { message, tree: branchTree, parents: [baseSha] });
          return Response.json({ sha: commitSha, message, tree: { sha: branchTree }, parents: [{ sha: baseSha }] }, created);
        case "/git/refs":
          assert.equal(published, false);
          assert.deepEqual(body, { ref: `refs/heads/${head}`, sha: commitSha });
          published = true;
          return Response.json(ref(head, commitSha), created);
        case "/pulls":
          assert.equal(published, true);
          assert.deepEqual([body.base, body.head, body.title, body.draft], [base, head, "Browser review", true]);
          assert.match(String(body.body), /^Approved branch for review\.\n\n<!-- okbrain-pr:[0-9a-f]{64} -->$/u);
          return Response.json({
            ...body, id: 500, number: 22,
            base: { ref: base, repo: { full_name: repository } }, head: { ref: head, repo: { full_name: repository } },
          }, created);
      }
    }
    throw new Error(`Unexpected GitHub browser fixture request to ${action}`);
  };
  return { fetch, repository, base, head, baseSha, commitSha, branchToken, pullToken, message, writes };
}
