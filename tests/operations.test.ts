import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqliteEngine } from "../src/core/engine/sqlite.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import { getOp, OpError, operations, runOp, type OpContext } from "../src/core/operations.ts";

let root: string;
let engine: Engine;

const ctx = (trusted = true): OpContext => ({
  bundle: root,
  trusted,
  engine: () => engine,
  hasIndex: () => true,
  vectors: () => {
    throw new Error("no vector store in this test");
  },
  hasVectors: () => false,
  config: () => ({}),
});
const op = (name: string) => getOp(name)!;

const expectOpError = async (p: Promise<unknown>, code: OpError["code"]) => {
  const e = await p.then(
    () => null,
    (err) => err,
  );
  expect(e).toBeInstanceOf(OpError);
  expect((e as OpError).code).toBe(code);
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "okb-ops-"));
  await mkdir(join(root, "notes"), { recursive: true });
  await writeFile(join(root, "index.md"), "# bundle\n");
  await writeFile(
    join(root, "alpha.md"),
    "---\ntype: note\ntitle: Alpha\ndescription: first\n---\nSee [beta](/notes/beta.md).\n",
  );
  await writeFile(
    join(root, "notes", "beta.md"),
    "---\ntype: note\ntitle: Beta\n---\nBody beta.\n",
  );
  await writeFile(join(root, "broken.md"), "---\ntype: [unclosed\n---\nraw text\n");
  engine = openSqliteEngine(":memory:");
});

afterAll(async () => {
  engine.close();
  await rm(root, { recursive: true, force: true });
});

describe("registry", () => {
  test("op and CLI names are unique", () => {
    expect(new Set(operations.map((o) => o.name)).size).toBe(operations.length);
    expect(new Set(operations.map((o) => o.cliName)).size).toBe(operations.length);
  });

  test("getOp finds ops by contract name", () => {
    expect(op("read_concept").cliName).toBe("read");
    expect(getOp("nope")).toBeUndefined();
  });
});

describe("trust gating (fail-closed)", () => {
  test("untrusted callers are refused admin ops before the handler runs", async () => {
    await expectOpError(runOp(op("index"), ctx(false), {}), "untrusted");
    await expectOpError(
      runOp(op("rebuild"), ctx(false), { "confirm-destructive": true }),
      "untrusted",
    );
  });

  test("untrusted callers may run read ops", async () => {
    expect(await runOp(op("search"), ctx(false), { query: "anything" })).toEqual([]);
  });
});

describe("param validation", () => {
  test("missing required, unknown, and mistyped params are bad_params", async () => {
    await expectOpError(runOp(op("search"), ctx(), {}), "bad_params");
    await expectOpError(runOp(op("search"), ctx(), { query: "x", bogus: 1 }), "bad_params");
    await expectOpError(
      runOp(op("search"), ctx(), { query: "x", limit: "many" }),
      "bad_params",
    );
  });

  test("int params accept numeric strings (CLI hands over strings)", async () => {
    await runOp(op("index"), ctx(), {});
    const hits = (await runOp(op("search"), ctx(), { query: "beta", limit: "1" })) as {
      id: string;
    }[];
    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toBe("notes/beta");
  });
});

describe("read ops", () => {
  test("read_concept returns parsed frontmatter + body", async () => {
    const r = (await runOp(op("read_concept"), ctx(), { id: "alpha" })) as {
      frontmatter: Record<string, unknown>;
      body: string;
    };
    expect(r.frontmatter.title).toBe("Alpha");
    expect(r.body).toContain("See [beta]");
  });

  test("read_concept is permissive on unparseable frontmatter", async () => {
    const r = (await runOp(op("read_concept"), ctx(), { id: "broken" })) as {
      frontmatter: Record<string, unknown>;
      body: string;
    };
    expect(r.frontmatter).toEqual({});
    expect(r.body).toContain("raw text");
  });

  test("read_concept: missing id is not_found, traversal id is bad_params", async () => {
    await expectOpError(runOp(op("read_concept"), ctx(), { id: "ghost" }), "not_found");
    await expectOpError(
      runOp(op("read_concept"), ctx(), { id: "../escape" }),
      "bad_params",
    );
  });

  test("list_concepts returns sorted ids, reserved files excluded", async () => {
    expect(await runOp(op("list_concepts"), ctx(), {})).toEqual([
      "alpha",
      "broken",
      "notes/beta",
    ]);
  });

  test("graph_neighbors returns titled, direction-tagged neighbors; unknown id is not_found", async () => {
    expect(await runOp(op("graph_neighbors"), ctx(), { id: "alpha" })).toEqual([
      { id: "notes/beta", depth: 1, title: "Beta", dir: "out" },
    ]);
    await expectOpError(runOp(op("graph_neighbors"), ctx(), { id: "ghost" }), "not_found");
  });
});

describe("rebuild", () => {
  test("refuses without --confirm-destructive", async () => {
    await expectOpError(runOp(op("rebuild"), ctx(), {}), "refused");
  });

  test("with confirmation, wipes then reindexes everything", async () => {
    const stats = await runOp(op("rebuild"), ctx(), { "confirm-destructive": true });
    expect(stats).toEqual({ indexed: 3, skipped: 0, removed: 0, edges: 1 });
  });
});
