// Model routing for coding work. A policy lists the models each role may
// use. The router picks one before any generation starts, on the expected
// cost of reaching an accepted result, and always records what the fixed
// first-choice model would have been so the learned choice can be compared
// against a static baseline.
//
// The choice is made when a plan is previewed and saved with it. A resumed
// run never routes again, so a request keeps its model binding.

import type { Api, Model, ModelThinkingLevel, OpenRouterRouting } from "@earendil-works/pi-ai";
import { hash32 } from "./atlas/text.ts";

export const codingRoles = ["orchestrator", "worker"] as const;
export type CodingRole = typeof codingRoles[number];
export const routeCells = ["small", "medium", "large"] as const;
export type RouteCell = typeof routeCells[number];

export interface RouteCandidate {
  provider: string;
  model: string;
  thinkingLevel?: ModelThinkingLevel;
}

export interface OpenRouterPreferences {
  /** `deny` restricts routing to upstream providers that do not retain or train on prompts. */
  dataCollection?: "deny" | "allow";
  /** Restrict routing to zero-data-retention endpoints. */
  zdr?: boolean;
  /** Upstream providers to try, in order. */
  order?: string[];
  allowFallbacks?: boolean;
  sort?: "price" | "throughput" | "latency";
}

export interface RoutingPolicy {
  version: 1;
  /** Models each role may use. The first is the role's fixed baseline. */
  roles: Partial<Record<CodingRole, RouteCandidate[]>>;
  /** What one rejected result costs in review time, in US dollars. Higher values favour stronger models. */
  reviewCost?: number;
  /** Learn from review outcomes. When false, every role uses its first model. */
  learn?: boolean;
  openRouter?: OpenRouterPreferences;
}

export class RoutingError extends Error {}

const maxCandidates = 4;
const maxPolicyBytes = 4096;
const defaultReviewCost = 0.5;
const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const modelPattern = /^[~a-zA-Z0-9][a-zA-Z0-9._:/~-]{0,159}$/u;
const upstreamPattern = /^[a-zA-Z0-9][a-zA-Z0-9._/ -]{0,63}$/u;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate a routing policy. `providers` names the providers this installation can call. */
export function validateRoutingPolicy(value: unknown, providers: readonly string[]): RoutingPolicy {
  if (!record(value) || value.version !== 1) throw new RoutingError("Use routing policy version 1.");
  if (Object.keys(value).some((key) => !["version", "roles", "reviewCost", "learn", "openRouter"].includes(key)))
    throw new RoutingError("Use only version, roles, reviewCost, learn, and openRouter in a routing policy.");
  if (Buffer.byteLength(JSON.stringify(value)) > maxPolicyBytes) throw new RoutingError(`Keep the routing policy within ${maxPolicyBytes} UTF-8 bytes.`);
  if (!record(value.roles)) throw new RoutingError("List the models each role may use under roles.");
  const roles: RoutingPolicy["roles"] = {};
  for (const [role, list] of Object.entries(value.roles)) {
    if (!(codingRoles as readonly string[]).includes(role)) throw new RoutingError(`Unknown routing role ${JSON.stringify(role)}. Use ${codingRoles.join(" or ")}.`);
    if (!Array.isArray(list) || list.length < 1 || list.length > maxCandidates) throw new RoutingError(`List 1–${maxCandidates} models for the ${role} role.`);
    const candidates: RouteCandidate[] = [];
    for (const entry of list) {
      if (!record(entry) || typeof entry.provider !== "string" || !providers.includes(entry.provider))
        throw new RoutingError(`Choose a provider from ${providers.join(", ")} for each ${role} model.`);
      if (Object.keys(entry).some((key) => !["provider", "model", "thinkingLevel"].includes(key)))
        throw new RoutingError(`Use only provider, model, and thinkingLevel in a ${role} model.`);
      if (typeof entry.model !== "string" || !modelPattern.test(entry.model)) throw new RoutingError(`Enter a model ID from the provider's catalog for each ${role} model.`);
      if (entry.thinkingLevel !== undefined && (typeof entry.thinkingLevel !== "string" || !thinkingLevels.has(entry.thinkingLevel)))
        throw new RoutingError("Choose a reasoning level the model supports.");
      if (candidates.some((other) => other.provider === entry.provider && other.model === entry.model)) throw new RoutingError(`List each ${role} model once.`);
      candidates.push({ provider: entry.provider, model: entry.model, ...(entry.thinkingLevel ? { thinkingLevel: entry.thinkingLevel as ModelThinkingLevel } : {}) });
    }
    roles[role as CodingRole] = candidates;
  }
  const policy: RoutingPolicy = { version: 1, roles };
  if (value.reviewCost !== undefined) {
    if (typeof value.reviewCost !== "number" || !Number.isFinite(value.reviewCost) || value.reviewCost < 0 || value.reviewCost > 1000)
      throw new RoutingError("Set reviewCost to a dollar amount from 0 to 1000.");
    policy.reviewCost = value.reviewCost;
  }
  if (value.learn !== undefined) {
    if (typeof value.learn !== "boolean") throw new RoutingError("Set learn to true or false.");
    policy.learn = value.learn;
  }
  if (value.openRouter !== undefined) {
    const preferences = value.openRouter;
    if (!record(preferences)) throw new RoutingError("Give the OpenRouter preferences as an object.");
    if (Object.keys(preferences).some((key) => !["dataCollection", "zdr", "order", "allowFallbacks", "sort"].includes(key)))
      throw new RoutingError("Use only dataCollection, zdr, order, allowFallbacks, and sort in OpenRouter preferences.");
    const parsed: OpenRouterPreferences = {};
    if (preferences.dataCollection !== undefined) {
      if (preferences.dataCollection !== "deny" && preferences.dataCollection !== "allow") throw new RoutingError("Set openRouter.dataCollection to deny or allow.");
      parsed.dataCollection = preferences.dataCollection;
    }
    for (const flag of ["zdr", "allowFallbacks"] as const) {
      if (preferences[flag] === undefined) continue;
      if (typeof preferences[flag] !== "boolean") throw new RoutingError(`Set openRouter.${flag} to true or false.`);
      parsed[flag] = preferences[flag];
    }
    if (preferences.sort !== undefined) {
      if (preferences.sort !== "price" && preferences.sort !== "throughput" && preferences.sort !== "latency") throw new RoutingError("Sort OpenRouter providers by price, throughput, or latency.");
      parsed.sort = preferences.sort;
    }
    if (preferences.order !== undefined) {
      if (!Array.isArray(preferences.order) || preferences.order.length > 8 || preferences.order.some((name) => typeof name !== "string" || !upstreamPattern.test(name)))
        throw new RoutingError("List up to eight upstream provider names under openRouter.order.");
      parsed.order = preferences.order as string[];
    }
    policy.openRouter = parsed;
  }
  return policy;
}

