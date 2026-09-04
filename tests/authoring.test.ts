// Stage 1.3 authoring: slugify, `okb new`, `okb capture` (incl. piped stdin),
// and `okb import` — all through the ops/CLI surface where it matters, all
// leaving a doctor-clean bundle behind.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import { captureNote } from "../src/core/ingest/capture.ts";
import { importPath, type ImportResult } from "../src/core/ingest/import.ts";
import { runDoctor } from "../src/core/okf/doctor.ts";
import { parse } from "../src/core/okf/document.ts";
import { InvalidIdError, slugify } from "../src/core/okf/paths.ts";
import { nowTimestamp } from "../src/core/okf/write.ts";

let root: string;
let src: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "okb-auth-"));
  src = await mkdtemp(join(tmpdir(), "okb-auth-src-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(src, { recursive: true, force: true });
});

async function okb(args: string[], stdin?: string) {
  let stdout = "";
  let stderr = "";
  const code = await runCli([...args, "--bundle", root], {
    out: (t) => void (stdout += t),
    err: (t) => void (stderr += t),
    stdin: stdin === undefined ? undefined : () => Promise.resolve(stdin),
  });
  return { code, stdout, stderr };
}

const concept = async (id: string) => parse(await readFile(join(root, ...id.split("/")) + ".md", "utf8"));

const expectClean = async () => {
  const rep = await runDoctor(root);
  expect({ errors: rep.errors, warnings: rep.warnings }).toEqual({ errors: 0, warnings: 0 });
};

describe("slugify", () => {
  test("lowercases, strips diacritics and symbols, collapses separators", () => {
    expect(slugify("Café Notes!")).toBe("cafe-notes");
    expect(slugify("  A -- B_C  ")).toBe("a-b-c");
  });

  test("throws when nothing survives", () => {
    expect(() => slugify("!!!")).toThrow(InvalidIdError);
  });
});

describe("okb new", () => {
  test("derives <type>s/<slug>, writes a conformant concept", async () => {
    const r = await okb(["new", "note", "My First Note", "A note about firsts", "--tags", "a,b"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("created notes/my-first-note\n");
    const doc = await concept("notes/my-first-note");
    expect(doc.frontmatter).toMatchObject({ type: "note", title: "My First Note", tags: ["a", "b"] });
    await expectClean();
  });

  test("--id overrides the derived id", async () => {
    const r = await okb(["new", "note", "Deep", "d", "--id", "a/b/deep"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("created a/b/deep\n");
  });

  test("refuses to clobber an existing concept", async () => {
    await okb(["new", "note", "Twice", "d"]);
    const r = await okb(["new", "note", "Twice", "other"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("concept exists: notes/twice");
    expect((await concept("notes/twice")).frontmatter.description).toBe("d");
  });
});

describe("okb capture", () => {
  test("derives title/description/id from the first line", async () => {
    const r = await okb(["capture", "# Grab this\n\nBody text."]);
    expect(r.code).toBe(0);
    const id = `inbox/${nowTimestamp().slice(0, 10)}-grab-this`;
    expect(r.stdout).toBe(`created ${id}\n`);
    const doc = await concept(id);
    expect(doc.frontmatter).toMatchObject({ type: "note", title: "Grab this", description: "Grab this", tags: ["inbox"] });
    expect(doc.body).toBe("# Grab this\n\nBody text.\n");
    await expectClean();
    // Captures are triage material: they show up in the reading inbox (B12).
    expect((await okb(["index"])).code).toBe(0);
    expect((await okb(["inbox"])).stdout).toContain(id);
  });

  test("colliding ids get a numeric suffix", async () => {
    await captureNote(root, { text: "same line" });
    const r = await captureNote(root, { text: "same line" });
    expect(r.id).toBe(`inbox/${nowTimestamp().slice(0, 10)}-same-line-2`);
  });

  test("long first lines are clipped; explicit title wins", async () => {
    const r = await captureNote(root, { text: `${"x".repeat(200)}\nrest`, title: "Short" });
    expect(r.id.endsWith("-short")).toBe(true);
    const doc = await concept(r.id);
    expect(doc.frontmatter.title).toBe("Short");
    expect((doc.frontmatter.description as string).length).toBe(120);
    expect((doc.frontmatter.description as string).endsWith("…")).toBe(true);
  });

  test("empty text is refused", async () => {
    const r = await okb(["capture", "   \n  "]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("nothing to capture");
  });

  test("falls back to piped stdin when no text argument is given", async () => {
    const r = await okb(["capture"], "from stdin\nmore");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("-from-stdin\n");
  });
});

describe("okb import", () => {
  test("maps a directory tree, deriving frontmatter and preserving unknown keys", async () => {
    await mkdir(join(src, "Old Notes"), { recursive: true });
    await writeFile(join(src, "Old Notes", "Plain File.md"), "# Real Title\n\nFirst prose line.\nMore.\n");
    await writeFile(
      join(src, "typed.md"),
      "---\ntype: reference\ntitle: Typed\ndescription: Has fm\nauthor: Ada\n---\nBody.\n",
    );
    await writeFile(join(src, "index.md"), "# listing\n"); // reserved: not a concept
    const r = await okb(["import", src, "--json"]);
    expect(r.code).toBe(0);
    const res = JSON.parse(r.stdout) as ImportResult;
    expect(res.imported.sort()).toEqual(["old-notes/plain-file", "typed"]);
    expect(res.skipped).toEqual([]);
    const plain = await concept("old-notes/plain-file");
    expect(plain.frontmatter).toMatchObject({
      type: "note",
      title: "Real Title",
      description: "First prose line.",
    });
    expect((await concept("typed")).frontmatter).toMatchObject({
      type: "reference",
      title: "Typed",
      author: "Ada",
    });
    await expectClean();
  });

  test("dedupes by id: second run skips, --overwrite updates", async () => {
    await writeFile(join(src, "a.md"), "# A\n\none\n");
    await importPath(root, { path: src });
    await writeFile(join(src, "a.md"), "# A\n\ntwo\n");
    const skip = await importPath(root, { path: src });
    expect(skip.imported).toEqual([]);
    expect(skip.skipped[0]!.reason).toContain("concept exists: a");
    expect((await concept("a")).body).toContain("one");
    const over = await importPath(root, { path: src, overwrite: true });
    expect(over.imported).toEqual(["a"]);
    expect((await concept("a")).body).toContain("two");
  });

  test("in-run slug collisions keep the first source", async () => {
    await writeFile(join(src, "Foo Bar.md"), "# One\n\np\n");
    await writeFile(join(src, "foo-bar.md"), "# Two\n\np\n");
    const res = await importPath(root, { path: src });
    expect(res.imported).toEqual(["foo-bar"]);
    expect(res.skipped[0]!.reason).toContain("id collision");
  });

  test("single file honors --dest and --type; unparseable frontmatter becomes body", async () => {
    await writeFile(join(src, "broken.md"), "---\n: nope: [\n---\ncontent\n");
    const res = await importPath(root, { path: join(src, "broken.md"), dest: "imported", type: "clip" });
    expect(res.imported).toEqual(["imported/broken"]);
    const doc = await concept("imported/broken");
    expect(doc.frontmatter.type).toBe("clip");
    expect(doc.body).toContain(": nope: [");
  });

  test("missing path is a usage error", async () => {
    const r = await okb(["import", join(src, "nope")]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("import path not found");
  });
});
