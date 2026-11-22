// 2.2: embed pipeline — content-hash skip (re-embed only on change), cache-key
// invalidation on provider/model switch, --limit pacing, stale removal, the
// write hook, and `okb embed` + hook end-to-end against a stub embed server.

import { SQL } from "bun";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IndexVectors, VectorStore } from "../src/core/engine/interface.ts";
import { openPostgresVectors } from "../src/core/engine/postgres-vectors.ts";
import { defaultVectorsPath, openVectorStore } from "../src/core/engine/vectors.ts";
import { readConceptPermissive } from "../src/core/okf/bundle.ts";
import { normalizeVerified } from "../src/core/okf/document.ts";
import { embedBundle, embedConcept, type Embedder } from "../src/core/retrieval/embed.ts";
import { okb } from "./helpers.ts";

interface FakeEmbedder extends Embedder {
  calls: string[][];
}

function fakeEmbedder(provider = "fake", model = "m1", dim = 4): FakeEmbedder {
  const calls: string[][] = [];
  return {
    provider,
    model,
    calls,
    embed: async (texts) => {
      calls.push(texts);
      return texts.map(vecOf.bind(null, dim));
    },
  };
}

function vecOf(dim: number, text: string): number[] {
  let h = 2166136261; // FNV-1a: distinct texts must get distinct directions
  for (const ch of text) h = ((h ^ ch.codePointAt(0)!) * 16777619) >>> 0;
  return Array.from({ length: dim }, (_, i) => 1 + ((h >>> ((i % 8) * 4)) & 15));
}

const concept = (title: string, description: string, body: string) =>
  `---\ntype: note\ntitle: ${title}\ndescription: ${description}\n---\n${body}`;

let root: string;
let store: VectorStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "okb-embed-"));
  await writeFile(join(root, "index.md"), "# bundle\n");
  await mkdir(join(root, "notes"), { recursive: true });
  await writeFile(join(root, "notes", "alpha.md"), concept("Alpha", "first", "Alpha body about databases.\n"));
  await writeFile(join(root, "notes", "beta.md"), concept("Beta", "second", "Beta body about gardens.\n"));
  await writeFile(join(root, "notes", "empty.md"), concept("Empty", "only a description", ""));
  store = openVectorStore(":memory:");
});

afterEach(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
});

async function rejectsStaleEmbed(stale: IndexVectors, current: IndexVectors) {
  for (const hasInitialKey of [true, false]) {
    await current.clear();
    if (hasInitialKey) await current.reset({ provider: "fixture", model: "older", dim: 2 });
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const oldWork = embedBundle(root, stale, {
      provider: "fixture", model: "older",
      async embed(texts) {
        started.resolve();
        await release.promise;
        return texts.map(() => [1, 0]);
      },
    }).catch((error: unknown) => error);
    try {
      await Promise.race([started.promise, oldWork.then(() => { throw new Error("The stale provider never started."); })]);
      await embedBundle(root, current, {
        provider: "fixture", model: "newer", embed: async (texts) => texts.map(() => [0, 1]),
      });
    } finally { release.resolve(); }
    expect(await oldWork).toMatchObject({ message: "The vector cache changed while embedding. Run okb embed again." });
    expect(await current.meta()).toEqual({ provider: "fixture", model: "newer", dim: 2 });
    expect(await current.count()).toBe(3);
    const hits = await current.search([0, 1]);
    expect(hits).toHaveLength(3);
    expect(hits.every(({ distance }) => distance === 0)).toBe(true);
  }
}

test("in-flight SQLite embedding cannot replace or reset a newer model's cache", async () => {
  await rejectsStaleEmbed(store, store);
});

const postgresFixture = process.env.OKB_TEST_POSTGRES_URL;
test.skipIf(!postgresFixture)("concurrent embeddings from separate PostgreSQL pools respect the cache key", async () => {
  const address = new URL(postgresFixture!);
  if (!["127.0.0.1", "[::1]"].includes(address.hostname)) throw new Error("Use a disposable loopback PostgreSQL fixture.");
  const schema = "okb_" + randomBytes(16).toString("hex");
  const sql = new SQL(address.toString());
  const second = new SQL(address.toString());
  try {
    const stale = await openPostgresVectors(sql, schema, true);
    const current = await openPostgresVectors(second, schema, false);
    await rejectsStaleEmbed(stale, current);
  } finally {
    try {
      await sql`DROP SCHEMA IF EXISTS ${sql(schema)} CASCADE`;
    } finally {
      await Promise.all([sql.close(), second.close()]);
    }
  }
});

