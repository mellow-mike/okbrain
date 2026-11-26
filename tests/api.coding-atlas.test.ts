import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { createModels, fauxAssistantMessage, fauxProvider, type Message } from "@earendil-works/pi-ai";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer, type ApiServer } from "../src/api.ts";
import { atlasStatus } from "../src/core/coding/atlas/context.ts";
import { operations } from "../src/core/operations.ts";
import { buildMonorepo, type Fixture } from "./fixtures/monorepo.ts";
import { okb } from "./helpers.ts";

setDefaultTimeout(60_000);

const ownerToken = "local-operator-test";
type Preview = { source: string; manifest: { id: string; files: { path: string }[]; atlas?: { generation: number } }; excerpts: { path: string }[]; map: string[];
  sourceManifest: { source: string; id: string; manifest: { atlas?: object } } };
type Plan = { source: string; id: string; plan: { mode: string; orders: { scope: string; route: { choice: { model: string }; fallbacks: { model: string }[] } }[]; warnings?: string[] } };
type Run = { id: string; status: string; review: string | null };
type MapState = { status: string; imported: boolean; map?: { files: number; packages: number }; knowledge?: string; learning?: { episodes: number } | null;
  skills?: { id: string; state: string }[]; error?: string };

let root: string;
let fixture: Fixture;
let api: ApiServer;
let seen: { model: string; request: Record<string, unknown> }[];

function client(base: string) {
  const request = (path: string, data?: unknown, token: string = ownerToken) => fetch(new URL("api/coding" + path, base), {
    method: data === undefined ? "GET" : "POST",
    headers: { ...(data === undefined ? {} : { "content-type": "application/json" }), ...(token === ownerToken ? { "x-okb-token": token } : { authorization: `Bearer ${token}` }) },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const call = async <T>(path: string, data?: unknown, token?: string) => {
    const response = await request(path, data, token);
    const body = await response.json() as { error?: string; result: T };
    if (!response.ok) throw new Error(body.error ?? String(response.status));
    return body.result;
  };
  return { request, call };
}

async function waitFor<T>(poll: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = await poll();
    if (done(value) || Date.now() > deadline) return value;
    await Bun.sleep(25);
  }
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "okb-api-atlas-")));
  fixture = await buildMonorepo(join(root, "repo"), 120);
  const models = createModels();
  const faux = fauxProvider({ provider: "openai", models: [{ id: "strong" }, { id: "cheap" }] });
  models.setProvider(faux.provider);
  seen = [];
  faux.setResponses(Array.from({ length: 64 }, () => (context: { messages: readonly Message[] }, _options: unknown, _state: unknown, model: { id: string }) => {
    const latest = context.messages.findLast(({ role }) => role === "user");
    const request = JSON.parse(latest?.role === "user" && typeof latest.content === "string" ? latest.content : "{}") as Record<string, unknown>;
    seen.push({ model: model.id, request });
    if (request.reports) return fauxAssistantMessage("Combined result.");
    const first = (request.excerpts as { path: string; startLine: number }[])[0]!;
    return fauxAssistantMessage(`Reviewed ${first.path}:${first.startLine}.`);
  }));
  api = createApiServer({ bundle: fixture.workspace, port: 0, token: ownerToken, coding: { stateDir: join(root, "projects"), models } });
});

afterAll(async () => {
  await api.stop();
  await rm(root, { force: true, recursive: true });
});

