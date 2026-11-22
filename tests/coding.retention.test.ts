import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer, type ApiServer } from "../src/api.ts";
import { ensureExtensionCapableSqlite } from "../src/core/engine/custom-sqlite.ts";

// This scenario settles six Pi transcripts serially before exercising restarts.
test("project transcript retention protects unfinished work and refuses replay of expired IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "okb-coding-retention-"));
  const workspace = join(root, "workspace");
  const stateDir = join(root, "state");
  const token = "local-coding-retention";
  const model = "retention-test";
  const models = createModels();
  const faux = fauxProvider({ provider: "openai", models: [{ id: model }] });
  models.setProvider(faux.provider);
  type Run = { id: string; session: string; status: string; error: string | null };
  let server: ApiServer | undefined;

  const open = (readonly = false) => {
    server = createApiServer({ bundle: workspace, port: 0, token, readonly, coding: { stateDir, models } });
  };
  const close = async () => {
    await server?.stop();
    server = undefined;
  };
  const request = async (path: string, data?: object, member?: string) => {
    const method = data ? "POST" : "GET";
    try {
      const response = await fetch(new URL("api/coding" + path, server!.url), {
        method,
        headers: { ...(member ? { authorization: `Bearer ${member}` } : { "x-okb-token": token }),
          ...(data ? { "content-type": "application/json" } : {}) },
        body: data ? JSON.stringify(data) : undefined,
        // The fixture repeatedly stops and reopens the server while exercising
        // retention. Its requests use fresh sockets and consume every reply.
        keepalive: false,
        signal: AbortSignal.timeout(12_000),
      });
      return { status: response.status, ok: response.ok, body: await response.json() };
    } catch (error) {
      throw new Error(`Retention fixture ${method} ${path} did not complete.`, { cause: error });
    }
  };
  const call = async <T>(path: string, data?: object) => {
    const response = await request(path, data);
    const body = response.body as { result: T; error?: string };
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    return body.result;
  };
  const waitFor = async (description: string, check: () => Promise<boolean>) => {
    const limit = Date.now() + 6000;
    while (Date.now() < limit) {
      if (await check()) return;
      await Bun.sleep(20);
    }
    throw new Error(`Timed out waiting for ${description}.`);
  };
  function withCatalog<T>(use: (database: Database) => T) {
    ensureExtensionCapableSqlite();
    using database = new Database(join(stateDir, "projects.sqlite"));
    return use(database);
  }

  try {
    await mkdir(workspace);
    await writeFile(join(workspace, "app.ts"), "export const value = 1;\n");
    open();
    const settings = { workspace, provider: "openai", model, title: "Retention fixture" };
    const project = await call<{ id: string }>("/projects", settings);
    const other = await call<{ id: string }>("/projects", { ...settings, title: "Separate project" });
    const path = `/projects/${project.id}`;
    const otherPath = `/projects/${other.id}`;
    const member = await call<{ token: string }>(path + "/members", { name: "reviewer" });
    expect((await request(path + "/retention", undefined, member.token)).status).toBe(403);
    expect((await request(path + "/retention", { days: 1 }, member.token)).status).toBe(403);
    expect((await request(path + "/retention", { days: 0 })).status).toBe(400);
    expect(await call(path + "/retention")).toMatchObject({ days: null, active: true });

    const source = { source: "files", files: ["app.ts"] };
    const { id: previewId } = await call<{ id: string }>(path + "/preview", source);
    const task = { ...source, prompt: "Inspect the selected file.", approved: true, previewId, requestId: "first" };
    for (const [endpoint, session] of [
      [path, "expire"], [path, "recent"], [path, "pending-expiry"], [path, "recoverable"], [path, "prepared"], [otherPath, "expire"],
    ] as const) {
      faux.setResponses([fauxAssistantMessage("Scoped review result.")]);
      await call(endpoint + "/run", { ...task, session });
      await waitFor(`session ${session} to settle`, async () => {
        const run = (await call<Run[]>(endpoint + "/runs")).find((row) => row.session === session);
        if (run && run.status !== "running" && run.status !== "done")
          throw new Error(`Retention fixture session ${session} ended as ${run.status}${run.error ? `: ${run.error}` : ""}.`);
        return run?.status === "done";
      });
    }
    await close();

    withCatalog((db) => {
      db.exec("UPDATE runs SET updated = '2020-01-01T00:00:00.000Z'");
      using review = db.prepare("UPDATE runs SET reviewed = ? WHERE project = ? AND session IN ('recent', 'pending-expiry')");
      review.run(new Date().toISOString(), project.id);
      using interrupt = db.prepare("UPDATE runs SET status = 'interrupted' WHERE project = ? AND session = 'recoverable'");
      interrupt.run(project.id);
      using prepared = db.prepare("INSERT INTO applied_patches VALUES (?, 'prepared', 'first', 'id', 'hash', '[]', 'prepared', NULL)");
      prepared.run(project.id);
    });

    open();
    expect(await call<{ days: number | null; active: boolean; removed: number }>(path + "/retention", { days: 30 }))
      .toEqual({ days: 30, active: true, removed: 1 });
    const identity = { session: "expire", requestId: "first" };
    expect((await request(path + "/inspect", identity)).status).toBe(410);
    expect((await request(path + "/run", { ...task, ...identity })).status).toBe(410);
    expect(await call<Run[]>(path + "/runs")).toHaveLength(4);
    expect(await call<Run[]>(otherPath + "/runs")).toHaveLength(1);
    expect(await call(path + "/audit")).toContainEqual(expect.objectContaining({
      kind: "session_expired", actor: "system:transcript-retention", session: "expire",
    }));
    expect(await Bun.file(join(stateDir, `project-${project.id}`, "session-expire", "transcript.sqlite")).exists()).toBe(false);
    expect(faux.state.callCount).toBe(6);
    await close();

    withCatalog((db) => {
      db.exec("UPDATE runs SET reviewed = NULL WHERE session = 'recent'");
      // Simulate a stop after recording the deletion intent and before removing the transcript.
      using pending = db.prepare("INSERT INTO session_deletions(project, session, actor, automatic) VALUES (?, 'pending-expiry', 'system:transcript-retention', 1)");
      pending.run(project.id);
    });
    open(true);
    expect(await call(path + "/retention")).toMatchObject({ days: 30, active: false });
    expect(await call<Run[]>(path + "/runs")).toHaveLength(4);
    expect((await request(path + "/retention", { days: 1 })).status).toBe(403);
    await close();

    open();
    await waitFor("startup expiry", async () => withCatalog((db) => {
      using query = db.prepare("SELECT 1 FROM expired_requests WHERE project = ? AND session = 'recent'");
      return query.get(project.id) !== null;
    }));
    expect(await call<Run[]>(path + "/runs")).toHaveLength(2);
    expect((await request(path + "/inspect", { ...identity, session: "recent" })).status).toBe(410);
    expect((await request(path + "/inspect", { ...identity, session: "pending-expiry" })).status).toBe(410);
    expect(await call(path + "/retention", { days: null })).toMatchObject({ days: null, removed: 0 });
  } finally {
    await close();
    await rm(root, { recursive: true, force: true });
  }
}, 40_000);

