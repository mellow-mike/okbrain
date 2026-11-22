import { expect, test } from "bun:test";
import { createAssistantMessageEventStream, createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApiServer, type ApiServer } from "../src/api.ts";
import { approvedSourceToolName } from "../src/core/coding/approved-source-tool.ts";
import { listCodingModels, maxLiveAnswerLength, runCodingSession, type CodingLiveAnswer, type CodingSessionStatusResult, type SavedCodingRequestInput } from "../src/core/coding/durable.ts";
import type { CodingTaskProgress } from "../src/core/coding/task-progress.ts";

const ownerToken = "local-operator-test";
type Project = { id: string; workspace: string; credential: string };
type Run = { id: string; status: string; actor: string; admitted: boolean; error: string | null; review: string | null };
type Inspection = { run: Run; liveAnswer?: CodingLiveAnswer; taskProgress?: CodingTaskProgress; pi?: { request?: { receipt?: { text?: string } } } };

async function fixture(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const workspace = join(root, "work");
  const stateDir = join(root, "data");
  await mkdir(join(workspace, "src"), { recursive: true });
  await mkdir(join(workspace, "private"), { recursive: true });
  await writeFile(join(workspace, "src", "example.ts"), "export const answer = 42;\n");
  await writeFile(join(workspace, "src", ".env"), "secret=never-share\n");
  await writeFile(join(workspace, "private", "example.ts"), "private text\n");
  return { root, workspace, stateDir };
}

async function waitFor<T>(poll: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 4000;
  for (;;) {
    const value = await poll();
    if (predicate(value) || Date.now() > deadline) return value;
    await Bun.sleep(20);
  }
}

