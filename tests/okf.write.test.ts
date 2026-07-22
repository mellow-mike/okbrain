import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { normalizeLinks } from "../src/core/graph/links.ts";
import { runDoctor } from "../src/core/okf/doctor.ts";
import { parse } from "../src/core/okf/document.ts";
import { OkfWriteError, writeConcept } from "../src/core/okf/write.ts";
import { getOp, runOp, type OpContext } from "../src/core/operations.ts";

let root: string;

const ctx = (trusted = true): OpContext => ({
  bundle: root,
  trusted,
  engine: () => {
    throw new Error("write_concept must not touch the engine");
  },
  hasIndex: () => false,
  vectors: () => {
    throw new Error("write_concept must not touch the vector store");
  },
  hasVectors: () => false,
  config: () => ({}),
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "okb-write-"));
});

afterEach(() => rm(root, { recursive: true, force: true }));

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

describe("normalizeLinks", () => {
  test("relative links become bundle-absolute; anchors and titles survive", () => {
    expect(normalizeLinks("notes/a", '[x](b.md) [y](../c.md#sec) [z](b.md "T")')).toBe(
      '[x](/notes/b.md) [y](/c.md#sec) [z](/notes/b.md "T")',
    );
  });

  test("already-absolute links are idempotent; unsafe destinations get wrapped", () => {
    expect(normalizeLinks("a", "[x](/notes/b.md)")).toBe("[x](/notes/b.md)");
    expect(normalizeLinks("a", "[s](<sp ace.md>)")).toBe("[s](</sp ace.md>)");
  });

  test("external, anchor-only, and non-md links pass through", () => {
    const body = "[e](https://x.test/a.md) [a](#frag) [p](pic.png)";
    expect(normalizeLinks("a", body)).toBe(body);
  });
});

describe("writeConcept: create", () => {
  test("scaffolds conformant frontmatter in canonical order and passes doctor", async () => {
    await writeConcept(root, { id: "notes/beta", type: "note", title: "Beta", description: "Link target" });
    const r = await writeConcept(root, {
      id: "notes/alpha",
      type: "note",
      title: "Alpha",
      description: "First note",
      tags: ["t1"],
      body: "Hello [beta](beta.md).",
    });
    expect(r).toMatchObject({ id: "notes/alpha", created: true });

    const raw = await readFile(r.path, "utf8");
    expect(raw.startsWith("---\ntype: note\ntitle: Alpha\ndescription: First note\ntimestamp: ")).toBe(true);
    const { frontmatter, body } = parse(raw);
    expect(frontmatter.timestamp).toMatch(ISO);
    expect(frontmatter.tags).toEqual(["t1"]);
    expect(body).toBe("Hello [beta](/notes/beta.md).\n"); // normalized + trailing LF

    const report = await runDoctor(root);
    expect(report.ok).toBe(true);
    expect(report.findings.filter((f) => f.path === "notes/alpha.md")).toEqual([]);
  });

  test("create requires type/title/description", async () => {
    expect(writeConcept(root, { id: "a", title: "A", description: "d" })).rejects.toThrow(
      OkfWriteError,
    );
    expect(writeConcept(root, { id: "a", type: "note", title: "A" })).rejects.toThrow(
      "description is required",
    );
  });

  test("reserved names are refused", async () => {
    expect(writeConcept(root, { id: "notes/index", type: "note", title: "x", description: "d" }))
      .rejects.toThrow("reserved");
  });
});

describe("writeConcept: update", () => {
  const seed = () =>
    writeFile(
      join(root, "a.md"),
      "---\ntype: note\ntitle: Old\ndescription: Keep me\ntimestamp: 2020-01-01T00:00:00Z\ncustom_key: 42\ntags: [x]\n---\nOld body.\n",
    );

  test("preserves unknown keys and unspecified fields; refreshes timestamp", async () => {
    await seed();
    const r = await writeConcept(root, { id: "a", title: "New" });
    expect(r.created).toBe(false);
    const { frontmatter, body } = parse(await readFile(r.path, "utf8"));
    expect(frontmatter).toMatchObject({
      type: "note",
      title: "New",
      description: "Keep me",
      custom_key: 42,
      tags: ["x"],
    });
    expect(frontmatter.timestamp).toMatch(ISO);
    expect(frontmatter.timestamp).not.toBe("2020-01-01T00:00:00Z");
    expect(body).toBe("Old body.\n");
  });

  test("tags: [] clears; undefined keeps", async () => {
    await seed();
    await writeConcept(root, { id: "a", tags: [] });
    expect(parse(await readFile(join(root, "a.md"), "utf8")).frontmatter.tags).toBeUndefined();
  });

  test("refuses to overwrite a concept whose frontmatter is unparseable", async () => {
    await writeFile(join(root, "bad.md"), "---\n: [broken\n---\nbody\n");
    expect(writeConcept(root, { id: "bad", title: "T" })).rejects.toThrow("unparseable");
  });
});

