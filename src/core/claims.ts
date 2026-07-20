// Calibration — takes vs facts (Stage 5). A "take" is an opinion/prediction
// held apart from settled knowledge: a concept of type `claim` carrying a
// stated `confidence` (0–100) and, once settled, an `outcome`
// (correct/incorrect/void) — all okbrain extension keys, OKF-safe because
// consumers tolerate and preserve unknown frontmatter. Scoring is
// deterministic and zero-AI: Brier score + per-decade calibration buckets
// over resolved claims, computed from a bundle scan (no index required).

import { listConcepts, readConceptPermissive } from "./okf/bundle.ts";
import { fmString } from "./okf/document.ts";

export const CLAIM_TYPE = "claim";
export type Outcome = "correct" | "incorrect" | "void";

export interface ClaimRow {
  id: string;
  title: string;
  /** Stated confidence 0–100; null when missing/unreadable (doctor-style tolerance). */
  confidence: number | null;
  /** Optional `resolve_by` date (YYYY-MM-DD). */
  resolveBy: string | null;
  outcome: Outcome | null;
  /** When the claim was resolved (ISO timestamp). */
  resolved: string | null;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
};

const outcomeOf = (v: unknown): Outcome | null => {
  if (v === true || v === "correct") return "correct";
  if (v === false || v === "incorrect") return "incorrect";
  return v === "void" ? "void" : null;
};

/** Every `type: claim` concept in the bundle (permissive read, no index needed). */
export async function scanClaims(root: string): Promise<ClaimRow[]> {
  const out: ClaimRow[] = [];
  for (const id of await listConcepts(root)) {
    const { doc } = await readConceptPermissive(root, id);
    const fm = doc.frontmatter;
    if (fmString(fm.type) !== CLAIM_TYPE) continue;
    out.push({
      id,
      title: fmString(fm.title),
      confidence: num(fm.confidence),
      resolveBy: fmString(fm.resolve_by) || null,
      outcome: outcomeOf(fm.outcome),
      resolved: fmString(fm.resolved) || null,
    });
  }
  return out;
}

export interface OpenClaim extends ClaimRow {
  /** `resolve_by` has passed and the claim is still open. */
  overdue: boolean;
}

export interface Bucket {
  /** Confidence decade, e.g. "70–79%" ("90–100%" for the top bucket). */
  range: string;
  n: number;
  meanConfidence: number;
  /** Share of the bucket's claims that resolved correct (0–100). */
  hitRate: number;
}

export interface CalibrationReport {
  open: OpenClaim[];
  correct: number;
  incorrect: number;
  void: number;
  /** Mean (confidence/100 − outcome)²; null when nothing scoreable. 0 best, 0.25 = coin flip. */
  brier: number | null;
  buckets: Bucket[];
}

/** Pure calibration over scanned claims. Void outcomes count but never score. */
export function calibration(claims: ClaimRow[], now: Date): CalibrationReport {
  const today = now.toISOString().slice(0, 10);
  const open = claims
    .filter((c) => c.outcome === null)
    .map((c): OpenClaim => ({ ...c, overdue: c.resolveBy !== null && c.resolveBy < today }))
    .sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.id < b.id ? -1 : 1));

  const scored = claims.filter(
    (c): c is ClaimRow & { confidence: number; outcome: "correct" | "incorrect" } =>
      c.confidence !== null && (c.outcome === "correct" || c.outcome === "incorrect"),
  );
  const brier =
    scored.length === 0
      ? null
      : scored.reduce(
          (s, c) => s + (c.confidence / 100 - (c.outcome === "correct" ? 1 : 0)) ** 2,
          0,
        ) / scored.length;

  const buckets: Bucket[] = [];
  for (let lo = 0; lo <= 90; lo += 10) {
    const hi = lo === 90 ? 100 : lo + 9;
    const inb = scored.filter((c) => c.confidence >= lo && c.confidence <= hi);
    if (inb.length === 0) continue;
    buckets.push({
      range: `${lo}–${hi}%`,
      n: inb.length,
      meanConfidence: Math.round(inb.reduce((s, c) => s + c.confidence, 0) / inb.length),
      hitRate: Math.round(
        (100 * inb.filter((c) => c.outcome === "correct").length) / inb.length,
      ),
    });
  }

  return {
    open,
    correct: claims.filter((c) => c.outcome === "correct").length,
    incorrect: claims.filter((c) => c.outcome === "incorrect").length,
    void: claims.filter((c) => c.outcome === "void").length,
    brier,
    buckets,
  };
}
