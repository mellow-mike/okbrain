import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer, type ApiServer } from "../../src/api.ts";
import { dockerWorkerConfig, planDockerWorker } from "../../src/core/coding/docker-worker.ts";
import { listCodingModels } from "../../src/core/coding/durable.ts";

const isolation = dockerWorkerConfig(process.argv[2], "none");
if (!isolation) throw new Error("Pass the local Docker worker image ID.");
const root = await realpath(await mkdtemp(join(tmpdir(), "okbrain-docker-smoke-")));
const workspace = join(root, "work");
const stateDir = join(root, "state");
const token = "local-docker-smoke";
const createServer = (image: string) => createApiServer({
  bundle: workspace, port: 0, token, coding: { stateDir, workerImage: image, workerNetwork: isolation.network },
});
let server: ApiServer | undefined;

type Run = { status: string; admitted: boolean; error: string | null };

async function call<T>(path: string, body?: object) {
  const response = await fetch(new URL("api/coding" + path, server!.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-okb-token": token, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json() as { result: T; error?: string };
  if (!response.ok) throw new Error(data.error || `Coding API returned ${response.status}.`);
  return data.result;
}

async function settled(path: string, identity: object): Promise<Run> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const { run } = await call<{ run: Run }>(path + "/inspect", identity);
    if (run.status !== "running") return run;
    await Bun.sleep(50);
  }
  throw new Error("The offline Docker worker did not settle within 20 seconds.");
}

try {
  await mkdir(workspace);
  const source = join(workspace, "app.ts");
  await writeFile(source, "export const answer = 42;\n");

  // Use the actual Docker launch policy with a disposable filesystem probe.
  const probeDir = join(root, "probe");
  const probe = planDockerWorker(isolation, probeDir, "current");
  await mkdir(join(probeDir, "session-sibling"), { mode: 0o700 });
  await writeFile(join(probeDir, "session-current", "visible"), "this session\n");
  await writeFile(join(probeDir, "session-sibling", "private"), "other session\n");
  const args = [...probe.argv];
  args[args.indexOf("--entrypoint") + 1] = "/bin/sh";
  const boundary = Bun.spawnSync([...args, "-ec", [
    'test -f /state/session-current/visible',
    'test ! -e /state/session-sibling/private',
    'test ! -e "$0"',
    'test ! -S /var/run/docker.sock',
    'test "$(id -u)" -ne 0',
    'grep -q "^CapEff:[[:space:]]*0000000000000000$" /proc/self/status',
    'grep -q "^NoNewPrivs:[[:space:]]*1$" /proc/self/status',
    'grep -q "^Seccomp:[[:space:]]*2$" /proc/self/status',
    'grep -q " / / ro," /proc/self/mountinfo',
  ].join("\n"), source], { stdin: "ignore", stderr: "pipe" });
  assert.equal(boundary.exitCode, 0, boundary.stderr.toString());

  server = createServer(isolation.image);
  const model = listCodingModels().find(({ provider }) => provider === "openai")!.models[0]!.id;
  const project = await call<{ id: string; workerIsolation: string }>("/projects", {
    title: "Offline Docker smoke", workspace, provider: "openai", model, apiKey: "offline-smoke-only",
  });
  assert.equal(project.workerIsolation, "docker");
  const path = `/projects/${project.id}`;
  const selection = { source: "files", files: ["app.ts"] };
  const before = await call<{ id: string }>(path + "/preview", selection);
  await writeFile(source, "export const answer = 43;\n");
  const identity = { session: "smoke", requestId: "stale" };
  const submission = { ...identity, ...selection, prompt: "Review the selected file.", approved: true };
  await call(path + "/run", { ...submission, previewId: before.id });
  const stale = await settled(path, identity);
  assert.equal(stale.status, "failed");
  assert.equal(stale.admitted, false);
  assert.match(stale.error!, /selected files changed/);

  const approved = await call<{ id: string }>(path + "/preview", selection);
  const offline = { session: "smoke", requestId: "offline" };
  await call(path + "/run", { ...submission, ...offline, previewId: approved.id, approvedSourceLookup: true });
  const failedProvider = await settled(path, offline);
  assert.equal(failedProvider.status, "unanswered");
  assert.equal(failedProvider.admitted, true);
  const saved = await call<{ pi: { request: { approvedSourceLookup?: boolean } } }>(path + "/inspect", offline);
  assert.equal(saved.pi.request.approvedSourceLookup, true);
  assert.equal(await Bun.file(join(stateDir, `project-${project.id}`, "session-smoke", "transcript.sqlite")).exists(), true);

  // Reopen the same control plane with a deliberately absent image. A run must
  // fail closed rather than starting an ordinary local process.
  await server.stop();
  server = createServer(`sha256:${"0".repeat(64)}`);
  const unavailable = { session: "unavailable", requestId: "no-worker" };
  await call(path + "/run", { ...submission, ...unavailable, previewId: approved.id });
  const launchFailure = await settled(path, unavailable);
  assert.equal(launchFailure.status, "interrupted");
  assert.equal(launchFailure.admitted, false);
  assert.match(launchFailure.error!, /Docker could not start/);
  assert.equal(await Bun.file(join(stateDir, `project-${project.id}`, "session-unavailable", "transcript.sqlite")).exists(), false);

  console.log("Docker Coding smoke passed. Verified one-session filesystem access, stale approval, offline admission and no fallback.");
} finally {
  await server?.stop();
  await rm(root, { recursive: true, force: true });
}
