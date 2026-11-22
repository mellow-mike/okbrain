import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { CodingError } from "./durable.ts";

const docker = ["docker", "--host", "unix:///var/run/docker.sock"];
export const dockerWorkerStateDir = "/state";

export interface DockerWorkerConfig {
  image: string;
  network: string;
}

export function dockerWorkerConfig(image: string | undefined, network: string | undefined): DockerWorkerConfig | undefined {
  if (image === undefined) return undefined;
  if (process.platform !== "linux" || !process.getuid?.() || !process.getgid?.()) {
    throw new CodingError("Docker workers require a non-root okbrain service account on Linux.");
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) {
    throw new CodingError("Set OKB_CODING_WORKER_IMAGE to the local worker image ID (sha256 followed by 64 hexadecimal digits).");
  }
  const selectedNetwork = network ?? "bridge";
  if (selectedNetwork === "host" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(selectedNetwork)) {
    throw new CodingError("Choose a Docker bridge network for OKB_CODING_WORKER_NETWORK, or use none for offline checks.");
  }
  return { image, network: selectedNetwork };
}

export function planDockerWorker(config: DockerWorkerConfig, stateDir: string, session: string) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(session)) throw new CodingError("Choose a valid coding session name.");
  const sessionName = `session-${session}`;
  const hostSession = join(stateDir, sessionName);
  mkdirSync(hostSession, { recursive: true, mode: 0o700 });
  const info = lstatSync(hostSession);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
    throw new CodingError("Docker workers require a private transcript directory owned by the okbrain service account.");
  }
  const source = realpathSync(hostSession);
  // The Docker CLI parses --mount as CSV. Permit ordinary spaces without interpreting additional mount fields.
  if (/[,"\r\n]/.test(source)) throw new CodingError("Choose a transcript directory path without commas, quotes, or line breaks for Docker workers.");
  const target = `${dockerWorkerStateDir}/${sessionName}`;
  const name = `okbrain-worker-${randomUUID()}`;
  return {
    argv: [
      ...docker, "run", "--rm", "--interactive", "--init", "--name", name, "--label", "okbrain.role=coding-worker",
      "--pull", "never", "--log-driver", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--user", `${process.getuid?.()}:${process.getgid?.()}`, "--pids-limit", "128", "--cpus", "1",
      "--memory", "512m", "--memory-swap", "512m", "--network", config.network,
      "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777", "--env", "HOME=/tmp",
      "--mount", `type=bind,source=${source},target=${target},bind-recursive=disabled`,
      "--workdir", target, "--entrypoint", "/usr/local/bin/okbrain-worker", config.image,
    ],
    async cleanup(env: Record<string, string | undefined>) {
      // A disconnected attach client can leave its container live. Scope cleanup to this exact launch.
      const child = Bun.spawn([...docker, "rm", "--force", name], { env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      const timeout = setTimeout(() => child.kill(), 5000);
      try { await child.exited; }
      finally { clearTimeout(timeout); }
    },
  };
}