test("retention uses alternative branch activity and expires the shared transcript as a unit", async () => {
  const root = await mkdtemp(join(tmpdir(), "okb-branch-retention-"));
  const workspace = join(root, "workspace");
  const stateDir = join(root, "state");
  const token = "local-alternative-branch-retention";
  const model = "branch-retention-test";
  const models = createModels();
  const faux = fauxProvider({ provider: "openai", models: [{ id: model }] });
  models.setProvider(faux.provider);
  type Run = { id: string; session: string; status: string };
  type Branch = { branchSession: string; status: string };
  let server: ApiServer | undefined;

  const open = () => {
    server = createApiServer({ bundle: workspace, port: 0, token, coding: { stateDir, models } });
  };
  const close = async () => {
    await server?.stop();
    server = undefined;
  };
  const request = (path: string, data?: object) => fetch(new URL("api/coding" + path, server!.url), {
    method: data ? "POST" : "GET",
    headers: { "x-okb-token": token, ...(data ? { "content-type": "application/json" } : {}) },
    body: data ? JSON.stringify(data) : undefined,
  });
  const call = async <T>(path: string, data?: object) => {
    const response = await request(path, data);
    const body = await response.json() as { result: T; error?: string };
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    return body.result;
  };
  function withCatalog(use: (database: Database) => void) {
    ensureExtensionCapableSqlite();
    using database = new Database(join(stateDir, "projects.sqlite"));
    use(database);
  }

  try {
    await mkdir(workspace);
    await writeFile(join(workspace, "app.ts"), "export const fixture = true;\n");
    open();
    const project = await call<{ id: string }>("/projects", { workspace, provider: "openai", model, title: "Alternative retention" });
    const path = `/projects/${project.id}`;
    const source = { source: "files", files: ["app.ts"] };
    const task = { ...source, prompt: "Review the supplied source.", approved: true };
    const transcript = (session: string) => join(stateDir, `project-${project.id}`, `session-${session}`, "transcript.sqlite");
    const runs = () => call<Run[]>(path + "/runs");
    const branches = () => call<Branch[]>(path + "/branches");
    const sweep = (days: number | null) => call<{ removed: number }>(path + "/retention", { days });
    async function finish(identity: { session: string; requestId: string }) {
      const preview = await call<{ id: string; branchContext?: { id: string } }>(path + "/preview", { ...source, session: identity.session });
      faux.setResponses([fauxAssistantMessage("Reviewed source.")]);
      await call(path + "/run", { ...task, ...identity, previewId: preview.id, branchContextId: preview.branchContext?.id });
      const deadline = Date.now() + 3500;
      while (Date.now() < deadline) {
        if ((await runs()).some((run) => run.session === identity.session && run.id === identity.requestId && run.status === "done"))
          return;
        await Bun.sleep(20);
      }
      throw new Error("Timed out waiting for the retention fixture run.");
    }
    async function branchFrom(identity: { session: string; requestId: string }) {
      await finish(identity);
      await call(path + "/review", { ...identity, decision: "accepted" });
      const { previewId } = await call<{ previewId: string }>(path + "/branches-preview", identity);
      return (await call<{ branchSession: string }>(path + "/branches", { ...identity, previewId })).branchSession;
    }

    const parent = { session: "parent", requestId: "root-review" };
    const emptyParent = { session: "parent-empty", requestId: "empty-root-review" };
    const branch = { session: await branchFrom(parent), requestId: "alternative-review" };
    const emptyBranch = await branchFrom(emptyParent);
    await finish(branch);
    await close();

    withCatalog((db) => {
      db.exec("UPDATE runs SET updated = '2020-01-01T00:00:00.000Z', reviewed = '2020-01-01T00:00:00.000Z' WHERE session IN ('parent', 'parent-empty')");
      db.exec("UPDATE conversation_branches SET created = '2020-01-01T00:00:00.000Z' WHERE parent_session = 'parent'");
    });
    open();
    // Only the branch's new run protects the first root. The second root only
    // has the recent creation receipt of a ready branch with no runs.
    expect(await sweep(30)).toMatchObject({ removed: 0 });
    expect(await Bun.file(transcript(parent.session)).exists()).toBe(true);
    expect(await Bun.file(transcript(emptyParent.session)).exists()).toBe(true);
    expect(await branches()).toContainEqual(expect.objectContaining({ branchSession: emptyBranch, status: "ready" }));
    expect((await runs()).some((run) => run.session === emptyBranch)).toBe(false);
    await sweep(null);
    await close();

    withCatalog((db) => {
      using ageBranch = db.prepare("UPDATE runs SET updated = '2020-01-01T00:00:00.000Z', status = 'interrupted' WHERE session = ?");
      ageBranch.run(branch.session);
      db.exec("UPDATE conversation_branches SET created = '2020-01-01T00:00:00.000Z' WHERE parent_session = 'parent-empty'");
    });
    open();
    expect(await sweep(30)).toMatchObject({ removed: 1 });
    expect(await Bun.file(transcript(parent.session)).exists()).toBe(true);
    expect(await Bun.file(transcript(emptyParent.session)).exists()).toBe(false);
    expect((await request(path + "/inspect", emptyParent)).status).toBe(410);
    expect((await request(path + "/preview", { ...source, session: emptyBranch })).status).toBe(404);
    expect(await branches()).toEqual([expect.objectContaining({ branchSession: branch.session, status: "ready" })]);
    expect(await runs()).toContainEqual(expect.objectContaining({ session: branch.session, status: "interrupted" }));
    await sweep(null);
    await close();

    withCatalog((db) => {
      using finishBranch = db.prepare("UPDATE runs SET status = 'done' WHERE session = ?");
      finishBranch.run(branch.session);
      using prepare = db.prepare("INSERT INTO applied_patches VALUES (?, ?, ?, 'fixture-preview', 'fixture-hash', '[]', 'prepared', NULL)");
      prepare.run(project.id, branch.session, branch.requestId);
    });
    open();
    // A prepared patch is catalogued under the alias. Its parent transcript
    // is still required to verify the saved response during recovery.
    expect(await sweep(30)).toMatchObject({ removed: 0 });
    expect(await Bun.file(transcript(parent.session)).exists()).toBe(true);
    expect(await runs()).toContainEqual(expect.objectContaining({ session: branch.session, status: "done" }));
    await sweep(null);
    await close();

    withCatalog((db) => {
      using markApplied = db.prepare("UPDATE applied_patches SET status = 'applied' WHERE project = ? AND session = ? AND request_id = ?");
      markApplied.run(project.id, branch.session, branch.requestId);
    });
    open();
    expect(await sweep(30)).toMatchObject({ removed: 1 });
    expect(await Bun.file(transcript(parent.session)).exists()).toBe(false);
    expect(await runs()).toEqual([]);
    expect(await branches()).toEqual([]);
    for (const identity of [parent, branch]) {
      expect((await request(path + "/inspect", identity)).status).toBe(410);
      expect((await request(path + "/run", { ...task, ...identity, previewId: "expired" })).status).toBe(410);
    }
    expect(await call(path + "/audit")).toContainEqual(expect.objectContaining({ kind: "session_expired", session: parent.session }));
    expect(faux.state.callCount).toBe(3);
  } finally {
    await close();
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);
