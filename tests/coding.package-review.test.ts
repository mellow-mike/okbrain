import { expect, test } from "bun:test";
import { createModels, fauxAssistantMessage, fauxProvider, getCurrentTools } from "@earendil-works/pi-ai";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApiServer } from "../src/api.ts";
import { cancelCodingRequest, getCodingSessionStatus, listStandaloneCodingRequests, runCodingSession, type CodingSessionResult,
  type CodingTaskProgress } from "../src/core/coding/durable.ts";
import { previewPackageReviews } from "../src/core/coding/package-review.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "okb-package-review-"));
  const workspace = join(root, "workspace");
  const models = createModels();
  const provider = "openai";
  const model = "package-test";
  const faux = fauxProvider({ provider, models: [{ id: model }] });
  models.setProvider(faux.provider);
  const packages = [
    { project: "left", query: "leftEvidence", path: "left/source.ts", content: "export const leftEvidence = 'left reviewed';" },
    { project: "right", query: "rightEvidence", path: "right/source.ts", content: "export const rightEvidence = 'right reviewed';" },
  ];
  try {
    for (const entry of packages) {
      await mkdir(join(workspace, entry.project), { recursive: true });
      await writeFile(join(workspace, entry.path), entry.content);
    }
    for (const args of [["init", "--quiet"], ["add", "--", "."]]) {
      const git = Bun.spawnSync(["git", ...args], { cwd: workspace });
      expect(git.exitCode, git.stderr.toString()).toBe(0);
    }
    return {
      root, workspace, packages, faux, dependencies: { models, stateDir: join(root, "state") },
      options: { workspace, model, provider, session: "package-review", requestId: "review-1" },
    };
  } catch (error) {
    await rm(root, { force: true, recursive: true });
    throw error;
  }
}

