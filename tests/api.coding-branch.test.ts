import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer, type ApiServer } from "../src/api.ts";
import type { CodingSessionStatusResult, SavedCodingRequestInput } from "../src/core/coding/durable.ts";
import type { CodingRunReport } from "../src/core/coding/run-report.ts";
import { ensureExtensionCapableSqlite } from "../src/core/engine/custom-sqlite.ts";

const ownerToken = "local-branch-owner-fixture";
const model = "alternative-review-fixture";
const modelKey = `openai/${model}`;
const contentId = /^[a-f0-9]{64}$/;

type Identity = { session: string; requestId: string };
type Run = { session: string; id: string; status: string; review: string | null; error: string | null; branch?: Identity };
type Inspection = { run: Run; pi?: CodingSessionStatusResult; report?: CodingRunReport; alternativeBranchEligible?: true };
type Branch = Identity & { branchSession: string; status: "pending" | "ready" };
type BranchContext = { id: string; history: unknown[]; inheritedEntries: number; estimatedTokens: number; providerContinuity: boolean };
type ForkPreview = Omit<BranchContext, "id"> & Identity & { branchSession: string; previewId: string };
type SourcePreview = { id: string; files: { path: string; content: string }[]; branchContext?: BranchContext };

test("owner alternative reviews bind inherited context and source, isolate usage, and survive API restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "okb-api-alternative-review-"));
  const workspace = join(root, "workspace");
  const stateDir = join(root, "state");
  const models = createModels();
  const faux = fauxProvider({ provider: "openai", models: [{ id: model }] });
  models.setProvider(faux.provider);
  const earlierAnswer = "Earlier reviewed result fixture.";
  const acceptedAnswer = "Accepted boundary result fixture.";
  const laterAnswer = "Parent-only result after the fork fixture.";
  const alternativeAnswer = "Independent alternative result fixture.";
  const providerMessages: string[] = [];
  faux.setResponses([earlierAnswer, acceptedAnswer, laterAnswer, alternativeAnswer].map((answer) => (input) => {
    providerMessages.push(JSON.stringify(input.messages));
    return fauxAssistantMessage(answer);
  }));

  const boot = () => createApiServer({ bundle: workspace, port: 0, token: ownerToken, coding: { stateDir, models } });
  let server: ApiServer | undefined;
  const request = (path: string, data?: unknown, member?: string) => fetch(new URL(`api/coding${path}`, server!.url), {
    method: data === undefined ? "GET" : "POST",
    headers: {
      ...(member ? { authorization: `Bearer ${member}` } : { "x-okb-token": ownerToken }),
      ...(data === undefined ? {} : { "content-type": "application/json" }),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const call = async <T>(path: string, data?: unknown, member?: string) => {
    const response = await request(path, data, member);
    const body = await response.json() as { result: T; error?: string };
    if (!response.ok) throw new Error(`${path} (${response.status}): ${body.error}`);
    return body.result;
  };
  const denied = async (path: string, data: unknown, status: number, message?: string, member?: string) => {
    const response = await request(path, data, member);
    if (message) expect(await response.json()).toMatchObject({ error: expect.stringContaining(message) });
    expect(response.status).toBe(status);
  };

  try {
    await mkdir(join(workspace, "src"), { recursive: true });
    server = boot();
    const { id: projectId } = await call<{ id: string }>("/projects", {
      title: "Branch fixture", workspace, scopes: ["src"], provider: "openai", model,
    });
    const base = `/projects/${projectId}`;
    const { token: member } = await call<{ token: string }>(base + "/members", { name: "branch-reviewer" });
    const file = "src/review.ts";
    const source = { source: "files", files: [file] };
    const setSource = (text: string) => writeFile(join(workspace, "src", "review.ts"), text);
    const inspect = (run: Identity, token?: string) => call<Inspection>(base + "/inspect", run, token);
    const waitForRun = async (run: Identity, status = "done") => {
      const deadline = Date.now() + 4000;
      for (;;) {
        const view = await inspect(run);
        if (view.run.status !== "running" && (view.pi?.request?.receipt || view.run.status !== "done")) {
          expect(view.run, JSON.stringify(view.run)).toMatchObject({ status, session: run.session, id: run.requestId });
          return view;
        }
        if (Date.now() > deadline) throw new Error(`Run did not settle for ${run.session}/${run.requestId}: ${JSON.stringify(view.run)}`);
        await Bun.sleep(20);
      }
    };
    const runParent = async (identity: Identity, prompt: string, content: string) => {
      await setSource(content);
      const preview = await call<SourcePreview>(base + "/preview", source);
      await call(base + "/run", { ...source, ...identity, prompt, previewId: preview.id, approved: true });
      return waitForRun(identity);
    };
    const usage = (view: Inspection) => view.pi?.usage.models[modelKey]?.totalTokens ?? 0;

    const earlier = { session: "root-review", requestId: "earlier" };
    const earlierView = await runParent(earlier, "Review earlier source fixture.", "export const initialFixture = 'first';\n");
    await denied(base + "/branches-preview", earlier, 409, "Accept a completed result");
    await call(base + "/review", { ...earlier, decision: "accepted" });
    const staleFork = await call<ForkPreview>(base + "/branches-preview", earlier);
    expect(faux.state.callCount).toBe(1);
    expect(await call(base + "/branches")).toEqual([]);

    const accepted = { session: earlier.session, requestId: "same-request-id" };
    const acceptedPrompt = "Review the boundary source fixture.";
    const acceptedBytes = "export const boundarySourceFixture = 'reviewed';\n";
    const acceptedView = await runParent(accepted, acceptedPrompt, acceptedBytes);
    await call(base + "/review", { ...accepted, decision: "accepted" });
    expect((await inspect(earlier)).alternativeBranchEligible).toBeUndefined();
    expect((await inspect(accepted)).alternativeBranchEligible).toBe(true);
    expect((await inspect(accepted, member)).alternativeBranchEligible).toBeUndefined();
    await denied(base + "/branches-preview", earlier, 409, "latest completed answer");
    await denied(base + "/branches", { ...earlier, previewId: staleFork.previewId }, 409);
    await denied(base + "/branches-preview", accepted, 403, undefined, member);

    const fork = await call<ForkPreview>(base + "/branches-preview", accepted);
    expect(fork).toMatchObject({ ...accepted, provider: "openai", model, providerContinuity: false });
    expect(fork.previewId).toMatch(contentId);
    expect(fork.branchSession).toBe(`alt-${fork.previewId.slice(0, 60)}`);
    expect(fork.inheritedEntries).toBeGreaterThan(0);
    expect(fork.estimatedTokens).toBeGreaterThan(0);
    expect(JSON.stringify(fork.history)).toContain(acceptedPrompt);
    expect(JSON.stringify(fork.history)).toContain("boundarySourceFixture");
    expect(JSON.stringify(fork.history)).toContain(acceptedAnswer);
    expect(await call(base + "/branches")).toEqual([]);
    const approval = { ...accepted, previewId: fork.previewId };
    await denied(base + "/branches", approval, 403, undefined, member);
    expect(await call(base + "/branches", approval)).toMatchObject({ ...accepted, branchSession: fork.branchSession, created: true });
    expect(await call(base + "/branches", approval)).toMatchObject({ branchSession: fork.branchSession, created: true, replayed: true });
    expect(await call<Branch[]>(base + "/branches")).toEqual([expect.objectContaining({ ...accepted, branchSession: fork.branchSession, status: "ready" })]);
    await denied(base + "/branches", undefined, 403, undefined, member);
    expect((await inspect(accepted)).alternativeBranchEligible).toBeUndefined();
    expect(faux.state.callCount).toBe(2);

    const later = { session: earlier.session, requestId: "after-fork" };
    const laterPrompt = "Parent-only task after the fork fixture.";
    const laterBytes = "export const parentOnlyFileFixture = 'later';\n";
    const parentView = await runParent(later, laterPrompt, laterBytes);
    const parentTokens = usage(parentView);
    expect(parentTokens).toBeGreaterThan(0);
    const requestTokens = (view: Inspection) => view.pi?.request?.usage?.totalTokens ?? 0;
    expect(parentTokens).toBe(requestTokens(earlierView) + requestTokens(acceptedView) + requestTokens(parentView));

    const alternative = { session: fork.branchSession, requestId: accepted.requestId };
    const alternativePrompt = "Assess an alternative interpretation of the fixture.";
    const alternativeBytes = "export const alternativeFileFixture = 'alternative';\n";
    await setSource(alternativeBytes);
    const selection = { ...source, session: alternative.session };

    await server.stop();
    server = undefined;
    // Simulate loss of the final catalog write after Pi persisted the fork receipt.
    ensureExtensionCapableSqlite();
    {
      using catalog = new Database(join(stateDir, "projects.sqlite"), { readwrite: true, create: false });
      using markPending = catalog.prepare("UPDATE conversation_branches SET status = 'pending' WHERE project = ? AND session = ?");
      expect(markPending.run(projectId, fork.branchSession).changes).toBe(1);
    }
    server = boot();
    expect(await call<Branch[]>(base + "/branches")).toMatchObject([{ ...accepted, branchSession: fork.branchSession,
      status: "pending", previewId: fork.previewId }]);
    await denied(base + "/preview", selection, 409, "Finish creating the approved alternative branch");
    expect(await call(base + "/branches", approval)).toMatchObject({ ...accepted, branchSession: fork.branchSession, created: true, replayed: true });
    expect(await call<Branch[]>(base + "/branches")).toMatchObject([{ ...accepted, branchSession: fork.branchSession, status: "ready" }]);
    expect(faux.state.callCount).toBe(3);

    await denied(base + "/preview", selection, 403, undefined, member);
    const preview = await call<SourcePreview>(base + "/preview", selection);
    expect(preview.files).toEqual([{ path: file, content: alternativeBytes }]);
    expect(preview.branchContext?.id).toMatch(contentId);
    expect(preview.branchContext).toMatchObject({ history: fork.history,
      inheritedEntries: fork.inheritedEntries, providerContinuity: false });
    const task = { ...source, ...alternative, prompt: alternativePrompt, previewId: preview.id, approved: true };
    const approved = { ...task, branchContextId: preview.branchContext!.id };
    await denied(base + "/run", approved, 403, undefined, member);
    await denied(base + "/run", task, 400, "branchContextId");
    await denied(base + "/run", { ...approved, approved: false }, 400, "confirm");
    await denied(base + "/run", { ...approved, branchContextId: "f".repeat(64) }, 409, "branch context changed");
    await setSource("export const rejectedUnapprovedFileFixture = true;\n");
    await call(base + "/run", approved);
    expect((await waitForRun(alternative, "failed")).run.error).toContain("selected files changed");
    expect(faux.state.callCount).toBe(3);
    await setSource(alternativeBytes);

    expect(await call(base + "/run", approved)).toMatchObject({ session: alternative.session, id: alternative.requestId, status: "running", branch: accepted });
    const alternativeView = await waitForRun(alternative);
    expect(alternativeView.pi?.request?.receipt).toMatchObject({ text: alternativeAnswer });
    expect(faux.state.callCount).toBe(4);
    expect(providerMessages).toHaveLength(4);
    expect(providerMessages[2]).toContain(laterPrompt);
    for (const value of [acceptedPrompt, "boundarySourceFixture", acceptedAnswer, alternativePrompt, "alternativeFileFixture"])
      expect(providerMessages[3]).toContain(value);
    for (const value of [laterPrompt, laterAnswer, "parentOnlyFileFixture", "rejectedUnapprovedFileFixture"])
      expect(providerMessages[3]).not.toContain(value);
    expect(usage(await inspect(accepted))).toBe(parentTokens);
    const alternativeTokens = usage(alternativeView);
    expect(alternativeTokens).toBeGreaterThan(0);
    expect(alternativeTokens).toBe(requestTokens(alternativeView));
    expect(alternativeView.report?.usage).toEqual(alternativeView.pi?.usage);

    const reviewed = await call<Run>(base + "/review", { ...alternative, decision: "accepted" }, member);
    expect(reviewed).toMatchObject({ review: "accepted", reviewer: "human:branch-reviewer", branch: accepted });
    expect(await call<SavedCodingRequestInput>(base + "/source-inspect", alternative, member)).toEqual({
      prompt: alternativePrompt, groups: [{ files: [{ path: file, text: alternativeBytes }] }],
    });
    expect((await inspect(alternative, member)).alternativeBranchEligible).toBeUndefined();
    expect((await inspect(accepted, member)).pi?.request?.receipt).toMatchObject({ text: acceptedAnswer });
    const after = await call<SourcePreview>(base + "/preview", selection);
    expect(after.branchContext?.id).not.toBe(preview.branchContext?.id);
    expect(JSON.stringify(after.branchContext?.history)).toContain(alternativeAnswer);
    await denied(base + "/run", { ...approved, requestId: "next-branch-request" }, 409, "branch context changed");

    await server.stop();
    server = undefined;
    server = boot();
    expect(await call<Branch[]>(base + "/branches")).toMatchObject([{ ...accepted, branchSession: fork.branchSession, status: "ready" }]);
    expect(await call<Run[]>(base + "/runs", undefined, member)).toEqual(expect.arrayContaining([
      expect.objectContaining({ session: accepted.session, id: accepted.requestId, review: "accepted" }),
      expect.objectContaining({ session: alternative.session, id: alternative.requestId, review: "accepted", branch: accepted }),
    ]));
    const reopened = await inspect(alternative, member);
    expect(reopened.pi?.request?.receipt).toMatchObject({ text: alternativeAnswer });
    expect(usage(reopened)).toBe(alternativeTokens);
    expect(usage(await inspect(accepted))).toBe(parentTokens);
    expect(await call(base + "/run", approved)).toMatchObject({ session: alternative.session, id: alternative.requestId, status: "done" });
    expect(faux.state.callCount).toBe(4);

    const transcript = join(stateDir, `project-${projectId}`, `session-${accepted.session}`, "transcript.sqlite");
    expect(await Bun.file(transcript).exists()).toBe(true);
    await denied(base + "/delete-session", { session: alternative.session, confirm: alternative.session }, 409, "parent transcript");
    expect(await call(base + "/delete-session", { session: accepted.session, confirm: accepted.session })).toEqual({
      session: accepted.session, deleted: true,
    });
    expect(await call(base + "/branches")).toEqual([]);
    expect(await call(base + "/runs", undefined, member)).toEqual([]);
    await denied(base + "/inspect", accepted, 404);
    await denied(base + "/inspect", alternative, 404, undefined, member);
    await denied(base + "/source-inspect", alternative, 404, undefined, member);
    await denied(base + "/preview", selection, 404, "alternative branch is unavailable");
    expect(await Bun.file(transcript).exists()).toBe(false);
    expect(faux.state.callCount).toBe(4);
  } finally {
    await server?.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
