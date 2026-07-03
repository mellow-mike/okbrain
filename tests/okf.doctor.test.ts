import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor, type Finding } from "../src/core/okf/doctor.ts";

const FM = "---\ntype: note\ntitle: T\ndescription: D\ntimestamp: 2026-07-01\n---\n";

let clean: string;
let broken: string;

beforeAll(async () => {
  clean = await mkdtemp(join(tmpdir(), "okb-doctor-clean-"));
  await mkdir(join(clean, "notes"), { recursive: true });
  await writeFile(
    join(clean, "index.md"),
    '---\nokf_version: "0.1"\n---\n# bundle\n\n- [Alpha](/alpha.md)\n- [notes](/notes/index.md)\n',
  );
  await writeFile(
    join(clean, "log.md"),
    "## 2026-07-02\n**Update** alpha\n\n## 2026-07-01\n**Creation** alpha\n",
  );
  await writeFile(join(clean, "alpha.md"), `${FM}See [beta](/notes/beta.md).\n`);
  await writeFile(join(clean, "notes", "beta.md"), `${FM}Back to [index](/index.md).\n`);
  await writeFile(join(clean, "notes", "index.md"), "# notes\n\n- [Beta](/notes/beta.md)\n");

  broken = await mkdtemp(join(tmpdir(), "okb-doctor-broken-"));
  await mkdir(join(broken, "notes"), { recursive: true });
  await mkdir(join(broken, "loose"), { recursive: true });
  await writeFile(join(broken, "index.md"), "# no okf_version here\n");
  await writeFile(
    join(broken, "log.md"),
    "## not-a-date\nx\n\n## 2026-01-01\nx\n\n## 2026-02-02\nx\n",
  );
  await writeFile(join(broken, "bad.md"), "---\ntype: [unclosed\n---\nbody\n");
  await writeFile(join(broken, "notype.md"), "---\ntitle: X\n---\nbody\n");
  await writeFile(join(broken, "dangling.md"), `${FM}A [gone link](/gone.md).\n`);
  await writeFile(join(broken, "notes", "index.md"), "---\ntype: dir\n---\n# notes\n");
  await writeFile(join(broken, "loose", "orphan.md"), `${FM}body\n`);
});

afterAll(async () => {
  await rm(clean, { recursive: true, force: true });
  await rm(broken, { recursive: true, force: true });
});

const has = (fs: Finding[], check: string, path: string): boolean =>
  fs.some((f) => f.check === check && f.path === path);

describe("runDoctor", () => {
  test("conformant bundle passes with no findings", async () => {
    const r = await runDoctor(clean);
    expect(r.findings).toEqual([]);
    expect(r).toMatchObject({ ok: true, files: 5, concepts: 2, errors: 0, warnings: 0 });
  });

  test("detects every failure class", async () => {
    const r = await runDoctor(broken);
    expect(r.ok).toBe(false);
    const f = r.findings;
    expect(has(f, "frontmatter", "bad.md")).toBe(true);
    expect(has(f, "type", "notype.md")).toBe(true);
    expect(has(f, "recommended-keys", "notype.md")).toBe(true);
    expect(has(f, "broken-link", "dangling.md")).toBe(true);
    expect(has(f, "index-frontmatter", "notes/index.md")).toBe(true);
    expect(has(f, "okf-version", "index.md")).toBe(true);
    expect(has(f, "log-heading", "log.md")).toBe(true);
    expect(has(f, "log-order", "log.md")).toBe(true);
    expect(has(f, "missing-index", "loose/index.md")).toBe(true);
    expect(f.every((x) => x.severity === "error" || x.severity === "warning")).toBe(true);
    expect(r.errors + r.warnings).toBe(f.length);
  });

  test("severities: violations are errors, tolerated issues are warnings", async () => {
    const bySev = Object.fromEntries(
      (await runDoctor(broken)).findings.map((f) => [f.check, f.severity]),
    );
    expect(bySev["frontmatter"]).toBe("error");
    expect(bySev["type"]).toBe("error");
    expect(bySev["index-frontmatter"]).toBe("error");
    expect(bySev["log-heading"]).toBe("error");
    expect(bySev["recommended-keys"]).toBe("warning");
    expect(bySev["broken-link"]).toBe("warning");
    expect(bySev["okf-version"]).toBe("warning");
    expect(bySev["log-order"]).toBe("warning");
    expect(bySev["missing-index"]).toBe("warning");
  });

  test("links to reserved files and unparseable-but-present targets are not broken", async () => {
    // clean/notes/beta.md links to /index.md — reserved, but present.
    const r = await runDoctor(clean);
    expect(r.findings.filter((f) => f.check === "broken-link")).toEqual([]);
  });

  test("missing root index.md is flagged even with no root concepts", async () => {
    const bare = await mkdtemp(join(tmpdir(), "okb-doctor-bare-"));
    try {
      await mkdir(join(bare, "n"));
      await writeFile(join(bare, "n", "a.md"), `${FM}x\n`);
      const r = await runDoctor(bare);
      expect(has(r.findings, "missing-index", "index.md")).toBe(true);
      expect(has(r.findings, "missing-index", "n/index.md")).toBe(true);
      expect(r.ok).toBe(true); // warnings only
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });
});
