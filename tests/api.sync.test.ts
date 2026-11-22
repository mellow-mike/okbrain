import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
