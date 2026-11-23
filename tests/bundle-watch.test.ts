import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApiServer } from "../src/api.ts";
import { loadConfig, saveConfig } from "../src/core/config.ts";
import { BundleWatcher, type BundleWatchStatus } from "../src/core/engine/bundle-watch.ts";
import { openSqliteEngine } from "../src/core/engine/sqlite.ts";
import { okb } from "./helpers.ts";

const token = "test-local-bundle-watch-token";
const path = "api/brains/watch";
const article = (title: string, body: string) => `---\ntype: note\ntitle: ${title}\n---\n${body}\n`;

async function until<T>(get: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 6_000;
  for (;;) {
    const value = await get();
    if (ready(value) || Date.now() >= deadline) return value;
    await Bun.sleep(35);
  }
}

function localRequest(url: string) {
  return async (endpoint: string, body?: unknown, extra?: Record<string, string>) => fetch(new URL(endpoint, url), {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-okb-token": token, ...(body === undefined ? {} : { "content-type": "application/json" }), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const watchStatus = async (response: Response): Promise<BundleWatchStatus | null> => {
  expect(response.status).toBe(200);
  return (await response.json() as { result: BundleWatchStatus | null }).result;
};

test("the watcher reconciles changed or recovered backends and releases each handle", async () => {
  const bundle = await mkdtemp(join(tmpdir(), "okb-watch-backend-"));
  await writeFile(join(bundle, "note.md"), article("Remote cache note", "remotewatchtoken"));
  const engine = openSqliteEngine(":memory:");
  let closed = 0;
  let available = false;
  let identity = "first";
  let disconnected = false;
  const watcher = new BundleWatcher(bundle, () => true, {
    async identity() { return identity; },
    async exists() {
      if (disconnected) throw new Error("Cache disconnected.");
      return available;
    },
    async open() {
      if (disconnected) throw new Error("Cache disconnected.");
      return { engine, async close() { available = true; closed++; } };
    },
  });
  try {
    const initial = await until(async () => watcher.status(), (value) => value.stats?.indexed === 1);
    expect(initial.stats?.indexed).toBe(1);
    expect(closed).toBe(1);
    engine.wipe();
    available = false;
    await until(async () => closed, (value) => value === 2);
    expect(closed).toBe(2);
    expect(engine.search("remotewatchtoken").map(({ id }) => id)).toEqual(["note"]);

    // The selected backend already has an index, but lacks the current note.
    engine.wipe();
    identity = "second";
    await until(async () => closed, (value) => value === 3);
    expect(closed).toBe(3);
    expect(engine.getNode("note")?.title).toBe("Remote cache note");

    disconnected = true;
    const outage = await until(async () => watcher.status(), (value) => value.error !== null);
    expect(outage.error).toBe("Cache disconnected.");
    engine.wipe();
    disconnected = false;
    const recovered = await until(async () => watcher.status(), (value) => value.error === null);
    expect(recovered.stats?.indexed).toBe(1);
    expect(closed).toBe(4);
    expect(engine.getNode("note")?.title).toBe("Remote cache note");
  } finally {
    await watcher.stop();
    engine.close();
    await rm(bundle, { recursive: true, force: true });
  }
}, 10_000);

test("the local watcher reconciles external folder moves, edits, and deletes", async () => {
  const bundle = await mkdtemp(join(tmpdir(), "okb-watch-api-"));
  const folder = join(bundle, "original");
  await mkdir(folder);
  await writeFile(join(folder, "target.md"), article("Target", "firstwatchtoken"));
  await writeFile(join(bundle, "source.md"), article("Source", "See [the target](/moved/target.md)."));
  const server = createApiServer({ bundle, port: 0, token });
  const request = localRequest(server.url);
  const status = async () => watchStatus(await request(path));
  const search = async (query: string): Promise<string[]> => {
    const res = await request("api/op/search", { query, "keyword-only": true });
    if (!res.ok) return [];
    return (await res.json() as { result: { id: string }[] }).result.map((hit) => hit.id);
  };
  try {
    expect((await fetch(new URL(`${path}?token=${token}`, server.url))).status).toBe(401);
    expect((await request(path, { action: "start" }, { origin: "https://remote.example" })).status).toBe(403);
    expect((await request("api/op/watch_index", {})).status).toBe(404);
    expect(await status()).toBeNull();
    expect((await watchStatus(await request(path, { action: "start" })))?.active).toBe(true);
    const initial = await until(status, (value) => Boolean(value?.stats && !value.indexing));
    expect(initial?.stats?.indexed).toBe(2);
    expect(await search("firstwatchtoken")).toEqual(["original/target"]);

    const renamed = join(bundle, "moved");
    await rename(folder, renamed);
    await writeFile(join(renamed, "target.md"), article("Target", "changedwatchtoken"));
    expect((await until(() => search("changedwatchtoken"), (ids) => ids.includes("moved/target")))).toContain("moved/target");
    expect(await search("firstwatchtoken")).toEqual([]);
    const links = await request("api/op/graph_neighbors", { id: "source" });
    expect(await links.json()).toMatchObject({ result: [{ id: "moved/target" }] });

    // A directory created after startup has to be watched too.
    await mkdir(join(renamed, "new"));
    await writeFile(join(renamed, "new", "note.md"), article("New", "newwatchtoken"));
    expect(await until(() => search("newwatchtoken"), (ids) => ids.includes("moved/new/note"))).toContain("moved/new/note");
    expect((await request("api/op/rebuild", { "confirm-destructive": true })).ok).toBe(true);
    await rm(renamed, { recursive: true });
    const removed = await until(async () => ({ hits: await search("newwatchtoken"), old: await search("changedwatchtoken") }), ({ hits, old }) => hits.length === 0 && old.length === 0);
    expect(removed).toEqual({ hits: [], old: [] });

    const idle = await until(status, (value) => value?.indexing === false);
    await writeFile(join(bundle, "index.md"), "# Generated index\n");
    await writeFile(join(bundle, ".okb", "ignored.md"), "Ignored watch data.\n");
    await Bun.sleep(900);
    expect((await status())?.lastIndexedAt).toBe(idle?.lastIndexedAt);

    expect((await watchStatus(await request(path, { action: "stop" })))?.active).toBe(false);
    await writeFile(join(bundle, "after.md"), article("After", "stoppedwatchtoken"));
    await Bun.sleep(900);
    expect(await search("stoppedwatchtoken")).toEqual([]);
  } finally {
    await server.stop();
    await rm(bundle, { recursive: true, force: true });
  }
}, 19_000);

test("watching requires a writable mount and stops when permission changes", async () => {
  const previous = loadConfig();
  const bundle = await mkdtemp(join(tmpdir(), "okb-watch-mount-"));
  const server = createApiServer({ bundle, port: 0, token, servedBrain: "external" });
  const request = localRequest(server.url);
  const setMount = (readonly: boolean) => saveConfig({ ...previous, brains: { external: { path: bundle, readonly } } });
  try {
    setMount(true);
    expect((await request(path, { action: "start" }, { "x-okb-brain": "external" })).status).toBe(403);
    expect((await request(path, { action: "start" })).status).toBe(403);
    expect((await okb(["--brain", "external", "watch"])).stderr).toContain("read-only");
    setMount(false);
    expect((await watchStatus(await request(path, { action: "start" })))?.active).toBe(true);
    const poll = async () => watchStatus(await request(path));
    expect((await until(poll, (value) => Boolean(value?.stats)))?.stats?.indexed).toBe(0);
    setMount(true);
    await writeFile(join(bundle, "private.md"), article("Private", "revokedwatchtoken"));
    const stopped = await until(poll, (value) => value?.active === false);
    expect(stopped?.error).toContain("write permission changed");
    const search = await request("api/op/search", { query: "revokedwatchtoken", "keyword-only": true });
    expect((await search.json() as { result: unknown }).result).toEqual([]);
  } finally {
    await server.stop();
    saveConfig(previous);
    await rm(bundle, { recursive: true, force: true });
  }
}, 10_000);

test("okb watch refreshes the index from a separate CLI process", async () => {
  const bundle = await mkdtemp(join(tmpdir(), "okb-watch-cli-"));
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const processHandle = Bun.spawn([process.execPath, "run", cli, "--bundle", bundle, "watch"], {
    stdout: "pipe", stderr: "pipe",
  });
  const search = (query: string) => okb(["--bundle", bundle, "--json", "search", query, "--keyword-only"]);
  try {
    expect((await until(() => search("initial"), (value) => value.code === 0)).code).toBe(0);
    await writeFile(join(bundle, "outside.md"), article("External", "clioutsidewatchtoken"));
    const result = await until(() => search("clioutsidewatchtoken"), (value) => value.stdout.includes('"id": "outside"'));
    expect(result.stdout).toContain('"id": "outside"');
  } finally {
    processHandle.kill();
    await processHandle.exited;
    await rm(bundle, { recursive: true, force: true });
  }
}, 14_000);
