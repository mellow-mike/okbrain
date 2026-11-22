import { expect, test } from "bun:test";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer, type ApiServer } from "../src/api.ts";

const owner = "team-editor-local-owner-fixture";
const cert = join(import.meta.dir, "fixtures", "coding-team-test-cert.pem");
const key = join(import.meta.dir, "fixtures", "coding-team-test-key.pem");
const transport = join(import.meta.dir, "..", "integrations", "vscode", "team-connection.cjs");
const previewText = "export const teamEditorEvidence = 42;\n";

// Exercise the same CJS transport loaded by the editor. A separate process
// trusts only the fixture through the normal additional-CA mechanism.
const driver = `
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { connectTeam } = require(process.argv.at(-1));
(async () => {
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const { mode, origin, token, project, other, redirectedOrigin, previewText } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const connect = () => connectTeam(origin, token, project);
if (mode === 'untrusted') {
  await assert.rejects(connect);
} else if (mode === 'revoked') {
  await assert.rejects(connect, (error) => (error.status ?? error.statusCode) === 401 && !error.message.includes(token));
} else if (mode === 'availability') {
  const { api, projects, projectId } = await connect();
  assert.equal(projectId, project);
  assert.deepEqual(projects.map(({ id }) => id), [project]);
  assert.equal(projects[0].workspace, undefined);
  await assert.rejects(() => connectTeam(origin, token, other));
  await assert.rejects(() => api('/projects/' + other + '/runs'));
} else {
  await assert.rejects(() => connectTeam(origin, token, other));
  await assert.rejects(() => connectTeam(redirectedOrigin, token));
  const connection = await connect();
  const { api, projects, projectId } = connection;
  assert.equal(connection.mode, 'team');
  assert.equal(projectId, project);
  assert.equal(projects.length, 1);
  assert.deepEqual(projects[0].scopes, ['src']);
  assert.equal(projects[0].workspace, undefined);
  const path = '/projects/' + project;
  await assert.rejects(() => api('/projects/' + other + '/runs'));
  await assert.rejects(() => api(path + '/credential', { apiKey: 'denied' }));
  await assert.rejects(() => api(path + '/preview', { source: 'files', files: ['src/answer.ts'] }));

  const { presets: [preset] } = await api(path + '/presets');
  assert.equal(preset.name, 'Review team evidence');
  const source = { source: 'repository', profile: preset.profile, query: preset.query };
  const preview = await api(path + '/preview', source);
  assert.equal(preview.guidance, preset.profile.guidance);
  assert.equal(preview.excerpts.length, 1);
  const [excerpt] = preview.excerpts;
  assert.equal(excerpt.path, 'src/answer.ts');
  assert.equal(excerpt.content.trimEnd(), previewText.trimEnd());
  const identity = { session: 'team-editor', requestId: 'ide-team-editor-fixture' };
  const request = { ...identity, ...source, prompt: preset.prompt, previewId: preview.manifest.id };
  await assert.rejects(() => api(path + '/run', request));
  const accepted = await api(path + '/run', { ...request, approved: true });
  assert.equal(accepted.id, identity.requestId);
  const deadline = Date.now() + 8_000;
  let inspected;
  do {
    inspected = await api(path + '/inspect', identity);
    if (inspected.run.status !== 'running') break;
    await delay(25);
  } while (Date.now() < deadline);
  assert.equal(inspected.run.status, 'done');
  assert.equal(inspected.pi.request.receipt.text, 'The team fixture found evidence on line 1.');
  assert.equal((await api(path + '/run', { ...request, approved: true })).id, identity.requestId);
  const saved = await api(path + '/source-inspect', identity);
  assert.equal(saved.prompt, preset.prompt);
  assert.equal(saved.guidance, preset.profile.guidance);
  const [{ files: [file] }] = saved.groups;
  assert.deepEqual(file, { path: excerpt.path, startLine: excerpt.startLine, endLine: excerpt.endLine, text: excerpt.content });
  assert.equal((await api(path + '/review', { ...identity, decision: 'accepted' })).review, 'accepted');
}
})().catch((error) => { console.error(error); process.exitCode = 1; });
`;

