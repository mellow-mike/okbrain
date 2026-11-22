import { expect, test } from "bun:test";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { githubBranchBrowserFixture } from "../scripts/github-branch-browser-fixture.ts";
import { createApiServer } from "../src/api.ts";

test("an accepted alternative publishes only its reviewed patch and recorded GitHub head", async () => {
  const root = await mkdtemp(join(tmpdir(), "okb-branch-publication-"));
  const workspace = join(root, "workspace");
  const stateDir = join(root, "state");
  const file = "review.ts";
  const before = "export const accepted = 'original';\n";
  const after = "export const accepted = 'alternative';\n";
  const diff = `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-${before}+${after}`;
  const github = githubBranchBrowserFixture(file, before, after);
  const provider = fauxProvider({ provider: "openai", models: [{ id: "publish-alternative" }] });
  provider.setResponses([fauxAssistantMessage("Keep the original for reference."), fauxAssistantMessage(`Use the alternative.\n\n\`\`\`diff\n${diff}\`\`\``)]);
  const models = createModels();
  models.setProvider(provider.provider);
  const token = "branch-publication-test";
  let server: ReturnType<typeof createApiServer> | undefined;

  function git(...args: string[]) {
    const result = Bun.spawnSync(["git", ...args], { cwd: workspace, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString();
  }

  const open = () => createApiServer({ bundle: workspace, port: 0, token, coding: { stateDir, models, githubFetch: github.fetch } });
  async function post<T = unknown>(path: string, body: object, status = 200, member?: string) {
    const response = await fetch(new URL(`api/coding${path}`, server!.url), {
      method: "POST",
      headers: { "content-type": "application/json", ...(member ? { authorization: `Bearer ${member}` } : { "x-okb-token": token }) },
      body: JSON.stringify(body),
    });
    const result = await response.json() as { result: T; error?: string };
    expect(response.status, `${path}: ${result.error ?? ""}`).toBe(status);
    return result;
  }

  try {
    await mkdir(workspace);
    await writeFile(join(workspace, file), before);
    git("init", "-q");
    git("config", "core.autocrlf", "false");
    git("add", "--", file);
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Fixture base");
    git("remote", "add", "origin", `https://github.com/${github.repository}.git`);
    server = open();
    const { result: project } = await post<{ id: string }>("/projects", { workspace, title: "Alternative publication fixture", provider: "openai", model: "publish-alternative" });
    const base = `/projects/${project.id}`;
    const { result: member } = await post<{ token: string }>(base + "/members", { name: "alternative-reviewer" });
    const source = { source: "files", files: [file] };
    const original = { session: "original", requestId: "same-request" };

    async function send(session: string) {
      const { result: preview } = await post<{ id: string; branchContext?: { id: string } }>(base + "/preview", { ...source, session });
      const run = { session, requestId: original.requestId };
      await post(base + "/run", { ...source, ...run, prompt: "Review and suggest a change.", approved: true,
        previewId: preview.id, branchContextId: preview.branchContext?.id });
      for (const deadline = Date.now() + 5000; Date.now() < deadline;) {
        const { result: { run: current } } = await post<{ run: { status: string } }>(base + "/inspect", run);
        if (current.status === "done") return run;
        expect(current.status).toBe("running");
        await Bun.sleep(20);
      }
      throw new Error(`The ${session} request did not finish.`);
    }

    await send(original.session);
    await post(base + "/review", { ...original, decision: "accepted" });
    const { result: fork } = await post<{ branchSession: string; previewId: string }>(base + "/branches-preview", original);
    await post(base + "/branches", { ...original, previewId: fork.previewId });
    const alternative = await send(fork.branchSession);
    await post(base + "/patch-proposals", alternative, 409);
    await post(base + "/review", { ...alternative, decision: "accepted" }, 200, member.token);
    await post(base + "/patch-proposals", alternative, 403, member.token);
    const { result: proposals } = await post<{ proposals: { diff: string }[] }>(base + "/patch-proposals", alternative);
    expect(proposals.proposals.map((proposal) => proposal.diff)).toEqual([diff]);
    const { result: originalPatch } = await post<{ id: string }>(base + "/patch-preview", { ...original, diff });
    const { result: alternativePatch } = await post<{ id: string }>(base + "/patch-preview", { ...alternative, diff });
    expect(alternativePatch.id).not.toBe(originalPatch.id);
    await post(base + "/patch-apply", { ...alternative, diff, previewId: originalPatch.id, approved: true }, 409);
    await post(base + "/patch-apply", { ...alternative, diff, previewId: alternativePatch.id }, 400);
    expect(await readFile(join(workspace, file), "utf8")).toBe(before);
    await post(base + "/patch-apply", { ...alternative, diff, previewId: alternativePatch.id, approved: true });
    expect(await readFile(join(workspace, file), "utf8")).toBe(after);
    expect(git("show", `:${file}`)).toBe(before);

    await post(base + "/github-connect", { remote: "origin", repository: github.repository });
    await post(base + "/github-branch-credential", { token: github.branchToken });
    await post(base + "/github-pr-credential", { token: github.pullToken });
    const branches = { base: github.base, head: github.head };
    const pull = { ...alternative, ...branches, title: "Browser review", body: "Approved branch for review.", draft: true };
    expect((await post(base + "/github-pr-preview", pull, 409)).error).toContain("Publish the applied patch");
    const branch = { ...alternative, ...branches, message: github.message };
    const { result: branchPreview } = await post<{ approval: string }>(base + "/github-branch-preview", branch);
    await post(base + "/github-branch-publish", { ...branch, approval: branchPreview.approval, approved: true }, 403, member.token);
    expect(github.writes).toEqual([]);
    await post(base + "/github-branch-publish", { ...branch, approval: branchPreview.approval, approved: true });
    expect((await post(base + "/github-pr-preview", { ...pull, head: "another-head" }, 409)).error).toContain("recorded for this alternative");
    const { result: pullPreview } = await post<{ approval: string; headCommit: string }>(base + "/github-pr-preview", pull);
    expect(pullPreview.headCommit).toBe(github.commitSha);
    const confirmed = { ...pull, approval: pullPreview.approval, approved: true };
    github.moveHead("5".repeat(40));
    expect((await post(base + "/github-pr-publish", confirmed, 409)).error).toContain("no longer points");
    expect(github.writes).toEqual(["/git/blobs", "/git/trees", "/git/commits", "/git/refs"]);
    github.moveHead(github.commitSha);
    github.losePullResponse();
    await post(base + "/github-pr-publish", confirmed, 502);
    await server.stop();
    server = open();
    github.moveHead("6".repeat(40));
    expect((await post(base + "/github-pr-recover", alternative, 409)).error).toContain("different head commit");
    expect((await post<{ receipt: unknown }>(base + "/github-pr-inspect", alternative)).result.receipt).toBeNull();
    github.moveHead(github.commitSha);
    const { result: recovered } = await post<{ receipt: { number: number; url: string } }>(base + "/github-pr-recover", alternative);
    expect(recovered.receipt).toMatchObject({ number: 22, url: `https://github.com/${github.repository}/pull/22` });
    expect((await post(base + "/github-pr-inspect", original)).result).toBeNull();
    expect(github.writes.filter((action) => action === "/pulls")).toHaveLength(1);
    expect(provider.state.callCount).toBe(2);
  } finally {
    await server?.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
