// OKF v0.2 (SPEC §5–§13): the pure frontmatter readers, path-valued field
// resolution + provenance edges, the v0.1 → v0.2 upgrade, and the ops that
// surface the new signals (list --detail, read signals, new-concept ids,
// init --actor). No network anywhere.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex, updateIndexFor } from "../src/core/engine/index-build.ts";
import { openSqliteEngine } from "../src/core/engine/sqlite.ts";
import { buildEdges, resolvePathField, sourceTargets } from "../src/core/graph/links.ts";
import { runDoctor } from "../src/core/okf/doctor.ts";
import {
  asInstant,
  fmSources,
  fmStatus,
  generatedAt,
  isActor,
  isIsoInstant,
  isStale,
  lastVerifiedAt,
  normalizeVerified,
  parse,
  trustTier,
} from "../src/core/okf/document.ts";
import { parseCitations, planUpgrade, upgradeBundle } from "../src/core/okf/upgrade.ts";
import { writeConcept } from "../src/core/okf/write.ts";
import { okb } from "./helpers.ts";

const NOW = new Date("2026-09-23T12:00:00Z");

describe("document readers (§5, §7)", () => {
  test("ISO instants need an explicit offset; actors follow the convention", () => {
    expect(isIsoInstant("2026-09-23T00:00:00Z")).toBe(true);
    expect(isIsoInstant("2026-09-23T00:00:00+02:00")).toBe(true);
    expect(isIsoInstant("2026-09-23")).toBe(false);
    expect(isIsoInstant("2026-09-23T00:00:00")).toBe(false);
    expect(isIsoInstant("not-a-date")).toBe(false);
    expect(asInstant("Mon, 13 Jul 2026 10:00:00 GMT")).toBe("2026-07-13T10:00:00Z");
    expect(asInstant("2026-01-01T00:00:00Z")).toBe("2026-01-01T00:00:00Z");
    expect(asInstant("nope")).toBeNull();
    for (const a of ["human:ahormati", "process:finance-nightly", "reference_agent/gemini-2.5-pro", "okb/0.1.0", "okb-enrich/openrouter/auto"])
      expect(isActor(a)).toBe(true);
    for (const a of ["ahormati", "human:", "a b/c", "", 42]) expect(isActor(a)).toBe(false);
  });

  test("verified: bare mapping is a one-element list; trust tiers key off human:", () => {
    expect(normalizeVerified({ verified: { by: "human:a", at: "x" } })).toEqual([{ by: "human:a", at: "x" }]);
    expect(normalizeVerified({ verified: [{ by: "process:p" }, { nope: 1 }, "junk"] })).toEqual([{ by: "process:p" }]);
    expect(normalizeVerified({})).toEqual([]);
    expect(trustTier({})).toBe("unverified");
    expect(trustTier({ verified: [{ by: "process:nightly", at: "x" }] })).toBe("machine-confirmed");
    expect(trustTier({ verified: [{ by: "process:nightly" }, { by: "human:a" }] })).toBe("human-reviewed");
    expect(lastVerifiedAt({ verified: [{ by: "process:p", at: "2026-02-01T00:00:00Z" }, { by: "human:a", at: "2026-01-01T00:00:00Z" }] })).toBe("2026-02-01T00:00:00Z");
    expect(lastVerifiedAt({ verified: [{ by: "process:p", at: "2026-02-01T00:00:00Z" }, { by: "human:a", at: "2026-01-01T00:00:00Z" }] }, true)).toBe("2026-01-01T00:00:00Z");
  });

  test("status defaults to stable; staleness is a plain comparison and ignores bare dates", () => {
    expect(fmStatus({})).toBe("stable");
    expect(fmStatus({ status: "draft" })).toBe("draft");
    expect(fmStatus({ status: "wip" })).toBe("stable");
    expect(isStale({ stale_after: "2026-09-23T00:00:00Z" }, NOW)).toBe(true);
    expect(isStale({ stale_after: "2026-09-24T00:00:00Z" }, NOW)).toBe(false);
    expect(isStale({ stale_after: "2026-09-23" }, NOW)).toBe(false);
    expect(isStale({}, NOW)).toBe(false);
  });

  test("generatedAt falls back to the v0.1 timestamp; sources tolerate a bare mapping", () => {
    expect(generatedAt({ generated: { by: "human:a", at: "2026-01-01T00:00:00Z" }, timestamp: "2020-01-01T00:00:00Z" })).toBe("2026-01-01T00:00:00Z");
    expect(generatedAt({ timestamp: "2020-01-01T00:00:00Z" })).toBe("2020-01-01T00:00:00Z");
    expect(generatedAt({})).toBeNull();
    expect(fmSources({ sources: { resource: "x" } })).toEqual([{ resource: "x" }]);
    expect(fmSources({ sources: [{ resource: "a" }, { title: "no resource" }, "junk"] })).toEqual([{ resource: "a" }]);
  });
});

