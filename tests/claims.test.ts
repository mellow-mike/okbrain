// Stage 5: calibration — takes vs facts. Pure Brier/bucket math, the bundle
// scan's permissive tolerance, and the take → resolve → calibrate CLI flow
// (claims are conformant concepts; outcomes settle exactly once).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calibration, scanClaims, type ClaimRow } from "../src/core/claims.ts";
import { okb as okbAt } from "./helpers.ts";

const NOW = new Date("2026-07-20T00:00:00Z");
const claim = (over: Partial<ClaimRow>): ClaimRow => ({
  id: "claims/x",
  title: "x",
  confidence: 70,
  resolveBy: null,
  outcome: null,
  resolved: null,
  ...over,
});

describe("calibration (pure)", () => {
  test("empty and unresolved sets produce no Brier score", () => {
    expect(calibration([], NOW).brier).toBeNull();
    const r = calibration([claim({})], NOW);
    expect(r.brier).toBeNull();
    expect(r.open).toHaveLength(1);
  });

  test("Brier score: mean squared distance from the outcome", () => {
    const r = calibration(
      [
        claim({ id: "a", confidence: 100, outcome: "correct" }), // (1−1)² = 0
        claim({ id: "b", confidence: 50, outcome: "incorrect" }), // (0.5−0)² = 0.25
      ],
      NOW,
    );
    expect(r.brier).toBeCloseTo(0.125);
    expect(r.correct).toBe(1);
    expect(r.incorrect).toBe(1);
  });

  test("void outcomes count but never score; missing confidence never scores", () => {
    const r = calibration(
      [
        claim({ id: "a", confidence: 80, outcome: "correct" }),
        claim({ id: "b", outcome: "void" }),
        claim({ id: "c", confidence: null, outcome: "incorrect" }),
      ],
      NOW,
    );
    expect(r.void).toBe(1);
    expect(r.brier).toBeCloseTo(0.04); // only claim a scores
  });

  test("buckets group by confidence decade with hit rates", () => {
    const r = calibration(
      [
        claim({ id: "a", confidence: 72, outcome: "correct" }),
        claim({ id: "b", confidence: 78, outcome: "incorrect" }),
        claim({ id: "c", confidence: 95, outcome: "correct" }),
        claim({ id: "d", confidence: 100, outcome: "correct" }),
      ],
      NOW,
    );
    expect(r.buckets).toEqual([
      { range: "70–79%", n: 2, meanConfidence: 75, hitRate: 50 },
      { range: "90–100%", n: 2, meanConfidence: 98, hitRate: 100 },
    ]);
  });

  test("overdue: resolve_by in the past on an open claim; overdue sort first", () => {
    const r = calibration(
      [
        claim({ id: "b", resolveBy: "2027-01-01" }),
        claim({ id: "a", resolveBy: "2026-01-01" }),
      ],
      NOW,
    );
    expect(r.open.map((o) => [o.id, o.overdue])).toEqual([
      ["a", true],
      ["b", false],
    ]);
  });
});

describe("take → resolve → calibrate (CLI)", () => {
  let root: string;
  const okb = (...args: string[]) => okbAt([...args, "--bundle", root]);

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "okb-claims-"));
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  test("take stakes a conformant claim concept", async () => {
    const r = await okb("take", "Local models beat APIs for PKM by 2027", "--confidence", "70", "--resolve-by", "2027-01-01");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("staked claims/local-models-beat-apis-for-pkm-by-2027 at 70%");
    expect((await okb("doctor")).code).toBe(0);
  });

  test("confidence and resolve-by are validated", async () => {
    expect((await okb("take", "x y z", "--confidence", "170")).code).toBe(2);
    expect((await okb("take", "x y z", "--confidence", "50", "--resolve-by", "soon")).code).toBe(2);
  });

  test("resolve settles once; wrong outcome and non-claims are refused", async () => {
    const id = "claims/local-models-beat-apis-for-pkm-by-2027";
    expect((await okb("resolve", id, "maybe")).code).toBe(2);
    const r = await okb("resolve", id, "false");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`resolved ${id}: incorrect\n`);
    expect((await okb("resolve", id, "correct")).code).toBe(1); // already resolved
    await okb("capture", "just a note");
    const notClaim = await okb("resolve", (await okb("list")).stdout.split("\n").find((l) => l.startsWith("inbox/"))!, "correct");
    expect(notClaim.code).toBe(2);
    expect(notClaim.stderr).toContain("not a claim");
  });

  test("calibrate reports open claims, Brier score, and buckets", async () => {
    await okb("take", "The sun rises tomorrow", "--confidence", "99");
    const r = await okb("calibrate");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("open claims (1):");
    expect(r.stdout).toContain("claims/the-sun-rises-tomorrow — 99%");
    expect(r.stdout).toContain("resolved: 0 correct, 1 incorrect, 0 void");
    expect(r.stdout).toContain("Brier score: 0.490 over 1 scored claims");
    expect(r.stdout).toContain("70–79%  n=1  said 70%  got 0%");

    const scanned = await scanClaims(root);
    expect(scanned).toHaveLength(2);
    expect(scanned.find((c) => c.outcome === "incorrect")?.resolved).toMatch(/^\d{4}-/);
  });

  test("calibrate on a claimless bundle points at okb take", async () => {
    const empty = await mkdtemp(join(tmpdir(), "okb-noclaims-"));
    const r = await okbAt(["calibrate", "--bundle", empty]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("no claims yet");
    await rm(empty, { recursive: true, force: true });
  });
});