test("a project imports its map, previews a selection, runs it, and learns from the review", async () => {
  const { request, call } = client(api.url);
  const project = await call<{ id: string }>("/projects", { title: "Storefront", workspace: fixture.workspace, scopes: ["packages", "apps"], provider: "openai", model: "strong" });
  const path = "/projects/" + project.id;
  const member = await call<{ token: string }>(path + "/members", { name: "reviewer" });

  expect(await call<MapState>(path + "/import")).toMatchObject({ status: "idle", imported: false });
  // Before an import the map has nothing to select from, and says how to fix that.
  const early = await request(path + "/preview", { source: "atlas", prompt: "refreshSession" });
  expect(early.status).toBe(409);
  expect((await early.json() as { error: string }).error).toContain("has not been imported");
  expect((await request(path + "/import", {}, member.token)).status).toBe(403);
  expect((await call<MapState>(path + "/import", {})).status).toBe("running");
  const imported = await waitFor(() => call<MapState>(path + "/import"), ({ status }) => status !== "running");
  expect(imported).toMatchObject({ status: "completed", imported: true, learning: null });
  expect(imported.map!.packages).toBe(11);
  expect(imported.knowledge).toContain("knowledge");
  // A project member sees that the map exists, not where it is kept or what it has learned.
  const forMember = await call<MapState>(path + "/import", undefined, member.token);
  expect(forMember).toMatchObject({ imported: true });
  expect(forMember).not.toHaveProperty("knowledge");
  expect(forMember).not.toHaveProperty("learning");

  const prompt = "Explain refreshSession and its test.";
  const selection = { source: "atlas", tokenBudget: 1200 };
  const preview = await call<Preview>(path + "/preview", { ...selection, prompt }, member.token);
  expect(preview.source).toBe("atlas");
  expect(preview.manifest.files[0]!.path).toBe("packages/auth/src/session.ts");
  expect(preview.map[0]).toContain("packages/auth");
  expect(preview.sourceManifest).toMatchObject({ source: "atlas", id: preview.manifest.id });
  expect(JSON.stringify(preview.sourceManifest)).not.toContain("AUTH_REFRESH");
  // The map never reads outside the project's permitted directories.
  expect((await request(path + "/preview", { ...selection, prompt, projects: ["."] })).status).toBe(403);
  expect((await request(path + "/preview", { ...selection, prompt, projects: ["../elsewhere"] })).status).toBe(400);
  expect((await request(path + "/preview", { ...selection, prompt, tokenBudget: 0 })).status).toBe(400);

  const identity = { session: "main", requestId: "map-1" };
  expect((await request(path + "/run", { ...selection, ...identity, prompt, previewId: preview.manifest.id })).status).toBe(400);
  const run = await call<Run>(path + "/run", { ...selection, ...identity, prompt, previewId: preview.manifest.id, approved: true });
  expect(run.id).toBe("map-1");
  const finished = await waitFor(() => call<{ run: Run }>(path + "/inspect", identity), ({ run: current }) => current.status !== "running");
  expect(finished.run.status).toBe("done");
  expect(seen.at(-1)!.request).toMatchObject({ task: prompt });
  expect(seen.at(-1)!.request.repositoryContext).toBeUndefined();
  // A stale approval is refused: the same ID with a different budget selects different bytes.
  expect((await request(path + "/run", { ...selection, tokenBudget: 700, session: "main", requestId: "map-2", prompt, previewId: preview.manifest.id, approved: true })).status).toBe(200);
  const stale = await waitFor(() => call<{ run: Run & { error: string | null } }>(path + "/inspect", { session: "main", requestId: "map-2" }), ({ run: current }) => current.status !== "running");
  expect(stale.run).toMatchObject({ status: "failed" });
  expect(stale.run.error).toContain("Preview it again");

  // The reviewer's decision is recorded first. Learning follows it and shows in the audit log.
  const reviewed = await call<Run>(path + "/review", { ...identity, decision: "accepted" }, member.token);
  expect(reviewed.review).toBe("accepted");
  const audit = await call<{ kind: string }[]>(path + "/audit");
  expect(audit.map(({ kind }) => kind)).toContain("review_learned");
  expect(audit.map(({ kind }) => kind)).toContain("repository_imported");
  const learned = await call<MapState>(path + "/import");
  expect(learned.learning).toMatchObject({ episodes: 1 });
  // The project's map is its own. Nothing was written to the operator's standalone map for this workspace.
  expect((await atlasStatus(fixture.workspace)).imported).toBe(false);

  // Deleting the transcript removes what was recorded from it.
  await call(path + "/delete-session", { session: "main", confirm: "main" });
  const forgotten = await waitFor(() => call<MapState>(path + "/import"), ({ learning }) => learning?.episodes === 0);
  expect(forgotten.learning).toMatchObject({ episodes: 0 });
});

