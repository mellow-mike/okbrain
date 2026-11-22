import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dockerWorkerConfig, planDockerWorker, type DockerWorkerConfig } from "./docker-worker.ts";

const workerChecks = {
  "local-image": "Pinned local image",
  "configured-network": "Configured worker network",
  "session-mount": "Single private session mount",
  "sibling-isolation": "Sibling files inaccessible",
  "docker-socket": "Docker socket inaccessible",
  "non-root": "Non-root worker",
  capabilities: "Linux capabilities dropped",
  "no-new-privileges": "No new privileges",
  seccomp: "Seccomp filter",
  "read-only-root": "Read-only root filesystem",
  "offline-network": "Loopback-only probe network",
} as const;

type CheckId = keyof typeof workerChecks;
type Check = { id: CheckId; label: string; status: "passed" | "failed" | "skipped"; message?: string };
export type CodingWorkerCheckResult = {
  isolation: "docker" | "process";
  status: "passed" | "failed" | "unavailable";
  configuredNetwork: string | null;
  checkedAt: string;
  checks: Check[];
};

type CommandResult = { status: number; stdout: string };
type CommandOptions = { cwd: string; env: Record<string, string>; timeout: number };
type RunCommand = (argv: string[], options: CommandOptions) => Promise<CommandResult>;

const inspectionTimeout = 4000;
const probeTimeout = 12_000;
const maxOutputBytes = 4096;
const boundaryChecks = [
  "session-mount", "sibling-isolation", "docker-socket", "non-root", "capabilities", "no-new-privileges",
  "seccomp", "read-only-root", "offline-network",
] as const satisfies readonly CheckId[];

// Keep all shell code fixed. The shell receives a synthetic nonce and a
// disposable sibling path as positional arguments, never as shell source.
const boundaryScript = `
test -x /usr/local/bin/okbrain-worker
check() {
  name="$1"
  shift
  if "$@"; then printf '%s:passed\n' "$name"; else printf '%s:failed\n' "$name"; fi
}
mount_ok() {
  test "$(cat input-marker)" = "$1" &&
  awk '$5 == "/state" || index($5, "/state/") == 1 {
    count++; if ($5 == "/state/session-check" && $6 ~ /^rw(,|$)/) found = 1
  } END { exit !(count == 1 && found) }' /proc/self/mountinfo &&
  printf '%s\n' "$1" > write-marker
}
sibling_ok() { test ! -e /state/session-sibling/hidden-marker && test ! -e "$1"; }
socket_ok() { test ! -e /var/run/docker.sock && test ! -e /run/docker.sock; }
non_root() { test "$(id -u)" -ne 0 && test "$(id -g)" -ne 0; }
caps_dropped() {
  awk '/^Cap(Inh|Prm|Eff|Bnd|Amb):/ {
    count++; if ($2 != "0000000000000000") bad = 1
  } END { exit (bad || count != 5) }' /proc/self/status
}
offline() { test "$(ls -A /sys/class/net)" = lo && test "$(wc -l < /proc/net/route)" -eq 1; }
check session-mount mount_ok "$1"
check sibling-isolation sibling_ok "$2"
check docker-socket socket_ok
check non-root non_root
check capabilities caps_dropped
check no-new-privileges grep -Eq '^NoNewPrivs:[[:space:]]+1$' /proc/self/status
check seccomp grep -Eq '^Seccomp:[[:space:]]+2$' /proc/self/status
check read-only-root awk '$5 == "/" && $6 ~ /^ro(,|$)/ { ok = 1 } END { exit !ok }' /proc/self/mountinfo
check offline-network offline
`;

function result(id: CheckId, status: Check["status"], message?: string): Check {
  return { id, label: workerChecks[id], status, ...(message ? { message } : {}) };
}

function report(isolation: CodingWorkerCheckResult["isolation"], configuredNetwork: string | null, checks: Check[]): CodingWorkerCheckResult {
  return {
    isolation, configuredNetwork, checkedAt: new Date().toISOString(), checks,
    status: isolation === "process" ? "unavailable" : checks.every(({ status }) => status === "passed") ? "passed" : "failed",
  };
}

async function runCommand(argv: string[], options: CommandOptions): Promise<CommandResult> {
  const child = Bun.spawn(argv, { ...options, stdin: "ignore", stdout: "pipe", stderr: "ignore", maxBuffer: maxOutputBytes, killSignal: "SIGKILL" });
  const bytes = Buffer.alloc(maxOutputBytes);
  let length = 0;
  try {
    for await (const chunk of child.stdout) {
      if (chunk.byteLength > bytes.length - length) throw new Error("Docker probe output exceeded its limit.");
      bytes.set(chunk, length);
      length += chunk.byteLength;
    }
    return { status: await child.exited, stdout: bytes.toString("utf8", 0, length) };
  } catch (error) {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    throw error;
  }
}

