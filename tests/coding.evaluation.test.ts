import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../src/api.ts";
import { CodingEvaluations, parseEvaluation, pinnedEvaluationBinding, type EvaluationSource } from "../src/core/coding/evaluation.ts";
import { pinnedEvaluationRubric } from "../src/core/coding/evaluation-rubric.ts";
import { ensureExtensionCapableSqlite } from "../src/core/engine/custom-sqlite.ts";

const ownerToken = "evaluation-test-owner";
type Report = ReturnType<CodingEvaluations["report"]> & { provider: string; model: string };
type Attempt = Report["attempts"][number];
type Preview = { id: string };
type Inspection = { run: { status: string }; pi?: { request?: { usage?: { totalTokens: number } } } };

function client(url: string) {
  const request = (path: string, data?: unknown, token: string | null = ownerToken) => fetch(new URL("api/coding" + path, url), {
    method: data === undefined ? "GET" : "POST",
    headers: {
      ...(data === undefined ? {} : { "content-type": "application/json" }),
      ...(token === ownerToken ? { "x-okb-token": token } : token ? { authorization: "Bearer " + token } : {}),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const call = async <T>(path: string, data?: unknown, token?: string): Promise<T> => {
    const response = await request(path, data, token);
    const body = await response.json() as { result: T; error?: string };
    if (!response.ok) throw new Error(body.error ?? String(response.status));
    return body.result;
  };
  return { call, request };
}

test("opt-in Coding evaluations use saved evidence, separate actors, and durably measured usage", async () => {
  const root = await mkdtemp(join(tmpdir(), "okb-evaluation-"));
  const workspace = join(root, "workspace");
  const stateDir = join(root, "data");
  const content = "export const document = 'private source marker';\n";
  const responseText = "The approved citation is src/example.ts:1. Private response marker.";
  const prompt = "Give an evidence-backed answer for the evaluation fixture.";
  const file = join(workspace, "src", "example.ts");
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(file, content);
  for (const args of [["init", "--quiet"], ["add", "--", "src/example.ts"]]) {
    const git = Bun.spawnSync(["git", ...args], { cwd: workspace });
    if (git.exitCode !== 0) throw new Error(git.stderr.toString());
  }
  const models = createModels();
  const faux = fauxProvider({ provider: "openai", models: [{ id: "review-model" }] });
  models.setProvider(faux.provider);
  const providerInputs: string[] = [];
  faux.setResponses(Array.from({ length: 4 }, () => (transcript) => {
    providerInputs.push(JSON.stringify(transcript.messages));
    return fauxAssistantMessage(responseText);
  }));
  const opts = { bundle: workspace, port: 0, token: ownerToken, coding: { stateDir, models } };
  let server = createApiServer(opts);
  try {
    const owner = client(server.url);
    const settings = { workspace, title: "Evaluation project", scopes: ["src"], provider: "openai", model: "review-model" };
    const project = await owner.call<{ id: string }>("/projects", settings);
    const other = await owner.call<{ id: string }>("/projects", { ...settings, title: "Outside project" });
    const path = "/projects/" + project.id;
    const addMember = (name: string) => owner.call<{ token: string }>(path + "/members", { name });
    const author = (await addMember("measurement-author")).token;
    const sameActor = (await addMember("MEASUREMENT-AUTHOR")).token;
    const reviewer = (await addMember("measurement-reviewer")).token;
    const observer = (await addMember("measurement-observer")).token;
    const host = await owner.call<{ url: string }>("/team", { action: "start", port: 0 });
    const team = client(host.url);
    expect(await (await fetch(host.url)).text()).toContain("/gui/coding-evaluation.js");
    expect((await fetch(new URL("gui/coding-evaluation.js", host.url))).status).toBe(200);
    expect((await team.request(path + "/evaluations", undefined, null)).status).toBe(401);
    expect((await team.request("/projects/" + other.id + "/evaluations", undefined, author)).status).toBe(403);

    const evaluation = { series: "fixture-v1", task: "trace-citation", evidence: ["src/example.ts:1"] };
    const source = { source: "files", files: ["src/example.ts"] };
    const identity = { session: "evaluation", requestId: "attempt-one" };
    const preview = await team.call<Preview>(path + "/preview", { ...source, measurePreview: true }, author);
    const run = { ...identity, ...source, prompt, evaluation, approved: true, previewId: preview.id };
    expect((await team.request(path + "/run", {
      ...run, evaluation: { ...evaluation, evidence: ["private/other.ts:3"] },
    }, author)).status).toBe(403);
    expect((await team.request(path + "/run", { ...run, approved: false }, author)).status).toBe(400);
    await team.call(path + "/run", run, author);
    const waitForDone = async (attempt: typeof identity) => {
      const expires = Date.now() + 4000;
      for (;;) {
        const result = await team.call<Inspection>(path + "/inspect", attempt, author);
        if (result.run.status === "done") return result.pi?.request?.usage?.totalTokens ?? 0;
        if (Date.now() >= expires || result.run.status !== "running") throw new Error("Unexpected run status " + result.run.status);
        await Bun.sleep(15);
      }
    };
    const firstTokens = await waitForDone(identity);
    expect(firstTokens).toBeGreaterThan(0);
    expect(providerInputs[0]).toContain(prompt);
    expect(providerInputs[0]).toContain("private source marker");
    expect(providerInputs[0]).not.toContain("fixture-v1");

    await writeFile(file, "export const document = 'changed after the preview';\n");
    const inspect = await team.call<{ task: string; sources: EvaluationSource[]; evidencePresent: number[]; response: string }>(
      path + "/evaluation-inspect", identity, reviewer,
    );
    expect(inspect).toMatchObject({ task: prompt, evidencePresent: [0], response: responseText,
      sources: [{ path: "src/example.ts", startLine: 1, endLine: 1, content }] });
    const acceptance = { ...identity, decision: "accepted", verified: [0] };
    expect((await team.request(path + "/evaluation-review", acceptance, author)).status).toBe(403);
    expect((await team.request(path + "/evaluation-review", acceptance, sameActor)).status).toBe(403);
    expect((await team.request(path + "/evaluation-review", { ...acceptance, verified: [] }, reviewer)).status).toBe(400);
    const accepted = await team.call<Attempt>(path + "/evaluation-review", acceptance, reviewer);
    expect(accepted).toMatchObject({ reviewer: "human:measurement-reviewer", verified: [0], origin: "injected", usage: { totalTokens: firstTokens } });
    expect(await team.call<Attempt>(path + "/evaluation-review", acceptance, reviewer)).toEqual(accepted);
    expect((await team.request(path + "/evaluation-review", acceptance, observer)).status).toBe(403);

    const secondIdentity = { session: "evaluation", requestId: "attempt-two" };
    const secondSource = { source: "files", files: [] };
    const secondPreview = await team.call<Preview>(path + "/preview", { ...secondSource, measurePreview: true }, author);
    const second = { ...run, ...secondIdentity, ...secondSource, previewId: secondPreview.id };
    expect((await team.request(path + "/run", { ...second, prompt: "Different evaluation task" }, author)).status).toBe(409);
    await team.call(path + "/run", second, author);
    const secondTokens = await waitForDone(secondIdentity);
    expect(secondTokens).toBeGreaterThan(0);
    expect((await team.request(path + "/evaluation-review", { ...acceptance, ...secondIdentity }, reviewer)).status).toBe(400);
    await team.call(path + "/evaluation-review", { ...secondIdentity, decision: "changes_requested", verified: [] }, reviewer);

    await writeFile(file, content);
    const strategies = [
      { strategy: "lexical", selection: { projects: ["src"] } },
      { strategy: "indexed", selection: { profile: { version: 1, name: "Fixture index", projects: ["src"] } } },
    ] as const;
    const repositoryGroups = [];
    for (const { strategy, selection } of strategies) {
      const repository = { source: "repository", query: "document", ...selection };
      const preview = await team.call<{ manifest: Preview }>(path + "/preview", { ...repository, measurePreview: true }, author);
      const comparison = { session: `evaluation-${strategy}`, requestId: `${strategy}-attempt` };
      await team.call(path + "/run", { ...run, ...comparison, ...repository, files: undefined, previewId: preview.manifest.id }, author);
      const tokens = await waitForDone(comparison);
      expect(tokens).toBeGreaterThan(0);
      const evidence = await team.call<{ task: string; sources: EvaluationSource[]; evidencePresent: number[] }>(
        path + "/evaluation-inspect", comparison, reviewer,
      );
      expect(evidence).toMatchObject({ task: prompt, evidencePresent: [0],
        sources: [{ path: "src/example.ts", startLine: 1, endLine: 1, content: content.trimEnd() }] });
      const accepted = await team.call<Attempt>(path + "/evaluation-review", { ...acceptance, ...comparison }, reviewer);
      expect(accepted).toMatchObject({ strategy, decision: "accepted", origin: "injected", verified: [0] });
      repositoryGroups.push(expect.objectContaining({ series: evaluation.series, strategy, origin: "injected",
        cases: 1, attempts: 1, reviewed: 1, accepted: 1, evidenceExpected: 1, evidenceVerified: 1,
        previewCount: 1, usageRecorded: 1, tokensPerAccepted: tokens, tokens: expect.objectContaining({ totalTokens: tokens }) }));
    }

    const report = await team.call<Report>(path + "/evaluations", undefined, observer);
    expect(report.groups).toHaveLength(3);
    expect(report.groups).toEqual(expect.arrayContaining([expect.objectContaining({
      series: "fixture-v1", strategy: "files", origin: "injected", attempts: 2, reviewed: 2, accepted: 1,
      cases: 1, evidenceExpected: 2, evidenceVerified: 1, previewCount: 2, usageRecorded: 2,
      meanSourceBytes: Math.round((Buffer.byteLength(JSON.stringify(inspect.sources)) + 2) / 2),
      tokensPerAccepted: firstTokens + secondTokens, tokens: expect.objectContaining({ totalTokens: firstTokens + secondTokens }),
    }), ...repositoryGroups]));
    expect(JSON.stringify(report)).not.toContain("private source marker");
    expect(JSON.stringify(report)).not.toContain(responseText);
    expect(JSON.stringify(report)).not.toContain(prompt);
    expect(faux.state.callCount).toBe(4);
    expect(await team.call<Inspection>(path + "/inspect", identity, reviewer)).not.toHaveProperty("pi.request.evaluationInput");
    const audit = await owner.call<{ kind: string }[]>(path + "/audit");
    expect(audit.filter(({ kind }) => kind === "evaluation_accepted")).toHaveLength(3);
    expect(JSON.stringify(audit)).not.toContain("src/example.ts");

    await server.stop();
    server = createApiServer(opts);
    const restarted = client(server.url);
    expect(report).toMatchObject({ provider: "openai", model: "review-model" });
    expect(await restarted.call<Report>(path + "/evaluations", undefined, observer)).toEqual(report);
    for (const session of [identity.session, ...strategies.map(({ strategy }) => `evaluation-${strategy}`)])
      await restarted.call(path + "/delete-session", { session, confirm: session });
    expect(await restarted.call(path + "/evaluations")).toMatchObject({ attempts: [], groups: [] });
    expect(faux.state.callCount).toBe(4);
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("pinned evaluation drafts are scoped and reject other checkouts without admitting a run", async () => {
  const root = await mkdtemp(join(tmpdir(), "okb-pinned-study-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  for (const args of [["init", "--quiet"], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "commit", "--quiet", "--allow-empty", "-m", "Test revision"]]) {
    const git = Bun.spawnSync(["git", ...args], { cwd: workspace });
    if (git.exitCode !== 0) throw new Error(git.stderr.toString());
  }
  const models = createModels();
  const faux = fauxProvider({ provider: "openai", models: [{ id: "pinned-fixture" }] });
  models.setProvider(faux.provider);
  const api = createApiServer({ bundle: workspace, port: 0, token: ownerToken, coding: { stateDir: join(root, "state"), models } });
  try {
    const { call, request } = client(api.url);
    const config = { workspace, title: "Pinned fixture", scopes: ["."], provider: "openai", model: "pinned-fixture" };
    const project = await call<{ id: string }>("/projects", config);
    const other = await call<{ id: string }>("/projects", { ...config, title: "Other fixture" });
    const path = "/projects/" + project.id;
    const member = await call<{ token: string }>(path + "/members", { name: "rubric-author" });
    expect((await request(path + "/evaluation-rubric", undefined, null)).status).toBe(401);
    expect((await request("/projects/" + other.id + "/evaluation-rubric", undefined, member.token)).status).toBe(403);
    const response = await request(path + "/evaluation-rubric", undefined, member.token);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ result: pinnedEvaluationRubric });
    expect(pinnedEvaluationRubric.studies.map(({ id, tokenBudget, tasks }) => [id, tokenBudget, tasks.length]))
      .toEqual([["package", 4096, 6], ["subsystem", 12288, 6]]);

    const study = pinnedEvaluationRubric.studies[0]!;
    const task = study.tasks[0]!;
    const evaluation = { series: study.series, task: task.id, evidence: task.evidence };
    const draft = { source: "files", files: task.files, evaluation, prompt: task.prompt, measurePreview: true };
    const changed = await request(path + "/preview", { ...draft, prompt: "A different task" }, member.token);
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ error: expect.stringContaining("exact task and citations") });
    const changedScope = await request(path + "/preview", { ...draft, files: ["extra.ts"] }, member.token);
    expect(changedScope.status).toBe(409);
    expect(await changedScope.json()).toMatchObject({ error: expect.stringContaining("published source strategy") });
    const wrong = await request(path + "/preview", draft, member.token);
    expect(wrong.status).toBe(409);
    expect(await wrong.json()).toMatchObject({ error: expect.stringContaining(pinnedEvaluationRubric.revision) });
    const run = await request(path + "/run", { ...draft, session: "trial", requestId: "unapproved", approved: true, previewId: "not-a-preview" }, member.token);
    expect(run.status).toBe(409);
    expect(await call<unknown[]>(path + "/runs", undefined, member.token)).toHaveLength(0);
    expect(faux.state.callCount).toBe(0);
  } finally {
    await api.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("pinned evaluation timing requires the author's matching measured case preview", () => {
  ensureExtensionCapableSqlite();
  using db = new Database(":memory:");
  db.exec(`CREATE TABLE runs(project TEXT, session TEXT, id TEXT, actor TEXT, status TEXT, PRIMARY KEY (project, session, id))`);
  const ledger = new CodingEvaluations(db);
  const attempt = { project: "project", session: "trial", requestId: "attempt" };
  const actor = "human:author";
  const preview = "fixture-hash";
  db.run("INSERT INTO runs VALUES (?, ?, ?, ?, ?)", [attempt.project, attempt.session, attempt.requestId, actor, "running"]);
  const [study] = pinnedEvaluationRubric.studies;
  const [task] = study!.tasks;
  const evaluation = parseEvaluation({ series: study!.series, task: task!.id, evidence: task!.evidence }, ["."]);
  const binding = pinnedEvaluationBinding(evaluation, task!.prompt, { files: task!.files }, false)!;
  const enroll = (principal = actor) => ledger.enroll(attempt, principal, evaluation, task!.prompt, "files", "injected", preview, binding);
  ledger.preview(attempt.project, actor, preview, 30);
  expect(() => enroll()).toThrow("Preview the pinned case again");
  ledger.preview(attempt.project, actor, preview, 50, binding);
  expect(() => enroll("human:reviewer")).toThrow("Preview the pinned case again");
  enroll();
  expect(ledger.get(attempt, actor)).toMatchObject({ previewMs: 50, series: study!.series });
  // The same approved preview can't supply timing to a second trial.
  expect(() => db.transaction(enroll)()).toThrow("Preview the pinned case again");
  expect(ledger.get(attempt, actor)?.previewMs).toBe(50);
});

test("package evaluations inspect the original Pi Durable package inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "okb-evaluation-packages-"));
  const workspace = join(root, "workspace");
  const models = createModels();
  const faux = fauxProvider({ provider: "openai", models: [{ id: "package-evaluation" }] });
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("alpha/example.ts:1"), fauxAssistantMessage("beta/example.ts:1")]);
  await mkdir(workspace, { recursive: true });
  const server = createApiServer({ bundle: workspace, port: 0, token: ownerToken, coding: { stateDir: join(root, "data"), models } });
  try {
    for (const packageName of ["alpha", "beta"]) {
      await mkdir(join(workspace, packageName));
      await writeFile(join(workspace, packageName, "example.ts"), `export const ${packageName} = 17;\n`);
    }
    for (const args of [["init", "--quiet"], ["add", "--", "alpha", "beta"]]) {
      const git = Bun.spawnSync(["git", ...args], { cwd: workspace });
      if (git.exitCode !== 0) throw new Error(git.stderr.toString());
    }
    const { call } = client(server.url);
    const project = await call<{ id: string }>("/projects", {
      workspace, title: "Package project", scopes: ["alpha", "beta"], provider: "openai", model: "package-evaluation",
    });
    const path = "/projects/" + project.id;
    const reviewer = await call<{ token: string }>(path + "/members", { name: "package-reviewer" });
    const source = { source: "packages", packages: [{ project: "alpha", query: "alpha" }, { project: "beta", query: "beta" }] };
    const preview = await call<Preview & { packages: { excerpts: EvaluationSource[] }[] }>(path + "/preview", source);
    const identity = { requestId: "package-trial", session: "evaluation" };
    await call(path + "/run", {
      ...identity, ...source, prompt: "Describe both packages with line references.", approved: true, previewId: preview.id,
      evaluation: { series: "fixture", task: "package-trace", evidence: ["alpha/example.ts:1", "beta/example.ts:1"] },
    });
    const deadline = Date.now() + 4000;
    for (;;) {
      const result = await call<Inspection>(path + "/inspect", identity);
      if (result.run.status === "done") break;
      if (Date.now() >= deadline || result.run.status !== "running") throw new Error("Unexpected run status " + result.run.status);
      await Bun.sleep(15);
    }
    const result = await call<{ sources: EvaluationSource[]; evidencePresent: number[] }>(path + "/evaluation-inspect", identity, reviewer.token);
    expect(result.evidencePresent).toEqual([0, 1]);
    expect(result.sources).toEqual(preview.packages.flatMap(({ excerpts }) => excerpts));
    expect(await call<Attempt>(path + "/evaluation-review", { ...identity, decision: "accepted", verified: [0, 1] }, reviewer.token))
      .toMatchObject({ strategy: "packages", decision: "accepted", verified: [0, 1] });
    expect(faux.state.callCount).toBe(2);
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
