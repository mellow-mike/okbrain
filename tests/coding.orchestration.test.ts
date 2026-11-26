import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { createModels, fauxAssistantMessage, fauxProvider, type Message, type Model } from "@earendil-works/pi-ai";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importRepository } from "../src/core/coding/atlas/import.ts";
import { Learning } from "../src/core/coding/atlas/learn.ts";
import {
  cancelCodingRequest, CodingError, getCodingSessionStatus, getSavedCodingRequestInput, listCodingModels, listStandaloneCodingRequests, previewAtlasContext,
  previewCodingOrchestration, runCodingSession, type CodingSessionOptions,
} from "../src/core/coding/durable.ts";
import { outboundContent } from "../src/core/coding/history.ts";
import { changedPaths, reconcile } from "../src/core/coding/orchestrator.ts";
import { recordCodingOutcome } from "../src/core/coding/outcomes.ts";
import { checkProviderModel } from "../src/core/coding/provider-check.ts";
import {
  chooseRoute, parseRoutingPolicy, routeCell, RoutingError, validateRoutingPolicy, withOpenRouterPreferences, type RouteCandidate, type RoutingPolicy,
} from "../src/core/coding/router.ts";
import { buildMonorepo, type Fixture } from "./fixtures/monorepo.ts";

setDefaultTimeout(60_000);

let root: string;
let fixture: Fixture;
let workspace: string;
let stateDir: string;
const provider = "openai";
const task = "Trace refreshSession, endSession and signToken, and computeTax with publishInvoice and InvoiceSchema. Cite paths.";

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "okb-orchestration-")));
  fixture = await buildMonorepo(join(root, "repo"), 160);
  workspace = fixture.workspace;
  stateDir = join(root, "sessions");
  await importRepository({ workspace });
});

afterAll(async () => { await rm(root, { force: true, recursive: true }); });

type Seen = { model: string; request: Record<string, unknown>; raw: string };

/** A scripted provider that records what each model was sent and answers from that. */
function scripted(answer: (seen: Seen) => string | { error: string }, modelIds = ["strong", "cheap"]) {
  const models = createModels();
  const faux = fauxProvider({ provider, models: modelIds.map((id) => ({ id, cost: id === "cheap" ? { input: 0.2, output: 1, cacheRead: 0, cacheWrite: 0 } : { input: 5, output: 25, cacheRead: 0, cacheWrite: 0 } })) });
  models.setProvider(faux.provider);
  const seen: Seen[] = [];
  const step = (context: { messages: readonly Message[] }, _options: unknown, _state: unknown, model: Model<string>) => {
    const latest = context.messages.findLast(({ role }) => role === "user");
    const raw = latest?.role === "user" && typeof latest.content === "string" ? latest.content : "";
    const entry = { model: model.id, request: JSON.parse(raw) as Record<string, unknown>, raw };
    seen.push(entry);
    const reply = answer(entry);
    return typeof reply === "string" ? fauxAssistantMessage(reply) : fauxAssistantMessage("", { stopReason: "error", errorMessage: reply.error });
  };
  faux.setResponses(Array.from({ length: 64 }, () => step));
  return { models, faux, seen };
}

const session = (name: string, requestId: string, model = "strong"): CodingSessionOptions => ({ workspace, session: name, requestId, provider, model });
const paths = (request: Record<string, unknown>) => (request.excerpts as { path: string }[]).map(({ path }) => path);