async function runEditor(input: Record<string, unknown>, trusted = true) {
  const runtime = process.env.OKB_TEST_EDITOR_RUNTIME || process.execPath;
  const child = Bun.spawn([runtime, "-e", driver, "--", transport], {
    stdin: new Blob([JSON.stringify(input)]), stdout: "pipe", stderr: "pipe",
    env: { ...process.env, NODE_EXTRA_CA_CERTS: trusted ? cert : undefined, NODE_TLS_REJECT_UNAUTHORIZED: "1" },
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 16_000);
  try {
    const [, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (status !== 0) throw new Error(`Team editor fixture exited ${status}: ${stderr}`);
  } finally { clearTimeout(timer); }
}

function secureFixture(fetch: (req: Request) => Response | Promise<Response>) {
  return Bun.serve({ hostname: "127.0.0.1", port: 0,
    tls: { cert: Bun.file(cert), key: Bun.file(key) }, fetch });
}

async function restartOwnerProcess(bundle: string, stateDir: string, port: number): Promise<ApiServer> {
  const source = `
    import { createApiServer } from "./src/api.ts";
    const { bundle, stateDir, token, port } = JSON.parse(process.argv.at(-1));
    const api = createApiServer({ bundle, token, port, coding: { stateDir } });
    process.stdout.write(api.url + "\\n");
    await Bun.stdin.text();
    await api.stop();
  `;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", source, "--", JSON.stringify({ bundle, stateDir, token: owner, port })], {
    cwd: join(import.meta.dir, ".."), stdin: "pipe", stdout: "pipe", stderr: "inherit",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 8_000);
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  try {
    let line = "";
    while (!line.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) throw new Error("The restarted owner app did not report its address.");
      line += decoder.decode(value, { stream: true });
    }
    const url = line.trim();
    if (url !== `http://127.0.0.1:${port}/`) throw new Error("The restarted owner app reported an unexpected address.");
    return { url, port, token: owner, async stop() { child.stdin.end(); await child.exited; } };
  } catch (error) {
    child.kill("SIGKILL");
    await child.exited;
    throw error;
  } finally { reader.releaseLock(); clearTimeout(timer); }
}

async function localCoding<T>(server: ApiServer, path: string, data?: unknown) {
  const headers = { "x-okb-token": owner, "content-type": "application/json" };
  const response = await fetch(new URL("api/coding" + path, server.url), data === undefined
    ? { headers } : { method: "POST", headers, body: JSON.stringify(data) });
  const payload = await response.json() as { result: T; error?: string };
  if (!response.ok) throw new Error(payload.error ?? String(response.status));
  return payload.result;
}

async function occupiedPort(port = 0) {
  const server = createHttpServer((_req, res) => res.writeHead(503).end("Team fixture port is occupied."));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject).listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a loopback TCP port.");
  return {
    port: address.port,
    async release() {
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    },
  };
}

async function waitFor<T>(poll: () => Promise<T>, ready: (value: T) => boolean) {
  const deadline = Date.now() + 3_000;
  let value = await poll();
  while (!ready(value) && Date.now() < deadline) {
    await Bun.sleep(30);
    value = await poll();
  }
  return value;
}

