import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../src/api.ts";
import { listCodingModels } from "../src/core/coding/durable.ts";
import { launchProjectProviderCheck, ProjectProviderCheckDisallowed, ProjectWorkerInterrupted } from "../src/core/coding/project-worker.ts";

test("the process provider check refuses malformed input without a provider call and removes its temporary state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "okb-provider-worker-test-"));
  const temporarySettings = ["TMPDIR", "TEMP", "TMP"] as const;
  const saved = temporarySettings.map((setting) => [setting, process.env[setting]] as const);
  for (const setting of temporarySettings) process.env[setting] = directory;
  const input = { provider: "openai" as const, model: "not/a-model-name", apiKey: "unused-process-fixture-key" };
  try {
    expect(await launchProjectProviderCheck(input, { signal: AbortSignal.timeout(8_000) })).toEqual({ code: "model-unavailable" });
    expect(await readdir(directory)).toEqual([]);
    await expect(launchProjectProviderCheck(input, { signal: AbortSignal.abort(new Error(input.apiKey)) }))
      .rejects.toBeInstanceOf(ProjectWorkerInterrupted);
    expect(await readdir(directory)).toEqual([]);
    await expect(launchProjectProviderCheck(input, { signal: AbortSignal.timeout(8_000), canLaunch: () => false }))
      .rejects.toBeInstanceOf(ProjectProviderCheckDisallowed);
    expect(await readdir(directory)).toEqual([]);
  } finally {
    for (const [setting, value] of saved) {
      if (value === undefined) delete process.env[setting];
      else process.env[setting] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

test("the owner API reports an invalid saved credential from the real offline-safe process worker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "okb-provider-worker-api-"));
  const workspace = join(directory, "workspace");
  const stateDir = join(directory, "projects");
  await mkdir(workspace);
  const token = "local-provider-worker-fixture";
  const api = createApiServer({ bundle: workspace, port: 0, token, coding: { stateDir } });
  const request = (path: string, data?: object) => fetch(new URL(`api/coding${path}`, api.url), {
    method: data === undefined ? "GET" : "POST",
    headers: { "x-okb-token": token, ...(data === undefined ? {} : { "content-type": "application/json" }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    signal: AbortSignal.timeout(22_000),
  });
  try {
    const model = listCodingModels().find(({ provider }) => provider === "openai")!.models[0]!.id;
    const apiKey = "offline fixture key with invalid header spaces";
    const created = await request("/projects", { title: "Offline-safe credential check", workspace, provider: "openai", model, apiKey });
    expect(created.status).toBe(200);
    const { result: { id } } = await created.json() as { result: { id: string } };
    const before = (await readdir(stateDir)).sort();
    const deployment = await request(`/projects/${id}/deployment-check`);
    expect(deployment.status).toBe(200);
    const { result: { providerCheckBinding: binding } } = await deployment.json() as { result: { providerCheckBinding: string } };
    expect(typeof binding).toBe("string");
    const checked = await request(`/projects/${id}/provider-check`, { approved: true, binding });
    expect(checked.status).toBe(200);
    const result = await checked.text();
    expect(JSON.parse(result)).toMatchObject({ result: { worker: "process", origin: "worker", status: "failed", code: "denied" } });
    expect(result).not.toContain(apiKey);
    expect(result).not.toContain(directory);
    expect(await (await request(`/projects/${id}/runs`)).json()).toEqual({ result: [] });
    expect((await readdir(stateDir)).sort()).toEqual(before);
  } finally {
    await api.stop();
    await rm(directory, { recursive: true, force: true });
  }
}, 28_000);
