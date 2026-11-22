import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer, type ApiServer } from "../src/api.ts";
import { loadConfig, saveConfig } from "../src/core/config.ts";

const token = "local-maintenance-test";
const interval = 6 * 60 * 60 * 1000;

interface Status {
  cadence: string;
  jobs: string[];
  enabled: boolean;
  bindingAvailable: boolean;
  nextAt: number | null;
  lastRun?: { startedAt: number; finishedAt: number; status: string; jobs: { name: string; status: string; ms: number }[] };
}

test("the local app runs persisted maintenance only on its still-writable brain", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "okb-maintenance-api-")));
  const served = join(root, "default");
  const selected = join(root, "selected");
  const other = join(root, "other");
  const saved = loadConfig();
  const symbol = "maintenanceMarker";
  let wallTime = Date.now();
  let api: ApiServer | undefined;
  const settings = (path = selected, readonly = false) => saveConfig({ ...saved, brains: { Selected: { path, readonly } } });
  const open = (readonly = false) => createApiServer({ bundle: served, token, port: 0, readonly,
    maintenance: { path: join(root, "data", "maintenance.sqlite"), now: () => wallTime, intervalMs: 20 } });
  const request = (path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(new URL(path, api!.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-okb-token": token, "x-okb-brain": "Selected", ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const status = async (body?: unknown): Promise<Status | null> => {
    const response = await request("api/maintenance", body);
    const payload = await response.json() as { result: { schedule: Status | null }; error?: string };
    if (!response.ok) throw new Error(payload.error);
    expect(response.headers.get("cache-control")).toBe("no-store");
    return payload.result.schedule;
  };
  const save = { action: "save", cadence: "6h", jobs: ["index", "review", "doctor"] };
  try {
    for (const path of [served, selected, other]) {
      await mkdir(path);
      await writeFile(join(path, "index.md"), "---\nokf_version: '0.2'\n---\n# Test brain\n");
    }
    await writeFile(join(selected, symbol + ".md"), "---\ntitle: Scheduled marker\ntype: note\n---\nIndexed by the local maintenance timer.\n");
    settings();
    api = open();
    expect((await fetch(new URL("api/maintenance?token=" + token, api.url))).status).toBe(401);
    expect((await request("api/maintenance", undefined, { origin: "https://other.example" })).status).toBe(403);
    expect((await request("api/maintenance", save, { "content-type": "text/plain" })).status).toBe(415);
    expect((await request("api/maintenance", { ...save, jobs: ["code"] })).status).toBe(400);
    expect((await request("api/maintenance", { ...save, jobs: ["rss"] })).status).toBe(409);
    expect((await request("api/maintenance", { ...save, jobs: ["embed"] })).status).toBe(409);
    expect(await status()).toBeNull();
    expect(await status(save)).toMatchObject({ cadence: "6h", enabled: true, nextAt: wallTime + interval, bindingAvailable: true });
    expect(await status({ action: "pause" })).toMatchObject({ enabled: false, nextAt: null });
    wallTime += interval * 2;
    expect(await status()).toMatchObject({ enabled: false, nextAt: null });
    const resumed = await status(save);
    expect(resumed?.nextAt).toBe(wallTime + interval);

    await api.stop();
    wallTime += interval * 8;
    settings(selected, true);
    api = open();
    expect(await status()).toMatchObject({ enabled: true, nextAt: resumed?.nextAt ?? -1, bindingAvailable: false });
    expect((await request("api/maintenance", { action: "remove" })).status).toBe(403);
    expect(await (await request("api/status")).json()).toMatchObject({ hasIndex: false });

    settings(other);
    expect(await status()).toBeNull();
    expect(await (await request("api/status")).json()).toMatchObject({ hasIndex: false });
    const held = join(root, "held");
    await rename(selected, held);
    await symlink(other, selected, process.platform === "win32" ? "junction" : "dir");
    settings();
    await Bun.sleep(100);
    expect(await status()).toBeNull();
    expect(await (await request("api/status")).json()).toMatchObject({ hasIndex: false });
    settings(other);
    await unlink(selected);
    await rename(held, selected);
    settings();
    const deadline = Date.now() + 8000;
    let settled = await status();
    while (settled?.lastRun?.status !== "completed" && Date.now() < deadline) {
      await Bun.sleep(40);
      settled = await status();
    }
    expect(settled).toMatchObject({ enabled: true, nextAt: wallTime + interval, bindingAvailable: true,
      lastRun: { status: "completed", jobs: save.jobs.map((name) => ({ name, status: "completed" })) } });
    expect(JSON.stringify(settled)).not.toContain(symbol);
    expect(await (await request("api/status")).json()).toMatchObject({ hasIndex: true });
    expect(await (await request("api/status", undefined, { "x-okb-brain": "" })).json()).toMatchObject({ hasIndex: false });

    await api.stop();
    api = open(true);
    expect(await status()).toMatchObject({ lastRun: settled?.lastRun, bindingAvailable: false });
    expect((await request("api/maintenance", { action: "pause" })).status).toBe(403);
    await api.stop();
    api = open();
    expect(await status({ action: "remove" })).toBeNull();
  } finally {
    await api?.stop();
    saveConfig(saved);
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
