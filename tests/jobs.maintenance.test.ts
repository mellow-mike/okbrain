import { expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OkbConfig } from "../src/core/config.ts";
import { openLocalContext } from "../src/core/context.ts";
import { acquireJobsLock, JobLockError, runJobs } from "../src/core/jobs/worker.ts";
import { maintenanceApprovals, runScheduledMaintenance } from "../src/core/operations.ts";

const note = (title: string, body: string, privateNote = false) =>
  `---\ntype: note\ntitle: ${title}\n${privateNote ? "db_only: true\n" : ""}---\n${body}\n`;

test("a scheduled pass shares the job lock and stops before the next job without process signal handlers", async () => {
  const root = await mkdtemp(join(tmpdir(), "okb-scheduled-worker-"));
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const listenerCount = process.listenerCount("SIGTERM");
  const run = runJobs(root, [
    { name: "first", async run() { started.resolve(); await finish.promise; return "ran"; } },
    { name: "next", async run() { throw new Error("must not start"); } },
  ], { signal: controller.signal, canWrite: () => true });
  try {
    await started.promise;
    expect(process.listenerCount("SIGTERM")).toBe(listenerCount);
    expect(() => acquireJobsLock(root)).toThrow(JobLockError);
    controller.abort();
    finish.resolve();
    expect(await run).toMatchObject([{ name: "first", ok: true }, { name: "next", skipped: true }]);
  } finally {
    finish.resolve();
    await run.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("a scheduled pass rechecks access after preflight and skips read-only brains without creating a lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "okb-scheduled-policy-"));
  const local = openLocalContext(root, true, true);
  let writable = true;
  try {
    const signal = new AbortController().signal;
    const blocked = await runScheduledMaintenance(local.ctx, { jobs: ["index"], canWrite: () => true, signal });
    expect(blocked).toMatchObject({ status: "skipped", jobs: [{ name: "index", status: "skipped" }] });
    expect(existsSync(join(root, ".okb"))).toBe(false);
    const result = await runJobs(root, [{ name: "guarded", async skip() { writable = false; return undefined; }, async run() { throw new Error("must not start"); } }],
      { signal, canWrite: () => writable });
    expect(result).toMatchObject([{ skipped: true, detail: "skipped: the brain mount changed or is read-only" }]);
    expect(existsSync(join(root, ".okb", "jobs.lock"))).toBe(false);
  } finally { await local.close(); await rm(root, { recursive: true, force: true }); }
});

test("scheduled embeddings bind settings, use the existing vector store, cap public notes, and never send private text", async () => {
  const root = await mkdtemp(join(tmpdir(), "okb-scheduled-embedding-"));
  const local = openLocalContext(root);
  const calls: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const body = await req.json() as { input: string[]; model: string };
    expect(new URL(req.url).pathname).toBe("/approved/embeddings");
    expect(body.model).toBe("maintenance-model");
    calls.push(...body.input);
    return Response.json({ data: body.input.map(() => ({ embedding: [1, 0, 0, 0] })) });
  } });
  const keys = ["OKB_AI_PROVIDER", "OKB_EMBED_PROVIDER", "OKB_EMBED_MODEL", "OKB_EMBED_BASE_URL"] as const;
  const env = keys.map((key) => [key, process.env[key]] as const);
  try {
    for (const key of keys) delete process.env[key];
    const config: OkbConfig = { ai: { provider: "ollama", embedModel: "maintenance-model", embedBaseUrl: new URL("approved", server.url).href } };
    local.ctx.config = () => config;
    const options = { jobs: ["embed"], canWrite: () => true, signal: new AbortController().signal };
    await writeFile(join(root, "index.md"), "# Scheduled fixture\n");
    await mkdir(join(root, "db_only"));
    await writeFile(join(root, "db_only", "private.md"), note("Private folder", "LOCAL-ONLY-FOLDER"));
    await writeFile(join(root, "hidden.md"), note("Private marker", "LOCAL-ONLY-MARKER", true));
    await writeFile(join(root, "malformed.md"), "---\ntype: [unclosed\n---\nUnparseable\n");
    await Promise.all(Array.from({ length: 101 }, (_, i) => writeFile(join(root, `note-${i}.md`), note(`Fixture ${i}`, `Public scheduled note ${i}.`))));
    const store = await local.ctx.vectors(true);
    const meta = { provider: "ollama", model: "maintenance-model", dim: 4 };
    await store.reset(meta, null);
    for (const id of ["db_only/private", "hidden", "malformed"])
      await store.replace(id, "fixture-before-schedule", [{ seq: 0, text: "Previously embedded fixture", vector: [0, 1, 0, 0] }], meta);
    expect((await maintenanceApprovals(local.ctx)).embedding).toBeNull();
    config.ai!.embedProvider = "ollama";
    const { embedding } = await maintenanceApprovals(local.ctx);
    expect(embedding).toMatchObject({ provider: "ollama", model: "maintenance-model", endpoint: config.ai!.embedBaseUrl, limit: 100 });
    expect(await runScheduledMaintenance(local.ctx, options)).toMatchObject({ status: "skipped" });
    const base = config.ai!.embedBaseUrl!;
    config.ai!.embedBaseUrl = new URL("changed", server.url).href;
    expect((await maintenanceApprovals(local.ctx)).embedding?.id).not.toBe(embedding?.id);
    const approved = { ...options, approvals: { embed: embedding!.id } };
    expect(await runScheduledMaintenance(local.ctx, approved)).toMatchObject({ status: "skipped", message: expect.stringContaining("approve") });
    expect(calls).toEqual([]);
    config.ai!.embedBaseUrl = base;
    expect(await runScheduledMaintenance(local.ctx, approved)).toMatchObject({ status: "completed", jobs: [{ name: "embed", status: "completed" }] });
    expect(calls).toHaveLength(100);
    expect(calls.every((input) => input.includes("Public scheduled note"))).toBe(true);
    const hashes = await store.embeddedHashes();
    expect(hashes.size).toBe(102);
    expect(hashes.get("db_only/private")).toBe("fixture-before-schedule");
    expect(hashes.get("hidden")).toBe("fixture-before-schedule");
    expect(hashes.has("malformed")).toBe(false);
  } finally {
    for (const [key, value] of env) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await local.close();
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

test("a separately approved RSS pass indexes the imported note without invoking embeddings", async () => {
  const root = await mkdtemp(join(tmpdir(), "okb-scheduled-rss-"));
  const local = openLocalContext(root);
  const approvedFeed = "https://192.0.2.5/feed?private-token=reader-fixture";
  const config: OkbConfig = { rss: { feeds: [approvedFeed] } };
  local.ctx.config = () => config;
  const seen: string[] = [];
  const mockFetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    seen.push(url);
    if (url !== approvedFeed) throw new Error("Unexpected scheduled network request");
    return new Response(`<rss version="2.0"><channel><title>Fixture feed</title><item><title>Example item</title><link>https://example.test/item</link><description>Fixture copy.</description></item></channel></rss>`);
  }, { preconnect: fetch.preconnect });
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(mockFetch);
  try {
    const vectors = await local.ctx.vectors(true);
    await vectors.reset({ provider: "ollama", model: "nomic-embed-text", dim: 4 }, null);
    const options = { jobs: ["rss", "index"], canWrite: () => true, signal: new AbortController().signal };
    const { rss } = await maintenanceApprovals(local.ctx);
    expect(rss).toMatchObject({ count: 1 });
    expect(JSON.stringify(rss)).not.toContain("reader-fixture");
    config.rss!.feeds = [approvedFeed.replace("reader-fixture", "changed")];
    const approved = { ...options, approvals: { rss: rss!.id } };
    expect(await runScheduledMaintenance(local.ctx, approved)).toMatchObject({ status: "completed", jobs: [
      { name: "index", status: "completed" }, { name: "rss", status: "skipped" },
    ] });
    expect(seen).toEqual([]);
    config.rss!.feeds = [approvedFeed];
    const result = await runScheduledMaintenance(local.ctx, approved);
    expect(result).toMatchObject({ status: "completed", jobs: [{ name: "index", status: "completed" }, { name: "rss", status: "completed" }] });
    expect(seen).toEqual([approvedFeed]);
    expect(JSON.stringify(result)).not.toContain("reader-fixture");
    expect(JSON.stringify(result)).not.toContain("Example item");
    expect(await readFile(join(root, "references", "example-item.md"), "utf8")).toContain("Fixture copy.");
    expect((await (await local.ctx.engine()).search("Fixture")).map(({ id }) => id)).toContain("references/example-item");
    expect((await vectors.embeddedHashes()).size).toBe(0);
  } finally {
    fetcher.mockRestore();
    await local.close();
    await rm(root, { recursive: true, force: true });
  }
});
