// Conformance acceptance on a bundle okbrain did not write: the OKF
// reference project's `acme_retail` sample (v0.2 throughout — generated /
// verified / status / stale_after / sources, an Attested Computation, agent
// style index.md files, a log.md with frontmatter). okbrain must read it
// permissively, index it, type its provenance edges, and never touch it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
import type { DoctorReport } from "../src/core/okf/doctor.ts";
import type { BrainStats } from "../src/core/stats.ts";
import type { VizGraph } from "../src/core/viz/export.ts";

const ACME = join(import.meta.dir, "..", "bundles", "acme_retail");
let root: string;

async function okb(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await runCli([...args, "--bundle", root], {
    out: (t) => void (stdout += t),
    err: (t) => void (stderr += t),
  });
  return { code, stdout, stderr };
}
const json = <T>(r: { stdout: string }): T => JSON.parse(r.stdout) as T;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "okb-acme-"));
  await cp(ACME, root, { recursive: true });
});

afterAll(() => rm(root, { recursive: true, force: true }));

describe("acme_retail (upstream OKF v0.2 sample)", () => {
  test("doctor: zero errors; the only warning is the undeclared okf_version", async () => {
    const r = await okb("doctor", "--json");
    expect(r.code).toBe(0);
    const rep = json<DoctorReport>(r);
    expect(rep).toMatchObject({ ok: true, concepts: 9, errors: 0, warnings: 1, okfVersion: null });
    expect(rep.findings.map((f) => f.check)).toEqual(["okf-version"]);
    expect(rep.signals.trust["human-reviewed"]).toBe(8);
    expect(rep.signals.status.deprecated).toBe(1);
    expect(rep.signals.legacy).toBe(0);
  });

  test("index + typed provenance edges: a metric cites its policy through `sources`", async () => {
    expect(json(await okb("index", "--json"))).toMatchObject({ indexed: 9, removed: 0 });
    const g = json<{ id: string; dir: string }[]>(await okb("graph", "computations/revenue-ytd", "--json"));
    expect(g.map((n) => n.id)).toContain("policies/revenue-recognition"); // sources[].resource (root-relative)
    expect(g.map((n) => n.id)).toContain("tables/orders");
    const hits = json<{ id: string; sources: string[] }[]>(await okb("search", "what cites revenue recognition policy", "--json"));
    expect(hits.some((h) => h.id === "metrics/revenue" && h.sources.includes("relational"))).toBe(true);
  });

  test("signals flow into read, list, stats, and the viewer export", async () => {
    const rev = json<{ signals: Record<string, unknown> }>(await okb("read", "metrics/revenue", "--json"));
    expect(rev.signals).toMatchObject({ status: "stable", trust: "human-reviewed", updated: "2026-06-30T14:00:00Z", verified: "2026-07-01T09:00:00Z" });
    expect(json<string[]>(await okb("list", "--status", "deprecated", "--json"))).toEqual(["metrics/gross-margin-legacy"]);
    const s = json<BrainStats>(await okb("stats", "--json"));
    expect(s.byStatus).toEqual({ draft: 0, stable: 8, deprecated: 1 });
    expect(s.byTrust).toMatchObject({ "human-reviewed": 8, unverified: 1 });
    expect(s.byType.find((t) => t.type === "Attested Computation")?.count).toBe(2);

    expect((await okb("export-viz")).code).toBe(0);
    const html = await readFile(join(root, "viz.html"), "utf8");
    const g = JSON.parse(/<script id="okb-graph"[^>]*>([\s\S]*?)<\/script>/.exec(html)![1]!) as VizGraph;
    const ytd = g.nodes.find((n) => n.id === "computations/revenue-ytd")!;
    expect(ytd.sources.map((x) => x.id)).toEqual(["revenue-policy", "orders-table"]);
    expect(ytd.verified).toEqual([{ by: "human:jsmith@acme", at: "2026-07-01T09:00:00Z" }]);
    expect(g.nodes.find((n) => n.id === "metrics/gross-margin-legacy")!.status).toBe("deprecated");
  });

  test("the bundle itself is untouched by reads (only derived files appear)", async () => {
    for (const rel of ["metrics/revenue.md", "index.md", "log.md", "attesters/sql_equality.py"])
      expect(await readFile(join(root, rel), "utf8")).toBe(await readFile(join(ACME, rel), "utf8"));
  });
});