async function checkCommand(run: RunCommand, argv: string[], options: CommandOptions): Promise<string | undefined> {
  try {
    const execution = await run(argv, options);
    if (execution.status === 0 && Buffer.byteLength(execution.stdout) <= maxOutputBytes) return execution.stdout.trim();
  } catch { /* Do not include process paths, environment, or Docker output in the report. */ }
}

function skippedBoundary(): Check[] {
  return boundaryChecks.map((id) => result(id, "skipped"));
}

function failedBoundary(): Check[] {
  return [
    result("session-mount", "failed", "Docker could not run the offline probe. Check the daemon and the locally built worker image."),
    ...boundaryChecks.slice(1).map((id) => result(id, "skipped")),
  ];
}

function probeResults(output: string | undefined): Check[] | undefined {
  const lines = output?.split("\n");
  if (!lines || lines.length !== boundaryChecks.length) return;
  const checks: Check[] = [];
  for (const [index, id] of boundaryChecks.entries()) {
    const line = lines[index];
    if (line !== `${id}:passed` && line !== `${id}:failed`) return;
    checks.push(result(id, line.endsWith(":passed") ? "passed" : "failed"));
  }
  return checks;
}

async function wroteMarker(path: string, expected: string): Promise<boolean> {
  try {
    // Treat the marker left by the container as untrusted. Read only the fixed
    // number of bytes and never follow symlinks out of the private directory.
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      const target = Buffer.from(expected);
      if (!info.isFile() || info.nlink !== 1 || info.size !== target.length) return false;
      const bytes = Buffer.alloc(target.length);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      return bytesRead === target.length && bytes.equals(target);
    } finally { await file.close(); }
  } catch { return false; }
}

/** Inspect local Docker metadata and exercise only a disposable, offline worker. */
export async function runCodingWorkerCheck(
  config: DockerWorkerConfig | undefined,
  run: RunCommand = runCommand,
): Promise<CodingWorkerCheckResult> {
  if (!config) return report("process", null, []);
  let verified: DockerWorkerConfig;
  try { verified = dockerWorkerConfig(config.image, config.network)!; }
  catch {
    return report("docker", null, [
      result("local-image", "failed", "Set a pinned local worker image on Linux under a non-root account."),
      result("configured-network", "skipped"), ...skippedBoundary(),
    ]);
  }
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(await realpath(tmpdir()), "okb-worker-check-"));
    const plan = planDockerWorker({ ...verified, network: "none" }, directory, "check");
    const docker = plan.argv.slice(0, plan.argv.indexOf("run"));
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
    const inspect = (args: string[]) => checkCommand(run, [...docker, ...args], { cwd: directory!, env, timeout: inspectionTimeout });
    const [imageId, network] = await Promise.all([
      inspect(["image", "inspect", "--format", "{{.Id}}", verified.image]),
      inspect(["network", "inspect", "--format", "{{.Driver}} {{.Scope}}", verified.network]),
    ]);
    const imageAvailable = imageId === verified.image;
    const validNetwork = network === (verified.network === "none" ? "null local" : "bridge local");
    const checks = [
      imageAvailable ? result("local-image", "passed")
        : result("local-image", "failed", "Docker did not verify the pinned image locally. Check the daemon and local worker image ID."),
      validNetwork ? result("configured-network", "passed", "Docker reports this network is available. The offline probe makes no connection through it.")
        : result("configured-network", "failed", "Docker could not verify the configured network as a local bridge or the offline network."),
    ];
    if (!imageAvailable) return report("docker", verified.network, [...checks, ...skippedBoundary()]);

    const session = join(directory, "session-check");
    const sibling = join(directory, "session-sibling");
    const marker = randomUUID();
    const privateMarker = join(sibling, "hidden-marker");
    await mkdir(sibling, { mode: 0o700 });
    await writeFile(privateMarker, "synthetic sibling\n", { flag: "wx", mode: 0o600 });
    await writeFile(join(session, "input-marker"), marker + "\n", { flag: "wx", mode: 0o600 });
    const argv = [...plan.argv];
    argv[argv.indexOf("--entrypoint") + 1] = "/bin/sh";
    const output = await checkCommand(run, [...argv, "-ec", boundaryScript, "worker-check", marker, privateMarker],
      { cwd: directory, env, timeout: probeTimeout });
    const boundary = probeResults(output);
    if (!boundary) {
      await plan.cleanup(env).catch(() => {});
      return report("docker", verified.network, [...checks, ...failedBoundary()]);
    }
    if (boundary[0]?.status === "passed" && !await wroteMarker(join(session, "write-marker"), marker + "\n"))
      boundary[0] = result("session-mount", "failed", "The worker could not write the expected marker through its private mount.");
    return report("docker", verified.network, [...checks, ...boundary]);
  } catch {
    return report("docker", verified.network, [
      result("local-image", "skipped"), result("configured-network", "skipped"), ...failedBoundary(),
    ]);
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
