import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer, type ApiServer } from "../src/api.ts";
import { listCodingModels } from "../src/core/coding/durable.ts";

const ownerToken = "local-deployment-owner-fixture";
const providerCredential = "deployment-provider-key-should-stay-local";

function codingRequest(server: ApiServer, path: string, data?: unknown, token: string | null = ownerToken) {
  return fetch(new URL("api/coding" + path, server.url), {
    method: data === undefined ? "GET" : "POST",
    headers: {
      ...(token === ownerToken ? { "x-okb-token": token } : token ? { authorization: `Bearer ${token}` } : {}),
      ...(data === undefined ? {} : { "content-type": "application/json" }),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}

async function codingResult<T>(response: Response): Promise<T> {
  const payload = await response.json() as { result: T; error?: string };
  if (!response.ok) throw new Error(`${response.url} (${response.status}): ${payload.error}`);
  return payload.result;
}

test("deployment diagnostics expose owner settings and reserve the probe for writable Docker configurations", async () => {
  const root = await mkdtemp(join(tmpdir(), "okb-api-deployment-"));
  const bundle = join(root, "brain");
  const workspace = join(root, "repository");
  const stateDir = join(root, "coding-state");
  const boot = (readonly = false) => createApiServer({ bundle, port: 0, token: ownerToken, readonly, coding: { stateDir } });
  let server: ApiServer | undefined;
  function request(path: string, data?: unknown, token: string | null = ownerToken) {
    return codingRequest(server!, path, data, token);
  }
  async function call<T>(path: string, data?: unknown) {
    return codingResult<T>(await request(path, data));
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
    const { providerCheckBinding } = JSON.parse(configuration).result;
    expect(providerCheckBinding).toMatch(/^[a-f0-9]{64}$/);
    const expected = { worker: { mode: "process" }, retention: { active: true, days: 30 },
      provider: "openai", model, credential: "project", providerCheckBinding,
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
    expect(await call(path)).toEqual({ ...expected, retention: { active: false, days: 30 }, providerCheckBinding: null });
    expect((await request(path, {})).status).toBe(403);
    expect(await call(base + "/runs")).toEqual([]);
  } finally {
    await server?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("provider connectivity requires explicit local-owner approval and only reports sanitized metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "okb-api-provider-deployment-"));
  const bundle = join(root, "brain");
  const workspace = join(root, "repository");
  const stateDir = join(root, "coding-state");
  const model = listCodingModels().find(({ provider }) => provider === "openai")!.models[0]!.id;
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const requests: Request[] = [];
  const providerCheckFetch = Object.assign(async (...[input, init]: Parameters<typeof fetch>) => {
    requests.push(input instanceof Request ? new Request(input, init) : new Request(String(input), init));
    if (requests.length === 1) {
      started.resolve();
      await release.promise;
      return Response.json({ object: "model", id: model, private: providerCredential });
    }
    return Response.json({ error: providerCredential }, { status: 403 });
  }, { preconnect: fetch.preconnect });
  let server: ApiServer | undefined;
  const boot = (readonly = false) => createApiServer({
    bundle, port: 0, token: ownerToken, readonly, coding: { stateDir, providerCheckFetch },
  });
  const request = (path: string, data?: unknown, token: string | null = ownerToken) => codingRequest(server!, path, data, token);
  const call = async <T,>(path: string, data?: unknown) => codingResult<T>(await request(path, data));

  try {
    await Promise.all([mkdir(bundle), mkdir(workspace)]);
    server = boot();
    const project = await call<{ id: string }>("/projects", {
      title: "Provider check fixture", workspace, provider: "openai", model, apiKey: providerCredential,
    });
    const unconfigured = await call<{ id: string }>("/projects", { title: "Missing credential", workspace, provider: "openai", model });
    const base = `/projects/${project.id}`;
    const path = base + "/provider-check";
    const member = await call<{ token: string }>(base + "/members", { name: "project-reviewer" });
    const readBinding = async (projectPath: string) => (await call<{ providerCheckBinding: string | null }>(projectPath + "/deployment-check")).providerCheckBinding;
    const firstBinding = await readBinding(base);
    expect(await readBinding(`/projects/${unconfigured.id}`)).toBeNull();
    await call(base + "/credential", { apiKey: "rotated-deployment-fixture" });
    expect(await readBinding(base)).not.toBe(firstBinding);
    expect((await request(path, { approved: true, binding: firstBinding })).status).toBe(409);
    await call(base + "/credential", { apiKey: providerCredential });
    const before = (await readdir(stateDir)).sort();
    const audit = await call(base + "/audit");
    const approval = { approved: true, binding: await readBinding(base) };

    expect((await request(path)).status).toBe(404);
    expect((await request(path, approval, null)).status).toBe(401);
    expect((await request(path, approval, member.token)).status).toBe(403);
    expect((await request(path, {})).status).toBe(400);
    expect((await request(path, { approved: true })).status).toBe(400);
    expect((await request(path, { ...approval, approved: false })).status).toBe(400);
    expect((await request(path, { ...approval, url: "https://fixture.invalid" })).status).toBe(400);
    expect((await request(`/projects/${unconfigured.id}/provider-check`, approval)).status).toBe(409);
    expect(requests).toHaveLength(0);

    const first = request(path, approval);
    await started.promise;
    expect((await request(path, approval)).status).toBe(409);
    release.resolve();
    const success = await first;
    expect(success.headers.get("cache-control")).toBe("no-store");
    const successBody = await success.text();
    expect(successBody).not.toContain(providerCredential);
    expect(JSON.parse(successBody).result).toMatchObject({
      provider: "openai", model, origin: "fixture", worker: "process", network: null, status: "passed", code: "ready", httpStatus: 200,
    });
    const failure = await request(path, approval);
    expect(failure.status).toBe(200);
    const failureBody = await failure.text();
    expect(failureBody).not.toContain(providerCredential);
    expect(JSON.parse(failureBody).result).toMatchObject({ status: "failed", code: "denied", httpStatus: 403 });
    expect(requests).toHaveLength(2);
    for (const sent of requests) {
      expect(sent.url).toBe(`https://api.openai.com/v1/models/${encodeURIComponent(model)}`);
      expect(sent.method).toBe("GET");
      expect(sent.headers.get("authorization")).toBe(`Bearer ${providerCredential}`);
      expect(sent.body).toBeNull();
    }
    expect(await call(base + "/runs")).toEqual([]);
    expect(await call(base + "/audit")).toEqual(audit);
    expect((await readdir(stateDir)).sort()).toEqual(before);

    await server.stop();
    server = undefined;
    server = boot(true);
    expect((await request(path, approval)).status).toBe(403);
    expect(requests).toHaveLength(2);
  } finally {
    release.resolve();
    await server?.stop();
    await rm(root, { recursive: true, force: true });
  }
});
