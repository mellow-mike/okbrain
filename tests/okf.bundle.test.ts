import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listConcepts, readConcept } from "../src/core/okf/bundle.ts";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "okb-bundle-"));
  await mkdir(join(root, "notes"), { recursive: true });
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(join(root, "index.md"), "# bundle\n");
  await writeFile(join(root, "log.md"), "# log\n");
  await writeFile(join(root, "alpha.md"), "---\ntype: note\ntitle: Alpha\n---\nA\n");
  await writeFile(join(root, "notes", "beta.md"), "---\ntype: note\n---\nB\n");
  await writeFile(join(root, "notes", "index.md"), "# notes\n");
  await writeFile(join(root, ".git", "hidden.md"), "---\ntype: x\n---\n");
  await writeFile(join(root, "readme.txt"), "not markdown\n");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("listConcepts", () => {
  test("returns sorted ids, excluding reserved/hidden/non-md", async () => {
    expect(await listConcepts(root)).toEqual(["alpha", "notes/beta"]);
  });
});

describe("readConcept", () => {
  test("reads and parses a concept by id", async () => {
    const c = await readConcept(root, "notes/beta");
    expect(c.id).toBe("notes/beta");
    expect(c.doc.frontmatter).toEqual({ type: "note" });
    expect(c.doc.body).toBe("B\n");
  });

  test("rejects unsafe ids before touching the filesystem", async () => {
    await expect(readConcept(root, "../escape")).rejects.toThrow();
  });
});
