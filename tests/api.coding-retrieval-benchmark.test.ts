import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../src/api.ts";
import { pinnedViteRevision } from "../src/core/coding/evaluation-rubric.ts";

test("a source retrieval benchmark is scoped to the writable local operator and pinned workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "okb-retrieval-benchmark-"));
  const bundle = join(root, "brain");
  const workspace = join(root, "repository");
  const locked = join(root, "read-only-brain");
  const token = "local-benchmark-test-owner";
  await Promise.all([mkdir(bundle), mkdir(workspace), mkdir(locked)]);
  const server = createApiServer({ bundle, token, port: 0, coding: { stateDir: join(root, "coding") } });
  const call = (path: string, body?: unknown, options: { member?: string; brain?: string; anonymous?: boolean } = {}) =>
    fetch(new URL("api/" + path, server.url), {
      method: body === undefined ? "GET" : "POST",
      headers: { ...(options.anonymous ? {} : options.member ? { authorization: `Bearer ${options.member}` } : { "x-okb-token": token }),
        ...(options.brain ? { "x-okb-brain": options.brain } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000),
    });
  const result = async <T,>(response: Response): Promise<T> => {
    const payload = await response.json() as { result: T; error?: string };
    if (!response.ok) throw new Error(`Unexpected Coding response ${response.status}: ${payload.error}`);
    return payload.result;
  };

  try {
    const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: workspace, stdio: "ignore",
      env: { ...gitEnv, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "unused-config") } });
    await mkdir(join(workspace, "src"));
    await writeFile(join(workspace, "src", "main.ts"), "export const fixture = true;\n");
    git("init", "--quiet", "--template=");
    git("add", "--", "src/main.ts");
    git("-c", "user.name=Benchmark Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgSign=false",
      "commit", "--quiet", "-m", "Fixture revision");

    const register = (title: string, scopes: string[]) => call("coding/projects", { title, scopes, workspace, provider: "openai", model: "gpt-5-mini" });
    const full = await result<{ id: string }>(await register("Benchmark preparation fixture", ["."]));
    const narrow = await result<{ id: string }>(await register("Restricted source fixture", ["src"]));
    const base = `coding/projects/${full.id}`;
    const path = `${base}/retrieval-benchmark`;
    const member = await result<{ token: string }>(await call(`${base}/members`, { name: "fixture-reviewer" }));
    expect((await call("brains/mounts", { action: "register", name: "locked-benchmark", path: locked, readonly: true })).status).toBe(200);
    const start = { action: "start", study: "subsystem", repetitions: 2, tokenBudget: 12288 };

    expect(await result(await call(path))).toEqual({ status: "idle" });
    expect((await call(path, undefined, { anonymous: true })).status).toBe(401);
    expect((await call(path, undefined, { member: member.token })).status).toBe(403);
    expect((await call(path, start, { member: member.token })).status).toBe(403);
    expect((await call(path, start, { brain: "locked-benchmark" })).status).toBe(403);
    expect((await call(path, { ...start, workspace })).status).toBe(400);
    expect((await call(path, { ...start, repetitions: 51 })).status).toBe(400);
    expect((await call(path, { ...start, tokenBudget: "12288" })).status).toBe(400);
    const narrowPath = `coding/projects/${narrow.id}/retrieval-benchmark`;
    expect((await call(narrowPath, start)).status).toBe(403);
    expect(await result(await call(narrowPath))).toEqual({ status: "idle" });
    expect(await result(await call(path))).toEqual({ status: "idle" });

    type State = { id: string; status: string; error?: string };
    const awaitFailure = async () => {
      const end = Date.now() + 4000;
      for (;;) {
        const response = await call(path);
        expect(response.headers.get("cache-control")).toBe("no-store");
        const current = await result<State>(response);
        if (current.status === "failed" || Date.now() >= end) return current;
        await Bun.sleep(20);
      }
    };
    const started = await result<State>(await call(path, start));
    expect(started).toMatchObject({ status: "running", completed: 0, total: 36, revision: pinnedViteRevision, study: "subsystem" });
    const failed = await awaitFailure();
    expect(failed).toMatchObject({ id: started.id, status: "failed" });
    expect(failed.error).toContain(pinnedViteRevision);
    expect(failed.error).not.toContain(workspace);
    expect(failed).not.toHaveProperty("report");
    const newer = await result<State>(await call(path, { ...start, study: "package", repetitions: 1, tokenBudget: 4096 }));
    expect(newer.id).not.toBe(started.id);
    expect((await call(path, { action: "cancel", id: started.id })).status).toBe(409);
    const terminal = await awaitFailure();
    expect(terminal).toMatchObject({ id: newer.id, status: "failed" });
    expect(await result(await call(path, { action: "cancel", id: newer.id }))).toEqual(terminal);
    expect(await result(await call(`${base}/runs`))).toEqual([]);
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