describe("path-valued fields and provenance edges (§5.1, §6.2)", () => {
  const known = new Set(["metrics/revenue", "policies/revenue-recognition", "tables/orders"]);

  test("resolvePathField: link rules plus the root-relative convention the spec's examples use", () => {
    expect(resolvePathField("metrics/revenue", "/tables/orders.md", known)).toBe("tables/orders");
    expect(resolvePathField("metrics/revenue", "../tables/orders.md", known)).toBe("tables/orders");
    expect(resolvePathField("metrics/revenue", "policies/revenue-recognition.md", known)).toBe("policies/revenue-recognition");
    expect(resolvePathField("metrics/revenue", "missing.md", known)).toBe("metrics/missing"); // still a (broken) path
    expect(resolvePathField("metrics/revenue", "https://wiki/x", known)).toBeNull();
    expect(resolvePathField("metrics/revenue", "all queries in project X", known)).toBeNull(); // scope descriptor
    expect(resolvePathField("metrics/revenue", "attesters/sql_equality.py", known)).toBeNull();
  });

  test("sourceTargets + buildEdges: sources[].resource concepts become edges, deduped with body links", () => {
    const fm = { sources: [{ resource: "policies/revenue-recognition.md" }, { resource: "/tables/orders.md" }, { resource: "https://x" }] };
    expect(sourceTargets("metrics/revenue", fm, known)).toEqual(["policies/revenue-recognition", "tables/orders"]);
    const edges = buildEdges(
      [{ id: "metrics/revenue", body: "See [orders](/tables/orders.md).", frontmatter: fm }],
      known,
    );
    expect(edges).toEqual([
      { src: "metrics/revenue", dst: "tables/orders" },
      { src: "metrics/revenue", dst: "policies/revenue-recognition" },
    ]);
  });

  test("index build: provenance edges are typed `cites`; generated/verified feed the node columns", async () => {
    const root = await mkdtemp(join(tmpdir(), "okb-v02-idx-"));
    const eng = openSqliteEngine(":memory:");
    try {
      await mkdir(join(root, "policies"), { recursive: true });
      await writeFile(join(root, "policies", "p.md"), "---\ntype: Policy\ntitle: P\n---\nPolicy text.\n");
      await writeFile(
        join(root, "m.md"),
        "---\ntype: Metric\ntitle: M\nstatus: draft\ngenerated: { by: human:a, at: 2026-01-01T00:00:00Z }\n" +
          "verified:\n  - { by: process:n, at: 2026-02-01T00:00:00Z }\n  - { by: human:a, at: 2026-01-15T00:00:00Z }\n" +
          "stale_after: 2026-03-01T00:00:00Z\nsources:\n  - resource: policies/p.md\n---\nBody.\n",
      );
      await buildIndex(root, eng);
      expect(eng.listEdges()).toEqual([{ src: "m", dst: "policies/p", rel: "cites" }]);
      expect(eng.getNode("m")).toMatchObject({
        timestamp: "2026-01-01T00:00:00Z",
        lastReviewed: "2026-01-15T00:00:00Z", // latest *human* verification
        status: "draft",
        staleAfter: "2026-03-01T00:00:00Z",
        trust: "human-reviewed",
      });
      // A body link to the same target wins over the provenance rel on refresh.
      await writeFile(join(root, "m.md"), "---\ntype: Metric\ntitle: M\nsources:\n  - resource: policies/p.md\n---\nSee [p](/policies/p.md).\n");
      await updateIndexFor(root, "m", eng);
      expect(eng.listEdges()).toEqual([{ src: "m", dst: "policies/p", rel: null }]);
      expect(eng.getNode("m")).toMatchObject({ timestamp: null, status: "stable", trust: "unverified" });
    } finally {
      eng.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("okb upgrade (§13: v0.1 → v0.2)", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "okb-v02-up-"));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  test("parseCitations reads v0.1 bullet lists (links, bare URLs, bylines)", () => {
    expect(parseCitations("- [T](https://a.test/x) — Ada\n- https://b.test\n* [U](/notes/u.md)\nnot a bullet\n")).toEqual([
      { resource: "https://a.test/x", title: "T", author: "Ada" },
      { resource: "https://b.test" },
      { resource: "/notes/u.md", title: "U" },
    ]);
  });

  test("planUpgrade: nothing to do for a v0.2 doc; every legacy convention maps", () => {
    expect(planUpgrade({ type: "note", generated: { by: "human:a", at: "x" } }, "Body.\n", "human:me")).toBeNull();
    const plan = planUpgrade(
      {
        type: "reference",
        resource: "https://a.test/x",
        timestamp: "2026-01-15T10:00:00Z",
        last_reviewed: "2026-02-01T00:00:00Z",
        author: "Ada",
        published: "2026-01-10T00:00:00Z",
      },
      "Text.\n\n# Highlights\n\n- q\n\n# Citations\n\n- [T](https://a.test/x)\n- [O](https://o.test)\n",
      "human:me",
    )!;
    expect(plan.changes).toEqual(["timestamp → generated", "last_reviewed → verified", "# Citations → sources (2)", "author/published → sources"]);
    expect(plan.input.generated).toEqual({ by: "human:me", at: "2026-01-15T10:00:00Z" });
    expect(plan.input.verify).toEqual({ by: "human:me", at: "2026-02-01T00:00:00Z" });
    expect(plan.input.sources).toEqual([
      { resource: "https://a.test/x", title: "T", author: "Ada", last_modified: "2026-01-10T00:00:00Z" },
      { resource: "https://o.test", title: "O" },
    ]);
    expect(plan.input.body).toBe("Text.\n\n# Highlights\n\n- q\n");
    expect(plan.input.extra).toEqual({ author: undefined, published: undefined });
  });

  test("upgradeBundle: dry-run writes nothing; the real run is idempotent and doctor-clean", async () => {
    await writeFile(join(root, "index.md"), '---\nokf_version: "0.1"\n---\n# b\n');
    await mkdir(join(root, "references"));
    await writeFile(
      join(root, "references", "r.md"),
      "---\ntype: reference\ntitle: R\ndescription: d\ntimestamp: 2026-01-15T10:00:00Z\nresource: https://a.test/x\ntags:\n  - inbox\nauthor: Ada\nlast_reviewed: 2026-02-01T00:00:00Z\n---\nText.\n\n# Citations\n\n- [T](https://a.test/x)\n",
    );
    await writeFile(join(root, "modern.md"), "---\ntype: note\ntitle: M\ndescription: d\ngenerated: { by: human:x, at: 2026-01-01T00:00:00Z }\n---\nok\n");
    await writeFile(join(root, "broken.md"), "---\n: [\n---\nx\n");

    const dry = await upgradeBundle(root, { actor: "human:me", dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, declared: true, unchanged: 1, skipped: ["broken"] });
    expect(dry.upgraded.map((u) => u.id)).toEqual(["references/r"]);
    expect(await readFile(join(root, "references", "r.md"), "utf8")).toContain("timestamp:");
    expect(existsSync(join(root, "log.md"))).toBe(false);

    const run = await upgradeBundle(root, { actor: "human:me" });
    expect(run.upgraded.map((u) => u.id)).toEqual(["references/r"]);
    const raw = await readFile(join(root, "references", "r.md"), "utf8");
    const fm = parse(raw).frontmatter;
    expect(fm).toMatchObject({
      generated: { by: "human:me", at: "2026-01-15T10:00:00Z" },
      verified: [{ by: "human:me", at: "2026-02-01T00:00:00Z" }],
      sources: [{ id: "a-test", resource: "https://a.test/x", title: "T", author: "Ada" }],
      tags: ["inbox"],
    });
    expect(fm.timestamp).toBeUndefined();
    expect(fm.last_reviewed).toBeUndefined();
    expect(fm.author).toBeUndefined();
    expect(raw).not.toContain("# Citations");
    expect(parse(await readFile(join(root, "index.md"), "utf8")).frontmatter.okf_version).toBe("0.2");
    expect(await readFile(join(root, "log.md"), "utf8")).toContain("upgraded 1 concept to OKF v0.2");

    const again = await upgradeBundle(root, { actor: "human:me" });
    expect(again.upgraded).toEqual([]);
    expect(again).toMatchObject({ unchanged: 2, declared: false });
    const rep = await runDoctor(root);
    expect(rep.findings.filter((f) => f.path.startsWith("references/"))).toEqual([]);
    expect(rep.signals.legacy).toBe(0);
  });

  test("okb upgrade: CLI validates the actor and reports per concept", async () => {
    await writeFile(join(root, "a.md"), "---\ntype: note\ntitle: A\ndescription: d\ntimestamp: 2026-01-01T00:00:00Z\n---\nx\n");
    expect((await okb(["upgrade", "--by", "nobody", "--bundle", root])).code).toBe(2);
    const r = await okb(["upgrade", "--by", "human:me", "--bundle", root]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("upgraded a — timestamp → generated");
    expect(r.stdout).toContain("1 upgraded, 0 already v0.2");
  });
});

describe("ops surfacing v0.2 signals", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "okb-v02-ops-"));
    await writeConcept(root, { id: "notes/a", type: "note", title: "A", description: "d", status: "draft", tags: ["x"], actor: "human:t" });
    await writeConcept(root, { id: "notes/b", type: "note", title: "B", description: "d", verify: { by: "human:t" }, actor: "human:t" });
    await writeConcept(root, { id: "refs/c", type: "reference", title: "C", description: "d", status: "deprecated", staleAfter: "2020-01-01T00:00:00Z", actor: "human:t" });
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  test("list --detail carries signals; type/tag/status filters narrow it", async () => {
    const all = JSON.parse((await okb(["list", "--detail", "--json", "--bundle", root])).stdout);
    expect(all.map((r: { id: string }) => r.id)).toEqual(["notes/a", "notes/b", "refs/c"]);
    expect(all[0]).toMatchObject({ id: "notes/a", type: "note", title: "A", tags: ["x"], status: "draft", trust: "unverified", stale: false });
    expect(all[1]).toMatchObject({ trust: "human-reviewed" });
    expect(all[2]).toMatchObject({ status: "deprecated", stale: true });
    expect(JSON.parse((await okb(["list", "--status", "deprecated", "--json", "--bundle", root])).stdout)).toEqual(["refs/c"]);
    expect(JSON.parse((await okb(["list", "--tag", "x", "--json", "--bundle", root])).stdout)).toEqual(["notes/a"]);
    expect(JSON.parse((await okb(["list", "--type", "reference", "--detail", "--json", "--bundle", root])).stdout)).toHaveLength(1);
    expect((await okb(["list", "--status", "wip", "--bundle", root])).code).toBe(2);
    const human = await okb(["list", "--detail", "--bundle", root]);
    expect(human.stdout).toContain("refs/c — C  [reference · deprecated · unverified · STALE]");
  });

  test("read exposes derived signals; write --status/--stale-after/--sources round-trip", async () => {
    const r = await okb(["write", "notes/a", "--status", "stable", "--stale-after", "2030-01-01T00:00:00Z", "--sources", "https://s.test/one, /notes/b.md", "--bundle", root]);
    expect(r.code).toBe(0);
    const v = JSON.parse((await okb(["read", "notes/a", "--json", "--bundle", root])).stdout);
    expect(v.signals).toMatchObject({ status: "stable", trust: "unverified", stale: false, verified: null });
    expect(v.frontmatter.sources).toEqual([{ id: "s-test", resource: "https://s.test/one" }, { id: "b", resource: "/notes/b.md" }]);
    expect((await okb(["write", "notes/a", "--sources", "[not json", "--bundle", root])).code).toBe(2);
    expect((await okb(["write", "notes/a", "--stale-after", "2030-01-01", "--bundle", root])).code).toBe(2);
    // A JSON array of objects (the GUI's form) works too.
    const j = await okb(["write", "notes/a", "--sources", JSON.stringify([{ id: "k", resource: "https://k.test", title: "K" }]), "--bundle", root]);
    expect(j.code).toBe(0);
    expect(JSON.parse((await okb(["read", "notes/a", "--json", "--bundle", root])).stdout).frontmatter.sources).toEqual([{ id: "k", resource: "https://k.test", title: "K" }]);
  });

  test("new derives the directory from a slugified type; rm deletes and logs", async () => {
    const r = await okb(["new", "Attested Computation", "Revenue YTD", "d", "--status", "draft", "--bundle", root]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("created attested-computations/revenue-ytd\n");
    expect(parse(await readFile(join(root, "attested-computations", "revenue-ytd.md"), "utf8")).frontmatter.status).toBe("draft");
    const del = await okb(["rm", "attested-computations/revenue-ytd", "--bundle", root]);
    expect(del.code).toBe(0);
    expect(existsSync(join(root, "attested-computations", "revenue-ytd.md"))).toBe(false);
    expect(await readFile(join(root, "log.md"), "utf8")).toContain("**Deletion**: [Revenue YTD](/attested-computations/revenue-ytd.md)");
    expect(await readFile(join(root, "index.md"), "utf8")).not.toContain("attested-computations");
    expect((await okb(["rm", "attested-computations/revenue-ytd", "--bundle", root])).code).toBe(1);
    expect((await okb(["rm", "../escape", "--bundle", root])).code).toBe(2);
  });

  test("init --actor persists the identity; a fresh directory gets a root index.md", async () => {
    const fresh = await mkdtemp(join(tmpdir(), "okb-v02-init-"));
    try {
      expect((await okb(["init", "--actor", "not-an-actor", "--no-default-bundle", "--bundle", fresh])).code).toBe(2);
      const r = await okb(["init", "--actor", "human:alice", "--no-default-bundle", "--bundle", fresh]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("actor: human:alice");
      expect(parse(await readFile(join(fresh, "index.md"), "utf8")).frontmatter.okf_version).toBe("0.2");
      const w = await okb(["capture", "attributed", "--bundle", fresh]);
      expect(w.code).toBe(0);
      const id = w.stdout.trim().replace(/^created /, "");
      expect(parse(await readFile(join(fresh, ...id.split("/")) + ".md", "utf8")).frontmatter.generated).toMatchObject({ by: "human:alice" });
      expect((await okb(["doctor", "--json", "--bundle", fresh])).code).toBe(0);
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });
});