test("an orchestrated request uses the project's routing policy and one approved plan", async () => {
  const { request, call } = client(api.url);
  const project = await call<{ id: string }>("/projects", { title: "Orchestrated", workspace: fixture.workspace, scopes: ["packages"], provider: "openai", model: "strong" });
  const path = "/projects/" + project.id;
  const member = await call<{ token: string }>(path + "/members", { name: "author" });
  // A second project on the same workspace starts with no map: the first project's import is not shared.
  expect(await call<MapState>(path + "/import")).toMatchObject({ status: "idle", imported: false });
  await call<MapState>(path + "/import", {});
  expect((await waitFor(() => call<MapState>(path + "/import"), ({ status }) => status !== "running")).map).toMatchObject({ packages: 9 });
  const policy = { version: 1, learn: false, roles: { worker: [{ provider: "openai", model: "cheap" }, { provider: "openai", model: "strong" }] } };
  expect((await request(path + "/routing", { policy }, member.token)).status).toBe(403);
  // A project holds one provider's key, so a policy cannot send its source anywhere else.
  const elsewhere = await request(path + "/routing", { policy: { version: 1, roles: { worker: [{ provider: "openrouter", model: "deepseek/deepseek-v3.2" }] } } });
  expect(elsewhere.status).toBe(400);
  expect((await elsewhere.json() as { error: string }).error).toContain("Route within OpenAI");
  expect((await request(path + "/routing", { policy: { version: 1, roles: { worker: [{ provider: "openai", model: "missing-model" }] } } })).status).toBe(400);
  expect(await call(path + "/routing", { policy })).toEqual({ policy });
  expect(await call(path + "/routing")).toEqual({ policy });

  const prompt = "Trace refreshSession, endSession and signToken, and computeTax with publishInvoice and InvoiceSchema.";
  const selection = { source: "orchestrated", workers: 2, tokenBudget: 900 };
  const preview = await call<Plan>(path + "/preview", { ...selection, prompt }, member.token);
  expect(preview.plan.mode).toBe("fan-out");
  expect(preview.plan.orders.map(({ scope }) => scope).sort()).toEqual(["packages/auth", "packages/billing"]);
  expect(preview.plan.orders.every(({ route }) => route.choice.model === "cheap" && route.fallbacks[0]?.model === "strong")).toBe(true);
  expect((await request(path + "/preview", { ...selection, prompt, workers: 7 })).status).toBe(400);
  expect((await request(path + "/run", { ...selection, session: "plan", requestId: "plan-1", prompt, previewId: preview.id, approved: true, approvedSourceLookup: true })).status).toBe(400);

  const before = seen.length;
  const identity = { session: "plan", requestId: "plan-1" };
  await call<Run>(path + "/run", { ...selection, ...identity, prompt, previewId: preview.id, approved: true }, member.token);
  const finished = await waitFor(() => call<{ run: Run; pi?: { request?: { receipt?: { text?: string; orchestration?: { orders: { model: string }[] } } } } }>(path + "/inspect", identity),
    ({ run }) => run.status !== "running");
  expect(finished.run.status).toBe("done");
  const calls = seen.slice(before);
  expect(calls.filter(({ request: sent }) => sent.workOrder).map(({ model }) => model)).toEqual(["cheap", "cheap"]);
  expect(calls.find(({ request: sent }) => sent.reports)?.model).toBe("strong");
  expect(finished.pi?.request?.receipt?.text).toBe("Combined result.");
  expect(finished.pi?.request?.receipt?.orchestration?.orders.map(({ model }) => model)).toEqual(["openai/cheap", "openai/cheap"]);

  // Changing the policy after approval changes what the approval covered, so the same request ID is refused.
  await call(path + "/routing", { policy: null });
  const rebound = await request(path + "/run", { ...selection, ...identity, prompt, previewId: preview.id, approved: true });
  expect(rebound.status).toBe(409);
  const lesson = await call<{ id: string }>(path + "/lesson", { text: "Session tokens are rotated on every refresh.", anchors: ["packages/auth"] });
  expect(lesson.id).toStartWith("lessons/session-tokens-are-rotated-on-every-");
  expect((await request(path + "/lesson", { text: "x", anchors: ["apps"] })).status).toBe(403);
  expect((await request(path + "/lesson", { text: "x" }, member.token)).status).toBe(403);
  expect((await call<MapState>(path + "/import")).skills?.find(({ id }) => id === lesson.id)).toMatchObject({ state: "trial" });
});