test("a routing policy is validated strictly and its preferences fail closed", () => {
  const providers = ["openai", "openrouter"];
  const policy = parseRoutingPolicy(JSON.stringify({ version: 1, roles: { worker: [{ provider: "openrouter", model: "deepseek/deepseek-v3.2" }, { provider: "openai", model: "gpt-5-mini", thinkingLevel: "low" }] },
    reviewCost: 2, learn: true, openRouter: { dataCollection: "deny", order: ["Fireworks"], sort: "price" } }), providers);
  expect(policy.roles.worker?.map(({ model }) => model)).toEqual(["deepseek/deepseek-v3.2", "gpt-5-mini"]);
  for (const bad of [
    { version: 2, roles: {} }, { version: 1, roles: { planner: [] } }, { version: 1, roles: { worker: [] } },
    { version: 1, roles: { worker: [{ provider: "azure", model: "x" }] } }, { version: 1, roles: { worker: [{ provider: "openai", model: "a b" }] } },
    { version: 1, roles: { worker: [{ provider: "openai", model: "x" }, { provider: "openai", model: "x" }] } },
    { version: 1, roles: { worker: [{ provider: "openai", model: "x" }] }, reviewCost: -1 },
    { version: 1, roles: { worker: [{ provider: "openai", model: "x" }] }, openRouter: { dataCollection: "maybe" } },
    { version: 1, roles: { worker: [{ provider: "openai", model: "x" }] }, openRouter: { order: ["ok", "bad\nname"] } },
  ]) expect(() => validateRoutingPolicy(bad, providers)).toThrow(RoutingError);
  expect(() => parseRoutingPolicy("{", providers)).toThrow("as JSON");

  const completions = { id: "deepseek/deepseek-v3.2", provider: "openrouter", api: "openai-completions", compat: { supportsStrictMode: true } } as unknown as Model<"openai-completions">;
  expect(withOpenRouterPreferences(completions, policy.openRouter).compat).toEqual({
    supportsStrictMode: true, openRouterRouting: { data_collection: "deny", order: ["Fireworks"], sort: "price" } });
  // Pi cannot send provider preferences on this API, so a privacy preference is refused instead of dropped.
  const messages = { id: "anthropic/claude-sonnet-5", provider: "openrouter", api: "anthropic-messages" } as unknown as Model<"anthropic-messages">;
  expect(() => withOpenRouterPreferences(messages, { dataCollection: "deny" })).toThrow("cannot be sent");
  expect(withOpenRouterPreferences(messages, { sort: "price" })).toBe(messages);
  const direct = { id: "gpt-5-mini", provider: "openai", api: "openai-completions" } as unknown as Model<"openai-completions">;
  expect(withOpenRouterPreferences(direct, policy.openRouter)).toBe(direct);
});

test("the router weighs price against the cost of a rejected result and keeps a fixed baseline in view", () => {
  const candidates: RouteCandidate[] = [{ provider, model: "strong" }, { provider, model: "cheap" }];
  const prices = ({ model }: RouteCandidate) => model === "cheap" ? { input: 0.2, output: 1 } : { input: 5, output: 25 };
  const fixed = chooseRoute({ role: "worker", candidates, contextTokens: 3000, prices, learn: false, seed: "s" });
  expect(fixed).toMatchObject({ choice: candidates[0], baseline: candidates[0], fallbacks: [candidates[1]], cell: "medium", reason: "Fixed first model for this role." });
  // With equal histories and a cheap review, the cheap model's lower price wins.
  const even = () => ({ alpha: 40, beta: 10, runs: 48 });
  const cheapReview = chooseRoute({ role: "worker", candidates, contextTokens: 3000, prices, stats: even, reviewCost: 0.01, seed: "s" });
  expect(cheapReview.choice.model).toBe("cheap");
  expect(cheapReview.baseline.model).toBe("strong");
  expect(cheapReview.options.find(({ model }) => model === "cheap")!.cost).toBeLessThan(cheapReview.options.find(({ model }) => model === "strong")!.cost);
  // A cheap model that is usually rejected costs more than it saves once a review is worth anything.
  const stats = (_role: string, _cell: string, key: string) => key.endsWith("/cheap") ? { alpha: 3, beta: 40, runs: 41 } : { alpha: 40, beta: 3, runs: 41 };
  const poor = chooseRoute({ role: "worker", candidates, contextTokens: 3000, prices, stats, reviewCost: 1, seed: "s" });
  expect(poor.choice.model).toBe("strong");
  expect(poor.options.find(({ model }) => model === "cheap")!.acceptance).toBeLessThan(0.2);
  // The same plan always routes the same way.
  expect(chooseRoute({ role: "worker", candidates, contextTokens: 3000, prices, stats: even, seed: "plan-7" }))
    .toEqual(chooseRoute({ role: "worker", candidates, contextTokens: 3000, prices, stats: even, seed: "plan-7" }));
  expect([routeCell(100), routeCell(1500), routeCell(9000)]).toEqual(["small", "medium", "large"]);
  expect(() => chooseRoute({ role: "worker", candidates: [], contextTokens: 1, prices, seed: "s" })).toThrow("No model is configured");
});

