import { expect, test } from "bun:test";
import { lstat, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCodingWorkerCheck } from "../src/core/coding/worker-check.ts";

const image = "sha256:" + "a".repeat(64);
const supported = process.platform === "linux" && Boolean(process.getuid?.()) && Boolean(process.getgid?.());
const checkOutput = [
  "session-mount", "sibling-isolation", "docker-socket", "non-root", "capabilities", "no-new-privileges", "seccomp",
  "read-only-root", "offline-network",
].map((id) => id + ":passed").join("\n");

test("the worker check does not launch commands for process mode or an invalid worker configuration", async () => {
  let calls = 0;
  const neverRun = async () => { calls++; throw new Error("No subprocess was expected."); };
  expect(await runCodingWorkerCheck(undefined, neverRun)).toMatchObject({
    isolation: "process", status: "unavailable", configuredNetwork: null, checks: [],
  });
  expect(await runCodingWorkerCheck({ image: "worker:latest", network: "host" }, neverRun)).toMatchObject({
    isolation: "docker", status: "failed", configuredNetwork: null,
    checks: expect.arrayContaining([{ id: "local-image", label: "Pinned local image", status: "failed",
      message: expect.any(String) }]),
  });
  expect(calls).toBe(0);
});

test.skipIf(!supported)("uses fixed local Docker arguments and a disposable offline mount with no credential environment", async () => {
  const commands: string[] = [];
  let directory = "";
  const checked = await runCodingWorkerCheck({ image, network: "offered-bridge" }, async (argv, options) => {
    expect(argv.slice(0, 3)).toEqual(["docker", "--host", "unix:///var/run/docker.sock"]);
    expect(Object.keys(options.env)).toEqual(["PATH"]);
    expect(options.timeout).toBeLessThanOrEqual(12_000);
    directory = options.cwd;
    commands.push(argv[3]!);
    if (argv[3] === "image") {
      expect(argv.at(-1)).toBe(image);
      return { status: 0, stdout: image + "\n" };
    }
    if (argv[3] === "network") {
      expect(argv.at(-1)).toBe("offered-bridge");
      return { status: 0, stdout: "bridge local\n" };
    }
    expect(argv[3]).toBe("run");
    expect(argv[argv.indexOf("--network") + 1]).toBe("none");
    expect(argv[argv.indexOf("--pull") + 1]).toBe("never");
    expect(argv[argv.indexOf("--entrypoint") + 1]).toBe("/bin/sh");
    expect(argv[argv.indexOf("--entrypoint") + 2]).toBe(image);
    expect(argv.filter((value) => value === "--mount")).toHaveLength(1);
    const session = join(directory, "session-check");
    expect(argv[argv.indexOf("--mount") + 1]).toBe(
      `type=bind,source=${session},target=/state/session-check,bind-recursive=disabled`,
    );
    expect((await lstat(directory)).mode & 0o077).toBe(0);
    expect(await readFile(join(session, "input-marker"), "utf8")).toBe(argv.at(-2) + "\n");
    expect(await readFile(argv.at(-1)!, "utf8")).toBe("synthetic sibling\n");
    await writeFile(join(session, "write-marker"), argv.at(-2) + "\n");
    return { status: 0, stdout: checkOutput + "\n" };
  });
  expect(commands.sort()).toEqual(["image", "network", "run"]);
  expect(checked).toMatchObject({ isolation: "docker", status: "passed", configuredNetwork: "offered-bridge" });
  expect(checked.checks).toHaveLength(11);
  expect(checked.checks.every(({ status }) => status === "passed")).toBe(true);
  expect(JSON.stringify(checked)).not.toContain(directory);
  expect(JSON.stringify(checked)).not.toContain(image);
  await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
});

test.skipIf(!supported)("an unavailable image skips the launch and arbitrary output never becomes a result", async () => {
  const commands: string[] = [];
  const checked = await runCodingWorkerCheck({ image, network: "bridge" }, async (argv) => {
    commands.push(argv[3]!);
    return argv[3] === "image"
      ? { status: 1, stdout: "DOCKER_PRIVATE_DETAIL" }
      : { status: 0, stdout: "bridge local\n" };
  });
  expect(commands.sort()).toEqual(["image", "network"]);
  expect(checked.status).toBe("failed");
  expect(checked.checks.find(({ id }) => id === "local-image")?.status).toBe("failed");
  expect(checked.checks.find(({ id }) => id === "session-mount")?.status).toBe("skipped");
  expect(JSON.stringify(checked)).not.toContain("DOCKER_PRIVATE_DETAIL");
});

test.skipIf(!supported)("a matching marker through a symlink cannot satisfy the mount check", async () => {
  const checked = await runCodingWorkerCheck({ image, network: "none" }, async (argv, options) => {
    if (argv[3] === "image") return { status: 0, stdout: image };
    if (argv[3] === "network") return { status: 0, stdout: "null local" };
    const session = join(options.cwd, "session-check");
    await symlink("input-marker", join(session, "write-marker"));
    return { status: 0, stdout: checkOutput };
  });
  expect(checked.status).toBe("failed");
  expect(checked.checks.find(({ id }) => id === "session-mount")?.status).toBe("failed");
});