test("only sends each reviewed package its own source and recovers durable work without rereading the workspace", async () => {
  const { root, workspace, packages, faux, dependencies, options } = await fixture();
  try {
    faux.setResponses([fauxAssistantMessage("Parent conversation only")]);
    const parent = await runCodingSession({ ...options, prompt: "Parent context only", requestId: "parent-context" }, dependencies);
    expect(parent.status).toBe("done");

    const preview = await previewPackageReviews(workspace, packages);
    expect(preview.packages.map((entry) => entry.excerpts.map(({ path }) => path))).toEqual([["left/source.ts"], ["right/source.ts"]]);
    const request = { ...options, prompt: "Compare package behavior", packageReviews: { packages, id: preview.id } };
    const changed = join(workspace, packages[0]!.path);
    await writeFile(changed, "export const leftEvidence = 'changed after preview';");
    await expect(runCodingSession(request, dependencies)).rejects.toThrow("The package selection changed");
    expect(faux.state.callCount).toBe(1);
    await writeFile(changed, packages[0]!.content);
    await expect(runCodingSession(request, { ...dependencies, admitted: () => { throw new Error("interrupt immediately after admission"); } }))
      .rejects.toThrow("Could not open Pi Durable session");
    const inFlight = await getCodingSessionStatus(options, dependencies);
    expect(inFlight.pendingRequestIds).toEqual([options.requestId]);
    expect(inFlight.request?.status).toBe("placed");
    expect(inFlight.request?.taskProgress).toEqual({
      stages: [{ kind: "package-review", pending: 1, running: 0, waiting: 0, completing: 0 }],
    });
    expect((await listStandaloneCodingRequests(options.session, dependencies)).requests).toEqual([
      { requestId: options.requestId, kind: "package-review", status: "placed" },
      { requestId: "parent-context", kind: "request", status: "done" },
    ]);
    for (const { path } of packages) await rm(join(workspace, path));

    faux.setResponses(Array.from({ length: 2 }, () => (input) => {
      const message = input.messages.findLast(({ role }) => role === "user");
      if (message?.role !== "user" || typeof message.content !== "string") throw new Error("No package input");
      expect(getCurrentTools(input.messages)).toEqual([]);
      expect(JSON.stringify(input.messages)).not.toContain("Parent context only");
      expect(JSON.stringify(input.messages)).not.toContain("Parent conversation only");
      const payload = JSON.parse(message.content);
      const approved = packages.find((entry) => entry.project === payload.package)!;
      expect(payload).toEqual({ task: request.prompt, package: approved.project, excerpts: [{
        path: approved.path, startLine: 1, endLine: 1, content: approved.content,
      }] });
      return fauxAssistantMessage(`Evidence from ${approved.path}:1.`);
    }));
    const progress: CodingTaskProgress[] = [];
    const receipt = await runCodingSession(options, {
      ...dependencies,
      taskProgress: (update) => { if (update) progress.push(update); },
    });
    for (const kind of ["package-review", "package-work", "model"] as const)
      expect(progress.some(({ stages }) => stages.some((stage) => stage.kind === kind))).toBe(true);
    expect(progress.at(-1)).toEqual({ stages: [] });
    expect(JSON.stringify(progress)).not.toMatch(/left|right|review-1|checkpoint|taskId|conversationId/i);
    expect(receipt).toMatchObject({ status: "done", packageReviews: [
      { project: "left", requestId: "review-1-package-1", summary: "Evidence from left/source.ts:1." },
      { project: "right", requestId: "review-1-package-2", summary: "Evidence from right/source.ts:1." },
    ] });
    expect(receipt.packageReviews?.[0]?.conversationId).not.toBe(receipt.packageReviews?.[1]?.conversationId);
    if (receipt.status !== "done") throw new Error(receipt.reason);
    expect(receipt.usage.totalTokens).toBe(receipt.packageReviews?.reduce((sum, child) => sum + (child.usage?.totalTokens ?? 0), 0) ?? 0);
    expect(await runCodingSession(options, dependencies)).toEqual(receipt);
    const settled = await getCodingSessionStatus({ ...options, includeReceipt: true }, dependencies);
    expect(settled.pendingRequestIds).toEqual([]);
    expect(settled.request?.receipt).toEqual(receipt);
    expect((await listStandaloneCodingRequests(options.session, dependencies)).requests[0]).toMatchObject({
      requestId: options.requestId, kind: "package-review", status: "done",
    });
    if (parent.status !== "done") throw new Error(parent.reason);
    const modelKey = `${options.provider}/${options.model}`;
    expect(settled.rootUsage.models[modelKey]?.totalTokens).toBe(parent.usage.totalTokens);
    expect(settled.usage.models[modelKey]?.totalTokens).toBe(parent.usage.totalTokens + receipt.usage.totalTokens);
    expect(faux.state.callCount).toBe(3);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 15_000);

test("can withdraw an admitted package review before any model work is resumed", async () => {
  const { root, workspace, packages, faux, dependencies, options } = await fixture();
  try {
    const preview = await previewPackageReviews(workspace, packages);
    expect(await previewPackageReviews(workspace, [{ project: "left", query: "leftEvidence" }, { project: "left/nested", query: "evidence" }])
      .catch((error: Error) => error.message)).toContain("without overlap");
    const request = { ...options, prompt: "Review", packageReviews: { packages, id: preview.id } };
    await expect(runCodingSession(request, { ...dependencies, admitted: () => { throw new Error("stop before scheduling"); } }))
      .rejects.toThrow("Could not open Pi Durable session");
    const receipt = await cancelCodingRequest(options, dependencies);
    expect(receipt).toMatchObject({ status: "unanswered", reason: "Package review cancelled." });
    expect(await runCodingSession(options, dependencies)).toEqual(receipt);
    expect((await getCodingSessionStatus(options, dependencies)).pendingRequestIds).toEqual([]);
    expect(faux.state.callCount).toBe(0);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 15_000);

test("coding API requires project access and explicit approval for each package selection", async () => {
  const { root, workspace, packages, faux, dependencies, options } = await fixture();
  const token = "local-package-test";
  const server = createApiServer({ bundle: workspace, port: 0, token, coding: dependencies });
  try {
    const request = (path: string, data: unknown) => fetch(new URL(`api/coding${path}`, server.url), {
      method: "POST", headers: { "content-type": "application/json", "x-okb-token": token }, body: JSON.stringify(data),
    });
    async function api<T>(path: string, data: unknown): Promise<T> {
      const response = await request(path, data);
      const payload = await response.json() as { result: T; error?: string };
      if (!response.ok) throw new Error(payload.error ?? String(response.status));
      return payload.result;
    }
    const settings = { title: "Package review", workspace, provider: options.provider, model: options.model };
    const limited = await api<{ id: string }>("/projects", { ...settings, scopes: ["left"] });
    const both = await api<{ id: string }>("/projects", { ...settings, scopes: ["left", "right"] });
    const source = { source: "packages", packages };
    expect((await request(`/projects/${limited.id}/preview`, source)).status).toBe(403);
    const prefix = `/projects/${both.id}`;
    const preview = await api<Awaited<ReturnType<typeof previewPackageReviews>>>(`${prefix}/preview`, source);
    const identity = { session: "main", requestId: "package-api" };
    const run = { ...source, ...identity, previewId: preview.id, prompt: "Review both packages" };
    expect((await request(`${prefix}/run`, run)).status).toBe(400);
    expect(faux.state.callCount).toBe(0);
    faux.setResponses([fauxAssistantMessage("First package summary."), fauxAssistantMessage("Second package summary.")]);
    await api(`${prefix}/run`, { ...run, approved: true });
    const deadline = Date.now() + 4_000;
    for (;;) {
      const result = await api<{ run: { status: string }; pi?: { request?: { receipt?: CodingSessionResult } } }>(`${prefix}/inspect`, identity);
      if (result.run.status !== "running" || Date.now() > deadline) {
        expect(result.run.status).toBe("done");
        expect(result.pi?.request?.receipt?.packageReviews?.map(({ project }) => project)).toEqual(["left", "right"]);
        break;
      }
      await Bun.sleep(20);
    }
    expect(await api(`${prefix}/review`, { ...identity, decision: "accepted" })).toMatchObject({ review: "accepted" });
  } finally {
    await server.stop();
    await rm(root, { force: true, recursive: true });
  }
}, 15_000);

test("recovers separate Pi child conversations after a process exits during generation", async () => {
  const { root, workspace, packages, faux, dependencies, options } = await fixture();
  try {
    const preview = await previewPackageReviews(workspace, packages);
    const request = { ...options, prompt: "Review after a restart", packageReviews: { packages, id: preview.id } };
    const script = `
      import { createModels, fauxProvider } from "@earendil-works/pi-ai";
      import { runCodingSession } from "./src/core/coding/durable.ts";
      const { options, stateDir } = JSON.parse(process.argv.at(-1));
      const models = createModels();
      const faux = fauxProvider({ provider: options.provider, models: [{ id: options.model }] });
      models.setProvider(faux.provider);
      faux.setResponses(Array.from({ length: 2 }, () => (input) => {
        const message = input.messages.findLast(({ role }) => role === "user");
        console.log(JSON.parse(message.content).package);
        return new Promise(() => {});
      }));
      const keepAlive = setInterval(() => {}, 1000);
      try { await runCodingSession(options, { models, stateDir }); }
      finally { clearInterval(keepAlive); }
    `;
    const child = Bun.spawn([process.execPath, "-e", script, "--", JSON.stringify({ options: request, stateDir: dependencies.stateDir })], {
      cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "inherit",
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 8_000);
    const reader = child.stdout.getReader();
    try {
      const decoder = new TextDecoder();
      let output = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        output += decoder.decode(value, { stream: true });
        if (output.includes("left\n") && output.includes("right\n")) break;
      }
      expect(output.trim().split("\n").sort()).toEqual(["left", "right"]);
    } finally {
      clearTimeout(timeout);
      reader.releaseLock();
      child.kill("SIGKILL");
      await child.exited;
    }
    expect((await getCodingSessionStatus(options, dependencies)).pendingRequestIds).toEqual([options.requestId]);
    for (const entry of packages) await rm(join(workspace, entry.path));
    faux.setResponses(Array.from({ length: 2 }, () => (input) => {
      const message = input.messages.findLast(({ role }) => role === "user");
      if (message?.role !== "user" || typeof message.content !== "string") throw new Error("No package input");
      const payload = JSON.parse(message.content);
      const approved = packages.find(({ project }) => project === payload.package);
      expect(payload.excerpts[0]?.content).toBe(approved?.content);
      return fauxAssistantMessage(`${payload.package} resumed.`);
    }));
    const recovered = await runCodingSession(options, dependencies);
    expect(recovered.status).toBe("done");
    expect(recovered.packageReviews?.map(({ summary }) => summary)).toEqual(["left resumed.", "right resumed."]);
    expect(await runCodingSession(options, dependencies)).toEqual(recovered);
    expect(faux.state.callCount).toBe(2);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 15_000);
