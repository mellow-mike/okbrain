import { expect, test } from "bun:test";
import { createModels, fauxAssistantMessage, fauxProvider, getCurrentTools } from "@earendil-works/pi-ai";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../src/api.ts";
import { listCodingModels } from "../src/core/coding/durable.ts";

const ownerToken = "local-operator-test";
type Project = { id: string; workspace: string; credential: string };
type Run = { id: string; status: string; actor: string; admitted: boolean; error: string | null; review: string | null };
type Inspection = { run: Run; pi?: { request?: { receipt?: { text?: string } } } };

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
      pi: { request: { receipt: { text: "Keep this change for review." } } },
    });
    expect(calls[0]).toContain("answer = 43");
    expect(await call<Run>(path + "/run", approved, member.token)).toMatchObject({ status: "done" });
    expect((await request(path + "/run", { ...approved, prompt: "Different task" }, member.token)).status).toBe(409);
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