describe("writeConcept: no-op detection", () => {
  test("a byte-identical update is skipped: no rewrite, no timestamp bump, no log entry", async () => {
    // Author through the writer so the on-disk bytes are already canonical.
    await writeConcept(root, { id: "notes/a", type: "note", title: "A", description: "d", body: "Body." });
    const path = join(root, "notes", "a.md");
    const before = await readFile(path, "utf8");
    const ts0 = parse(before).frontmatter.timestamp;
    const logBefore = await readFile(join(root, "log.md"), "utf8");

    // Re-write the exact same content (same fields, same body).
    const r = await writeConcept(root, { id: "notes/a", type: "note", title: "A", description: "d", body: "Body." });
    expect(r).toMatchObject({ id: "notes/a", created: false, noop: true });

    const after = await readFile(path, "utf8");
    expect(after).toBe(before); // byte-identical, timestamp untouched
    expect(parse(after).frontmatter.timestamp).toBe(ts0);
    // No spurious **Update** entry appended to the log.
    expect(await readFile(join(root, "log.md"), "utf8")).toBe(logBefore);
  });

  test("a real change still rewrites and refreshes the timestamp", async () => {
    await writeFile(
      join(root, "a.md"),
      "---\ntype: note\ntitle: Old\ndescription: keep\ntimestamp: 2020-01-01T00:00:00Z\n---\nOne.\n",
    );
    const r = await writeConcept(root, { id: "a", body: "Two." });
    expect(r.noop).toBeUndefined();
    const { frontmatter, body } = parse(await readFile(join(root, "a.md"), "utf8"));
    expect(body).toBe("Two.\n");
    expect(frontmatter.timestamp).not.toBe("2020-01-01T00:00:00Z");
  });

  test("a non-canonical existing file is not a no-op — it is rewritten canonically", async () => {
    // Same content, but CRLF line endings + a timestamp present: writing must
    // normalize to LF, so it is a real change (never falsely detected as no-op).
    await writeFile(
      join(root, "a.md"),
      "---\r\ntype: note\r\ntitle: A\r\ndescription: d\r\ntimestamp: 2020-01-01T00:00:00Z\r\n---\r\nBody.\r\n",
    );
    const r = await writeConcept(root, { id: "a", type: "note", title: "A", description: "d", body: "Body." });
    expect(r.noop).toBeUndefined();
    const raw = await readFile(join(root, "a.md"), "utf8");
    expect(raw.includes("\r")).toBe(false); // rewritten as LF
  });

  test("op-level render reports an unchanged write", async () => {
    let out = "";
    const io = { out: (t: string) => void (out += t), err: (t: string) => void (out += t) };
    const args = (extra: string[]) =>
      ["write", "notes/n", "--type", "note", "--title", "N", "--description", "d", "--body", "Same.", ...extra, "--bundle", root];
    expect(await runCli(args([]), io)).toBe(0);
    out = "";
    expect(await runCli(args([]), io)).toBe(0);
    expect(out).toContain("unchanged notes/n");
  });
});

describe("write_concept op", () => {
  test("is gated for untrusted callers before the handler runs", async () => {
    expect(
      runOp(getOp("write_concept")!, ctx(false), { id: "a", type: "note", title: "A", description: "d" }),
    ).rejects.toThrow("not available to untrusted callers");
  });

  test("okb write: CLI round-trip, comma tags, bad params exit 2", async () => {
    let out = "";
    const io = { out: (t: string) => void (out += t), err: (t: string) => void (out += t) };
    expect(
      await runCli(
        ["write", "notes/n", "--type", "note", "--title", "N", "--description", "d",
         "--tags", "a, b,", "--body", "See [x](x.md).", "--bundle", root],
        io,
      ),
    ).toBe(0);
    expect(out).toContain("created notes/n");
    const { frontmatter, body } = parse(await readFile(join(root, "notes", "n.md"), "utf8"));
    expect(frontmatter.tags).toEqual(["a", "b"]);
    expect(body).toBe("See [x](/notes/x.md).\n");

    expect(await runCli(["write", "notes/n2", "--title", "no type", "--bundle", root], io)).toBe(2);
  });
});
