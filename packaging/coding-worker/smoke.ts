import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createApiServer, type ApiServer } from "../../src/api.ts";
import { dockerWorkerConfig, planDockerWorker } from "../../src/core/coding/docker-worker.ts";
import { listCodingModels } from "../../src/core/coding/durable.ts";
import { ensureExtensionCapableSqlite } from "../../src/core/engine/custom-sqlite.ts";

const isolation = dockerWorkerConfig(process.argv[2], "none");
if (!isolation) throw new Error("Pass the local Docker worker image ID.");
const root = await realpath(await mkdtemp(join(tmpdir(), "okbrain-docker-smoke-")));
const bundle = join(root, "brain");
const workspace = join(root, "work");
const stateDir = join(root, "state");
const token = "local-docker-smoke";
const createServer = (image: string) => createApiServer({
  bundle, port: 0, token, coding: { stateDir, workerImage: image, workerNetwork: isolation.network },
});
let server: ApiServer | undefined;

type Run = { status: string; admitted: boolean; error: string | null };
type Inspection = { run: Run; pi: { request: { approvedSourceLookup?: boolean; receipt: unknown } } };

function request(path: string, body?: object, member?: string) {
  return fetch(new URL("api/coding" + path, server!.url), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(member ? { authorization: `Bearer ${member}` } : { "x-okb-token": token }),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
}

async function call<T>(path: string, body?: object, member?: string) {
  const response = await request(path, body, member);
  const data = await response.json() as { result: T; error?: string };
  if (!response.ok) throw new Error(data.error || `Coding API returned ${response.status}.`);
  return data.result;
}

async function closeServer() {
  await server?.stop();
  server = undefined;
}

function cli(argv: string[]) {
  const result = Bun.spawnSync(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${argv[0]} failed (exit ${result.exitCode}): ${result.stderr.toString()}`);
  return result.stdout;
}

function withCatalog<T>(use: (db: Database) => T) {
  ensureExtensionCapableSqlite();
  using db = new Database(join(stateDir, "projects.sqlite"), { strict: true });
  return use(db);
}

function checkDatabase(file: string) {
  ensureExtensionCapableSqlite();
  using db = new Database(file, { readonly: true });
  using check = db.prepare("PRAGMA quick_check");
  assert.deepEqual(check.all(), [{ quick_check: "ok" }]);
}

async function restoreQuiescedState(label: string) {
  assert.equal(server, undefined);
  assert.equal((await stat(root)).mode & 0o077, 0);
  const backup = join(root, `${label}.tar`);
  await writeFile(backup, cli(["tar", "-cf", "-", "-C", root, "state"]), { flag: "wx", mode: 0o600 });
  assert.equal((await stat(backup)).mode & 0o077, 0);
  await rename(stateDir, join(root, `${label}-previous`));
  assert.equal(await Bun.file(join(stateDir, "projects.sqlite")).exists(), false);
  cli(["tar", "-xpf", backup, "-C", root]);
  assert.equal((await stat(stateDir)).mode & 0o077, 0);
  checkDatabase(join(stateDir, "projects.sqlite"));
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
  await Promise.all([mkdir(workspace), mkdir(bundle)]);
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
    'test "$(ls /sys/class/net)" = lo',
    'test "$(wc -l < /proc/net/route)" -eq 1',
    'printf "worker write\n" > /state/session-current/write-probe',
  ].join("\n"), source], { stdin: "ignore", stderr: "pipe" });
  assert.equal(boundary.exitCode, 0, boundary.stderr.toString());
  assert.equal(await readFile(join(probeDir, "session-current", "write-probe"), "utf8"), "worker write\n");

  server = createServer(isolation.image);
  const model = listCodingModels().find(({ provider }) => provider === "openai")!.models[0]!.id;
  const settings = { workspace, provider: "openai", model, apiKey: "offline-smoke-only" };
  const project = await call<{ id: string; workerIsolation: string }>("/projects", { ...settings, title: "Offline Docker smoke" });
  assert.equal(project.workerIsolation, "docker");
  const other = await call<{ id: string }>("/projects", { ...settings, title: "Separate offline project" });
  const path = `/projects/${project.id}`;
  const member = await call<{ id: string; token: string }>(path + "/members", { name: "smoke-reviewer" });
  const selection = { source: "files", files: ["app.ts"] };
  const before = await call<{ id: string }>(path + "/preview", selection);
  const admittedSource = "export const answer = 43;\n";
  await writeFile(source, admittedSource);
  const identity = { session: "smoke", requestId: "stale" };
  const submission = { ...identity, ...selection, prompt: "Review the selected file.", approved: true };
  await call(path + "/run", { ...submission, previewId: before.id });
  const stale = await settled(path, identity);
  assert.equal(stale.status, "failed");
  assert.equal(stale.admitted, false);
  assert.match(stale.error!, /selected files changed/);

  const approved = await call<{ id: string }>(path + "/preview", selection);
  const offline = { session: "smoke", requestId: "offline" };
  await call(path + "/run", {
    ...submission, ...offline, previewId: approved.id, approvedSourceLookup: true,
    evaluation: { series: "offline-restore", task: "saved-source", evidence: ["app.ts:1"] },
  });
  const failedProvider = await settled(path, offline);
  assert.equal(failedProvider.status, "unanswered");
  assert.equal(failedProvider.admitted, true);
  const saved = await call<Inspection>(path + "/inspect", offline);
  assert.equal(saved.pi.request.approvedSourceLookup, true);
  assert.ok(saved.pi.request.receipt);
  const transcript = join(stateDir, `project-${project.id}`, "session-smoke", "transcript.sqlite");
  assert.equal(await Bun.file(transcript).exists(), true);

  await closeServer();
  // Leave the catalog at an earlier crash boundary while keeping the worker's
  // settled SQLite receipt. Recovery must find that receipt in the backup.
  withCatalog((db) => {
    using rollback = db.prepare("UPDATE runs SET status = 'running', admitted = 0 WHERE project = ? AND session = ? AND id = ?");
    assert.equal(rollback.run(project.id, offline.session, offline.requestId).changes, 1);
  });
  await restoreQuiescedState("admitted-backup");
  checkDatabase(transcript);
  assert.equal((await stat(dirname(transcript))).mode & 0o077, 0);
  const detachedWorkspace = join(root, "work-detached");
  await rename(workspace, detachedWorkspace);
  await writeFile(join(detachedWorkspace, "app.ts"), "export const answer = 'different after backup';\n");
  assert.equal(await Bun.file(source).exists(), false);

  // Reopen the same control plane with a deliberately absent image. A run must
  // fail closed instead of starting a local process. Replaying the restored
  // request also demonstrates that a settled receipt needs no worker.
  const unavailableImage = `sha256:${"0".repeat(64)}`;
  server = createServer(unavailableImage);
  const projects = await call<{ id: string; workspace?: string }[]>("/projects", undefined, member.token);
  assert.deepEqual(projects.map(({ id }) => id), [project.id]);
  assert.equal(projects[0]?.workspace, undefined);
  assert.equal((await request(`/projects/${other.id}/runs`, undefined, member.token)).status, 403);
  assert.equal((await request(path + "/retention", { days: 30 }, member.token)).status, 403);
  const replay = await call<Run>(path + "/resume", offline, member.token);
  assert.equal(replay.status, "unanswered");
  assert.equal(replay.admitted, true);
  const restored = await call<Inspection>(path + "/inspect", offline, member.token);
  assert.deepEqual(restored.pi.request.receipt, saved.pi.request.receipt);
  assert.equal(restored.pi.request.approvedSourceLookup, true);
  const evidence = await call<{ sources: { path: string; content: string }[] }>(path + "/evaluation-inspect", offline, member.token);
  assert.deepEqual(evidence.sources.map(({ path, content }) => ({ path, content })), [{ path: "app.ts", content: admittedSource }]);
  const session = { session: offline.session };
  const resetPreview = path + "/reset-context-preview";
  const reset = path + "/reset-context";
  assert.equal((await request(resetPreview, session, member.token)).status, 403);
  const { version } = await call<{ version: string }>(resetPreview, session);
  const confirmReset = { ...session, version };
  assert.deepEqual(await call(reset, confirmReset), { reset: true, version });
  assert.notEqual((await call<{ version: string }>(resetPreview, session)).version, version);
  assert.deepEqual(await call(reset, confirmReset), { reset: true, version, replayed: true });
  assert.deepEqual((await call<Inspection>(path + "/inspect", offline, member.token)).pi.request.receipt, saved.pi.request.receipt);

  await rename(detachedWorkspace, workspace);
  const unavailable = { session: "unavailable", requestId: "no-worker" };
  const unavailablePreview = await call<{ id: string }>(path + "/preview", selection);
  const unavailableSubmission = { ...submission, ...unavailable, previewId: unavailablePreview.id };
  await call(path + "/run", unavailableSubmission);
  const launchFailure = await settled(path, unavailable);
  assert.equal(launchFailure.status, "interrupted");
  assert.equal(launchFailure.admitted, false);
  assert.match(launchFailure.error!, /Docker could not start/);
  assert.equal(await Bun.file(join(stateDir, `project-${project.id}`, "session-unavailable", "transcript.sqlite")).exists(), false);

  await closeServer();
  withCatalog((db) => {
    using age = db.prepare("UPDATE runs SET updated = '2020-01-01T00:00:00.000Z' WHERE project = ? AND session = ?");
    assert.equal(age.run(project.id, offline.session).changes, 2);
  });
  server = createServer(unavailableImage);
  assert.deepEqual(await call(path + "/retention", { days: 30 }), { days: 30, active: true, removed: 1 });
  assert.equal(await Bun.file(transcript).exists(), false);
  assert.equal((await request(path + "/inspect", offline, member.token)).status, 410);
  await closeServer();
  await restoreQuiescedState("retention-backup");
  server = createServer(unavailableImage);
  assert.equal(await Bun.file(transcript).exists(), false);
  assert.equal((await request(path + "/resume", offline, member.token)).status, 410);
  assert.equal((await request(path + "/run", { ...submission, ...offline, previewId: approved.id })).status, 410);
  const audit = await call<{ kind: string; session: string | null }[]>(path + "/audit");
  assert.ok(audit.some(({ kind, session }) => kind === "session_expired" && session === offline.session));

  console.log("Docker Coding smoke passed. Verified offline worker isolation and admission, no fallback, scoped access, quiesced backup restoration, owner context reset, archived Pi receipts, and retention tombstones.");
} finally {
  await closeServer();
  await rm(root, { recursive: true, force: true });
}
