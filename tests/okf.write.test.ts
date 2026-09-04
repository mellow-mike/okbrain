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
  actor: () => "human:test",
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
    expect(raw.startsWith("---\ntype: note\ntitle: Alpha\ndescription: First note\ntags:\n  - t1\ngenerated:\n  by: human:")).toBe(true);
    const { frontmatter, body } = parse(raw);
    expect((frontmatter.generated as { at: string }).at).toMatch(ISO);
    expect(frontmatter.timestamp).toBeUndefined(); // v0.2: no legacy key
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

  test("preserves unknown keys and unspecified fields; a content write supersedes the v0.1 timestamp", async () => {
    await seed();
    const r = await writeConcept(root, { id: "a", title: "New", actor: "human:me" });
    expect(r.created).toBe(false);
    const { frontmatter, body } = parse(await readFile(r.path, "utf8"));
    expect(frontmatter).toMatchObject({
      type: "note",
      title: "New",
      description: "Keep me",
      custom_key: 42,
      tags: ["x"],
      generated: { by: "human:me" },
    });
    expect((frontmatter.generated as { at: string }).at).toMatch(ISO);
    expect(frontmatter.timestamp).toBeUndefined(); // superseded by generated.at
    expect(body).toBe("Old body.\n");
  });

  test("metadata-only writes keep a legacy timestamp (no actor is invented)", async () => {
    await seed();
    await writeConcept(root, { id: "a", tags: ["y"], metadataOnly: true });
    const { frontmatter } = parse(await readFile(join(root, "a.md"), "utf8"));
    expect(frontmatter.timestamp).toBe("2020-01-01T00:00:00Z");
    expect(frontmatter.generated).toBeUndefined();
    expect(frontmatter.tags).toEqual(["y"]);
  });

  test("status / stale_after / sources: validated, written in canonical order, cleared by empty values", async () => {
    await writeConcept(root, {
      id: "notes/s", type: "note", title: "S", description: "d", actor: "human:me",
      status: "draft", staleAfter: "2030-01-01T00:00:00Z",
      sources: [{ resource: "https://ex.test/page", title: "Page", author: "human:ada" }, { resource: "/notes/other.md" }, { resource: "https://ex.test/again" }],
    });
    const raw = await readFile(join(root, "notes", "s.md"), "utf8");
    expect(raw).toMatch(/^---\ntype: note\ntitle: S\ndescription: d\nstatus: draft\ngenerated:\n  by: human:me\n  at: .*\nstale_after: 2030-01-01T00:00:00Z\nsources:\n/);
    const fm = parse(raw).frontmatter;
    expect(fm.sources).toEqual([
      { id: "ex-test", resource: "https://ex.test/page", title: "Page", author: "human:ada" },
      { id: "other", resource: "/notes/other.md" },
      { id: "ex-test-2", resource: "https://ex.test/again" }, // ids stay unique
    ]);
    await expect(writeConcept(root, { id: "notes/s", status: "wip" })).rejects.toThrow(/status must be one of/);
    await expect(writeConcept(root, { id: "notes/s", staleAfter: "2030-01-01" })).rejects.toThrow(/ISO 8601 instant/);
    await expect(writeConcept(root, { id: "notes/s", sources: [{ resource: "" }] })).rejects.toThrow(/needs a resource/);
    await expect(writeConcept(root, { id: "notes/s", actor: "just-a-name" })).rejects.toThrow(/actor convention/);

    await writeConcept(root, { id: "notes/s", status: "", staleAfter: "", sources: [] });
    const cleared = parse(await readFile(join(root, "notes", "s.md"), "utf8")).frontmatter;
    expect(cleared.status).toBeUndefined();
    expect(cleared.stale_after).toBeUndefined();
    expect(cleared.sources).toBeUndefined();
  });

  test("verify: one event per actor (replaced, not appended); legacy last_reviewed retired", async () => {
    await writeFile(
      join(root, "v.md"),
      "---\ntype: note\ntitle: V\ndescription: d\ngenerated:\n  by: human:me\n  at: 2026-01-01T00:00:00Z\nlast_reviewed: 2025-01-01T00:00:00Z\n---\nBody.\n",
    );
    await writeConcept(root, { id: "v", verify: { by: "process:nightly", at: "2026-02-01T00:00:00Z" }, metadataOnly: true });
    await writeConcept(root, { id: "v", verify: { by: "human:me", at: "2026-03-01T00:00:00Z" }, metadataOnly: true });
    await writeConcept(root, { id: "v", verify: { by: "human:me", at: "2026-04-01T00:00:00Z" }, metadataOnly: true });
    const fm = parse(await readFile(join(root, "v.md"), "utf8")).frontmatter;
    expect(fm.verified).toEqual([
      { by: "process:nightly", at: "2026-02-01T00:00:00Z" },
      { by: "human:me", at: "2026-04-01T00:00:00Z" },
    ]);
    expect(fm.generated).toEqual({ by: "human:me", at: "2026-01-01T00:00:00Z" }); // metadata-only: untouched
    expect(fm.last_reviewed).toBeUndefined();
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
  test("a byte-identical update is skipped: no rewrite, no generated bump, no log entry", async () => {
    // Author through the writer so the on-disk bytes are already canonical.
    await writeConcept(root, { id: "notes/a", type: "note", title: "A", description: "d", body: "Body." });
    const path = join(root, "notes", "a.md");
    const before = await readFile(path, "utf8");
    const gen0 = parse(before).frontmatter.generated;
    const logBefore = await readFile(join(root, "log.md"), "utf8");

    // Re-write the exact same content (same fields, same body).
    const r = await writeConcept(root, { id: "notes/a", type: "note", title: "A", description: "d", body: "Body." });
    expect(r).toMatchObject({ id: "notes/a", created: false, noop: true });

    const after = await readFile(path, "utf8");
    expect(after).toBe(before); // byte-identical, generated untouched
    expect(parse(after).frontmatter.generated).toEqual(gen0);
    // No spurious **Update** entry appended to the log.
    expect(await readFile(join(root, "log.md"), "utf8")).toBe(logBefore);
  });

  test("a real change still rewrites and records a fresh generated event", async () => {
    await writeFile(
      join(root, "a.md"),
      "---\ntype: note\ntitle: Old\ndescription: keep\ngenerated:\n  by: human:old\n  at: 2020-01-01T00:00:00Z\n---\nOne.\n",
    );
    const r = await writeConcept(root, { id: "a", body: "Two.", actor: "human:new" });
    expect(r.noop).toBeUndefined();
    const { frontmatter, body } = parse(await readFile(join(root, "a.md"), "utf8"));
    expect(body).toBe("Two.\n");
    expect(frontmatter.generated).toMatchObject({ by: "human:new" });
    expect((frontmatter.generated as { at: string }).at).not.toBe("2020-01-01T00:00:00Z");
  });

  test("a non-canonical existing file is not a no-op — it is rewritten canonically", async () => {
    // Same content, but CRLF line endings + a timestamp present: writing must
    // normalize to LF, so it is a real change (never falsely detected as no-op).
    await writeFile(
      join(root, "a.md"),
      "---\r\ntype: note\r\ntitle: A\r\ndescription: d\r\ngenerated:\r\n  by: human:a\r\n  at: 2020-01-01T00:00:00Z\r\n---\r\nBody.\r\n",
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
