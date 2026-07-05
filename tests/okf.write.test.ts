import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor } from "../src/core/okf/doctor.ts";
import { parse } from "../src/core/okf/document.ts";
import { InvalidIdError } from "../src/core/okf/paths.ts";
import { normalizeLinks, writeConcept, WriteRefusedError } from "../src/core/okf/write.ts";
import { okb } from "./helpers.ts";

let root: string;
const NOW = new Date("2026-07-05T10:00:00.000Z");
const read = (rel: string) => readFile(join(root, ...rel.split("/")), "utf8");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "okb-write-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe("normalizeLinks", () => {
  const at = (body: string) => normalizeLinks("notes/src", body);

  test("relative links become bundle-absolute; absolute stay put", () => {
    expect(at("see [x](foo.md)")).toBe("see [x](/notes/foo.md)");
    expect(at("see [x](../top.md)")).toBe("see [x](/top.md)");
    expect(at("see [x](/notes/foo.md)")).toBe("see [x](/notes/foo.md)");
  });

  test("external, anchor-only, and non-md targets pass through", () => {
    const body = "[a](https://x.io/p.md) [b](#h) [c](img.png)";
    expect(at(body)).toBe(body);
  });

  test("fragments and link titles survive; spaced targets get <> wrapped", () => {
    expect(at('[x](foo.md#sec "Foo")')).toBe('[x](/notes/foo.md#sec "Foo")');
    expect(at('[x](<my note.md> "T")')).toBe('[x](</notes/my note.md> "T")');
  });

  test("idempotent", () => {
    const once = at("see [x](foo.md#s) and [y](<a b.md>)");
    expect(at(once)).toBe(once);
  });
});

describe("writeConcept", () => {
  test("create scaffolds conformant frontmatter and passes doctor", async () => {
    const r = await writeConcept(
      root,
      { id: "notes/alpha", type: "note", title: "Alpha", description: "First note.", body: "Hello [beta](beta.md)" },
      NOW,
    );
    expect(r).toEqual({ id: "notes/alpha", created: true, changed: true });

    const raw = await read("notes/alpha.md");
    expect(raw).toBe(
      "---\ntype: note\ntitle: Alpha\ndescription: First note.\ntimestamp: 2026-07-05T10:00:00Z\n---\nHello [beta](/notes/beta.md)\n",
    );
    const report = await runDoctor(root);
    expect(report.errors).toBe(0);
  });

  test("create defaults title to the id basename and requires type", async () => {
    await writeConcept(root, { id: "ideas/spark", type: "idea" }, NOW);
    expect(parse(await read("ideas/spark.md")).frontmatter.title).toBe("spark");
    expect(writeConcept(root, { id: "ideas/untyped" }, NOW)).rejects.toThrow(WriteRefusedError);
  });

  test("edit preserves unknown keys, key order, and untouched fields", async () => {
    await writeFile(
      join(root, "keep.md"),
      "---\ntype: note\ncustom_key: 42\ntitle: Old\ntimestamp: 2020-01-01T00:00:00Z\n---\nold body\n",
    );
    const r = await writeConcept(root, { id: "keep", title: "New" }, NOW);
    expect(r).toEqual({ id: "keep", created: false, changed: true });
    const raw = await read("keep.md");
    expect(raw).toBe(
      "---\ntype: note\ncustom_key: 42\ntitle: New\ntimestamp: 2026-07-05T10:00:00Z\n---\nold body\n",
    );
  });

  test("byte-identical write is a no-op: file and timestamp untouched", async () => {
    await writeConcept(root, { id: "same", type: "note", body: "stable" }, NOW);
    const before = await read("same.md");
    const r = await writeConcept(root, { id: "same", body: "stable" }, new Date("2027-01-01T00:00:00Z"));
    expect(r.changed).toBe(false);
    expect(await read("same.md")).toBe(before);
  });

  test("reserved ids and unparseable-frontmatter edits are refused", async () => {
    expect(writeConcept(root, { id: "notes/index", type: "note" }, NOW)).rejects.toThrow(InvalidIdError);
    await writeFile(join(root, "broken.md"), "---\n: [\n---\nbody\n");
    expect(writeConcept(root, { id: "broken", title: "X" }, NOW)).rejects.toThrow(WriteRefusedError);
  });
});

describe("okb write (CLI over the op)", () => {
  test("creates, updates, and reports no-ops", async () => {
    const at = (...args: string[]) => okb([...args, "--bundle", root]);
    expect((await at("write", "notes/n", "--type", "note", "--body", "hi")).stdout).toBe("created notes/n\n");
    expect((await at("write", "notes/n", "--title", "N")).stdout).toBe("updated notes/n\n");
    expect((await at("write", "notes/n", "--title", "N")).stdout).toBe("unchanged notes/n\n");
    expect((await at("write", "nope")).code).toBe(1); // create without --type is refused
  });
});