function apiClient(base: string) {
  const request = (path: string, data?: unknown, token: string | null = ownerToken) => fetch(
    new URL("api/coding" + path, base),
    {
      method: data === undefined ? "GET" : "POST",
      headers: {
        ...(data === undefined ? {} : { "content-type": "application/json" }),
        ...(token === ownerToken ? { "x-okb-token": token } : token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    },
  );
  const call = async <T>(path: string, data?: unknown, token?: string) => {
    const response = await request(path, data, token);
    const body = await response.json() as { error?: string; result: T };
    if (!response.ok) throw new Error(body.error ?? String(response.status));
    return body.result;
  };
  return { request, call };
}

test("local coding opens existing standalone Pi receipts and admits app requests only after a fresh source approval", async () => {
  const { root, workspace, stateDir } = await fixture("okb-standalone-app-");
  const models = createModels();
  const faux = fauxProvider({ provider: "openai", models: [{ id: "standalone-test" }] });
  models.setProvider(faux.provider);
  const identity = { session: "standalone", workspace, provider: "openai", model: "standalone-test" };
  faux.setResponses([() => fauxAssistantMessage("Existing standalone answer.")]);
  await runCodingSession({ ...identity, requestId: "cli-original", prompt: "Original task.", files: ["src/example.ts"] }, { stateDir, models });
  const api = createApiServer({
    bundle: workspace, port: 0, token: ownerToken, standaloneCoding: { stateDir, models }, coding: { models, stateDir: join(root, "projects") },
  });
  const readonly = createApiServer({ bundle: workspace, readonly: true, port: 0, token: ownerToken, standaloneCoding: { stateDir, models } });
  type View = {
    identity?: Pick<typeof identity, "session" | "workspace" | "provider" | "model">;
    requests: { requestId: string; status: string }[];
    pi?: CodingSessionStatusResult;
    active?: { status: string; cancelled?: boolean; error?: string };
  };
  try {
    const { call, request } = apiClient(api.url);
    expect((await request("/standalone", undefined, null)).status).toBe(401);
    const dashboard = await request("/standalone");
    expect(dashboard.headers.get("cache-control")).toBe("no-store");
    expect(await dashboard.json()).toMatchObject({
      result: { sessions: [{ ...identity, workspace: expect.any(String), state: "ready" }] },
    });
    const bearer = await fetch(new URL("api/coding/standalone", api.url), {
      headers: { authorization: "Bearer " + ownerToken },
    });
    expect(bearer.status).toBe(403);
    const project = await call<Project>("/projects", { workspace, title: "Separate team space", provider: "openai", model: "standalone-test" });
    const member = await call<{ token: string }>("/projects/" + project.id + "/members", { name: "reviewer" });
    expect((await request("/standalone", undefined, member.token)).status).toBe(403);
    const erase = { session: identity.session, confirm: identity.session };
    expect((await request("/standalone/delete-session", erase, member.token)).status).toBe(403);
    expect((await apiClient(readonly.url).request("/standalone/delete-session", erase)).status).toBe(403);
    expect((await request("/standalone/delete-session", { session: identity.session, confirm: "another-session" })).status).toBe(400);
    expect((await request("/standalone/inspect", { session: "../projects" })).status).toBe(400);
    const first = await call<View>("/standalone/inspect", { session: identity.session, requestId: "cli-original" });
    expect(first.requests).toEqual([expect.objectContaining({ requestId: "cli-original", status: "done" })]);
    expect(first.pi?.request?.receipt).toMatchObject({ text: "Existing standalone answer." });
    expect(faux.state.callCount).toBe(1);

    const source = { workspace, source: "files", files: ["src/example.ts"] };
    const preview = await call<{ id: string }>("/standalone/preview", source);
    const task = { ...source, ...identity, requestId: "app-follow-up", prompt: "Review the current fixture.", previewId: preview.id };
    expect((await request("/standalone/run", task)).status).toBe(400);
    expect((await apiClient(readonly.url).request("/standalone/run", { ...task, approved: true })).status).toBe(403);
    await writeFile(join(workspace, "src", "example.ts"), "export const answer = 99;\n");
    expect((await request("/standalone/run", { ...task, approved: true })).status).toBe(409);
    expect(faux.state.callCount).toBe(1);
    const revised = await call<{ id: string }>("/standalone/preview", source);
    const approved = { ...task, previewId: revised.id, approved: true };
    faux.setResponses([(prompt) => {
      expect(JSON.stringify(prompt.messages)).toContain("answer = 99");
      return fauxAssistantMessage("App follow-up answer.");
    }]);
    expect(await call("/standalone/run", approved)).toMatchObject({ requestId: task.requestId, status: "running" });
    const result = await waitFor(
      () => call<View>("/standalone/inspect", { session: identity.session, requestId: task.requestId }),
      (view) => view.pi?.request?.status === "done",
    );
    expect(result.pi?.request).toMatchObject({
      status: "done", receipt: { text: "App follow-up answer." },
      savedPrompt: task.prompt, savedSource: { source: "files", files: [{ path: "src/example.ts", content: "export const answer = 99;\n" }] },
    });
    expect(faux.state.callCount).toBe(2);
    expect((await request("/standalone/cancel", { session: identity.session, requestId: task.requestId })).status).toBe(409);
    await call("/standalone/run", { ...approved, prompt: "A different request cannot reuse this ID." });
    const duplicate = await waitFor(
      () => call<View>("/standalone/inspect", { session: identity.session, requestId: task.requestId }),
      (view) => view.active?.status === "failed",
    );
    expect(duplicate.active?.error).toContain("request ID is already saved");
    expect(faux.state.callCount).toBe(2);

    const modelStarted = Promise.withResolvers<void>();
    faux.setResponses([(_input, options) => new Promise((resolve) => {
      modelStarted.resolve();
      const interrupted = () => resolve(fauxAssistantMessage("", { stopReason: "aborted" }));
      if (options?.signal?.aborted) interrupted();
      else options?.signal?.addEventListener("abort", interrupted, { once: true });
    })]);
    const pending = { session: identity.session, requestId: "cancel-app-request" };
    await call("/standalone/run", { ...approved, ...pending });
    await modelStarted.promise;
    expect((await request("/standalone/delete-session", erase)).status).toBe(409);
    await call("/standalone/cancel", pending);
    const cancelled = await waitFor(
      () => call<View>("/standalone/inspect", pending),
      (view) => view.active?.cancelled === true && view.pi?.request?.status === "unanswered",
    );
    expect(cancelled.active).toMatchObject({ status: "unanswered", cancelled: true });
    expect(cancelled.pi?.pendingRequestIds).toEqual([]);
    expect(await call<{ session: string; deleted: boolean }>("/standalone/delete-session", erase)).toEqual({ session: identity.session, deleted: true });
    expect(await call<{ sessions: unknown[] }>("/standalone")).toMatchObject({ sessions: [] });
    const erased = await request("/standalone/inspect", { session: identity.session, requestId: task.requestId });
    expect(erased.status).toBe(404);
    expect(await erased.text()).not.toContain("App follow-up answer.");
    expect((await request("/standalone/resume", { ...pending, approved: true })).status).toBe(404);
    expect(await call<{ session: string; deleted: boolean }>("/standalone/delete-session", erase)).toEqual({ session: identity.session, deleted: false });
    expect(await Bun.file(join(stateDir, `session-${identity.session}`, "transcript.sqlite")).exists()).toBe(false);
    expect(await Bun.file(join(stateDir, `session-${identity.session}`, "owner.sqlite")).exists()).toBe(true);
    expect(faux.state.callCount).toBe(3);
  } finally {
    await Promise.all([api.stop(), readonly.stop()]);
    await rm(root, { recursive: true, force: true });
  }
});

test("the local coding app resumes an interrupted standalone request after the workspace is removed", async () => {
  const { root, workspace, stateDir } = await fixture("okb-standalone-recovery-");
  const models = createModels();
  const faux = fauxProvider({ provider: "openai", models: [{ id: "standalone-replay" }] });
  models.setProvider(faux.provider);
  const identity = { session: "legacy", requestId: "interrupted" };
  const options = { ...identity, workspace, provider: "openai", model: "standalone-replay", prompt: "Read the saved fixture.", files: ["src/example.ts"] };
  const script = `
    import { createModels, fauxProvider } from "@earendil-works/pi-ai";
    import { runCodingSession } from "./src/core/coding/durable.ts";
    const { options, stateDir } = JSON.parse(process.argv.at(-1));
    const models = createModels();
    const faux = fauxProvider({ provider: options.provider, models: [{ id: options.model }] });
    models.setProvider(faux.provider);
    faux.setResponses([() => {
      console.log("generation-started");
      return new Promise(() => {});
    }]);
    const keepAlive = setInterval(() => {}, 1000);
    try { await runCodingSession(options, { stateDir, models }); }
    finally { clearInterval(keepAlive); }
  `;
  const child = Bun.spawn([process.execPath, "-e", script, "--", JSON.stringify({ options, stateDir })], {
    cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "inherit",
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
  const api = createApiServer({ bundle: root, port: 0, token: ownerToken, standaloneCoding: { stateDir, models } });
  try {
    const reader = child.stdout.getReader();
    const marker = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(marker.value).trim()).toBe("generation-started");
    const { call, request } = apiClient(api.url);
    expect(await call("/standalone")).toMatchObject({ sessions: [{ session: "legacy", state: "busy" }] });
    expect(await call<{ state: "busy"; requests: unknown[] }>("/standalone/inspect", identity)).toEqual({ state: "busy", requests: [] });
    expect((await request("/standalone/delete-session", { session: identity.session, confirm: identity.session })).status).toBe(409);
    child.kill("SIGKILL");
    await child.exited;
    await rm(workspace, { recursive: true, force: true });
    type Inspection = { pi?: CodingSessionStatusResult };
    const inspect = () => call<Inspection>("/standalone/inspect", identity);
    expect(await inspect()).toMatchObject({
      requests: [{ requestId: identity.requestId, status: "placed" }],
      pi: { pendingRequestIds: [identity.requestId], request: {
        savedPrompt: options.prompt, savedSource: { source: "files", files: [{ path: "src/example.ts", content: "export const answer = 42;\n" }] },
      } },
    });
    expect((await request("/standalone/resume", identity)).status).toBe(400);
    expect(faux.state.callCount).toBe(0);
    faux.setResponses([(input) => {
      expect(JSON.stringify(input.messages)).toContain("answer = 42");
      return fauxAssistantMessage("Recovered the standalone request.");
    }]);
    expect(await call("/standalone/resume", { ...identity, approved: true })).toMatchObject({ status: "running" });
    const settled = await waitFor(inspect, (view) => view.pi?.request?.status === "done");
    expect(settled.pi?.request?.receipt).toMatchObject({ text: "Recovered the standalone request." });
    expect(faux.state.callCount).toBe(1);
  } finally {
    clearTimeout(timeout);
    child.kill("SIGKILL");
    await child.exited;
    await api.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

test("browser and IDE share approved, project-scoped Pi runs and authenticated review", async () => {
  const { root, workspace, stateDir } = await fixture("okb-api-coding-");
  const models = createModels();
  const faux = fauxProvider({ provider: "openai", models: [{ id: "preview-test" }] });
  models.setProvider(faux.provider);
  const api = createApiServer({ bundle: workspace, port: 0, token: ownerToken, coding: { stateDir, models } });
  try {
    const { request, call } = apiClient(api.url);
    expect((await request("/projects", undefined, null)).status).toBe(401);
    expect((await request("/projects?token=" + ownerToken, undefined, null)).status).toBe(401);
    expect((await fetch(new URL("api/coding/projects", api.url), {
      headers: { origin: "https://unrelated.example", "x-okb-token": ownerToken },
    })).status).toBe(403);
    expect(await (await fetch(api.url)).text()).toContain('href="#coding"');
    expect((await fetch(new URL("gui/coding.js", api.url))).ok).toBe(true);

    const settings = { title: "Review workspace", workspace, scopes: ["src"], provider: "openai", model: "preview-test" };
    const project = await call<Project>("/projects", settings);
    const other = await call<Project>("/projects", { ...settings, title: "Other project" });
    const path = "/projects/" + project.id;
    const member = await call<{ id: string; token: string }>(path + "/members", { name: "reviewer" });
    const scoped = await call<Project[]>("/projects", undefined, member.token);
    expect(scoped).toHaveLength(1);
    expect(scoped[0]?.id).toBe(project.id);
    expect(scoped[0]).not.toHaveProperty("workspace");
    expect((await request("/projects/" + other.id + "/runs", undefined, member.token)).status).toBe(403);
    expect((await request(path + "/credential", { apiKey: "denied" }, member.token)).status).toBe(403);
    expect((await request(path + "/preview", { source: "files", files: ["src/.env"] }, member.token)).status).toBe(409);
    expect((await request(path + "/preview", { source: "files", files: ["private/example.ts"] }, member.token)).status).toBe(409);

    const source = { source: "files", files: ["src/example.ts"] };
    const before = await call<{ id: string; files: { path: string; content: string }[] }>(path + "/preview", source, member.token);
    expect(before.files).toEqual([{ path: "src/example.ts", content: "export const answer = 42;\n" }]);
    const identity = { session: "main", requestId: "review-1" };
    const task = { ...source, ...identity, prompt: "Review the scoped source" };
    expect((await request(path + "/run", { ...task, previewId: before.id }, member.token)).status).toBe(400);
    await writeFile(join(workspace, "src", "example.ts"), "export const answer = 43;\n");
    await call(path + "/run", { ...task, approved: true, previewId: before.id }, member.token);
    const inspect = () => call<Inspection>(path + "/inspect", identity, member.token);
    const failed = await waitFor(inspect, (value) => value.run.status === "failed");
    expect(failed.run).toMatchObject({ status: "failed", admitted: false, error: expect.stringContaining("selected files changed") });
    expect(await call(path + "/source-inspect", identity, member.token)).toBeNull();
    expect(faux.state.callCount).toBe(0);

    const after = await call<{ id: string }>(path + "/preview", source, member.token);
    const calls: string[] = [];
    faux.setResponses([(transcript) => {
      expect(getCurrentTools(transcript.messages)).toEqual([]);
      calls.push(JSON.stringify(transcript.messages));
      return fauxAssistantMessage("Keep this change for review.");
    }]);
    const approved = { ...task, approved: true, previewId: after.id };
    const run = await call<Run>(path + "/run", approved, member.token);
    expect(run).toMatchObject({ status: "running", actor: "human:reviewer" });
    const result = await waitFor(inspect, (value) => value.run.status === "done");
    expect(result).toMatchObject({
      run: { id: "review-1", status: "done", admitted: true },
      pi: {
        request: { receipt: { text: "Keep this change for review." } },
        usage: { models: { "openai/preview-test": { totalTokens: expect.any(Number) } } },
        rootUsage: { models: { "openai/preview-test": { totalTokens: expect.any(Number) } } },
      },
    });
    expect((await request("/projects/" + other.id + "/inspect", identity, member.token)).status).toBe(403);
    expect(calls[0]).toContain("answer = 43");
    expect(await call<Run>(path + "/run", approved, member.token)).toMatchObject({ status: "done" });
    expect((await request(path + "/run", { ...approved, prompt: "Different task" }, member.token)).status).toBe(409);
    await writeFile(join(workspace, "src", "example.ts"), "export const answer = 44;\n");
    expect(JSON.stringify(await inspect())).not.toContain("export const answer = 43;");
    const saved = await request(path + "/source-inspect", identity, member.token);
    expect(saved.headers.get("cache-control")).toBe("no-store");
    expect(await saved.json()).toEqual({ result: {
      prompt: task.prompt, groups: [{ files: [{ path: "src/example.ts", text: "export const answer = 43;\n" }] }],
    } });
    expect((await request(path + "/source-inspect", { ...identity, requestId: "missing" }, member.token)).status).toBe(404);
    expect((await request("/projects/" + other.id + "/source-inspect", identity, member.token)).status).toBe(403);
    expect((await request(path + "/source-inspect", identity, null)).status).toBe(401);
    expect(faux.state.callCount).toBe(1);
    expect(await call<Run>(path + "/review", { ...identity, decision: "accepted" }, member.token))
      .toMatchObject({ review: "accepted", reviewer: "human:reviewer" });
    const audit = await call<{ kind: string }[]>(path + "/audit");
    expect(audit.map((row) => row.kind)).toContain("admitted");
    expect(JSON.stringify(audit)).not.toContain(task.prompt);
    expect((await request(path + "/delete-session", { session: "main", confirm: "main" }, member.token)).status).toBe(403);
    expect(await call(path + "/delete-session", { session: "main", confirm: "main" })).toMatchObject({ deleted: true });
    expect(await call<Run[]>(path + "/runs")).toEqual([]);
    await call(path + "/members", { revoke: member.id });
    expect((await request(path + "/runs", undefined, member.token)).status).toBe(401);
  } finally {
    await api.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("source inspection reopens archived profile and package inputs from a read-only app", async () => {
  const { root, workspace, stateDir } = await fixture("okb-saved-coding-source-");
  const models = createModels();
  const faux = fauxProvider({ provider: "openai", models: [{ id: "saved-source-test" }] });
  models.setProvider(faux.provider);
  const open = (readonly: boolean) => createApiServer({ bundle: root, port: 0, token: ownerToken, readonly, coding: { stateDir, models } });
  let api = open(false);
  try {
    for (const args of [["init", "--quiet"], ["add", "--", "src/example.ts", "private/example.ts"]]) {
      const git = Bun.spawnSync(["git", ...args], { cwd: workspace, stdout: "ignore", stderr: "pipe" });
      if (git.exitCode !== 0) throw new Error(git.stderr.toString());
    }
    const { call } = apiClient(api.url);
    const project = await call<Project>("/projects", {
      workspace, title: "Saved source", scopes: ["src", "private"], provider: "openai", model: "saved-source-test",
    });
    const path = "/projects/" + project.id;
    const member = await call<{ token: string }>(path + "/members", { name: "saved-source-reviewer" });
    const guidance = "Cite the relevant source lines.";
    const repository = { source: "repository", query: "answer", profile: { version: 1, name: "Source", projects: ["src"], guidance } };
    const packages = { source: "packages", packages: [{ project: "src", query: "answer" }, { project: "private", query: "text" }] };
    type Excerpt = { path: string; content: string; startLine: number; endLine: number };
    const repositoryPreview = await call<{ manifest: { id: string }; excerpts: Excerpt[] }>(path + "/preview", repository);
    const packagePreview = await call<{ id: string; packages: { project: string; excerpts: Excerpt[] }[] }>(path + "/preview", packages);
    const repositoryRequest = { session: "profile", requestId: "profile-request" };
    const packageRequest = { session: "packages", requestId: "package-request" };
    faux.setResponses(["Profile review", "First package", "Second package"].map((answer) => fauxAssistantMessage(answer)));
    await call(path + "/run", { ...repository, ...repositoryRequest, prompt: "Review the profile.", approved: true, previewId: repositoryPreview.manifest.id });
    expect(await waitFor(() => call<Inspection>(path + "/inspect", repositoryRequest), ({ run }) => run.status !== "running"))
      .toMatchObject({ run: { status: "done", admitted: true } });
    await call(path + "/run", { ...packages, ...packageRequest, prompt: "Review both packages.", approved: true, previewId: packagePreview.id });
    expect(await waitFor(() => call<Inspection>(path + "/inspect", packageRequest), ({ run }) => run.status !== "running"))
      .toMatchObject({ run: { status: "done", admitted: true } });
    const beforeAudit = await call<unknown[]>(path + "/audit");
    await api.stop();
    await rm(workspace, { recursive: true });
    api = open(true);
    const readonly = apiClient(api.url);
    const savedFiles = (excerpts: Excerpt[]) => excerpts.map(({ content, ...source }) => ({ ...source, text: content }));
    expect(await readonly.call<SavedCodingRequestInput>(path + "/source-inspect", repositoryRequest)).toEqual({
      prompt: "Review the profile.", guidance, groups: [{ files: savedFiles(repositoryPreview.excerpts) }],
    });
    expect(await readonly.call<SavedCodingRequestInput>(path + "/source-inspect", packageRequest, member.token)).toEqual({
      prompt: "Review both packages.", groups: packagePreview.packages.map(({ project, excerpts }) => ({ label: project, files: savedFiles(excerpts) })),
    });
    expect(await readonly.call<unknown[]>(path + "/audit")).toEqual(beforeAudit);
    expect(faux.state.callCount).toBe(3);
  } finally {
    await api.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("the production worker rejects a stale approval across a real child process", async () => {
  const { root, workspace, stateDir } = await fixture("okb-project-worker-");
  const api = createApiServer({ bundle: workspace, port: 0, token: ownerToken, coding: { stateDir } });
  try {
    const { call } = apiClient(api.url);
    const model = listCodingModels().find((catalog) => catalog.provider === "openai")?.models[0]?.id;
    expect(model).toBeDefined();
    const project = await call<Project>("/projects", {
      workspace, title: "Worker smoke test", scopes: ["src"], provider: "openai", model, apiKey: "no-provider-call-is-expected",
    });
    const path = "/projects/" + project.id;
    const source = { source: "files", files: ["src/example.ts"] };
    const preview = await call<{ id: string }>(path + "/preview", source);
    await writeFile(join(workspace, "src", "example.ts"), "export const answer = 'changed';");
    const identity = { session: "main", requestId: "worker-stale" };
    await call(path + "/run", { ...source, ...identity, approved: true, previewId: preview.id, prompt: "Inspect this change." });
    const result = await waitFor(
      () => call<Inspection>(path + "/inspect", identity),
      (value) => value.run.status !== "running",
    );
    expect(result.run).toMatchObject({ status: "failed", admitted: false, error: expect.stringContaining("selected files changed") });
  } finally {
    await api.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("an accepted Pi diff edits and adds exact files, publishes a GitHub branch, and recovers a lost ref response", async () => {
  const { root, workspace, stateDir } = await fixture("okb-github-branch-");
  const models = createModels();
  const model = "branch-fixture";
  const faux = fauxProvider({ provider: "openai", models: [{ id: model }] });
  models.setProvider(faux.provider);
  const repo = "/repos/example-org/changes";
  const path = join(workspace, "app.ts");
  const addedPath = join(workspace, "added.test.ts");
  const before = "export const count = 1;\n";
  const after = "export const count = 2;\n";
  const added = "export const checks = 1;\n";
  const diff = `diff --git a/app.ts b/app.ts\n--- a/app.ts\n+++ b/app.ts\n@@ -1 +1 @@\n-${before}+${after}` +
    `diff --git a/added.test.ts b/added.test.ts\nnew file mode 100644\n--- /dev/null\n+++ b/added.test.ts\n@@ -0,0 +1 @@\n+${added}`;
  faux.setResponses([fauxAssistantMessage("Review the change and its test.\n\n```diff\n" + diff + "```\n")]);
  const oid = (byte: string) => byte.repeat(40);
  const blob = (text: string) => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex");
  const treeItem = (path: string, sha: string) => ({ path, mode: "100644", type: "blob", sha });
  const nextEntries = [treeItem("app.ts", blob(after)), treeItem("added.test.ts", blob(added))];
  const parent = oid("1");
  const baseTree = oid("2");
  const nextTree = oid("3");
  const commitSha = oid("4");
  const occupiedTree = oid("5");
  const occupiedBase = oid("6");
  const refs = new Map([["main", parent]]);
  const writes: { route: string; body: Record<string, unknown> }[] = [];
  const token = "github_pat_" + "contents_fixture_".repeat(4);
  const readToken = "github_pat_" + "activity_fixture_".repeat(4);
  let loseResponse = true;
  const githubFetch = async (url: URL, options: RequestInit) => {
    expect(url.origin).toBe("https://api.github.com");
    expect(options.redirect).toBe("error");
    expect(new Headers(options.headers).get("authorization")).toBe("Bearer " + token);
    const route = decodeURIComponent(url.pathname.slice(repo.length));
    expect(url.pathname.startsWith(repo + "/git/")).toBe(true);
    if (options.method === "GET") {
      if (route.startsWith("/git/ref/heads/")) {
        const name = route.slice("/git/ref/heads/".length);
        return refs.has(name) ? Response.json({ ref: "refs/heads/" + name, object: { type: "commit", sha: refs.get(name) } })
          : Response.json({}, { status: 404 });
      }
      if (route === `/git/commits/${refs.get("main")}`)
        return Response.json({ sha: refs.get("main"), tree: { sha: refs.get("main") === occupiedBase ? occupiedTree : baseTree } });
      if (route === `/git/trees/${baseTree}` || route === `/git/trees/${occupiedTree}`) {
        const sha = route.slice("/git/trees/".length);
        return Response.json({ sha, truncated: false, tree: [treeItem("app.ts", blob(before)),
          ...(sha === occupiedTree ? [treeItem("added.test.ts", blob(added))] : [])] });
      }
      if (route === `/git/trees/${nextTree}`)
        return Response.json({ sha: nextTree, truncated: false, tree: nextEntries });
      if (route === `/git/blobs/${blob(before)}`)
        return Response.json({ sha: blob(before), encoding: "base64", content: Buffer.from(before).toString("base64"), size: Buffer.byteLength(before) });
    }
    expect(options.method).toBe("POST");
    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    writes.push({ route, body });
    if (route === "/git/blobs") {
      const submitted = Buffer.from(body.content as string, "base64").toString("utf8");
      expect([after, added]).toContain(submitted);
      return Response.json({ sha: blob(submitted) }, { status: 201 });
    }
    if (route === "/git/trees")
      return Response.json({ sha: nextTree, truncated: false, tree: nextEntries }, { status: 201 });
    if (route === "/git/commits")
      return Response.json({ sha: commitSha, message: body.message, tree: { sha: nextTree }, parents: [{ sha: parent }] }, { status: 201 });
    if (route === "/git/refs") {
      const name = (body.ref as string).slice("refs/heads/".length);
      expect(refs.has(name)).toBe(false);
      refs.set(name, body.sha as string);
      if (loseResponse) {
        loseResponse = false;
        throw new Error("fixture lost the create-ref response");
      }
      return Response.json({ ref: body.ref, object: { type: "commit", sha: body.sha } }, { status: 201 });
    }
    throw new Error(`Unexpected fixture GitHub operation ${route}`);
  };
  const createServer = (readonly = false) =>
    createApiServer({ bundle: workspace, port: 0, token: ownerToken, readonly, coding: { stateDir, models, githubFetch } });
  let api: ApiServer | undefined;
  try {
    await writeFile(path, before);
    for (const args of [["init", "-q"], ["add", "--", "app.ts"], ["remote", "add", "origin", "git@github.com:Example-Org/Changes.git"]]) {
      const git = Bun.spawnSync(["git", ...args], { cwd: workspace });
      expect(git.exitCode).toBe(0);
    }
    api = createServer();
    const { call, request } = apiClient(api.url);
    const project = await call<Project>("/projects", { title: "Branch fixture", workspace, provider: "openai", model });
    const prefix = "/projects/" + project.id;
    const member = await call<{ token: string }>(prefix + "/members", { name: "not-the-owner" });
    await call(prefix + "/github-connect", { remote: "origin", repository: "example-org/changes", token: readToken });
    expect((await request(prefix + "/github-branch-credential", { token }, member.token)).status).toBe(403);
    expect((await request(prefix + "/github-branch-credential", { token: readToken })).status).toBe(400);
    expect(await call(prefix + "/github-branch-credential", { token })).toMatchObject({ connection: { hasContentsToken: true } });
    expect(JSON.stringify(await call(prefix + "/github-status"))).not.toContain(token);
    expect((await request(prefix + "/github-pr-credential", { token })).status).toBe(400);

    const selected = { source: "files", files: ["app.ts"] };
    const source = await call<{ id: string }>(prefix + "/preview", selected);
    const id = { session: "main", requestId: "branch-request" };
    await call(prefix + "/run", { ...id, ...selected, approved: true, previewId: source.id, prompt: "Review app.ts." });
    expect(await waitFor(() => call<Inspection>(prefix + "/inspect", id), ({ run }) => run.status === "done"))
      .toMatchObject({ run: { status: "done" } });
    const draft = { ...id, base: "main", head: "okbrain/reviewed-patch", message: "Update count from the reviewed patch" };
    const branchPreview = prefix + "/github-branch-preview";
    const branchPublish = prefix + "/github-branch-publish";
    expect((await request(branchPreview, draft, member.token)).status).toBe(403);
    expect((await request(branchPreview, draft)).status).toBe(409);
    expect((await request(prefix + "/patch-proposals", id)).status).toBe(409);
    await call(prefix + "/review", { ...id, decision: "accepted" });
    expect((await request(prefix + "/patch-proposals", id, member.token)).status).toBe(403);
    const proposals = await call<{ proposals: { diff: string; paths: string[] }[] }>(prefix + "/patch-proposals", id);
    expect(proposals).toEqual({ proposals: [{ diff, paths: ["app.ts", "added.test.ts"] }] });
    expect(await Bun.file(path).text()).toBe(before);
    expect(await Bun.file(addedPath).exists()).toBe(false);
    expect(faux.state.callCount).toBe(1);
    expect((await request(branchPreview, draft)).status).toBe(409);
    const patch = await call<{ id: string; files: unknown[] }>(prefix + "/patch-preview", { ...id, diff });
    expect(patch.files).toMatchObject([{ path: "app.ts" }, { path: "added.test.ts", before: null }]);
    await call(prefix + "/patch-apply", { ...id, diff, approved: true, previewId: patch.id });
    expect(await Bun.file(path).text()).toBe(after);
    expect(await Bun.file(addedPath).text()).toBe(added);
    expect(Bun.spawnSync(["git", "ls-files"], { cwd: workspace }).stdout.toString()).toBe("app.ts\n");

    refs.set(draft.head, oid("9"));
    expect((await request(branchPreview, draft)).status).toBe(409);
    refs.delete(draft.head);
    refs.set("main", occupiedBase);
    expect((await request(branchPreview, draft)).status).toBe(409);
    refs.set("main", parent);
    const preview = await call<{ approval: string }>(branchPreview, draft);
    expect(preview).toMatchObject({ baseSha: parent, message: draft.message,
      files: [{ path: "app.ts", content: after }, { path: "added.test.ts", before: null, content: added }] });
    const approved = { ...draft, approval: preview.approval, approved: true };
    expect((await request(branchPublish, { ...approved, approved: false })).status).toBe(409);
    await writeFile(path, "export const count = 99;\n");
    expect((await request(branchPublish, approved)).status).toBe(409);
    await writeFile(path, after);
    await writeFile(addedPath, "export const checks = 99;\n");
    expect((await request(branchPublish, approved)).status).toBe(409);
    await writeFile(addedPath, added);
    refs.set("main", oid("8"));
    expect((await request(branchPublish, approved)).status).toBe(409);
    refs.set("main", parent);
    expect(writes).toHaveLength(0);

    const lost = await request(branchPublish, approved);
    expect(lost.status).toBe(502);
    expect(writes).toEqual([
      { route: "/git/blobs", body: { encoding: "base64", content: Buffer.from(after).toString("base64") } },
      { route: "/git/blobs", body: { encoding: "base64", content: Buffer.from(added).toString("base64") } },
      { route: "/git/trees", body: { base_tree: baseTree, tree: nextEntries } },
      { route: "/git/commits", body: { message: draft.message, tree: nextTree, parents: [parent] } },
      { route: "/git/refs", body: { ref: "refs/heads/" + draft.head, sha: commitSha } },
    ]);
    expect(await call(prefix + "/github-branch-inspect", id)).toMatchObject({ receipt: null, approval: preview.approval });
    await api.stop();
    api = createServer(true);
    expect((await apiClient(api.url).request(branchPublish, approved)).status).toBe(403);
    expect((await apiClient(api.url).request(prefix + "/patch-proposals", id)).status).toBe(403);
    await api.stop();
    api = createServer();
    await writeFile(path, "Current worktree content must never be sent on recovery.\n");
    const recovered = apiClient(api.url);
    const receipt = await recovered.call<{ receipt: { commitSha: string; head: string; base: string; url: string } }>(
      prefix + "/github-branch-recover", id,
    );
    expect(receipt).toMatchObject({ receipt: { commitSha, head: draft.head, base: draft.base,
      url: "https://github.com/example-org/changes/tree/okbrain%2Freviewed-patch" } });
    expect(await recovered.call<typeof receipt>(branchPublish, approved)).toEqual(receipt);
    expect(writes).toHaveLength(5);
    expect(faux.state.callCount).toBe(1);
    const audit = await recovered.call<{ kind: string }[]>(prefix + "/audit");
    expect(audit.map(({ kind }) => kind)).toContain("github_branch_recovered");
    expect(JSON.stringify(audit)).not.toContain(draft.message);
  } finally {
    await api?.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

test("GitHub reads stay on the bound project and comparison requires an accepted request", async () => {
  const { root, workspace, stateDir } = await fixture("okb-github-project-");
  const fineGrained = "github_pat_" + "fake".repeat(14);
  const models = createModels();
  const faux = fauxProvider({ provider: "openai", models: [{ id: "repo-test" }] });
  models.setProvider(faux.provider);
  const seen: { path: string; method?: string; authorization: string | null }[] = [];
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: workspace, stdout: "ignore", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  };
  const repo = "/repos/example-org/product";
  git("init", "-q");
  git("remote", "add", "origin", "git@github.com:Example-Org/Product.git");
  git("remote", "add", "unrelated", "https://example.com/acme/product.git");
  git("remote", "add", "embedded", "https://secret@github.com/example-org/product.git");
  const api = createApiServer({ bundle: workspace, port: 0, token: ownerToken, coding: {
    stateDir, models,
    githubFetch: async (url, options) => {
      expect(url.origin).toBe("https://api.github.com");
      expect(options.redirect).toBe("error");
      seen.push({ path: url.pathname, method: options.method, authorization: new Headers(options.headers).get("authorization") });
      switch (url.pathname) {
        case repo:
          return Response.json({ full_name: "Example-Org/Product", default_branch: "main" });
        case repo + "/issues":
          return Response.json([
            { number: 1, title: "Review settings", html_url: "https://example.com/other", body: "Do not send issue body" },
            { number: 2, title: "This entry is a pull request", pull_request: {} },
          ]);
        case repo + "/pulls":
          return Response.json([{ number: 2, title: "Update settings", draft: true }]);
      }
      return new Response(null, { status: 404 });
    },
  } });
  try {
    const { request, call } = apiClient(api.url);
    const projectFields = { workspace, title: "Connected workspace", scopes: ["src"], provider: "openai", model: "repo-test" };
    const project = await call<Project>("/projects", projectFields);
    const other = await call<Project>("/projects", { ...projectFields, title: "Other workspace" });
    const prefix = "/projects/" + project.id;
    const member = await call<{ token: string }>(prefix + "/members", { name: "reviewer" });
    const endpoint = prefix + "/github-";
    const target = { remote: "origin", repository: "example-org/product" };
    expect(await call(endpoint + "status")).toMatchObject({ canConfigure: true, connection: null });
    expect(await call<{ remote: string; repository: string }[]>(endpoint + "remotes")).toEqual([target]);
    expect((await request(endpoint + "remotes", undefined, member.token)).status).toBe(403);
    expect((await request(endpoint + "connect", { ...target, repository: "example-org/other", token: fineGrained })).status).toBe(409);
    expect((await request(endpoint + "connect", { ...target, token: fineGrained }, member.token)).status).toBe(403);
    expect(await call(endpoint + "connect", { ...target, token: fineGrained })).toMatchObject({
      connection: { ...target, hasToken: true },
    });
    expect(seen).toEqual([]);
    const scoped = await call(endpoint + "status", undefined, member.token);
    expect(scoped).toMatchObject({ canConfigure: false, connection: { ...target, hasToken: true } });
    expect(JSON.stringify(scoped)).not.toContain(fineGrained);
    expect((await request("/projects/" + other.id + "/github-activity", undefined, member.token)).status).toBe(403);
    expect((await request(endpoint + "activity", { repository: "example-org/other" })).status).toBe(404);
    const activity = await call(endpoint + "activity", undefined, member.token);
    expect(activity).toMatchObject({
      defaultBranch: "main",
      issues: [{ number: 1, url: "https://github.com/example-org/product/issues/1" }],
      pulls: [{ number: 2, url: "https://github.com/example-org/product/pull/2", draft: true }],
    });
    expect(JSON.stringify(activity)).not.toContain("Do not send issue body");
    expect(seen.map((entry) => entry.path).sort()).toEqual([repo, repo + "/issues", repo + "/pulls"]);
    for (const result of seen) expect(result).toMatchObject({ method: "GET", authorization: "Bearer " + fineGrained });

    const inputs = { source: "files", files: ["src/example.ts"] };
    const source = await call<{ id: string }>(prefix + "/preview", inputs);
    const identity = { session: "main", requestId: "github-review" };
    faux.setResponses([fauxAssistantMessage("A reviewable response.")]);
    await call(prefix + "/run", { ...inputs, ...identity, previewId: source.id, approved: true, prompt: "Review this example." });
    await waitFor(() => call<Inspection>(prefix + "/inspect", identity), ({ run }) => run.status === "done");
    const branches = { ...identity, base: "main", head: "feature/settings" };
    expect((await request(endpoint + "handoff", branches)).status).toBe(409);
    await call(prefix + "/review", { ...identity, decision: "accepted" });
    expect((await request(endpoint + "handoff", { ...branches, head: "../settings" })).status).toBe(400);
    expect(await call(endpoint + "handoff", branches)).toMatchObject({
      url: "https://github.com/example-org/product/compare/main...feature%2Fsettings?expand=1",
      requestId: identity.requestId,
    });
    expect(await call(prefix + "/audit")).toContainEqual(expect.objectContaining({
      kind: "github_handoff", request_id: identity.requestId, session: "main",
    }));
    git("remote", "set-url", "origin", "https://github.com/example-org/changed.git");
    expect((await request(endpoint + "activity")).status).toBe(409);
    expect((await request(endpoint + "handoff", branches)).status).toBe(409);
    expect(seen).toHaveLength(3);
    expect(await call(endpoint + "disconnect", {})).toMatchObject({ connection: null });
  } finally {
    await api.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("publishes only an owner-approved GitHub PR and reconciles a lost receipt after restart", async () => {
  const { root, workspace, stateDir } = await fixture("okb-coding-github-publish-");
  const repository = "example-org/product";
  const readToken = "github_pat_exampleActivityToken0000001";
  const publishToken = "github_pat_examplePublishingToken0001";
  const models = createModels();
  const faux = fauxProvider({ provider: "openai", models: [{ id: "publish-fixture" }] });
  models.setProvider(faux.provider);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: workspace, stdout: "ignore", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  };
  type Payload = { base: string; head: string; title: string; body: string; draft: boolean };
  type Publication = { approval: string; receipt: { number: number; id: number; draft: boolean; url: string; apiRequestId: string } | null };
  type Row = Omit<Payload, "base" | "head"> & {
    base: { ref: string; repo: { full_name: string } }; head: Row["base"]; number: number; id: number; state: string;
  };
  const pulls: Row[] = [];
  const requests: { method: string; authorization: string | null; payload?: Payload }[] = [];
  const open = () => createApiServer({ bundle: workspace, port: 0, token: ownerToken, coding: {
    stateDir, models, async githubFetch(url, options) {
      expect(url.origin).toBe("https://api.github.com");
      expect(url.pathname).toBe(`/repos/${repository}/pulls`);
      expect(options.redirect).toBe("error");
      const authorization = new Headers(options.headers).get("authorization");
      const method = options.method!;
      expect(authorization).toBe("Bearer " + publishToken);
      const headers = { "x-github-request-id": "C0DE:123:ABC" };
      if (method === "GET") {
        requests.push({ method, authorization });
        expect(url.searchParams.get("state")).toBe("all");
        return Response.json(pulls.filter((row) => url.searchParams.get("head") === `example-org:${row.head.ref}`
          && url.searchParams.get("base") === row.base.ref), { headers });
      }
      const payload = JSON.parse(String(options.body)) as Payload;
      requests.push({ method, authorization, payload });
      expect(method).toBe("POST");
      const number = pulls.length + 1;
      const branch = (ref: string) => ({ ref, repo: { full_name: repository } });
      const row = { ...payload, base: branch(payload.base), head: branch(payload.head), number, id: 800 + number, state: "open" };
      pulls.push(row);
      if (payload.head === "work/recovery") throw new Error("fixture lost the 201 response");
      return Response.json(row, { status: 201, headers });
    },
  } });

  git("init", "--quiet");
  git("remote", "add", "origin", `https://github.com/${repository}.git`);
  let api = open();
  try {
    let { call, request } = apiClient(api.url);
    const project = await call<Project>("/projects", { title: "Publish a review", workspace, provider: "openai", model: "publish-fixture" });
    const prefix = "/projects/" + project.id;
    const route = prefix + "/github-pr-";
    const member = await call<{ token: string }>(prefix + "/members", { name: "reviewer" });
    await call(prefix + "/github-connect", { remote: "origin", repository, token: readToken });
    expect((await request(route + "credential", { token: readToken })).status).toBe(400);
    expect((await request(route + "credential", { token: publishToken }, member.token)).status).toBe(403);
    const connected = await call(route + "credential", { token: publishToken });
    expect(connected).toMatchObject({ connection: { hasPublishToken: true, hasToken: true } });
    expect(JSON.stringify(connected)).not.toContain(publishToken);
    const memberStatus = await call<{ connection: object }>(prefix + "/github-status", undefined, member.token);
    expect(memberStatus.connection).not.toHaveProperty("hasPublishToken");

    const source = { source: "files", files: ["src/example.ts"] };
    const { id: previewId } = await call<{ id: string }>(prefix + "/preview", source);
    const createRun = async (session: string, requestId: string) => {
      const identity = { session, requestId };
      faux.setResponses([fauxAssistantMessage("Private Pi answer.")]);
      await call(prefix + "/run", { ...source, ...identity, previewId, approved: true, prompt: "Private coding task." });
      await waitFor(() => call<Inspection>(prefix + "/inspect", identity), ({ run }) => run.status === "done");
      return identity;
    };
    const first = await createRun("publish", "first");
    const body = { ...first, base: "main", head: "work/new", title: "Operator PR title", body: "Operator Markdown", draft: true };
    expect((await request(route + "preview", body)).status).toBe(409);
    await call(prefix + "/review", { ...first, decision: "accepted" }, member.token);
    expect((await request(route + "preview", body, member.token)).status).toBe(403);
    expect((await request(route + "preview", { ...body, head: "fork:work/new" })).status).toBe(400);
    const preview = await call<Payload & { approval: string }>(route + "preview", body);
    expect(preview.body).toBe(`Operator Markdown\n\n<!-- okbrain-pr:${preview.approval} -->`);
    expect((await request(route + "publish", { ...body, approval: preview.approval })).status).toBe(409);
    expect((await request(route + "publish", { ...body, title: "Different", approval: preview.approval, approved: true })).status).toBe(409);
    const confirmation = { ...body, approval: preview.approval, approved: true };
    expect((await request(route + "publish", confirmation, member.token)).status).toBe(403);
    git("remote", "set-url", "origin", "https://github.com/example-org/different");
    expect((await request(route + "publish", confirmation)).status).toBe(409);
    expect(requests).toEqual([]);
    git("remote", "set-url", "origin", `https://github.com/${repository}.git`);

    const [published, duplicate] = await Promise.all([
      call<Publication>(route + "publish", confirmation), call<Publication>(route + "publish", confirmation),
    ]);
    expect(duplicate).toEqual(published);
    expect(published).toMatchObject({ receipt: { number: 1, id: 801, url: `https://github.com/${repository}/pull/1`, apiRequestId: "C0DE:123:ABC" } });
    expect(requests.map(({ method }) => method)).toEqual(["GET", "POST"]);
    expect(requests[1]?.payload).toEqual({ base: body.base, head: body.head, title: body.title, body: preview.body, draft: true });
    expect(JSON.stringify(requests[1]?.payload)).not.toMatch(/Private Pi|Private coding task|answer = 42|first/);
    expect(await call<Publication>(route + "inspect", first)).toEqual(published);

    const second = await createRun("recover", "second");
    await call(prefix + "/review", { ...second, decision: "accepted" });
    const retryBody = { ...body, ...second, head: "work/recovery", draft: false };
    const retryPreview = await call<{ approval: string }>(route + "preview", retryBody);
    const retry = { ...retryBody, approval: retryPreview.approval, approved: true };
    expect((await request(route + "publish", retry)).status).toBe(502);
    expect(await call(route + "inspect", second)).toMatchObject({ receipt: null, approval: retryPreview.approval });
    await api.stop();
    api = open();
    ({ call, request } = apiClient(api.url));
    const recovered = await call<Publication>(route + "recover", second);
    expect(recovered).toMatchObject({ receipt: { number: 2, id: 802, draft: false } });
    expect(await call<Publication>(route + "publish", retry)).toEqual(recovered);
    expect(requests.map(({ method }) => method)).toEqual(["GET", "POST", "GET", "POST", "GET"]);
    expect(await call(prefix + "/audit")).toContainEqual(expect.objectContaining({
      kind: "github_pr_recovered", session: second.session, request_id: second.requestId,
    }));
    expect(await call(prefix + "/audit")).toContainEqual(expect.objectContaining({
      kind: "github_pr_created", session: first.session, request_id: first.requestId,
    }));
    const third = await createRun("competing", "third");
    await call(prefix + "/review", { ...third, decision: "accepted" });
    const competing = { ...body, ...third, title: "Another request on the same branches" };
    const competingPreview = await call<{ approval: string }>(route + "preview", competing);
    expect((await request(route + "publish", { ...competing, approved: true, approval: competingPreview.approval })).status).toBe(409);
    expect(await call<Publication | null>(route + "inspect", third)).toBeNull();
    expect(requests.map(({ method }) => method)).toEqual(["GET", "POST", "GET", "POST", "GET", "GET"]);

    await call(prefix + "/delete-session", { session: first.session, confirm: first.session });
    expect(await call<Publication>(route + "inspect", first)).toEqual(published);
  } finally {
    await api.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("allows an approved source lookup only for the submitted preview and opt-in request", async () => {
  const { root, workspace, stateDir } = await fixture("okb-coding-source-lookup-");
  const models = createModels();
  const faux = fauxProvider({ provider: "openai", models: [{ id: "lookup-fixture" }] });
  models.setProvider(faux.provider);
  const api = createApiServer({ bundle: workspace, port: 0, token: ownerToken, coding: { stateDir, models } });
  try {
    const { call, request } = apiClient(api.url);
    const project = await call<Project>("/projects", {
      title: "Source lookup", workspace, provider: "openai", model: "lookup-fixture",
    });
    const path = "/projects/" + project.id;
    const source = { source: "files", files: ["src/example.ts"] };
    const preview = await call<{ id: string }>(path + "/preview", source);
    const identity = { session: "main", requestId: "lookup" };
    const body = { ...source, prompt: "Review the example", approved: true, previewId: preview.id, ...identity };
    faux.setResponses([(input) => {
      expect(getCurrentTools(input.messages).map(({ name }) => name)).toEqual([approvedSourceToolName]);
      return fauxAssistantMessage([
        fauxToolCall(approvedSourceToolName, { path: "src/example.ts", startLine: 1, endLine: 1 }, { id: "approved" }),
        fauxToolCall(approvedSourceToolName, { path: "private/example.ts", startLine: 1, endLine: 1 }, { id: "outside" }),
        fauxToolCall(approvedSourceToolName, { path: "src/example.ts", startLine: 1, endLine: 2 }, { id: "outside-lines" }),
      ], { stopReason: "toolUse" });
    }, (input, options) => {
      expect(options?.toolChoice).toBe("none");
      const results = input.messages.filter((message) => message.role === "toolResult");
      expect(results.map(({ toolCallId, isError }) => ({ toolCallId, isError }))).toEqual([
        { toolCallId: "approved", isError: false }, { toolCallId: "outside", isError: true },
        { toolCallId: "outside-lines", isError: true },
      ]);
      const result = results[0]?.content[0];
      expect(result?.type === "text" && JSON.parse(result.text)).toEqual({
        path: "src/example.ts", startLine: 1, endLine: 1, content: "export const answer = 42;",
      });
      expect(JSON.stringify(results)).not.toContain("private text");
      return fauxAssistantMessage("Checked the approved line.");
    }, (input) => {
      expect(getCurrentTools(input.messages)).toEqual([]);
      return fauxAssistantMessage("Reviewed without a lookup.");
    }]);
    expect((await request(path + "/run", { ...body, approved: false, approvedSourceLookup: true })).status).toBe(400);
    expect((await request(path + "/run", { ...body, files: [], approvedSourceLookup: true })).status).toBe(400);
    await call(path + "/run", { ...body, approvedSourceLookup: true });
    const done = await waitFor(() => call<Inspection>(path + "/inspect", identity), ({ run }) => run.status !== "running");
    expect(done.pi?.request?.receipt?.text).toBe("Checked the approved line.");
    expect((await request(path + "/run", body)).status).toBe(409);
    await call(path + "/run", { ...body, approvedSourceLookup: true });
    expect(faux.state.callCount).toBe(2);

    const followup = { session: identity.session, requestId: "default" };
    await call(path + "/run", { ...body, ...followup });
    const defaultRun = await waitFor(() => call<Inspection>(path + "/inspect", followup), ({ run }) => run.status !== "running");
    expect(defaultRun.pi?.request?.receipt?.text).toBe("Reviewed without a lookup.");
    expect(faux.state.callCount).toBe(3);

    const file = "src/indexed.ts";
    const tracked = Array.from({ length: 160 }, (_, index) =>
      index === 80 ? "export const exactReviewNeedle = 42;" : `const ordinary${index} = ${index};`);
    await writeFile(join(workspace, file), tracked.join("\n") + "\n");
    for (const args of [["init", "--quiet"], ["add", "--", file]]) {
      const git = Bun.spawnSync(["git", ...args], { cwd: workspace, stdout: "ignore", stderr: "pipe" });
      if (git.exitCode !== 0) throw new Error(git.stderr.toString());
    }
    const repository = { source: "repository", projects: ["src"], query: "exactReviewNeedle", tokenBudget: 300 };
    const excerpts = await call<{ manifest: { id: string }; excerpts: { path: string; startLine: number; endLine: number }[] }>(
      path + "/preview", repository,
    );
    const selected = excerpts.excerpts.find((excerpt) => excerpt.path === file && excerpt.startLine <= 81 && excerpt.endLine >= 81);
    expect(selected?.startLine).toBeGreaterThan(1);
    const repositoryRun = { session: identity.session, requestId: "excerpt" };
    faux.setResponses([fauxAssistantMessage([
      fauxToolCall(approvedSourceToolName, { path: file, startLine: 81, endLine: 81 }, { id: "excerpt-line" }),
      fauxToolCall(approvedSourceToolName, { path: file, startLine: 1, endLine: 1 }, { id: "unapproved-line" }),
    ], { stopReason: "toolUse" }), (input) => {
      const results = input.messages.filter((message) => message.role === "toolResult")
        .filter(({ toolCallId }) => toolCallId === "excerpt-line" || toolCallId === "unapproved-line");
      expect(results.map(({ toolCallId, isError }) => ({ toolCallId, isError }))).toEqual([
        { toolCallId: "excerpt-line", isError: false }, { toolCallId: "unapproved-line", isError: true },
      ]);
      const result = results[0]?.content[0];
      expect(result?.type === "text" && JSON.parse(result.text)).toEqual({
        path: file, startLine: 81, endLine: 81, content: "export const exactReviewNeedle = 42;",
      });
      return fauxAssistantMessage("Checked line 81 in the saved excerpt.");
    }]);
    await call(path + "/run", { ...repository, ...repositoryRun, prompt: "Find the exact reviewed line", approved: true,
      previewId: excerpts.manifest.id, approvedSourceLookup: true });
    const excerptRun = await waitFor(() => call<Inspection>(path + "/inspect", repositoryRun), ({ run }) => run.status !== "running");
    expect(excerptRun.pi?.request?.receipt?.text).toBe("Checked line 81 in the saved excerpt.");
    expect(faux.state.callCount).toBe(5);
  } finally {
    await api.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("scopes bounded answer and task progress to the selected running request", async () => {
  const { root, workspace, stateDir } = await fixture("okb-coding-live-answer-");
  const models = createModels();
  models.setProvider(fauxProvider({ provider: "openai", models: [{ id: "live-test" }] }).provider);
  const streams = [createAssistantMessageEventStream(), createAssistantMessageEventStream()];
  let calls = 0;
  models.streamSimple = (_model, _transcript, options) => {
    const stream = streams[calls++]!;
    const signal = options?.signal;
    signal?.addEventListener("abort", () => stream.end(fauxAssistantMessage("", { stopReason: "aborted" })), { once: true });
    return stream;
  };
  const api = createApiServer({ bundle: workspace, port: 0, token: ownerToken, coding: { stateDir, models } });
  try {
    const { call, request } = apiClient(api.url);
    const settings = { title: "Live answer", workspace, provider: "openai", model: "live-test" };
    const project = await call<Project>("/projects", settings);
    const other = await call<Project>("/projects", { ...settings, title: "Other project" });
    const path = "/projects/" + project.id;
    const member = await call<{ token: string }>(`/projects/${other.id}/members`, { name: "other-project" });
    const selected = { source: "files", files: ["src/example.ts"] };
    const preview = await call<{ id: string }>(path + "/preview", selected);
    const body = { ...selected, prompt: "Review the example", approved: true, previewId: preview.id, session: "main" };
    const first = { session: body.session, requestId: "first" };
    const firstText = "<b>Visible text</b>" + "x".repeat(maxLiveAnswerLength);
    const partial = fauxAssistantMessage([
      { type: "thinking", thinking: "private reasoning fixture" },
      { type: "text", text: firstText },
    ]);
    streams[0]!.push({ type: "text_delta", contentIndex: 1, delta: firstText, partial });
    await call(path + "/run", { ...body, ...first });
    const active = await waitFor(() => call<Inspection>(path + "/inspect", first),
      (value) => Boolean(value.liveAnswer && value.taskProgress?.stages.some(({ kind, running }) => kind === "model" && running > 0)));
    expect(active.run).toMatchObject({ status: "running", admitted: true });
    expect(active.liveAnswer).toEqual({ text: firstText.slice(0, maxLiveAnswerLength), truncated: true });
    expect(active.taskProgress?.stages).toContainEqual(expect.objectContaining({ kind: "model", running: 1 }));
    expect(JSON.stringify(active.taskProgress)).not.toContain("Review the example");
    expect(active.pi).toBeUndefined();
    expect(JSON.stringify(active)).not.toContain("private reasoning fixture");
    expect((await request(path + "/inspect", first, member.token)).status).toBe(403);
    expect((await request(path + "/review", { ...first, decision: "accepted" })).status).toBe(409);
    expect(JSON.stringify(await call(path + "/runs"))).not.toContain("Visible text");

    const final = fauxAssistantMessage("Completed first answer.");
    streams[0]!.push({ type: "done", reason: "stop", message: final });
    const finished = await waitFor(() => call<Inspection>(path + "/inspect", first), (value) => value.run.status === "done");
    expect(finished.liveAnswer).toBeUndefined();
    expect(finished.taskProgress).toBeUndefined();
    expect(finished.pi?.request?.receipt?.text).toBe("Completed first answer.");

    const second = { session: body.session, requestId: "second" };
    const secondText = "Waiting for cancellation.";
    streams[1]!.push({ type: "text_delta", contentIndex: 0, delta: secondText, partial: fauxAssistantMessage(secondText) });
    await call(path + "/run", { ...body, ...second });
    const running = await waitFor(() => call<Inspection>(path + "/inspect", second), (value) => Boolean(value.liveAnswer));
    expect(running.liveAnswer).toEqual({ text: secondText, truncated: false });
    const older = await call<Inspection>(path + "/inspect", first);
    expect(older.liveAnswer).toBeUndefined();
    expect(older.taskProgress).toBeUndefined();
    expect((await request(path + "/source-inspect", first)).status).toBe(409);
    expect((await request(path + "/source-inspect", second)).status).toBe(409);
    await call(path + "/cancel", second);
    const cancelled = await waitFor(() => call<Inspection>(path + "/inspect", second), (value) => value.run.status === "cancelled");
    expect(cancelled.run.status).toBe("cancelled");
    expect(cancelled.liveAnswer).toBeUndefined();
    expect(cancelled.taskProgress).toBeUndefined();
    expect(calls).toBe(2);
  } finally {
    for (const stream of streams) stream.end(fauxAssistantMessage("", { stopReason: "aborted" }));
    await api.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("cancels a running provider request through the coding API", async () => {
  const { root, workspace, stateDir } = await fixture("okb-coding-cancel-");
  const models = createModels();
  const faux = fauxProvider({ provider: "openai", models: [{ id: "abort-test" }] });
  models.setProvider(faux.provider);
  const api = createApiServer({ bundle: workspace, port: 0, token: ownerToken, coding: { stateDir, models } });
  const modelStarted = Promise.withResolvers<void>();
  try {
    const { call } = apiClient(api.url);
    const project = await call<Project>("/projects", {
      title: "Cancellation workspace", workspace, scopes: ["src"], provider: "openai", model: "abort-test",
    });
    const path = "/projects/" + project.id;
    const source = { source: "files", files: [] };
    const preview = await call<{ id: string }>(path + "/preview", source);
    faux.setResponses([(_input, options) => new Promise((resolve) => {
      modelStarted.resolve();
      const cancel = () => resolve(fauxAssistantMessage("Cancelled", { stopReason: "aborted" }));
      if (options?.signal?.aborted) cancel();
      else options?.signal?.addEventListener("abort", cancel, { once: true });
    })]);
    const identity = { session: "main", requestId: "cancel-me" };
    await call(path + "/run", { ...source, ...identity, prompt: "Review this work", approved: true, previewId: preview.id });
    await modelStarted.promise;
    await call(path + "/cancel", identity);
    const cancelled = await waitFor(
      () => call<Inspection>(path + "/inspect", identity),
      (value) => value.run.status === "cancelled",
    );
    expect(cancelled.run).toMatchObject({ status: "cancelled", admitted: true });
    expect(await call<SavedCodingRequestInput>(path + "/source-inspect", identity)).toEqual({ prompt: "Review this work", groups: [] });
    expect(faux.state.callCount).toBe(1);
  } finally {
    await api.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("resumes an interrupted HTTP run from the admitted source after the control process exits", async () => {
  const { root, workspace, stateDir } = await fixture("okb-coding-server-replay-");
  const childScript = `
    import { createModels, fauxProvider } from "@earendil-works/pi-ai";
    import { createApiServer } from "./src/api.ts";
    const { workspace, stateDir, ownerToken } = JSON.parse(process.argv.at(-1));
    const models = createModels();
    const faux = fauxProvider({ provider: "openai", models: [{ id: "replay-model" }] });
    models.setProvider(faux.provider);
    faux.setResponses([() => new Promise(() => {})]);
    const api = createApiServer({ bundle: workspace, port: 0, token: ownerToken, coding: { stateDir, models } });
    console.log(api.url);
  `;
  const worker = Bun.spawn([process.execPath, "-e", childScript, "--", JSON.stringify({ workspace, stateDir, ownerToken })], {
    cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "inherit",
  });
  const timeout = setTimeout(() => worker.kill("SIGKILL"), 8_000);
  let recovery: ReturnType<typeof createApiServer> | undefined;
  try {
    const reader = worker.stdout.getReader();
    const marker = await reader.read();
    reader.releaseLock();
    const childUrl = new TextDecoder().decode(marker.value).trim();
    const { call } = apiClient(childUrl);
    const project = await call<Project>("/projects", {
      title: "Recovery workspace", workspace, scopes: ["src"], provider: "openai", model: "replay-model",
    });
    const path = "/projects/" + project.id;
    const source = { source: "files", files: ["src/example.ts"] };
    const preview = await call<{ id: string }>(path + "/preview", source);
    const identity = { session: "main", requestId: "after-crash" };
    await call(path + "/run", { ...source, ...identity, approved: true, previewId: preview.id, prompt: "Review persisted bytes." });
    const before = await waitFor(() => call<Inspection>(path + "/inspect", identity), (value) => value.run.admitted);
    expect(before.run).toMatchObject({ status: "running", admitted: true });
    worker.kill("SIGKILL");
    await worker.exited;
    await rm(workspace, { recursive: true, force: true });

    const models = createModels();
    const faux = fauxProvider({ provider: "openai", models: [{ id: "replay-model" }] });
    models.setProvider(faux.provider);
    const recorded: string[] = [];
    faux.setResponses([(input) => {
      recorded.push(JSON.stringify(input.messages));
      return fauxAssistantMessage("Recovered answer");
    }]);
    recovery = createApiServer({ bundle: root, port: 0, token: ownerToken, coding: { stateDir, models } });
    const recovered = apiClient(recovery.url);
    expect(await recovered.call<Inspection>(path + "/inspect", identity)).toMatchObject({ run: { status: "interrupted" } });
    expect(await recovered.call<SavedCodingRequestInput>(path + "/source-inspect", identity)).toEqual({
      prompt: "Review persisted bytes.", groups: [{ files: [{ path: "src/example.ts", text: "export const answer = 42;\n" }] }],
    });
    expect(faux.state.callCount).toBe(0);
    expect(await recovered.call<Run>(path + "/resume", identity)).toMatchObject({ status: "running" });
    const after = await waitFor(
      () => recovered.call<Inspection>(path + "/inspect", identity),
      (value) => value.run.status === "done",
    );
    expect(after).toMatchObject({ run: { status: "done" }, pi: { request: { receipt: { text: "Recovered answer" } } } });
    expect(recorded[0]).toContain("answer = 42");
    expect(faux.state.callCount).toBe(1);
  } finally {
    clearTimeout(timeout);
    worker.kill("SIGKILL");
    await worker.exited;
    await recovery?.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test("the dedicated team listener serves only coding assets and project token routes", async () => {
  const { root, workspace, stateDir } = await fixture("okb-team-web-");
  const models = createModels();
  models.setProvider(fauxProvider({ provider: "openai", models: [{ id: "team-test" }] }).provider);
  const api = createApiServer({ bundle: workspace, port: 0, token: ownerToken, coding: { stateDir, models } });
  try {
    const local = apiClient(api.url);
    expect(await local.call("/team")).toBeNull();
    expect((await local.request("/team", { action: "start", publicOrigin: "http://team.example" })).status).toBe(400);
    const team = await local.call<{ url: string; publicOrigin: string }>("/team", {
      action: "start", port: 0, publicOrigin: "https://team.example",
    });
    const landing = await fetch(team.url);
    expect(landing.ok).toBe(true);
    expect(landing.headers.get("content-security-policy")).toContain("default-src 'self'");
    const page = await landing.text();
    expect(page).toContain("Project token");
    expect(page).not.toContain(ownerToken);
    expect((await fetch(new URL("gui/app.js", team.url))).status).toBe(404);
    expect((await fetch(new URL("api/ops", team.url))).status).toBe(404);
    expect((await fetch(new URL("api/status", team.url))).status).toBe(404);
    const project = await local.call<Project>("/projects", {
      workspace, title: "Team project", scopes: ["src"], provider: "openai", model: "team-test", apiKey: "only-test",
    });
    const localPath = "/projects/" + project.id;
    const { token } = await local.call<{ token: string }>(localPath + "/members", { name: "teammate" });
    const connected = apiClient(team.url);
    expect((await connected.request("/projects")).status).toBe(401);
    expect(await connected.call<Project[]>("/projects", undefined, token)).toMatchObject([{ id: project.id, credential: "project" }]);
    expect((await connected.request("/team", { action: "stop" }, token)).status).toBe(404);
    const originRequest = (origin: string) => fetch(new URL("api/coding/projects", team.url), {
      headers: { origin, authorization: `Bearer ${token}` },
    });
    expect((await originRequest(team.publicOrigin)).headers.get("access-control-allow-origin")).toBe(team.publicOrigin);
    expect((await originRequest("https://other.example")).status).toBe(403);
    expect(await local.call("/team", { action: "stop" })).toBeNull();
  } finally {
    await api.stop();
    await rm(root, { recursive: true, force: true });
  }
});
