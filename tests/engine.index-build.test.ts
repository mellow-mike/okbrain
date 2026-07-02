import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex } from "../src/core/engine/index-build.ts";
import { defaultDbPath, openSqliteEngine } from "../src/core/engine/sqlite.ts";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "okb-index-"));
  await mkdir(join(root, "notes"), { recursive: true });
  await writeFile(join(root, "index.md"), "# bundle\n");
  await writeFile(
    join(root, "alpha.md"),
    '---\ntype: note\ntitle: Alpha\ndescription: first\ntags: [core, "seed"]\n---\nSee [beta](/notes/beta.md) and [beta again](notes/beta.md).\n',
  );
  await writeFile(
    join(root, "notes", "beta.md"),
    "---\ntype: reference\ntitle: Beta\nresource: https://example.com\n---\nBack to [alpha](../alpha.md). Broken: [gone](missing.md).\n",
  );
  await writeFile(join(root, "broken.md"), "---\ntype: [unclosed\n---\nstill findable text\n");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("buildIndex", () => {
  const engine = openSqliteEngine(":memory:");
  afterAll(() => engine.close());

  test("indexes nodes, tags, and deduped resolved edges", async () => {
    const stats = await buildIndex(root, engine);
    expect(stats).toEqual({ indexed: 3, skipped: 0, removed: 0, edges: 2 });
    expect(engine.getNode("alpha")).toMatchObject({
      type: "note",
      title: "Alpha",
      description: "first",
      resource: null,
    });
    expect(engine.getTags("alpha")).toEqual(["core", "seed"]);
    expect(engine.getNode("notes/beta")?.resource).toBe("https://example.com");
    // alpha->beta deduped; beta's broken link dropped
    expect(engine.listEdges()).toEqual([
      { src: "alpha", dst: "notes/beta" },
      { src: "notes/beta", dst: "alpha" },
    ]);
  });

  test("a concept with unparseable frontmatter is still searchable", () => {
    expect(engine.search("findable").map((h) => h.id)).toEqual(["broken"]);
    expect(engine.getNode("broken")?.type).toBe("");
  });

  test("re-run is idempotent: everything skipped, same derived state", async () => {
    const stats = await buildIndex(root, engine);
    expect(stats).toEqual({ indexed: 0, skipped: 3, removed: 0, edges: 2 });
    expect(engine.contentHashes().size).toBe(3);
  });

  test("re-index after edit updates only the changed node", async () => {
    await writeFile(
      join(root, "alpha.md"),
      "---\ntype: note\ntitle: Alpha Prime\n---\nNo more links.\n",
    );
    const stats = await buildIndex(root, engine);
    expect(stats).toEqual({ indexed: 1, skipped: 2, removed: 0, edges: 1 });
    expect(engine.getNode("alpha")?.title).toBe("Alpha Prime");
    expect(engine.search("Prime")[0]?.id).toBe("alpha");
    expect(engine.listEdges()).toEqual([{ src: "notes/beta", dst: "alpha" }]);
  });

  test("deleted concepts are removed from the index", async () => {
    await rm(join(root, "broken.md"));
    const stats = await buildIndex(root, engine);
    expect(stats.removed).toBe(1);
    expect(engine.getNode("broken")).toBeNull();
    expect(engine.search("findable")).toEqual([]);
  });
});

describe("defaultDbPath + on-disk engine", () => {
  test("creates .okb/index.db inside the bundle and persists across opens", async () => {
    const dbPath = defaultDbPath(root);
    expect(dbPath).toBe(join(root, ".okb", "index.db"));

    const e1 = openSqliteEngine(dbPath);
    await buildIndex(root, e1);
    e1.close();

    const e2 = openSqliteEngine(dbPath);
    expect(e2.getNode("alpha")?.title).toBe("Alpha Prime");
    e2.close();
  });
});