test("the harness reports overlapping and out-of-scope proposals without a model", () => {
  const diff = (path: string) => `Findings.\n\n--- a/${path}\n+++ b/${path}\n@@ -1,2 +1,2 @@\n-a\n+b\n`;
  expect(changedPaths(`${diff("packages/a/x.ts")}\n--- /dev/null\n+++ b/packages/a/new.ts\n`)).toEqual(["packages/a/new.ts", "packages/a/x.ts"]);
  expect(reconcile([
    { id: "w1", scope: "packages/a", report: diff("packages/a/x.ts") + diff("packages/shared/y.ts") },
    { id: "w2", scope: "packages/b", report: diff("packages/shared/y.ts") }, { id: "w3", scope: "packages/c" },
  ])).toEqual({ conflicts: ["packages/shared/y.ts"], outOfScope: [{ order: "w1", path: "packages/shared/y.ts" }, { order: "w2", path: "packages/shared/y.ts" }] });
});

test("a deferred excerpt is saved whole and leaves this computer as a pointer", () => {
  const saved = JSON.stringify({ task: "t", excerpts: [{ path: "a.ts", startLine: 1, endLine: 2, content: "sent" }, { path: "b.ts", startLine: 5, endLine: 9, content: "held back", deferred: true }],
    repositoryContext: { id: "x" }, approvedSourceLookup: true });
  const outbound = JSON.parse(outboundContent(saved));
  expect(outbound.excerpts).toEqual([{ path: "a.ts", startLine: 1, endLine: 2, content: "sent" }, { path: "b.ts", startLine: 5, endLine: 9, deferred: true }]);
  expect(outbound.repositoryContext).toBeUndefined();
  expect(outboundContent("not json")).toBe("not json");
});

