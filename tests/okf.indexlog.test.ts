import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor } from "../src/core/okf/doctor.ts";
import { parse } from "../src/core/okf/document.ts";
import { generateIndexMd, OKF_VERSION } from "../src/core/okf/indexmd.ts";
import { appendLog, todayUtc } from "../src/core/okf/logmd.ts";
import { writeConcept } from "../src/core/okf/write.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "okb-indexlog-"));
});

afterEach(() => rm(root, { recursive: true, force: true }));

const read = (...p: string[]) => readFile(join(root, ...p), "utf8");

describe("generateIndexMd", () => {
  test("groups concepts by type, sorted, with title/description rows", async () => {
    await writeConcept(root, { id: "d/zeta", type: "note", title: "Zeta", description: "Last" });
    await writeConcept(root, { id: "d/alpha", type: "note", title: "Alpha", description: "First" });
    await writeConcept(root, { id: "d/ref", type: "reference", title: "Ref", description: "A source" });
    expect(await read("d", "index.md")).toBe(
      [
        "# d",
        "",
        "Concepts under /d/.",
        "",
        "## note",
        "",
        "- [Alpha](/d/alpha.md) — First",
        "- [Zeta](/d/zeta.md) — Last",
        "",
        "## reference",
        "",
        "- [Ref](/d/ref.md) — A source",
        "",
      ].join("\n"),
    );
  });

  test("preserves H1 and intro; regenerates all ## sections", async () => {
    await writeConcept(root, { id: "d/a", type: "note", title: "A", description: "d1" });
    await writeFile(
      join(root, "d", "index.md"),
      "# My notes\n\nHand-written intro.\nSecond line.\n\n## stale\n\n- [gone](/nope.md)\n",
    );
    await generateIndexMd(root, "d");
    const body = await read("d", "index.md");
    expect(body).toStartWith("# My notes\n\nHand-written intro.\nSecond line.\n\n## note\n");
    expect(body).not.toContain("stale");
  });

  test("root index.md: okf_version maintained, unknown fm keys preserved, dirs listed with intro-derived descriptions", async () => {
    await writeFile(join(root, "index.md"), "---\ncustom: keep\n---\n# Brain\n\nRoot intro.\n");
    await writeConcept(root, { id: "notes/n", type: "note", title: "N", description: "d" });
    const { frontmatter, body } = parse(await read("index.md"));
    expect(frontmatter).toEqual({ okf_version: OKF_VERSION, custom: "keep" });
    expect(body).toStartWith("# Brain\n\nRoot intro.\n\n## Directories\n");
    expect(body).toContain("- [notes](/notes/index.md) — Concepts under /notes/");

    // A hand-edited dir intro feeds the parent listing (trailing period stripped).
    await writeFile(join(root, "notes", "index.md"), "# notes\n\nAll my notes.\n\n## note\n");
    await generateIndexMd(root, "");
    expect(await read("index.md")).toContain("- [notes](/notes/index.md) — All my notes");
  });

  test("nested write regenerates the whole ancestor chain", async () => {
    await writeConcept(root, { id: "a/b/c", type: "note", title: "C", description: "deep" });
    expect(await read("a", "b", "index.md")).toContain("- [C](/a/b/c.md) — deep");
    expect(await read("a", "index.md")).toContain("- [b](/a/b/index.md)");
    expect(await read("index.md")).toContain("- [a](/a/index.md)");
  });
});

describe("appendLog", () => {
  test("creates log.md with # Log and a dated Creation entry", async () => {
    await appendLog(root, "Creation", "notes/x", "X", "made it");
    expect(await read("log.md")).toBe(
      `# Log\n\n## ${todayUtc()}\n\n**Creation**: [X](/notes/x.md) — made it\n`,
    );
  });

  test("same-day entries share a section; a new day is inserted newest-first", async () => {
    await writeFile(
      join(root, "log.md"),
      "# Log\n\n## 2020-01-02\n\n**Creation**: [Old](/old.md)\n\n## 2020-01-01\n\n**Creation**: [Older](/older.md)\n",
    );
    await appendLog(root, "Update", "a", "A");
    await appendLog(root, "Deprecation", "b", "B", "gone");
    const text = await read("log.md");
    expect(text).toBe(
      `# Log\n\n## ${todayUtc()}\n\n**Update**: [A](/a.md)\n\n**Deprecation**: [B](/b.md) — gone\n\n## 2020-01-02\n\n**Creation**: [Old](/old.md)\n\n## 2020-01-01\n\n**Creation**: [Older](/older.md)\n`,
    );
  });
});

describe("writer end-to-end", () => {
  test("a fresh bundle built only by writeConcept is fully doctor-clean", async () => {
    await writeConcept(root, { id: "notes/a", type: "note", title: "A", description: "one" });
    await writeConcept(root, { id: "refs/r", type: "reference", title: "R", description: "two" });
    await writeConcept(root, { id: "notes/a", title: "A2" }); // update logs too
    const report = await runDoctor(root);
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
    expect(await read("log.md")).toContain("**Update**: [A2](/notes/a.md)");
  });
});
