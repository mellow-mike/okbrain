import { expect, test } from "bun:test";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
    const local = async <T>(path: string, data: unknown) => {
      const response = await fetch(new URL("api/coding" + path, server!.url), { method: "POST",
        headers: { "x-okb-token": owner, "content-type": "application/json" }, body: JSON.stringify(data) });
      const payload = await response.json() as { result: T; error?: string };
      if (!response.ok) throw new Error(payload.error ?? String(response.status));
      return payload.result;
    };
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
