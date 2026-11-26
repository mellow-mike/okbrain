// The learned parameters of the readout, and their defaults. They are few and
// bounded on purpose: every value has a meaning an operator can inspect, and
// an update can only move them inside the ranges below (see learn.ts).

import { roles } from "./structure.ts";

export const lanes = ["lexical", "dense", "exact", "graph", "experience"] as const;
export type Lane = typeof lanes[number];

export interface ReadoutParams {
  /** Incremented on every committed update. Zero means the defaults. */
  version: number;
  /** How much each evidence lane counts when a unit's lanes are fused. */
  lanes: Record<Lane, number>;
  /** How strongly a role slot prefers units of its role, one value per role. */
  roleGain: number[];
  /** How strongly a region slot prefers units of its package. */
  regionGain: number;
  /** Beta posterior of "a unit this slot contributed was used", per role, then one entry for region slots. */
  slotUtility: { alpha: number; beta: number }[];
}

export const laneBounds: Record<Lane, [number, number]> = {
  lexical: [0.25, 3], dense: [0.05, 2], exact: [0.5, 4], graph: [0, 1.5], experience: [0, 2],
};
export const gainBounds: [number, number] = [0, 1.5];

export function defaultParams(): ReadoutParams {
  return {
    version: 0,
    lanes: { lexical: 1, dense: 0.6, exact: 2, graph: 0.6, experience: 0.8 },
    roleGain: roles.map(() => 0.5),
    regionGain: 0.5,
    // A weak, symmetric prior: a slot earns or loses budget only as evidence arrives.
    slotUtility: [...roles.map(() => ({ alpha: 2, beta: 2 })), { alpha: 2, beta: 2 }],
  };
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const clamp = (value: number, [low, high]: [number, number]) => Math.min(high, Math.max(low, value));

/** Read saved parameters defensively: anything missing or out of range falls back to its default. */
export function parseParams(value: unknown): ReadoutParams {
  const base = defaultParams();
  if (!value || typeof value !== "object" || Array.isArray(value)) return base;
  const saved = value as Record<string, unknown>;
  if (finite(saved.version) && Number.isInteger(saved.version) && saved.version >= 0) base.version = saved.version;
  if (saved.lanes && typeof saved.lanes === "object") for (const lane of lanes) {
    const weight = (saved.lanes as Record<string, unknown>)[lane];
    if (finite(weight)) base.lanes[lane] = clamp(weight, laneBounds[lane]);
  }
  if (Array.isArray(saved.roleGain)) for (const [index, gain] of saved.roleGain.slice(0, roles.length).entries()) {
    if (finite(gain)) base.roleGain[index] = clamp(gain, gainBounds);
  }
  if (finite(saved.regionGain)) base.regionGain = clamp(saved.regionGain, gainBounds);
  if (Array.isArray(saved.slotUtility)) for (const [index, slot] of saved.slotUtility.slice(0, roles.length + 1).entries()) {
    if (slot && typeof slot === "object" && finite((slot as { alpha?: unknown }).alpha) && finite((slot as { beta?: unknown }).beta)) {
      const { alpha, beta } = slot as { alpha: number; beta: number };
      if (alpha > 0 && beta > 0) base.slotUtility[index] = { alpha: Math.min(alpha, 1e6), beta: Math.min(beta, 1e6) };
    }
  }
  return base;
}

/** What the readout asks of learned state. Implemented over `learning.sqlite`; absent before any outcome is recorded. */
export interface LearningView {
  params: ReadoutParams;
  /** Units that were used in earlier accepted requests similar to this query, by stable identity. */
  experience(query: Float32Array): { path: string; name: string; weight: number }[];
}
