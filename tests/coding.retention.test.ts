import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer, type ApiServer } from "../src/api.ts";
import { ensureExtensionCapableSqlite } from "../src/core/engine/custom-sqlite.ts";

test("project transcript retention protects unfinished work and refuses replay of expired IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "okb-coding-retention-"));
  const workspace = join(root, "workspace");
  const stateDir = join(root, "state");
  const token = "local-coding-retention";
  const model = "retention-test";
  const models = createModels();
  const faux = fauxProvider({ provider: "openai", models: [{ id: model }] });
  models.setProvider(faux.provider);
  type Run = { id: string; session: string; status: string };
  let server: ApiServer | undefined;

  const open = (readonly = false) => {
    server = createApiServer({ bundle: workspace, port: 0, token, readonly, coding: { stateDir, models } });
  };
  const close = async () => {
    await server?.stop();
    server = undefined;
  };
  const request = (path: string, data?: object, member?: string) => fetch(new URL("api/coding" + path, server!.url), {
    method: data ? "POST" : "GET",
    headers: { ...(member ? { authorization: `Bearer ${member}` } : { "x-okb-token": token }),
      ...(data ? { "content-type": "application/json" } : {}) },
    body: data ? JSON.stringify(data) : undefined,
  });
  const call = async <T>(path: string, data?: object) => {
    const response = await request(path, data);
    const body = await response.json() as { result: T; error?: string };
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    return body.result;
  };
  const waitFor = async (check: () => Promise<boolean>) => {
    const limit = Date.now() + 3500;
    while (Date.now() < limit) {
      if (await check()) return;
      await Bun.sleep(20);
    }
    throw new Error("Timed out waiting on the Coding API.");
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
      await waitFor(async () => (await call<Run[]>(endpoint + "/runs")).find((row) => row.session === session)?.status === "done");
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
    await waitFor(async () => withCatalog((db) => {
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
}, 10_000);
