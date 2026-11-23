import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { GitHubFetch } from "../src/core/coding/github.ts";

const blobSha = (content: string) => createHash("sha1")
  .update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest("hex");

/** Simulate GitHub issue reads and review publishing without reaching the live service. */
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
  const activityToken = "github_pat_browserActivityTokenFixture1";
  const message = "Apply browser review changes";
  const writes: string[] = [];
  const repoPath = `/repos/${repository}`;
  const issue = {
    number: 12,
    title: "Record browser settings",
    body: "## Reproduction\n\nSee **browser settings**.\n\n<span data-fixture-issue-markup>Literal markup</span>",
    html_url: `https://github.com/${repository}/issues/12`,
  };
  const issueReads: number[] = [];
  const ref = (name: string, sha: string) => ({ ref: `refs/heads/${name}`, object: { type: "commit", sha } });
  const tree = (sha: string, content: string) => ({
    sha, truncated: false,
    tree: [{ path, mode: "100644", type: "blob", sha: blobSha(content), size: Buffer.byteLength(content) }],
  });
  let currentHead: string | null = null;
  let pull: Record<string, unknown> | undefined;
  let dropPullResponse = false;
  const pullHead = () => ({ ref: head, sha: currentHead, repo: { full_name: repository } });
  const fetch: GitHubFetch = async (url, options) => {
    assert.equal(url.origin, "https://api.github.com");
    assert.ok(url.pathname === repoPath || url.pathname.startsWith(repoPath + "/"));
    assert.equal(options.redirect, "error");
    const action = url.pathname.slice(repoPath.length);
    const activity = action === "" || action.startsWith("/issues") ||
      (options.method === "GET" && action === "/pulls" && !url.searchParams.has("head"));
    const token = activity ? activityToken : action.startsWith("/git/") ? branchToken : pullToken;
    assert.equal(new Headers(options.headers).get("authorization"), `Bearer ${token}`);
    if (options.method === "GET") {
      switch (action) {
        case "": return Response.json({ full_name: repository, default_branch: base });
        case "/issues":
          assert.equal(url.searchParams.get("state"), "open");
          return Response.json([{ number: issue.number, title: issue.title, body: issue.body, html_url: issue.html_url }]);
        case `/issues/${issue.number}`:
          issueReads.push(issue.number);
          return Response.json(issue);
        case `/git/ref/heads/${base}`: return Response.json(ref(base, baseSha));
        case `/git/ref/heads/${head}`: return currentHead
          ? Response.json(ref(head, currentHead)) : Response.json({}, { status: 404 });
        case `/git/commits/${baseSha}`: return Response.json({ sha: baseSha, tree: { sha: baseTree } });
        case `/git/trees/${baseTree}`: return Response.json(tree(baseTree, before));
        case `/git/trees/${branchTree}`: return Response.json(tree(branchTree, after));
        case `/git/blobs/${blobSha(before)}`: return Response.json({
          sha: blobSha(before), encoding: "base64", content: Buffer.from(before).toString("base64"), size: Buffer.byteLength(before),
        });
        case "/pulls":
          if (activity) return Response.json([]);
          assert.ok(currentHead);
          assert.deepEqual([url.searchParams.get("base"), url.searchParams.get("head")], [base, `fixture-owner:${head}`]);
          return Response.json(pull ? [{ ...pull, head: pullHead() }] : []);
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
          assert.equal(currentHead, null);
          assert.deepEqual(body, { ref: `refs/heads/${head}`, sha: commitSha });
          currentHead = commitSha;
          return Response.json(ref(head, commitSha), created);
        case "/pulls":
          assert.ok(currentHead);
          assert.equal(pull, undefined);
          assert.deepEqual([body.base, body.head, body.title, body.draft], [base, head, "Browser review", true]);
          assert.match(String(body.body), /^Approved branch for review\.\n\n<!-- okbrain-pr:[0-9a-f]{64} -->$/u);
          pull = {
            ...body, id: 500, number: 22, state: "open",
            base: { ref: base, repo: { full_name: repository } }, head: pullHead(),
          };
          if (dropPullResponse) throw new Error("Fixture dropped the response after creating the pull request.");
          return Response.json(pull, created);
      }
    }
    throw new Error(`Unexpected GitHub browser fixture request to ${action}`);
  };
  return {
    fetch, repository, base, head, baseSha, commitSha, branchToken, pullToken, activityToken, message, writes, issue, issueReads,
    moveHead(sha: string) { currentHead = sha; },
    losePullResponse() { dropPullResponse = true; },
  };
}