test("the editor transport uses project-scoped HTTPS to preview, admit, and review a team run", async () => {
  const root = await mkdtemp(join(tmpdir(), "okb-team-editor-"));
  const workspace = join(root, "repo");
  const models = createModels();
  const faux = fauxProvider({ provider: "openai", models: [{ id: "team-editor-fixture" }] });
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("The team fixture found evidence on line 1.")]);
  let server: ApiServer | undefined;
  let upstream: URL;
  let redirectVisits = 0;
  let sinkVisits = 0;
  const traffic: { method: string; path: string; bearer: boolean; owner: boolean }[] = [];
  const sink = secureFixture(() => { sinkVisits++; return new Response(null, { status: 403 }); });
  const redirect = secureFixture(() => { redirectVisits++; return Response.redirect(sink.url.href, 307); });
  const tls = secureFixture(async (req) => {
    const url = new URL(req.url);
    const headers = new Headers(req.headers);
    headers.set("host", upstream.host);
    traffic.push({ method: req.method, path: url.pathname, bearer: headers.get("authorization")?.startsWith("Bearer okbp_") ?? false,
      owner: headers.has("x-okb-token") });
    return fetch(new URL(url.pathname + url.search, upstream), { method: req.method, headers, redirect: "error",
      ...(req.method === "POST" ? { body: await req.arrayBuffer() } : {}) });
  });
  try {
    await mkdir(join(workspace, "src"), { recursive: true });
    await mkdir(join(workspace, "private"));
    await writeFile(join(workspace, "src", "answer.ts"), previewText);
    await writeFile(join(workspace, "private", "only.ts"), "export const teamEditorEvidence = 'unshared';\n");
    for (const args of [["init", "--quiet"], ["add", "--", "src/answer.ts", "private/only.ts"]]) {
      const git = Bun.spawnSync(["git", ...args], { cwd: workspace, stdout: "ignore", stderr: "pipe" });
      if (git.exitCode !== 0) throw new Error(git.stderr.toString());
    }
    server = createApiServer({ bundle: workspace, port: 0, token: owner, coding: { stateDir: join(root, "state"), models } });
    const local = <T>(path: string, data: unknown) => localCoding<T>(server!, path, data);
    const settings = { title: "Team editor project", workspace, scopes: ["src"], provider: "openai", model: "team-editor-fixture", apiKey: "fixture-key" };
    const project = await local<{ id: string }>("/projects", settings);
    const other = await local<{ id: string }>("/projects", { ...settings, title: "Second project" });
    const path = "/projects/" + project.id;
    const member = await local<{ id: string; token: string }>(path + "/members", { name: "editor-reviewer" });
    await local(path + "/presets", { action: "save", name: "Review team evidence", prompt: "Trace the evidence.",
      query: "teamEditorEvidence", profile: { version: 1, name: "Team scope", projects: ["src"], guidance: "Cite the scoped path." } });
    const team = await local<{ url: string }>("/team", { action: "start", port: 0, publicOrigin: tls.url.origin });
    upstream = new URL(team.url);

    const request = (suffix: string, token: string, data?: unknown) => fetch(new URL("api/coding" + suffix, tls.url), {
      method: data === undefined ? "GET" : "POST", tls: { ca: Bun.file(cert) },
      headers: { authorization: `Bearer ${token}`, ...(data === undefined ? {} : { "content-type": "application/json" }) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    expect((await request("/projects", owner)).status).toBe(401);
    expect((await request("/projects/" + other.id + "/runs", member.token)).status).toBe(403);
    expect((await request(path + "/credential", member.token, { apiKey: "denied" })).status).toBe(403);
    expect((await request(path + "/preview", member.token, { source: "repository", query: "teamEditorEvidence", projects: ["private"] })).status).toBe(403);
    expect((await request(path + "/run", member.token, { source: "repository" })).status).toBe(400);
    expect(faux.state.callCount).toBe(0);

    const input = { origin: tls.url.origin, redirectedOrigin: redirect.url.origin, token: member.token,
      project: project.id, other: other.id, previewText };
    const before = traffic.length;
    await runEditor({ ...input, mode: "untrusted" }, false);
    expect(traffic).toHaveLength(before);
    await runEditor({ ...input, mode: "exercise" });
    expect(redirectVisits).toBe(1);
    expect(sinkVisits).toBe(0);
    expect(faux.state.callCount).toBe(1);
    const editorRequests = traffic.slice(before);
    expect(editorRequests.every(({ bearer, owner }) => bearer && !owner)).toBe(true);
    expect(editorRequests.filter(({ path: url }) => url.endsWith("/preview"))).toHaveLength(1);
    expect(editorRequests.some(({ path: url }) => url.endsWith("/credential") || url.startsWith(`/api/coding/projects/${other.id}`))).toBe(false);

    await local(path + "/members", { revoke: member.id });
    await runEditor({ ...input, mode: "revoked" });
    expect((await request(path + "/runs", member.token)).status).toBe(401);
  } finally {
    await Promise.all([tls.stop(true), redirect.stop(true), sink.stop(true), server?.stop()]);
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("the fixed team listener recovers across operator restarts and stays scoped through HTTPS", async () => {
  const root = await mkdtemp(join(tmpdir(), "okb-team-restart-"));
  const workspace = join(root, "repo");
  const models = createModels();
  const faux = fauxProvider({ provider: "openai", models: [{ id: "team-restart-fixture" }] });
  models.setProvider(faux.provider);
  const opts = { bundle: workspace, token: owner, coding: { stateDir: join(root, "state"), models } };
  const start = (port = 0) => createApiServer({ ...opts, port });
  let server: ApiServer | undefined;
  let guard: Awaited<ReturnType<typeof occupiedPort>> | undefined;
  let tls: ReturnType<typeof secureFixture> | undefined;
  try {
    await mkdir(join(workspace, "src"), { recursive: true });
    const git = Bun.spawnSync(["git", "init", "--quiet"], { cwd: workspace, stdout: "ignore", stderr: "pipe" });
    if (git.exitCode !== 0) throw new Error(git.stderr.toString());
    server = start();
    const ownerPort = server.port;
    const local = <T>(path: string, data?: unknown) => localCoding<T>(server!, path, data);
    const settings = { title: "Persistent team project", workspace, scopes: ["src"], provider: "openai",
      model: "team-restart-fixture", apiKey: "fixture-key" };
    const project = await local<{ id: string }>("/projects", settings);
    const other = await local<{ id: string }>("/projects", { ...settings, title: "Second project" });
    const projectPath = `/api/coding/projects/${project.id}`;
    const member = await local<{ id: string; token: string }>(`/projects/${project.id}/members`, { name: "restart-reviewer" });

    guard = await occupiedPort();
    const upstream = new URL(`http://127.0.0.1:${guard.port}/`);
    tls = secureFixture(async (req) => {
      const { pathname, search } = new URL(req.url);
      const headers = new Headers(req.headers);
      headers.set("host", upstream.host);
      try {
        return await fetch(new URL(pathname + search, upstream), { headers, redirect: "error", signal: AbortSignal.timeout(2_500) });
      } catch {
        return new Response("Team fixture upstream is unavailable.", { status: 503 });
      }
    });
    const tlsUrl = tls.url;
    const request = (path: string, headers?: Record<string, string>) => fetch(new URL(path, tlsUrl), {
      headers, tls: { ca: Bun.file(cert) }, signal: AbortSignal.timeout(3_500),
    });
    const startup = { port: guard.port, publicOrigin: tlsUrl.origin };
    const active = { ...startup, url: upstream.href };
    const preferences = (data?: unknown) => local<{ startup: typeof startup | null; startupError: string | null }>("/team/preferences", data);
    const listener = (data?: unknown) => local<typeof active | null>("/team", data);
    await guard.release();
    guard = undefined;
    expect(await preferences()).toEqual({ startup: null, startupError: null });
    expect(await listener({ action: "start", ...startup, startOnLaunch: true })).toEqual(active);
    expect(await preferences()).toEqual({ startup, startupError: null });
    await server.stop();
    server = undefined;

    let ownerCollision: ApiServer | undefined;
    try {
      expect(() => { ownerCollision = start(startup.port); }).toThrow(/team.*port|port.*team/i);
    } finally { await ownerCollision?.stop(); }

    server = await restartOwnerProcess(workspace, opts.coding.stateDir, ownerPort);
    expect(await waitFor(listener, (value) => value !== null)).toEqual(active);
    expect(await preferences()).toEqual({ startup, startupError: null });
    const input = { origin: tlsUrl.origin, token: member.token, project: project.id, other: other.id, mode: "availability" };
    const bearer = { authorization: `Bearer ${member.token}` };
    const operator = { "x-okb-token": owner };
    await runEditor(input);
    const scoped = await request(`${projectPath}/runs`, { ...bearer, origin: tlsUrl.origin });
    expect(scoped.status).toBe(200);
    expect(scoped.headers.get("access-control-allow-origin")).toBe(tlsUrl.origin);
    expect((await request("/api/coding/projects", operator)).status).toBe(401);
    expect((await request(`/api/coding/projects/${other.id}/runs`, bearer)).status).toBe(403);
    expect((await request("/api/coding/team/preferences", bearer)).status).toBe(404);
    for (const path of ["/api/status", "/api/brains", "/api/maintenance", "/gui/app.js"]) {
      expect((await request(path, operator)).status).toBe(404);
    }
    expect(await (await request("/")).text()).not.toContain(owner);
    await server.stop();
    server = undefined;

    guard = await occupiedPort(startup.port);
    server = start(ownerPort);
    const blocked = await waitFor(preferences, ({ startupError }) => startupError !== null);
    expect(blocked.startup).toEqual(startup);
    expect(blocked.startupError).toMatch(/port.*(?:in use|unavailable|busy)/i);
    expect(await listener()).toBeNull();
    expect(await (await request("/")).text()).toBe("Team fixture port is occupied.");
    await guard.release();
    guard = undefined;

    expect(await preferences({ action: "retry" })).toEqual({ startup, startupError: null });
    expect(await listener()).toEqual(active);
    expect((await request(`${projectPath}/runs`, bearer)).status).toBe(200);
    await local(`/projects/${project.id}/members`, { revoke: member.id });
    await runEditor({ ...input, mode: "revoked" });
    expect((await request(`${projectPath}/runs`, bearer)).status).toBe(401);
    expect(faux.state.callCount).toBe(0);

    expect(await listener({ action: "stop" })).toBeNull();
    expect(await preferences()).toEqual({ startup: null, startupError: null });
    await server.stop();
    server = start(ownerPort);
    expect(await listener()).toBeNull();
    expect(await preferences()).toEqual({ startup: null, startupError: null });
    const stopped = await request("/");
    expect(stopped.status).toBe(503);
    expect(await stopped.text()).toBe("Team fixture upstream is unavailable.");
  } finally {
    await Promise.all([tls?.stop(true), server?.stop(), guard?.release()]);
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