export function parseRoutingPolicy(text: string, providers: readonly string[]): RoutingPolicy {
  if (Buffer.byteLength(text) > maxPolicyBytes) throw new RoutingError(`Keep the routing policy within ${maxPolicyBytes} UTF-8 bytes.`);
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new RoutingError("Enter the routing policy as JSON."); }
  return validateRoutingPolicy(value, providers);
}

/** How large a piece of work is, by the context it was given. Routing statistics are kept per size. */
export function routeCell(contextTokens: number): RouteCell {
  return contextTokens < 1500 ? "small" : contextTokens < 6000 ? "medium" : "large";
}

export const routeKey = ({ provider, model }: RouteCandidate): string => `${provider}/${model}`;

export interface RouteStatistics { alpha: number; beta: number; runs: number }
export type RouteStats = (role: CodingRole, cell: RouteCell, key: string) => RouteStatistics | undefined;
/** US dollars per million input and output tokens, when the catalog lists them. */
export type RoutePrices = (candidate: RouteCandidate) => { input: number; output: number } | undefined;

export interface RouteOption extends RouteCandidate {
  /** Dollars this piece of work is expected to cost on this model. */
  cost: number;
  /** Posterior mean of "the result is accepted", from this workspace's reviewed runs. */
  acceptance: number;
  runs: number;
  /** Dollars expected to reach an accepted result, counting a wasted review and a retry on rejection. */
  expected: number;
}

export interface RouteDecision {
  role: CodingRole;
  cell: RouteCell;
  choice: RouteCandidate;
  /** The role's fixed first model: what a static policy would have used. */
  baseline: RouteCandidate;
  /** Remaining models, in the order they are tried if the chosen model's provider fails. */
  fallbacks: RouteCandidate[];
  options: RouteOption[];
  reason: string;
}

/** A small seeded generator, so the same plan always draws the same numbers. */
function generator(seed: string): () => number {
  let state = hash32(seed) || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function gamma(shape: number, random: () => number): number {
  // Marsaglia and Tsang. Shapes below one use the boosting identity.
  if (shape < 1) return gamma(shape + 1, random) * Math.pow(Math.max(random(), 1e-12), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let attempt = 0; attempt < 64; attempt++) {
    const u1 = Math.max(random(), 1e-12);
    const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * random());
    const v = (1 + c * normal) ** 3;
    if (v <= 0) continue;
    if (Math.log(Math.max(random(), 1e-12)) < 0.5 * normal * normal + d - d * v + d * Math.log(v)) return d * v;
  }
  return d;
}