describe("embedBundle", () => {
  test("fresh run embeds everything, pins the cache key, prefixes titles", async () => {
    const emb = fakeEmbedder();
    const stats = await embedBundle(root, store, emb);
    expect(stats).toMatchObject({
      embedded: 3,
      chunks: 3,
      skipped: 0,
      removed: 0,
      pending: 0,
      dim: 4,
      reset: true,
    });
    expect(store.meta()).toEqual({ provider: "fake", model: "m1", dim: 4 });
    expect(store.count()).toBe(3);
    const inputs = emb.calls.flat();
    expect(inputs).toContain("Alpha\n\nAlpha body about databases.");
    // empty body falls back to the description
    expect(inputs).toContain("Empty\n\nonly a description");
  });

  test("rerun skips everything without a single embed call", async () => {
    const emb = fakeEmbedder();
    await embedBundle(root, store, emb);
    const callsBefore = emb.calls.length;
    const stats = await embedBundle(root, store, emb);
    expect(stats).toMatchObject({ embedded: 0, skipped: 3, reset: false });
    expect(emb.calls.length).toBe(callsBefore);
  });

  test("only a changed concept re-embeds; vector search finds the new text", async () => {
    const emb = fakeEmbedder();
    await embedBundle(root, store, emb);
    await writeFile(join(root, "notes", "beta.md"), concept("Beta", "second", "Rewritten body about oceans.\n"));
    const stats = await embedBundle(root, store, emb);
    expect(stats).toMatchObject({ embedded: 1, chunks: 1, skipped: 2 });
    expect(emb.calls.at(-1)).toEqual(["Beta\n\nRewritten body about oceans."]);
    const hit = store.search(vecOf(4, "Beta\n\nRewritten body about oceans."), 1)[0]!;
    expect(hit.nodeId).toBe("notes/beta");
    expect(hit.text).toBe("Rewritten body about oceans.");
  });

  test("a metadata-only frontmatter change does not re-embed", async () => {
    const emb = fakeEmbedder();
    await embedBundle(root, store, emb);
    await writeFile(
      join(root, "notes", "alpha.md"),
      `---\ntype: note\ntitle: Alpha\ndescription: first\nlast_reviewed: 2026-07-13T00:00:00Z\n---\nAlpha body about databases.\n`,
    );
    const stats = await embedBundle(root, store, emb);
    expect(stats).toMatchObject({ embedded: 0, skipped: 3 });
  });

  test("provider/model switch invalidates the whole store", async () => {
    await embedBundle(root, store, fakeEmbedder("fake", "m1"));
    const stats = await embedBundle(root, store, fakeEmbedder("fake", "m2", 8));
    expect(stats).toMatchObject({ embedded: 3, skipped: 0, reset: true, dim: 8 });
    expect(store.meta()).toEqual({ provider: "fake", model: "m2", dim: 8 });
    expect(store.count()).toBe(3);
  });

  test("--limit paces; the next run picks up the remainder", async () => {
    const emb = fakeEmbedder();
    const first = await embedBundle(root, store, emb, { limit: 2 });
    expect(first).toMatchObject({ embedded: 2, pending: 1, reset: true });
    const second = await embedBundle(root, store, emb);
    expect(second).toMatchObject({ embedded: 1, skipped: 2, pending: 0, reset: false });
    expect(store.count()).toBe(3);
  });

  test("a vanished concept is removed from the store", async () => {
    const emb = fakeEmbedder();
    await embedBundle(root, store, emb);
    await unlink(join(root, "notes", "beta.md"));
    const stats = await embedBundle(root, store, emb);
    expect(stats).toMatchObject({ embedded: 0, skipped: 2, removed: 1 });
    expect(store.count()).toBe(2);
    expect(store.embeddedHashes().has("notes/beta")).toBe(false);
  });

  test("multi-chunk concepts assemble correctly across batch boundaries", async () => {
    const paras = ["one", "two", "three"].map((w) => `${w} ${"x".repeat(1200)}`);
    await writeFile(join(root, "notes", "gamma.md"), concept("Gamma", "long", paras.join("\n\n")));
    const emb = fakeEmbedder();
    const stats = await embedBundle(root, store, emb, { batchSize: 2 });
    expect(stats).toMatchObject({ embedded: 4, chunks: 6 });
    expect(emb.calls.every((c) => c.length <= 2)).toBe(true);
    const hit = store.search(vecOf(4, `Gamma\n\n${paras[2]}`), 1)[0]!;
    expect([hit.nodeId, hit.seq]).toEqual(["notes/gamma", 2]);
  });
});