test("the repository map commands stay local and work from the command line", async () => {
  for (const name of ["code_import", "code_map", "code_recall", "code_plan", "code_learn", "code_lesson", "code_skills", "code_forget"]) {
    const operation = operations.find((candidate) => candidate.name === name);
    // None of these take a brain, and none are offered to an API or MCP client.
    expect(operation, name).toMatchObject({ localOnly: true, bundleIndependent: true });
  }
  const workspace = fixture.workspace;
  const imported = await okb(["code", "import", "--workspace", workspace, "--projects", "packages/auth,packages/contracts", "--history-commits", "0", "--json"]);
  expect(imported.code).toBe(0);
  expect(JSON.parse(imported.stdout)).toMatchObject({ scopes: ["packages/auth", "packages/contracts"], historyCommits: 0 });
  // Narrowing the import drops everything outside the new scope.
  expect((await okb(["code", "recall", "--workspace", workspace, "--query", "computeTax"])).stdout).toContain("No excerpts selected.");
  expect((await okb(["code", "import", "--workspace", workspace])).stdout).toContain("in 12 packages");

  const recall = await okb(["code", "recall", "--workspace", workspace, "--query", "refreshSession", "--context-tokens", "900", "--explain"]);
  expect(recall.code).toBe(0);
  expect(recall.stdout).toContain("packages/auth/src/session.ts:");
  expect(recall.stdout).toContain("(Declares refreshSession)");
  expect(recall.stdout).toContain("--- Ranking ---");
  expect(recall.stdout).not.toContain("AUTH_REFRESH");
  const shown = JSON.parse((await okb(["code", "recall", "--workspace", workspace, "--query", "refreshSession", "--show-content", "--json"])).stdout);
  expect(shown.excerpts[0].content).toContain("AUTH_REFRESH");
  expect(shown).not.toHaveProperty("ranked");

  const plan = await okb(["code", "plan", "--workspace", workspace, "--provider", "openai", "--model", "gpt-5-mini", "--prompt", "refreshSession"]);
  expect(plan.code).toBe(0);
  expect(plan.stdout).toContain("One worker.");
  expect(plan.stdout).toContain("No credential for openai");
  expect((await okb(["code", "plan", "--workspace", workspace, "--provider", "openai", "--model", "gpt-5-mini", "--prompt", "x", "--workers", "many"])).code).toBe(2);
  expect((await okb(["code", "plan", "--workspace", workspace, "--provider", "openai", "--model", "gpt-5-mini", "--prompt", "x", "--routing-json", "{"])).code).toBe(2);

  // A plan lists everything each worker is sent, and prints all of it on request: excerpts, map lines, and facts.
  const planned = ["code", "plan", "--workspace", workspace, "--provider", "openai", "--model", "gpt-5-mini", "--workers", "2", "--context-tokens", "900",
    "--prompt", "Trace refreshSession, endSession and signToken, and computeTax with publishInvoice and InvoiceSchema.",
    "--routing-json", JSON.stringify({ version: 1, roles: { worker: [{ provider: "openai", model: "gpt-5-mini", thinkingLevel: "low" }] }, openRouter: { dataCollection: "deny" } })];
  const brief = await okb(planned);
  expect(brief.stdout).toContain("2 workers.");
  expect(brief.stdout).toContain("openai/gpt-5-mini (low reasoning)");
  expect(brief.stdout).toContain("OpenRouter preferences for every call: data collection deny.");
  expect(brief.stdout).toMatch(/Map: \d+ lines sent with the excerpts\./u);
  expect(brief.stdout).toContain("Facts delivered: builtin/test-map");
  expect(brief.stdout).not.toContain("--- Map for");
  const full = await okb([...planned, "--show-content"]);
  expect(full.stdout).toContain("--- Map for packages/auth ---");
  expect(full.stdout).toContain("--- Facts for packages/billing ---");
  expect(full.stdout).toContain("Tests that cover the selected files:");
  expect(full.stdout).toContain("AUTH_REFRESH");
  const fullJson = JSON.parse((await okb([...planned, "--show-content", "--json"])).stdout) as { id: string; orders: { map: string[]; facts: string[] }[] };
  expect(fullJson.orders.every(({ map: lines, facts }) => lines.length > 0 && facts.length > 0)).toBe(true);
  const briefJson = JSON.parse((await okb([...planned, "--json"])).stdout) as { id: string; orders: Record<string, unknown>[] };
  expect(briefJson.id).toBe(fullJson.id);
  expect(briefJson.orders.every((order) => !("map" in order) && !("facts" in order) && !("excerpts" in order))).toBe(true);

  // Excerpts approved for lookup are printed too: approving the ID approves sending them on request.
  const lookup = ["code", "recall", "--workspace", workspace, "--query", "session token", "--context-tokens", "600", "--deferred"];
  const named = await okb(lookup);
  expect(named.stdout).toMatch(/On request: \S+:\d+-\d+/u);
  expect(named.stdout).not.toContain("--- On request:");
  const shownLookup = await okb([...lookup, "--show-content"]);
  const onRequest = /--- On request: (\S+):(\d+)-(\d+) ---\n([^\n]+)/u.exec(shownLookup.stdout);
  expect(onRequest).not.toBeNull();
  expect(onRequest![4]!.length).toBeGreaterThan(0);

  const map = await okb(["code", "map", "--workspace", workspace]);
  expect(map.stdout).toContain("in 12 packages");
  expect((await okb(["code", "map", "--workspace", root])).stdout).toContain("has not been imported");
  const lesson = await okb(["code", "lesson", "--workspace", workspace, "--text", "Contracts are versioned. Bump the version with every field change.", "--anchors", "packages/contracts"]);
  expect(lesson.stdout).toContain("as a draft");
  const skills = await okb(["code", "skills", "--workspace", workspace, "--disable", "builtin/change-coupling"]);
  expect(skills.stdout).toContain("builtin/change-coupling [built-in, disabled]");
  expect(skills.stdout).toContain("[lesson, trial] Contracts are versioned.");
  expect((await okb(["code", "skills", "--workspace", workspace, "--enable", "builtin/change-coupling"])).stdout).toContain("builtin/change-coupling [built-in, established]");

  // The run modes insist on a reviewed ID and refuse to be mixed.
  const run = ["code", "run", "--workspace", workspace, "--session", "cli", "--request-id", "r1", "--provider", "openai", "--model", "gpt-5-mini", "--prompt", "refreshSession"];
  expect((await okb([...run, "--atlas"])).stderr).toContain("Get the ID from `okb code recall`");
  expect((await okb([...run, "--orchestrate"])).stderr).toContain("Get the ID from `okb code plan`");
  expect((await okb([...run, "--atlas", "--orchestrate"])).code).toBe(2);
  expect((await okb([...run, "--deferred"])).code).toBe(2);
  // With an ID, the next thing a send needs is the provider credential. Nothing is selected without one.
  expect((await okb([...run, "--atlas", "--context-id", "0".repeat(64)])).stderr).toContain("Set OPENAI_API_KEY");
  expect((await okb(["code", "forget", "--workspace", workspace])).code).toBe(2);
  expect((await okb(["code", "forget", "--workspace", workspace, "--everything"])).stdout).toContain("Deleted all learned state");
});