function betaDraw(alpha: number, beta: number, random: () => number): number {
  const a = gamma(alpha, random);
  const b = gamma(beta, random);
  return a + b > 0 ? a / (a + b) : 0.5;
}

/**
 * Choose a model for one piece of work.
 *
 * Each candidate's cost of reaching an accepted result is estimated as its
 * own price plus, with the probability its result is rejected, the cost of a
 * wasted review and a retry on the role's baseline model. The acceptance
 * probability is drawn from that model's posterior (Thompson sampling), so a
 * model with little history is still tried occasionally. With `learn` off,
 * or a single candidate, the baseline is returned unchanged.
 */
export function chooseRoute(input: {
  role: CodingRole;
  candidates: readonly RouteCandidate[];
  contextTokens: number;
  outputTokens?: number;
  prices: RoutePrices;
  stats?: RouteStats;
  reviewCost?: number;
  learn?: boolean;
  /** Stable for a given plan, so a preview and its send agree. */
  seed: string;
}): RouteDecision {
  const { role, candidates } = input;
  if (!candidates.length) throw new RoutingError(`No model is configured for the ${role} role.`);
  const cell = routeCell(input.contextTokens);
  const outputTokens = input.outputTokens ?? 1200;
  const reviewCost = input.reviewCost ?? defaultReviewCost;
  const baseline = candidates[0]!;
  const priceOf = (candidate: RouteCandidate) => {
    const price = input.prices(candidate);
    return price ? (input.contextTokens * price.input + outputTokens * price.output) / 1_000_000 : 0;
  };
  const retry = priceOf(baseline);
  const options: (RouteOption & { drawn: number })[] = candidates.map((candidate, position) => {
    const saved = input.stats?.(role, cell, routeKey(candidate));
    // The order of the list is the operator's prior: earlier models are expected to do better.
    const prior = Math.max(0.5, 0.75 - 0.08 * position);
    const alpha = (saved?.alpha ?? 1) + 2 * prior;
    const beta = (saved?.beta ?? 1) + 2 * (1 - prior);
    const acceptance = alpha / (alpha + beta);
    const cost = priceOf(candidate);
    const drawn = input.learn === false ? acceptance : betaDraw(alpha, beta, generator(`${input.seed}:${role}:${routeKey(candidate)}`));
    return {
      ...candidate, cost: Number(cost.toFixed(6)), acceptance: Number(acceptance.toFixed(4)), runs: saved?.runs ?? 0,
      expected: Number((cost + (1 - acceptance) * (reviewCost + retry)).toFixed(6)), drawn: cost + (1 - drawn) * (reviewCost + retry),
    };
  });
  const learned = input.learn !== false && candidates.length > 1;
  const ordered = learned ? [...options].sort((a, b) => a.drawn - b.drawn) : options;
  const chosen = ordered[0]!;
  const strip = ({ provider, model, thinkingLevel }: RouteCandidate): RouteCandidate => ({ provider, model, ...(thinkingLevel ? { thinkingLevel } : {}) });
  const same = routeKey(chosen) === routeKey(baseline);
  return {
    role, cell, choice: strip(chosen), baseline: strip(baseline), fallbacks: ordered.slice(1).map(strip),
    options: options.map(({ drawn: _drawn, ...option }) => option),
    reason: !learned ? "Fixed first model for this role."
      : same ? `The routing draw favored the first model for ${cell} work.`
        : `The routing draw favored a different model for ${cell} work.`,
  };
}

/** Provider preferences as OpenRouter's request body expects them. */
export function openRouterRouting(model: Model<Api>, preferences: OpenRouterPreferences | undefined): OpenRouterRouting | undefined {
  if (!preferences || model.provider !== "openrouter") return undefined;
  const routing: OpenRouterRouting = {};
  if (preferences.dataCollection) routing.data_collection = preferences.dataCollection;
  if (preferences.zdr !== undefined) routing.zdr = preferences.zdr;
  if (preferences.order?.length) routing.order = preferences.order;
  if (preferences.allowFallbacks !== undefined) routing.allow_fallbacks = preferences.allowFallbacks;
  if (preferences.sort) routing.sort = preferences.sort;
  if (!Object.keys(routing).length) return undefined;
  if (model.api !== "openai-completions" && model.api !== "anthropic-messages")
    throw new RoutingError(`OpenRouter preferences cannot be sent for ${model.id}, which Pi calls through the ${model.api} API.`);
  return routing;
}