describe("embedConcept (write hook)", () => {
  test("does nothing until okb embed has pinned a cache key", async () => {
    const emb = fakeEmbedder();
    expect(await embedConcept(root, "notes/alpha", store, emb)).toBe(false);
    expect(emb.calls).toEqual([]);
  });

  test("refreshes a changed concept under a matching key, skips unchanged", async () => {
    const emb = fakeEmbedder();
    await embedBundle(root, store, emb);
    expect(await embedConcept(root, "notes/alpha", store, emb)).toBe(false);
    await writeFile(join(root, "notes", "alpha.md"), concept("Alpha", "first", "Changed body.\n"));
    expect(await embedConcept(root, "notes/alpha", store, emb)).toBe(true);
    expect(store.search(vecOf(4, "Alpha\n\nChanged body."), 1)[0]!.nodeId).toBe("notes/alpha");
  });

  test("never fights the cache key: a mismatched embedder is a no-op", async () => {
    await embedBundle(root, store, fakeEmbedder("fake", "m1"));
    const other = fakeEmbedder("fake", "m2");
    await writeFile(join(root, "notes", "alpha.md"), concept("Alpha", "first", "Changed body.\n"));
    expect(await embedConcept(root, "notes/alpha", store, other)).toBe(false);
    expect(other.calls).toEqual([]);
    expect(store.meta()!.model).toBe("m1");
  });
});

describe("okb embed + write hook (stub embed server)", () => {
  let server: ReturnType<typeof Bun.serve>;
  let requests = 0;

  beforeAll(async () => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { input: string[] };
        requests++;
        return Response.json({ data: body.input.map(() => ({ embedding: [0.1, 0.2, 0.3] })) });
      },
    });
    process.env.OKB_EMBED_PROVIDER = "ollama";
    process.env.OKB_EMBED_BASE_URL = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    delete process.env.OKB_EMBED_PROVIDER;
    delete process.env.OKB_EMBED_BASE_URL;
    server.stop();
  });

  test("okb embed builds the store; rerun is incremental", async () => {
    const first = await okb(["--bundle", root, "embed"]);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("embedded 3");
    expect(await Bun.file(defaultVectorsPath(root)).exists()).toBe(true);

    const again = await okb(["--bundle", root, "embed"]);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("embedded 0 (0 chunks), skipped 3");
  });

  test("a write refreshes its own vectors, so okb embed has nothing to do", async () => {
    await okb(["--bundle", root, "embed"]);
    const before = requests;
    const write = await okb([
      "--bundle", root, "write", "notes/fresh",
      "--type", "note", "--title", "Fresh", "--description", "d", "--body", "hello vectors",
    ]);
    expect(write.code).toBe(0);
    expect(requests).toBe(before + 1); // the hook embedded it
    const stats = await okb(["--bundle", root, "embed"]);
    expect(stats.stdout).toContain("skipped 4");
  });

  test("review done updates verification and the queue without embedding an uncached note", async () => {
    const id = "notes/beta";
    const cli = (...args: string[]) => okb(["--bundle", root, ...args]);
    expect((await cli("index")).code).toBe(0);
    const primed = await cli("embed", "--limit", "1");
    expect(primed.code).toBe(0);
    expect(primed.stdout).toContain("embedded 1");
    expect((await cli("review", "--json")).stdout).toContain(`"${id}"`);
    const before = requests;
    const original = (await readConceptPermissive(root, id)).doc;

    const reviewed = await cli("review", "done", id);
    expect(reviewed.code).toBe(0);
    expect(reviewed.stdout).toContain(`reviewed ${id}`);
    expect(requests).toBe(before);
    const saved = (await readConceptPermissive(root, id)).doc;
    expect(saved.body).toBe(original.body);
    expect(normalizeVerified(saved.frontmatter)).toHaveLength(1);
    expect((await cli("review", "--json")).stdout).not.toContain(`"${id}"`);
    const cached = openVectorStore(defaultVectorsPath(root));
    try {
      expect(cached.meta()?.provider).toBe("ollama");
      expect(cached.embeddedHashes().has("notes/alpha")).toBe(true);
      expect(cached.embeddedHashes().has(id)).toBe(false);
    } finally { cached.close(); }
  });

  test("an unreachable embed provider never fails the write", async () => {
    await okb(["--bundle", root, "embed"]);
    process.env.OKB_EMBED_BASE_URL = "http://127.0.0.1:9"; // discard port; nothing listens
    const write = await okb([
      "--bundle", root, "write", "notes/offline",
      "--type", "note", "--title", "Offline", "--description", "d", "--body", "written anyway",
    ]);
    expect(write.code).toBe(0);
    process.env.OKB_EMBED_BASE_URL = `http://127.0.0.1:${server.port}`;
    const stats = await okb(["--bundle", root, "embed"]);
    expect(stats.stdout).toContain("embedded 1"); // okb embed caught it up
  });
});