test("an OpenRouter key check uses the key lookup and Pi's own catalog", async () => {
  const calls: { url: string; auth: string | null }[] = [];
  const transport = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
    return new Response(JSON.stringify({ data: { label: "sk-or-…", limit: null } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const signal = new AbortController().signal;
  expect(await checkProviderModel({ provider: "openrouter", model: "anthropic/claude-sonnet-5", apiKey: "sk-or-test" }, signal, transport)).toEqual({ code: "ready", httpStatus: 200 });
  expect(calls).toEqual([{ url: "https://openrouter.ai/api/v1/key", auth: "Bearer sk-or-test" }]);
  // A model Pi does not list is refused before any request is made.
  expect(await checkProviderModel({ provider: "openrouter", model: "nobody/not-a-model", apiKey: "sk-or-test" }, signal, transport)).toEqual({ code: "model-unavailable" });
  expect(await checkProviderModel({ provider: "openrouter", model: "../../etc", apiKey: "sk-or-test" }, signal, transport)).toEqual({ code: "model-unavailable" });
  expect(calls.length).toBe(1);
});

test("a request sourced from the repository map sends the approved selection and nothing else", async () => {
  const prompt = "Explain refreshSession and what it depends on.";
  const preview = await previewAtlasContext(workspace, prompt, { tokenBudget: 700, deferred: true });
  expect(preview.deferred.length).toBeGreaterThan(0);
  const { models, seen } = scripted(({ request }) => `Used ${paths(request).join(", ")}. See packages/auth/src/session.ts:6-9.`);
  const options = { ...session("map", "map-1"), prompt, atlas: { tokenBudget: 700, deferred: true, id: preview.manifest.id } };
  const receipt = await runCodingSession(options, { models, stateDir });
  expect(receipt.status).toBe("done");
  expect(receipt.repositoryContext?.atlas?.generation).toBe(1);
  expect(seen.length).toBe(1);
  const sent = seen[0]!.request;
  expect(sent.task).toBe(prompt);
  expect(sent.repositoryContext).toBeUndefined();
  expect(sent.map).toEqual(preview.map);
  expect(sent.facts).toEqual(preview.skills.map(({ text }) => text));
  const excerpts = sent.excerpts as { path: string; content?: string; deferred?: true }[];
  expect(excerpts.filter(({ deferred }) => !deferred).map(({ path, content }) => [path, content])).toEqual(preview.excerpts.map(({ path, content }) => [path, content]));
  // Deferred excerpts are approved and saved, but their text was not sent.
  expect(excerpts.filter(({ deferred }) => deferred).every(({ content }) => content === undefined)).toBe(true);
  for (const { content } of preview.deferred) expect(seen[0]!.raw).not.toContain(JSON.stringify(content).slice(1, -1));
  const saved = await getSavedCodingRequestInput(session("map", "map-1"), { models, stateDir, workspaceBinding: workspace });
  expect(saved?.groups[0]?.files.length).toBe(preview.excerpts.length + preview.deferred.length);

  // A different budget is a different selection: the approved ID no longer matches.
  await expect(runCodingSession({ ...session("map", "map-2"), prompt, atlas: { tokenBudget: 900, id: preview.manifest.id } }, { models, stateDir }))
    .rejects.toThrow("Preview it again");
  await expect(runCodingSession({ ...session("map", "map-3"), prompt, files: ["README.md"], atlas: { id: preview.manifest.id } }, { models, stateDir }))
    .rejects.toThrow("Choose one source");
  expect(seen.length).toBe(1);
});

test("a plan is local, reproducible, and splits work only when it should", async () => {
  const single = await previewCodingOrchestration({ ...session("plan", "p"), prompt: "refreshSession", orchestration: {} }, { models: scripted(() => "").models });
  expect(single.plan).toMatchObject({ mode: "single", orders: [{ id: "w1", scope: "." }] });
  expect(single.plan.reason).toContain("one part of the repository");
  expect(single.plan.synthesis).toBeUndefined();

  const { models, seen } = scripted(() => "unused");
  const fanOut = await previewCodingOrchestration({ ...session("plan", "p"), prompt: task, orchestration: { workers: 2, tokenBudget: 900 } }, { models });
  expect(seen.length).toBe(0);
  expect(fanOut.plan.mode).toBe("fan-out");
  expect(fanOut.plan.orders.map(({ scope }) => scope).sort()).toEqual(["packages/auth", "packages/billing"]);
  for (const order of fanOut.plan.orders) expect(order.manifest.files.every(({ path }) => path.startsWith(`${order.scope}/`))).toBe(true);
  expect(fanOut.plan.synthesis?.route.choice).toEqual({ provider, model: "strong" });
  expect(fanOut.input.orders.map(({ requestId }) => requestId)).toEqual(["p-work-1", "p-work-2"]);
  const again = await previewCodingOrchestration({ ...session("plan", "other-request"), prompt: task, orchestration: { workers: 2, tokenBudget: 900 } }, { models });
  expect(again.plan.id).toBe(fanOut.plan.id);
  expect((await previewCodingOrchestration({ ...session("plan", "p"), prompt: task, orchestration: { workers: 1, tokenBudget: 900 } }, { models })).plan.mode).toBe("single");
  // With no key at hand the plan can still be read, and says so.
  const listed = listCodingModels().find((entry) => entry.provider === provider)!.models[0]!.id;
  const keyless = await previewCodingOrchestration({ ...session("plan", "p", listed), prompt: task, orchestration: { workers: 2, tokenBudget: 900 } }, { allowEnvKey: false });
  expect(keyless.plan.warnings?.[0]).toContain("No credential for openai");
  await expect(previewCodingOrchestration({ ...session("plan", "p"), prompt: task, orchestration: { workers: 9 } }, { models })).rejects.toThrow("between 1 and 4 workers");
  await expect(previewCodingOrchestration({ ...session("plan", "p"), prompt: "zeppelin ingress annotations", orchestration: {} }, { models })).rejects.toThrow("found no source");
});

test("workers see only their own scope, and a combining step answers from their reports", async () => {
  const orchestration = { workers: 2, tokenBudget: 900 };
  const { models, seen, faux } = scripted(({ request }) => {
    if (request.reports) return `Combined: ${(request.reports as { scope: string; report: string }[]).map(({ scope, report }) => `${scope} -> ${report}`).join(" | ")}`;
    const order = request.workOrder as { scope: string };
    return `Report for ${order.scope} citing ${paths(request)[0]}:1-3.`;
  });
  const { plan } = await previewCodingOrchestration({ ...session("orch", "o-1"), prompt: task, orchestration }, { models });
  const progress: string[] = [];
  const options = { ...session("orch", "o-1"), prompt: task, orchestration: { ...orchestration, id: plan.id } };
  const receipt = await runCodingSession(options, { models, stateDir, taskProgress: (value) => { for (const stage of value?.stages ?? []) progress.push(stage.kind); } });
  expect(receipt.status).toBe("done");
  if (receipt.status !== "done") return;
  const workers = seen.filter(({ request }) => request.workOrder);
  expect(workers.length).toBe(2);
  for (const { request } of workers) {
    const scope = (request.workOrder as { scope: string }).scope;
    // Context isolation: no path from another worker's scope, no manifest, no session history.
    expect(paths(request).every((path) => path.startsWith(`${scope}/`))).toBe(true);
    expect(request.repositoryContext).toBeUndefined();
    expect((request.workOrder as { deliverable: string }).deliverable).toContain("unified diff limited to this scope");
  }
  const combine = seen.find(({ request }) => request.reports)!;
  expect(combine.request.task).toBe(task);
  expect(JSON.stringify(combine.request)).not.toContain("AUTH_REFRESH");
  expect(receipt.text).toStartWith("Combined: ");
  expect(receipt.text).toContain("Report for packages/auth");
  expect(receipt.orchestration).toMatchObject({ mode: "fan-out", conflicts: [], outOfScope: [] });
  expect(receipt.orchestration!.orders.map(({ model, attempts, requestId }) => [model, attempts, requestId]).sort())
    .toEqual([["openai/strong", 1, "o-1-work-1"], ["openai/strong", 1, "o-1-work-2"]]);
  expect(receipt.usage.totalTokens).toBe(receipt.orchestration!.orders.reduce((total, order) => total + order.usage!.totalTokens, 0) + receipt.orchestration!.synthesis!.usage!.totalTokens);
  expect(progress).toContain("orchestration");
  expect(progress).toContain("work-order");

  // Reopening the same request returns the saved result without another model call.
  const calls = faux.state.callCount;
  const replay = await runCodingSession({ ...session("orch", "o-1") }, { models, stateDir });
  expect(replay.status === "done" && replay.text).toBe(receipt.text);
  expect(faux.state.callCount).toBe(calls);
  const status = await getCodingSessionStatus({ ...session("orch", "o-1"), includeReceipt: true }, { models, stateDir });
  expect(status.request).toMatchObject({ requestId: "o-1", status: "done" });
  expect(Object.keys(status.usage.models)).toEqual(["openai/strong"]);
  expect((await listStandaloneCodingRequests("orch", { stateDir })).requests).toEqual([{ requestId: "o-1", kind: "orchestration", status: "done" }]);
  const saved = await getSavedCodingRequestInput(session("orch", "o-1"), { models, stateDir, workspaceBinding: workspace });
  expect(saved?.prompt).toBe(task);
  expect(saved?.groups.map(({ label }) => label).sort()).toEqual(["packages/auth", "packages/billing"]);
  // A plan that no longer matches what was previewed is refused before anything is sent.
  await expect(runCodingSession({ ...session("orch", "o-2"), prompt: task, orchestration: { workers: 2, tokenBudget: 700, id: plan.id } }, { models, stateDir }))
    .rejects.toThrow("Preview the plan again");
  await expect(runCodingSession({ ...session("orch", "o-1"), prompt: task, orchestration: { ...orchestration, id: plan.id } }, { models, stateDir, requireNewRequest: true }))
    .rejects.toBeInstanceOf(CodingError);
});

test("a failed provider falls back to the next approved model with a fresh work order", async () => {
  const routing: RoutingPolicy = { version: 1, learn: false, roles: { worker: [{ provider, model: "cheap" }, { provider, model: "strong" }], orchestrator: [{ provider, model: "strong" }] } };
  const orchestration = { workers: 2, tokenBudget: 900, routing };
  const { models, seen } = scripted(({ model, request }) => {
    if (request.reports) return "Combined answer.";
    const scope = (request.workOrder as { scope: string }).scope;
    if (model === "cheap" && scope === "packages/billing") return { error: "upstream unavailable" };
    return `Report for ${scope} from ${model}.\n\n--- a/packages/contracts/src/index.ts\n+++ b/packages/contracts/src/index.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n`;
  });
  const { plan } = await previewCodingOrchestration({ ...session("fallback", "f-1"), prompt: task, orchestration }, { models });
  expect(plan.orders.every(({ route }) => route.choice.model === "cheap" && route.fallbacks[0]?.model === "strong")).toBe(true);
  const receipt = await runCodingSession({ ...session("fallback", "f-1"), prompt: task, orchestration: { ...orchestration, id: plan.id } }, { models, stateDir });
  expect(receipt.status).toBe("done");
  if (receipt.status !== "done") return;
  const byScope = Object.fromEntries(receipt.orchestration!.orders.map((order) => [order.scope, order]));
  expect(byScope["packages/auth"]).toMatchObject({ model: "openai/cheap", attempts: 1 });
  expect(byScope["packages/billing"]).toMatchObject({ model: "openai/strong", attempts: 2 });
  // The stronger model started from the work order alone, not from the failed attempt's transcript.
  const retry = seen.find(({ model, request }) => model === "strong" && (request.workOrder as { scope: string } | undefined)?.scope === "packages/billing")!;
  expect(retry.request.workOrder).toBeDefined();
  // Both workers proposed a change to the same shared file, outside their scopes. The reviewer is told.
  expect(receipt.orchestration!.conflicts).toEqual(["packages/contracts/src/index.ts"]);
  expect(receipt.orchestration!.outOfScope.length).toBe(2);
  expect(receipt.text).toContain("More than one worker proposed changes to: packages/contracts/src/index.ts");
  expect(Object.keys((await getCodingSessionStatus(session("fallback", "f-1"), { models, stateDir })).usage.models).sort()).toEqual(["openai/cheap", "openai/strong"]);

  // A review of the result teaches the route statistics and the map.
  const learned = await recordCodingOutcome({ workspace, session: "fallback", requestId: "f-1", outcome: "accepted", receipt });
  expect(learned.routes).toBe(3);
  expect(learned.learned.map(({ requestId }) => requestId).sort()).toEqual(["f-1-work-1", "f-1-work-2"]);
  const learning = Learning.open(workspace)!;
  try {
    expect(learning.routeRows().map(({ role, model, runs }) => [role, model, runs]).sort()).toEqual([
      ["orchestrator", "openai/strong", 1], ["worker", "openai/cheap", 1], ["worker", "openai/strong", 1]]);
  } finally { learning.close(); }
  // Recording the same review twice changes nothing.
  expect((await recordCodingOutcome({ workspace, session: "fallback", requestId: "f-1", outcome: "accepted", receipt })).routes).toBe(0);
});

test("when the reports cannot be combined they are returned as written, and a cancelled plan stops its workers", async () => {
  const orchestration = { workers: 2, tokenBudget: 900 };
  const failing = scripted(({ request }) => request.reports ? { error: "combiner down" } : `Report for ${(request.workOrder as { scope: string }).scope}.`);
  const first = await previewCodingOrchestration({ ...session("degraded", "d-1"), prompt: task, orchestration }, { models: failing.models });
  const receipt = await runCodingSession({ ...session("degraded", "d-1"), prompt: task, orchestration: { ...orchestration, id: first.plan.id } }, { models: failing.models, stateDir });
  expect(receipt.status).toBe("done");
  if (receipt.status !== "done") return;
  expect(receipt.text).toContain("## packages/auth\n\nReport for packages/auth.");
  expect(receipt.text).toContain("could not be combined by a model");
  expect(receipt.orchestration!.synthesis?.text).toBeUndefined();

  const controller = new AbortController();
  const slow = scripted(() => { controller.abort(); return "late"; });
  const second = await previewCodingOrchestration({ ...session("cancelled", "c-1"), prompt: task, orchestration }, { models: slow.models });
  const stopped = await runCodingSession({ ...session("cancelled", "c-1"), prompt: task, orchestration: { ...orchestration, id: second.plan.id } },
    { models: slow.models, stateDir, signal: controller.signal });
  expect(stopped).toMatchObject({ status: "unanswered", reason: "Orchestrated request cancelled." });
  expect((await cancelCodingRequest(session("cancelled", "c-1"), { models: slow.models, stateDir })).status).toBe("unanswered");
});
