import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer, type ApiServer } from "../src/api.ts";
import { mcpOps } from "../src/mcp/server.ts";

const ownerToken = "sync-fixture-owner-0123456789";

function request(api: ApiServer, action: string, input: unknown, headers?: Record<string, string>) {
  return fetch(new URL(`/api/op/${action}`, api.url), {
    method: "POST", body: JSON.stringify(input),
    headers: headers ?? { "content-type": "application/json", "x-okb-token": ownerToken },
  });
}

test("Git setup and recovery require the local owner and a writable brain", async () => {
  const bundle = await mkdtemp(join(tmpdir(), "okb-api-sync-"));
  const writable = createApiServer({ bundle, port: 0, token: ownerToken });
  const readonly = createApiServer({ bundle, port: 0, token: ownerToken, readonly: true });
  try {
    const credentials = { "content-type": "application/json", "x-okb-token": ownerToken };
    const settings = { action: "identity", name: "Browser Owner", email: "owner@example.test" };
    const recovery = { action: "abort", confirm: true };
    const actions = [["sync_settings", settings], ["sync_recovery", recovery]] as const;
    for (const [op, body] of actions) {
      expect((await request(writable, op, body, { "content-type": "application/json", authorization: `Bearer ${ownerToken}` })).status)
        .toBe(401);
      expect((await request(writable, op, body, { ...credentials, origin: "https://outside.example.test" })).status).toBe(403);
      expect((await request(readonly, op, body)).status).toBe(403);
      expect(mcpOps(true).some((candidate) => candidate.name === op)).toBe(false);
    }
    expect(existsSync(join(bundle, ".git"))).toBe(false);

    const status = await request(writable, "sync_settings", { action: "status" });
    expect(status.status).toBe(200);
    expect(status.headers.get("cache-control")).toBe("no-store");
    expect(await status.json()).toMatchObject({ result: { repository: "new", originConfigured: false } });
    expect(existsSync(join(bundle, ".git"))).toBe(false);

    const saved = await request(writable, "sync_settings", settings);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ result: {
      repository: "ready", originConfigured: false, name: settings.name, email: settings.email,
    } });
    expect((await request(writable, "index", {})).status).toBe(200);
    await writeFile(join(bundle, "example.md"), "---\ntype: note\ntitle: Example\ndescription: Offline test\n---\n\nAsync lookup fixture.\n");
    const synced = await request(writable, "sync", {});
    expect(synced.status).toBe(200);
    expect(await synced.json()).toMatchObject({ result: { committed: expect.any(String), pushed: false } });
    const searched = await request(writable, "search", { query: "lookup fixture", "keyword-only": true });
    expect(await searched.json()).toMatchObject({ result: [{ id: "example" }] });
    const url = "https://git.example.test/team/brain.git";
    const origin = await request(writable, "sync_settings", { action: "origin", url });
    const configured = await origin.json();
    expect(configured).toMatchObject({ result: { originConfigured: true, origin: url, fetch: url, push: url } });
    expect(origin.status).toBe(200);

    const current = await request(writable, "sync_recovery", { action: "status" });
    expect(current.status).toBe(200);
    expect(current.headers.get("cache-control")).toBe("no-store");
    expect(await current.json()).toMatchObject({ result: { inProgress: false, conflicts: [] } });
    const oversized = { action: "resolve", path: "notes/example.md", text: "a".repeat(2 * 1024 * 1024) };
    expect((await request(writable, "sync_recovery", oversized)).status).toBe(413);
  } finally {
    await Promise.all([writable.stop(), readonly.stop()]);
    await rm(bundle, { recursive: true, force: true });
  }
});

test("the local GitHub credential route scopes a fake token to the brain and hides its bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "okb-api-sync-github-"));
  const bundle = join(root, "first");
  const other = join(root, "other");
  await Promise.all([mkdir(bundle), mkdir(other)]);
  const writable = createApiServer({ bundle, port: 0, token: ownerToken });
  const readonly = createApiServer({ bundle, port: 0, token: ownerToken, readonly: true });
  const otherBrain = createApiServer({ bundle: other, port: 0, token: ownerToken });
  const owner = { "content-type": "application/json", "x-okb-token": ownerToken };
  const github = (api: ApiServer, input: unknown, headers: Record<string, string> = owner) => fetch(new URL("/api/brains/sync-github", api.url), {
    method: "POST", headers, body: JSON.stringify(input),
  });
  try {
    const login = "fixture-owner";
    const token = "github_pat_" + "OkbrainFixture1234567890".repeat(4);
    const save = { action: "save", login, token };
    const status = { action: "status" };
    const rejected = await github(writable, save, { ...owner, "x-okb-token": "", authorization: `Bearer ${ownerToken}` });
    expect(rejected.status).toBe(401);
    expect(rejected.headers.get("cache-control")).toBe("no-store");
    expect((await github(writable, save, { ...owner, origin: "https://outside.example.test" })).status).toBe(403);
    expect((await github(readonly, save)).status).toBe(403);
    expect((await github(writable, save, { ...owner, "content-type": "text/plain" })).status).toBe(415);
    expect((await github(writable, { ...save, token: "x".repeat(4096) })).status).toBe(413);
    expect((await github(writable, { action: "save", token })).status).toBe(400);

    expect((await github(writable, save)).status).toBe(409);
    const repository = "fixture-owner/private-brain";
    const url = `https://github.com/${repository}.git`;
    for (const api of [writable, otherBrain])
      expect((await request(api, "sync_settings", { action: "origin", url })).status).toBe(200);

    const saved = await github(writable, save);
    expect(saved.headers.get("cache-control")).toBe("no-store");
    const text = await saved.text();
    expect(text).not.toContain(token);
    expect(JSON.parse(text)).toMatchObject({ result: { repository, savedFor: repository, hasToken: true } });
    expect(saved.status).toBe(200);
    expect(await readFile(join(bundle, ".git", "config"), "utf8")).not.toContain(token);
    expect(await (await github(writable, status)).json()).toMatchObject({ result: { repository, hasToken: true } });
    expect(await (await github(otherBrain, status)).json()).toMatchObject({ result: { repository, hasToken: false } });
    expect(mcpOps(true).some((op) => op.name.includes("sync_github"))).toBe(false);

    const git = Bun.spawnSync(["git", "-C", bundle, "config", "--local", "remote.origin.pushurl", "https://github.com/other/other.git"]);
    expect(git.exitCode).toBe(0);
    expect(await (await github(writable, status)).json()).toMatchObject({ result: { repository: null, savedFor: repository, hasToken: true } });
    const removed = await github(writable, { action: "remove" });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ result: { repository: null, savedFor: null, hasToken: false } });
  } finally {
    await Promise.all([writable.stop(), readonly.stop(), otherBrain.stop()]);
    await rm(root, { recursive: true, force: true });
  }
});
