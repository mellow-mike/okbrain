import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor, type Finding } from "../src/core/okf/doctor.ts";

const FM = "---\ntype: note\ntitle: T\ndescription: D\ngenerated:\n  by: human:t\n  at: 2026-07-01T00:00:00Z\n---\n";
const V01 = "---\ntype: note\ntitle: T\ndescription: D\ntimestamp: 2026-07-01T00:00:00Z\n---\n";

let clean: string;
let broken: string;

beforeAll(async () => {
  clean = await mkdtemp(join(tmpdir(), "okb-doctor-clean-"));
  await mkdir(join(clean, "notes"), { recursive: true });
  await writeFile(
    join(clean, "index.md"),
    '---\nokf_version: "0.2"\n---\n# bundle\n\n- [Alpha](/alpha.md)\n- [notes](/notes/index.md)\n',
  );
  await writeFile(
    join(clean, "log.md"),
    "## 2026-07-02\n**Update** alpha\n\n## 2026-07-01\n**Creation** alpha\n",
  );
  await writeFile(
    join(clean, "alpha.md"),
    "---\ntype: note\ntitle: T\ndescription: D\nstatus: stable\ngenerated:\n  by: human:t\n  at: 2026-07-01T00:00:00Z\n" +
      "verified: { by: process:nightly, at: 2026-07-02T00:00:00Z }\nstale_after: 2099-01-01T00:00:00Z\n" +
      "sources:\n  - id: beta\n    resource: /notes/beta.md\n    last_modified: 2026-07-01T00:00:00Z\n---\nSee [beta](/notes/beta.md).[^beta]\n\n[^beta]: Beta\n",
  );
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
  await writeFile(join(broken, "legacy.md"), `${V01}Text.\n\n# Citations\n\n- [x](https://x.test)\n`);
  await writeFile(
    join(broken, "families.md"),
    "---\ntype: Attested Computation\ntitle: F\ndescription: D\nstatus: wip\ngenerated: { at: 2026-01-01T00:00:00Z }\n" +
      "verified:\n  - { by: nobody, at: yesterday }\nstale_after: 2026-09-23\nsources:\n  - title: no resource\n  - resource: /missing.md\n---\nbody\n",
  );
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
    expect(r).toMatchObject({ ok: true, files: 5, concepts: 2, errors: 0, warnings: 0, okfVersion: "0.2" });
    expect(r.signals).toEqual({
      trust: { unverified: 1, "machine-confirmed": 1, "human-reviewed": 0 },
      status: { draft: 0, stable: 2, deprecated: 0 },
      stale: 0,
      legacy: 0,
    });
  });

  test("v0.2 families: legacy leftovers and malformed shapes are warnings, never errors", async () => {
    const f = (await runDoctor(broken)).findings;
    expect(has(f, "legacy-timestamp", "legacy.md")).toBe(true);
    expect(has(f, "legacy-citations", "legacy.md")).toBe(true);
    expect(has(f, "generated-shape", "families.md")).toBe(true); // no `by`
    expect(has(f, "verified-shape", "families.md")).toBe(true); // bad actor + bad instant
    expect(has(f, "status-value", "families.md")).toBe(true);
    expect(has(f, "stale-after-format", "families.md")).toBe(true); // bare date
    expect(has(f, "sources-shape", "families.md")).toBe(true); // entry without resource
    expect(has(f, "broken-source", "families.md")).toBe(true); // /missing.md
    expect(has(f, "computation-runtime", "families.md")).toBe(true);
    for (const x of f.filter((x) => x.path === "families.md" || x.path === "legacy.md"))
      expect(x.severity).toBe("warning");
    expect((await runDoctor(broken)).signals.legacy).toBe(1);
  });

  test("a declared okf_version other than the current one is a warning", async () => {
    const dir = await mkdtemp(join(tmpdir(), "okb-doctor-ver-"));
    try {
      await writeFile(join(dir, "index.md"), '---\nokf_version: "0.1"\n---\n# b\n');
      const r = await runDoctor(dir);
      expect(r.okfVersion).toBe("0.1");
      expect(r.findings.find((x) => x.check === "okf-version")!.message).toContain("okb upgrade");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
