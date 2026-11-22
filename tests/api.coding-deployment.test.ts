import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer, type ApiServer } from "../src/api.ts";
import { listCodingModels } from "../src/core/coding/durable.ts";

const ownerToken = "local-deployment-owner-fixture";
const providerCredential = "deployment-provider-key-should-stay-local";

test("deployment diagnostics expose owner settings and reserve the probe for writable Docker configurations", async () => {
  const root = await mkdtemp(join(tmpdir(), "okb-api-deployment-"));
  const bundle = join(root, "brain");
  const workspace = join(root, "repository");
  const stateDir = join(root, "coding-state");
  const boot = (readonly = false) => createApiServer({ bundle, port: 0, token: ownerToken, readonly, coding: { stateDir } });
  let server: ApiServer | undefined;
  function request(path: string, data?: unknown, token: string | null = ownerToken) {
    return fetch(new URL("api/coding" + path, server!.url), {
      method: data === undefined ? "GET" : "POST",
      headers: {
        ...(token === ownerToken ? { "x-okb-token": token } : token ? { authorization: `Bearer ${token}` } : {}),
        ...(data === undefined ? {} : { "content-type": "application/json" }),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  }
  async function call<T>(path: string, data?: unknown) {
    const response = await request(path, data);
    const payload = await response.json() as { result: T; error?: string };
    if (!response.ok) throw new Error(`${path} (${response.status}): ${payload.error}`);
    return payload.result;
  }

  try {
    await Promise.all([mkdir(bundle), mkdir(workspace)]);
    server = boot();
    const model = listCodingModels().find(({ provider }) => provider === "openai")!.models[0]!.id;
    const project = await call<{ id: string }>("/projects", { title: "Deployment fixture", workspace,
      provider: "openai", model, apiKey: providerCredential,
    });
    const base = `/projects/${project.id}`;
    const path = base + "/deployment-check";
    const member = await call<{ token: string }>(base + "/members", { name: "deployment-reviewer" });
    await call(base + "/retention", { days: 30 });
    const before = (await readdir(stateDir)).sort();

    expect((await request(path, undefined, null)).status).toBe(401);
    expect((await request(path, {}, null)).status).toBe(401);
    expect((await request(path, undefined, member.token)).status).toBe(403);
    expect((await request(path, {}, member.token)).status).toBe(403);
    const settings = await request(path);
    expect(settings.status).toBe(200);
    expect(settings.headers.get("cache-control")).toBe("no-store");
    const configuration = await settings.text();
    const expected = { worker: { mode: "process" }, retention: { active: true, days: 30 },
      provider: "openai", model, credential: "project",
    };
    expect(JSON.parse(configuration)).toEqual({ result: expected });
    for (const value of [workspace, stateDir, providerCredential, ownerToken, member.token])
      expect(configuration).not.toContain(JSON.stringify(value).slice(1, -1));
    expect((await request(path, { workerImage: "unexpected-field" })).status).toBe(400);
    expect((await request(path, {})).status).toBe(409);
    expect(await call(base + "/runs")).toEqual([]);
    expect((await readdir(stateDir)).sort()).toEqual(before);

    await server.stop();
    server = undefined;
    server = boot(true);
    expect(await call(path)).toEqual({ ...expected, retention: { active: false, days: 30 } });
    expect((await request(path, {})).status).toBe(403);
    expect(await call(base + "/runs")).toEqual([]);
  } finally {
    await server?.stop();
    await rm(root, { recursive: true, force: true });
  }
});
