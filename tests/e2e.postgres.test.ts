import { SQL } from "bun";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensureExtensionCapableSqlite } from "../src/core/engine/custom-sqlite.ts";

const postgresUrl = process.env.OKB_TEST_POSTGRES_URL;

test.skipIf(!postgresUrl)("CLI PostgreSQL cache matches local keyword, graph, and vector workflows through rebuild", async () => {
  const address = new URL(postgresUrl!);
  if (!["127.0.0.1", "[::1]"].includes(address.hostname)) throw new Error("Use a disposable loopback PostgreSQL fixture.");
  const root = await mkdtemp(join(tmpdir(), "okb-postgres-e2e-"));
  const config = join(root, "config");
  const data = join(root, "data");
  const bundles = { postgres: join(root, "postgres-brain"), sqlite: join(root, "sqlite-brain") };
  const settings = join(data, "okbrain", "cache", "settings.sqlite");
  const sql = new SQL(address.toString());
  let embeddingCalls = 0;
  const provider = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/embeddings")
        return new Response("Unknown fixture endpoint", { status: 404 });
      const payload = await request.json() as { input: string[]; model: string };
      if (payload.model !== "pg-parity-embedding") return new Response("Wrong fixture model", { status: 400 });
      embeddingCalls++;
      return Response.json({ data: payload.input.map((text, index) => ({
        index, embedding: /citrus|sea glass/iu.test(text) ? [1, 0, 0] : [0, 1, 0],
      })) });
    },
  });
  const cli = resolve(import.meta.dir, "../src/cli.ts");
  const cwd = resolve(import.meta.dir, "..");
  const env = { ...process.env, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data, APPDATA: config, LOCALAPPDATA: data };
  async function run(bundle: string, ...args: string[]) {
    const child = Bun.spawn([process.execPath, cli, "--bundle", bundle, "--json", ...args], {
      cwd, env, stdout: "pipe", stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([child.exited, child.stdout.text(), child.stderr.text()]);
    return { code, out, err };
  }
  async function succeeds<T>(bundle: string, ...args: string[]): Promise<T> {
    const result = await run(bundle, ...args);
    if (result.code) throw new Error(`okb ${args[0]} failed: ${result.err.trim()}`);
    return JSON.parse(result.out) as T;
  }

  try {
    await mkdir(join(config, "okbrain"), { recursive: true });
    await writeFile(join(config, "okbrain", "config.json"), JSON.stringify({
      ai: { embedProvider: "local", embedModel: "pg-parity-embedding", embedBaseUrl: `http://127.0.0.1:${provider.port}/v1` },
    }));
    for (const bundle of Object.values(bundles)) {
      await mkdir(join(bundle, "notes"), { recursive: true });
      await writeFile(join(bundle, "notes", "fruit.md"),
        "---\ntype: note\ntitle: Citrus orchard\ndescription: Seasonal fruit\ntags: [orchard]\n---\nTree fruit grows here. [Weather](/notes/weather.md).\n");
      await writeFile(join(bundle, "notes", "weather.md"),
        "---\ntype: note\ntitle: Winter forecast\ndescription: Temperature records\n---\nFrost and cold mornings.\n");
    }
    const selected = await succeeds<{ backend: string }>(bundles.postgres, "cache-settings", "postgres", "--connection-env", "OKB_TEST_POSTGRES_URL");
    expect(selected.backend).toBe("postgres");
    expect(JSON.stringify(selected)).not.toContain(address.password);
    const unopened = await run(bundles.postgres, "search", "citrus", "--keyword-only");
    expect(unopened.code).toBe(1);
    expect(unopened.err).toContain("okb index");
    for (const bundle of Object.values(bundles)) await succeeds(bundle, "index");

    type Hit = { id: string; sources: string[] };
    const keyword = (bundle: string) => succeeds<Hit[]>(bundle, "search", "citrus", "--keyword-only");
    const pgKeyword = await keyword(bundles.postgres);
    const localKeyword = await keyword(bundles.sqlite);
    expect(pgKeyword.map(({ id }) => id)).toEqual(localKeyword.map(({ id }) => id));
    expect(pgKeyword[0]?.id).toBe("notes/fruit");
    const graph = (bundle: string) => succeeds<{ id: string; dir: string }[]>(bundle, "graph", "notes/fruit");
    const sqliteGraph = await graph(bundles.sqlite);
    expect(await graph(bundles.postgres)).toEqual(sqliteGraph);
    expect(sqliteGraph).toContainEqual(expect.objectContaining({ id: "notes/weather", dir: "out" }));

    for (const bundle of Object.values(bundles)) {
      expect(await succeeds<{ embedded: number; dim: number }>(bundle, "embed")).toMatchObject({ embedded: 2, dim: 3 });
    }
    const semantic = (bundle: string) => succeeds<Hit[]>(bundle, "search", "sea glass", "--profile", "balanced");
    const pgVectorHits = await semantic(bundles.postgres);
    expect(pgVectorHits[0]).toMatchObject({ id: "notes/fruit", sources: expect.arrayContaining(["vector"]) });
    expect(pgVectorHits.map(({ id, sources }) => ({ id, sources }))).toEqual(
      (await semantic(bundles.sqlite)).map(({ id, sources }) => ({ id, sources })),
    );
    expect(existsSync(join(bundles.postgres, ".okb", "index.db"))).toBe(false);
    expect(existsSync(join(bundles.postgres, ".okb", "vectors.db"))).toBe(false);

    await succeeds(bundles.postgres, "rebuild", "--confirm-destructive");
    const before = embeddingCalls;
    expect(await succeeds<{ embedded: number; skipped: number }>(bundles.postgres, "embed")).toMatchObject({ embedded: 0, skipped: 2 });
    expect(embeddingCalls).toBe(before);
    expect(await graph(bundles.postgres)).toEqual(sqliteGraph);
    expect((await semantic(bundles.postgres))[0]?.id).toBe("notes/fruit");

    // Simulate a failed database connection without affecting other tests using the fixture.
    const failedDatabase = Bun.listen({
      hostname: "127.0.0.1", port: 0,
      socket: { open(socket) { socket.end(); }, data() {} },
    });
    const unavailable = new URL(address);
    unavailable.port = String(failedDatabase.port);
    unavailable.searchParams.set("sslmode", "disable");
    ensureExtensionCapableSqlite();
    {
      using db = new Database(settings);
      db.query("UPDATE settings SET connection = ? WHERE connection IS NOT NULL").run(unavailable.toString());
    }
    const server = Bun.spawn([process.execPath, cli, "--bundle", bundles.postgres, "serve", "--desktop"], {
      cwd, env, stdout: "pipe", stderr: "ignore",
    });
    const stopUnreadyServer = setTimeout(() => server.kill(), 5000);
    try {
      const reader = server.stdout.getReader();
      let line = "";
      while (!line.includes("\n")) {
        const next = await reader.read();
        if (next.done) break;
        line += Buffer.from(next.value).toString();
      }
      reader.releaseLock();
      clearTimeout(stopUnreadyServer);
      if (!line.startsWith("http://127.0.0.1:")) throw new Error("The local app did not start.");
      const base = new URL(line.trim());
      const token = (await readFile(join(config, "okbrain", "serve-token"), "utf8")).trim();
      const headers = { "x-okb-token": token, "content-type": "application/json" };
      const post = (op: string, params: object) => fetch(new URL("api/op/" + op, base), {
        method: "POST", headers, body: JSON.stringify(params),
      });
      const status = await fetch(new URL("api/status", base), { headers });
      expect(status.status).toBe(200);
      const degraded = await status.json();
      expect(degraded).toMatchObject({
        cacheBackend: "postgres", cacheError: expect.stringContaining("PostgreSQL cache is unavailable"),
        hasIndex: false, hasVectors: false,
      });
      expect(JSON.stringify(degraded)).not.toContain(address.password);
      const search = await post("search", { query: "citrus", "keyword-only": true });
      expect(search.status).toBe(409);
      expect(await search.text()).toContain("PostgreSQL cache is unavailable");
      const write = await post("write_concept", { id: "notes/offline", type: "note", title: "Offline durable note",
        description: "Keeps its canonical data", body: "Saved while PostgreSQL was unavailable." });
      expect(write.status).toBe(200);
      expect(await readFile(join(bundles.postgres, "notes", "offline.md"), "utf8")).toContain("Saved while PostgreSQL was unavailable.");
      const fallback = await post("cache_settings", { backend: "sqlite" });
      expect(fallback.status).toBe(200);
      expect(await fallback.json()).toMatchObject({ result: { backend: "sqlite" } });
      const recovered = await fetch(new URL("api/status", base), { headers });
      expect(await recovered.json()).toMatchObject({ cacheBackend: "sqlite", cacheError: null });
    } finally {
      clearTimeout(stopUnreadyServer);
      server.kill();
      await server.exited;
      failedDatabase.stop(true);
    }
    await succeeds(bundles.postgres, "index");
    expect(existsSync(join(bundles.postgres, ".okb", "index.db"))).toBe(true);
  } finally {
    try {
      if (existsSync(settings)) {
        ensureExtensionCapableSqlite();
        using db = new Database(settings, { readonly: true });
        const schemas = db.query<{ namespace: string }, []>("SELECT namespace FROM settings").all();
        for (const { namespace } of schemas) {
          if (/^okb_[0-9a-f]{32}$/u.test(namespace)) await sql`DROP SCHEMA IF EXISTS ${sql(namespace)} CASCADE`;
        }
      }
    } finally {
      await provider.stop(true);
      await sql.close();
      await rm(root, { recursive: true, force: true });
    }
  }
}, 25_000);
