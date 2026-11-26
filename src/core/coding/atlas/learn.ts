// The self-improvement loop. Its only teacher is a person's review decision
// on a finished request, plus the files that decision shows were needed.
// Nothing here calls a model and nothing rewrites prompts. What changes is
// small, bounded and inspectable:
//
//   - an episode memory of which units mattered for which kind of task,
//   - aliases that attach a task's words to the code that answered it,
//   - five lane weights and nine slot utilities for the readout,
//   - an include-or-withhold record for every skill still being measured.
//
// Two rules keep it from fooling itself. An update to the lane weights is
// committed only if it does not rank past episodes worse (a held-out replay
// gate with a frozen best snapshot). And a skill or alias is trusted only
// after independent evidence: two accepted requests for an alias, a measured
// difference between requests that received a skill and requests that did not.

import { Database, type SQLQueryBindings } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureExtensionCapableSqlite } from "../../engine/custom-sqlite.ts";
import { defaultParams, laneBounds, lanes, parseParams, type LearningView, type ReadoutParams } from "./params.ts";
import type { RankedUnit } from "./readout.ts";
import { atlasDirectory, type AtlasLocation } from "./store.ts";
import { roles } from "./structure.ts";
import { cosine, dequantize, embeddingDim, quantize } from "./text.ts";

export type Outcome = "accepted" | "changes_requested";
export type SkillState = "trial" | "established" | "retired" | "disabled";

export interface SkillRecord {
  id: string;
  state: SkillState;
  shown: number;
  shownAccepted: number;
  withheld: number;
  withheldAccepted: number;
  /** Probability that delivering the skill raises acceptance, once both arms have data. */
  confidence?: number;
}

export interface UsedEvidence { path: string; lines?: [number, number][] }

export interface OutcomeInput {
  session: string;
  requestId: string;
  outcome: Outcome;
  queryVector: Float32Array;
  /** Distinctive task terms, most distinctive first. */
  queryTerms: string[];
  /** Candidates as the readout ranks them now, with their lane scores. */
  ranked: RankedUnit[];
  /** Line ranges that were sent with the request. */
  sent: { path: string; startLine: number; endLine: number }[];
  /** Files the answer cited or the approved patch changed, with the cited or changed lines when known. */
  used: UsedEvidence[];
  skills: { id: string; trial?: true }[];
  withheldSkills: string[];
}

export interface OutcomeReport {
  recorded: boolean;
  /** False when this request's outcome had already been learned from. */
  learned: boolean;
  params: number;
  laneUpdate: "committed" | "rejected" | "skipped";
  panel?: { episodes: number; before: number; after: number };
  aliases: number;
  skills: { id: string; state: SkillState }[];
  missedPaths: string[];
}

const maxEpisodes = 2000;
const maxEpisodeUnits = 96;
const panelSize = 200;
const experienceFloor = 0.45;
const learningRate = 0.05;
const maxStep = 0.1;
const listTemperature = 4;
const aliasAdmission = 2;
const maxAliasesPerUnit = 24;
const maxAliasTermsPerEpisode = 6;
const minArm = 4;
const decisionConfidence = 0.9;

const schema = `
  CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS episodes(
    id INTEGER PRIMARY KEY, session TEXT NOT NULL, request TEXT NOT NULL, at TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK(outcome IN ('accepted', 'changes_requested')), vector BLOB NOT NULL, params INTEGER NOT NULL,
    units TEXT NOT NULL, UNIQUE(session, request)
  );
  CREATE TABLE IF NOT EXISTS aliases(
    path TEXT NOT NULL, name TEXT NOT NULL, term TEXT NOT NULL, weight REAL NOT NULL, PRIMARY KEY(path, name, term)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS skills(
    id TEXT PRIMARY KEY, state TEXT NOT NULL, shown INTEGER NOT NULL DEFAULT 0, shown_ok INTEGER NOT NULL DEFAULT 0,
    held INTEGER NOT NULL DEFAULT 0, held_ok INTEGER NOT NULL DEFAULT 0, updated TEXT NOT NULL
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS routes(
    role TEXT NOT NULL, cell TEXT NOT NULL, model TEXT NOT NULL, alpha REAL NOT NULL, beta REAL NOT NULL, runs INTEGER NOT NULL,
    cost REAL NOT NULL DEFAULT 0, updated TEXT NOT NULL, PRIMARY KEY(role, cell, model)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS updates(seq INTEGER PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL);
`;

export const learningPath = (workspace: string, location: AtlasLocation = {}): string => join(atlasDirectory(workspace, location), "learning.sqlite");

interface EpisodeUnit { p: string; n: string; l: number[]; u: 0 | 1; s: 0 | 1 }
interface EpisodeRow { id: number; session: string; request: string; outcome: Outcome; vector: Uint8Array; units: string }

function parseUnits(text: string): EpisodeUnit[] {
  try {
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value)) return [];
    return value.filter((unit): unit is EpisodeUnit => Boolean(unit) && typeof unit === "object" && typeof unit.p === "string" && typeof unit.n === "string"
      && Array.isArray(unit.l) && unit.l.length === lanes.length && unit.l.every((score: unknown) => typeof score === "number"));
  } catch { return []; }
}

const fused = (params: ReadoutParams, scores: number[]): number =>
  lanes.reduce((total, lane, index) => total + params.lanes[lane] * (scores[index] ?? 0), 0);

/** nDCG@10 of the used units when an episode's candidates are ranked by fused evidence. */
function rankingQuality(params: ReadoutParams, units: EpisodeUnit[]): number | undefined {
  const used = units.filter((unit) => unit.u).length;
  if (!used || used === units.length) return undefined;
  const order = units.map((unit) => [fused(params, unit.l), unit.u] as const).sort((a, b) => b[0] - a[0]);
  let gain = 0;
  let ideal = 0;
  for (let rank = 0; rank < Math.min(10, order.length); rank++) {
    const discount = 1 / Math.log2(rank + 2);
    if (order[rank]![1]) gain += discount;
    if (rank < used) ideal += discount;
  }
  return ideal ? gain / ideal : undefined;
}

function panelQuality(params: ReadoutParams, panel: EpisodeUnit[][]): number {
  let total = 0;
  let count = 0;
  for (const units of panel) {
    const quality = rankingQuality(params, units);
    if (quality === undefined) continue;
    total += quality;
    count++;
  }
  return count ? total / count : 0;
}

/** Standard normal CDF, by the Abramowitz and Stegun polynomial. */
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const tail = 0.3989422804 * Math.exp(-z * z / 2) * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - tail : tail;
}

/** Probability that the delivered arm's acceptance rate exceeds the withheld arm's, under Beta(1,1) priors. */
function liftConfidence(record: Pick<SkillRecord, "shown" | "shownAccepted" | "withheld" | "withheldAccepted">): number {
  const moments = (successes: number, trials: number) => {
    const a = successes + 1;
    const b = trials - successes + 1;
    return { mean: a / (a + b), variance: (a * b) / ((a + b) ** 2 * (a + b + 1)) };
  };
  const shown = moments(record.shownAccepted, record.shown);
  const held = moments(record.withheldAccepted, record.withheld);
  return normalCdf((shown.mean - held.mean) / Math.sqrt(shown.variance + held.variance));
}

export class Learning implements LearningView {
  readonly #db: Database;
  params: ReadoutParams;

  private constructor(db: Database) {
    this.#db = db;
    this.params = this.#loadParams("params");
  }

  /** Open learned state for a workspace. Returns undefined when nothing has been learned and `create` is unset. */
  static open(workspace: string, location: AtlasLocation = {}, create = false): Learning | undefined {
    const path = learningPath(workspace, location);
    if (!create && !existsSync(path)) return undefined;
    if (create) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    ensureExtensionCapableSqlite();
    const db = new Database(path, { strict: true, readwrite: true, create });
    try {
      db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000");
      db.exec(schema);
      return new Learning(db);
    } catch (error) {
      db.close(true);
      throw error;
    }
  }

  close(): void { this.#db.close(true); }
  [Symbol.dispose](): void { this.close(); }

  #all<Row>(sql: string, ...params: SQLQueryBindings[]): Row[] {
    using statement = this.#db.prepare<Row, SQLQueryBindings[]>(sql);
    return statement.all(...params);
  }

  #run(sql: string, ...params: SQLQueryBindings[]): void {
    using statement = this.#db.prepare<unknown, SQLQueryBindings[]>(sql);
    statement.run(...params);
  }

  #loadParams(key: string): ReadoutParams {
    const saved = this.#all<{ value: string }>("SELECT value FROM state WHERE key = ?", key)[0]?.value;
    if (saved === undefined) return defaultParams();
    try { return parseParams(JSON.parse(saved)); } catch { return defaultParams(); }
  }

  #saveState(key: string, value: unknown): void {
    this.#run("INSERT INTO state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, JSON.stringify(value));
  }

  #audit(kind: string, detail: unknown): void {
    this.#run("INSERT INTO updates(at, kind, detail) VALUES (?, ?, ?)", new Date().toISOString(), kind, JSON.stringify(detail));
    this.#run("DELETE FROM updates WHERE seq <= (SELECT max(seq) FROM updates) - 2000");
  }

  /** Units used in accepted requests whose task resembles this one. */
  experience(query: Float32Array): { path: string; name: string; weight: number }[] {
    const best = new Map<string, { path: string; name: string; weight: number }>();
    for (const row of this.#all<EpisodeRow>("SELECT id, session, request, outcome, vector, units FROM episodes WHERE outcome = 'accepted' ORDER BY id DESC LIMIT ?", maxEpisodes)) {
      if (row.vector.byteLength !== embeddingDim) continue;
      const similarity = cosine(query, dequantize(new Int8Array(row.vector.buffer, row.vector.byteOffset, embeddingDim), 0));
      if (similarity < experienceFloor) continue;
      const weight = (similarity - experienceFloor) / (1 - experienceFloor);
      for (const unit of parseUnits(row.units)) {
        if (!unit.u) continue;
        const key = `${unit.p}\0${unit.n}`;
        const current = best.get(key);
        if (!current || weight > current.weight) best.set(key, { path: unit.p, name: unit.n, weight });
      }
    }
    return [...best.values()].sort((a, b) => b.weight - a.weight || (a.path < b.path ? -1 : 1)).slice(0, 24);
  }

  skillRecords(): Map<string, SkillRecord> {
    const records = new Map<string, SkillRecord>();
    for (const row of this.#all<{ id: string; state: SkillState; shown: number; shown_ok: number; held: number; held_ok: number }>("SELECT * FROM skills")) {
      const record: SkillRecord = { id: row.id, state: row.state, shown: row.shown, shownAccepted: row.shown_ok, withheld: row.held, withheldAccepted: row.held_ok };
      if (record.shown >= 1 && record.withheld >= 1) record.confidence = Number(liftConfidence(record).toFixed(3));
      records.set(row.id, record);
    }
    return records;
  }

  setSkillState(id: string, state: SkillState): void {
    this.#run(`INSERT INTO skills(id, state, updated) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, updated = excluded.updated`,
      id, state, new Date().toISOString());
    this.#audit("skill-state", { id, state, by: "operator" });
  }

  /** Aliases that have been confirmed often enough to be searchable, grouped by unit. */
  admittedAliases(): Map<string, { path: string; name: string; terms: string[] }> {
    const groups = new Map<string, { path: string; name: string; terms: string[] }>();
    for (const { path, name, term } of this.#all<{ path: string; name: string; term: string }>(
      "SELECT path, name, term FROM aliases WHERE weight >= ? ORDER BY path, name, weight DESC, term", aliasAdmission)) {
      const key = `${path}\0${name}`;
      let group = groups.get(key);
      if (!group) groups.set(key, group = { path, name, terms: [] });
      if (group.terms.length < maxAliasesPerUnit) group.terms.push(term);
    }
    return groups;
  }

  summary() {
    const count = (sql: string) => this.#all<{ count: number }>(sql)[0]?.count ?? 0;
    return {
      params: this.params,
      best: this.#loadParams("best"),
      episodes: count("SELECT count(*) AS count FROM episodes"),
      accepted: count("SELECT count(*) AS count FROM episodes WHERE outcome = 'accepted'"),
      aliases: count(`SELECT count(*) AS count FROM aliases WHERE weight >= ${aliasAdmission}`),
      pendingAliases: count(`SELECT count(*) AS count FROM aliases WHERE weight < ${aliasAdmission}`),
      skills: [...this.skillRecords().values()],
      recent: this.#all<{ at: string; kind: string; detail: string }>("SELECT at, kind, detail FROM updates ORDER BY seq DESC LIMIT 20")
        .map(({ at, kind, detail }) => ({ at, kind, detail: JSON.parse(detail) as unknown })),
    };
  }

  /** Remove what was recorded from one session. Aggregates already learned from it stay. */
  forgetSession(session: string): number {
    const before = this.#all<{ count: number }>("SELECT count(*) AS count FROM episodes WHERE session = ?", session)[0]?.count ?? 0;
    this.#run("DELETE FROM episodes WHERE session = ?", session);
    if (before) this.#audit("forget-session", { episodes: before });
    return before;
  }

  /** Return the readout parameters to the best snapshot the replay gate has seen. */
  rollback(): ReadoutParams {
    const best = this.#loadParams("best");
    this.params = { ...best, version: this.params.version + 1 };
    this.#saveState("params", this.params);
    this.#audit("rollback", { version: this.params.version });
    return this.params;
  }

  /** Learn from one reviewed request. Idempotent per request: a repeated or changed decision updates the record only. */
  recordOutcome(input: OutcomeInput): OutcomeReport {
    const sent = new Set(input.sent.map(({ path }) => path));
    const used = new Map(input.used.map((evidence) => [evidence.path, evidence.lines ?? []]));
    const overlaps = (unit: RankedUnit, ranges: readonly (readonly [number, number])[]) =>
      ranges.some(([start, end]) => start <= unit.endLine && end >= unit.startLine);
    // Credit goes to units, not files: a unit was sent when one of the sent ranges covers part
    // of it, and used when the answer cited lines inside it, or cited its file while it was sent.
    const units: EpisodeUnit[] = input.ranked.slice(0, maxEpisodeUnits).map((unit) => {
      const wasSent = overlaps(unit, input.sent.filter(({ path }) => path === unit.path).map(({ startLine, endLine }) => [startLine, endLine] as const));
      const cited = used.get(unit.path);
      const wasUsed = cited !== undefined && (cited.length ? overlaps(unit, cited) : wasSent);
      return { p: unit.path, n: unit.name, l: lanes.map((lane) => Number((unit.lanes[lane] ?? 0).toFixed(4))), u: wasUsed ? 1 : 0, s: wasSent ? 1 : 0 };
    });
    const credited = new Set(units.filter((unit) => unit.u).map((unit) => unit.p));
    // A file the answer needed that no ranked unit accounts for is a localization miss worth remembering.
    const missedPaths = [...used.keys()].filter((path) => !credited.has(path)).sort().slice(0, 16);
    for (const path of missedPaths) units.push({ p: path, n: "", l: lanes.map(() => 0), u: 1, s: 0 });

    const vector = new Int8Array(embeddingDim);
    quantize(input.queryVector, vector, 0);
    const prior = this.#all<{ id: number }>("SELECT id FROM episodes WHERE session = ? AND request = ?", input.session, input.requestId)[0];
    const report: OutcomeReport = { recorded: true, learned: !prior, params: this.params.version, laneUpdate: "skipped", aliases: 0, skills: [], missedPaths };
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#run(`INSERT INTO episodes(session, request, at, outcome, vector, params, units) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session, request) DO UPDATE SET at = excluded.at, outcome = excluded.outcome, vector = excluded.vector, units = excluded.units`,
        input.session, input.requestId, new Date().toISOString(), input.outcome, new Uint8Array(vector.buffer), this.params.version, JSON.stringify(units));
      this.#run("DELETE FROM episodes WHERE id <= (SELECT max(id) FROM episodes) - ?", maxEpisodes);
      if (!prior) {
        const accepted = input.outcome === "accepted";
        this.#learnSkills(input, accepted, report);
        if (accepted) {
          report.aliases = this.#learnAliases(input, units);
          this.#learnReadout(input, units, report);
        }
        this.#audit("outcome", {
          outcome: input.outcome, sent: sent.size, used: [...used.keys()].filter((path) => sent.has(path)).length, missed: missedPaths.length,
          laneUpdate: report.laneUpdate, ...(report.panel ? { panel: report.panel } : {}), aliases: report.aliases,
        });
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      if (this.#db.inTransaction) this.#db.exec("ROLLBACK");
      throw error;
    }
    report.params = this.params.version;
    return report;
  }

  #learnAliases(input: OutcomeInput, units: EpisodeUnit[]): number {
    const terms = input.queryTerms.filter((term) => /^[\p{L}\p{N}_$]{3,48}$/u.test(term)).slice(0, maxAliasTermsPerEpisode);
    if (!terms.length) return 0;
    let admitted = 0;
    for (const unit of units) {
      // Only units the answer demonstrably needed. One request is not enough: see the admission threshold.
      if (!unit.u || !unit.n) continue;
      for (const term of terms) {
        this.#run(`INSERT INTO aliases(path, name, term, weight) VALUES (?, ?, ?, 1)
          ON CONFLICT(path, name, term) DO UPDATE SET weight = min(weight + 1, 64)`, unit.p, unit.n, term);
        const weight = this.#all<{ weight: number }>("SELECT weight FROM aliases WHERE path = ? AND name = ? AND term = ?", unit.p, unit.n, term)[0]?.weight ?? 0;
        if (weight === aliasAdmission) admitted++;
      }
    }
    return admitted;
  }

  #learnReadout(input: OutcomeInput, units: EpisodeUnit[], report: OutcomeReport): void {
    const current = this.params;
    const next: ReadoutParams = structuredClone(current);
    // Slot utilities are plain counts with a prior, decayed so old habits fade.
    for (const slot of next.slotUtility) {
      slot.alpha = 2 + (slot.alpha - 2) * 0.995;
      slot.beta = 2 + (slot.beta - 2) * 0.995;
    }
    for (const [position, unit] of input.ranked.slice(0, maxEpisodeUnits).entries()) {
      const credit = units[position]!;
      if (!credit.s) continue;
      const role = roles.indexOf(unit.role);
      const index = unit.slot.startsWith("in ") ? roles.length : role >= 0 ? role : 0;
      const slot = next.slotUtility[index]!;
      if (credit.u) slot.alpha += 1;
      else slot.beta += 1;
    }

    // Lane weights follow the gradient of a listwise objective: raise the
    // likelihood of the used units under a softmax over this request's
    // candidates. Each lane's step is scaled by that lane's spread within the
    // group, the same normalization group-relative policy optimization uses.
    // Units the readout gave no evidence at all say nothing about how to weigh the lanes.
    const scored = units.filter((unit) => unit.n !== "" && unit.l.some((score) => score > 0));
    const usedUnits = scored.filter((unit) => unit.u);
    let stepped = false;
    if (usedUnits.length && usedUnits.length < scored.length) {
      const logits = scored.map((unit) => listTemperature * fused(current, unit.l));
      const peak = Math.max(...logits);
      const weights = logits.map((logit) => Math.exp(logit - peak));
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      for (const [index, lane] of lanes.entries()) {
        let expected = 0;
        let mean = 0;
        let squares = 0;
        for (const [position, unit] of scored.entries()) {
          expected += (weights[position]! / total) * unit.l[index]!;
          mean += unit.l[index]!;
          squares += unit.l[index]! ** 2;
        }
        mean /= scored.length;
        const spread = Math.sqrt(Math.max(0, squares / scored.length - mean * mean));
        if (spread < 1e-6) continue;
        const observed = usedUnits.reduce((sum, unit) => sum + unit.l[index]!, 0) / usedUnits.length;
        const step = Math.max(-maxStep, Math.min(maxStep, learningRate * (observed - expected) / spread));
        const [low, high] = laneBounds[lane];
        next.lanes[lane] = Math.min(high, Math.max(low, current.lanes[lane] + step));
        stepped ||= next.lanes[lane] !== current.lanes[lane];
      }
    }
    if (stepped) {
      // The replay gate: past accepted episodes, never this one.
      const panel = this.#all<{ units: string }>(
        "SELECT units FROM episodes WHERE outcome = 'accepted' AND NOT (session = ? AND request = ?) ORDER BY id DESC LIMIT ?", input.session, input.requestId, panelSize)
        .map(({ units: saved }) => parseUnits(saved).filter((unit) => unit.n !== "" && unit.l.some((score) => score > 0)));
      const before = panelQuality(current, panel);
      const after = panelQuality(next, panel);
      report.panel = { episodes: panel.length, before: Number(before.toFixed(4)), after: Number(after.toFixed(4)) };
      if (after + 1e-9 < before) {
        next.lanes = { ...current.lanes };
        report.laneUpdate = "rejected";
      } else {
        report.laneUpdate = "committed";
        const best = this.#loadParams("best");
        const bestScore = this.#all<{ value: string }>("SELECT value FROM state WHERE key = 'bestScore'")[0]?.value;
        if (panel.length >= 5 && (bestScore === undefined || after > Number(bestScore) || best.version === 0)) {
          this.#saveState("best", { ...next, version: current.version + 1 });
          this.#saveState("bestScore", after);
        }
      }
    }
    next.version = current.version + 1;
    this.params = next;
    this.#saveState("params", next);
  }

  #learnSkills(input: OutcomeInput, accepted: boolean, report: OutcomeReport): void {
    const now = new Date().toISOString();
    const bump = (id: string, shown: boolean) => {
      this.#run(`INSERT INTO skills(id, state, shown, shown_ok, held, held_ok, updated) VALUES (?, 'trial', ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET shown = shown + excluded.shown, shown_ok = shown_ok + excluded.shown_ok,
          held = held + excluded.held, held_ok = held_ok + excluded.held_ok, updated = excluded.updated`,
        id, Number(shown), Number(shown && accepted), Number(!shown), Number(!shown && accepted), now);
    };
    const trials = new Set<string>();
    for (const { id, trial } of input.skills) { bump(id, true); if (trial) trials.add(id); }
    for (const id of input.withheldSkills) { bump(id, false); trials.add(id); }
    const records = this.skillRecords();
    for (const id of trials) {
      const record = records.get(id);
      if (!record || record.state !== "trial" || record.shown < minArm || record.withheld < minArm) continue;
      const confidence = liftConfidence(record);
      const state: SkillState | undefined = confidence >= decisionConfidence ? "established" : confidence <= 1 - decisionConfidence ? "retired" : undefined;
      if (!state) continue;
      this.#run("UPDATE skills SET state = ?, updated = ? WHERE id = ?", state, now, id);
      this.#audit("skill-state", { id, state, confidence: Number(confidence.toFixed(3)), shown: record.shown, withheld: record.withheld });
      report.skills.push({ id, state });
    }
  }

  /** Route statistics live in the same file so one reset clears everything learned for a workspace. */
  routeRows(): { role: string; cell: string; model: string; alpha: number; beta: number; runs: number; cost: number }[] {
    return this.#all("SELECT role, cell, model, alpha, beta, runs, cost FROM routes ORDER BY role, cell, model");
  }

  recordRoute(role: string, cell: string, model: string, success: boolean, cost: number, discount = 0.98): void {
    // Discounted counts: recent outcomes weigh more, since a hosted model changes under the same name.
    this.#run(`INSERT INTO routes(role, cell, model, alpha, beta, runs, cost, updated) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(role, cell, model) DO UPDATE SET alpha = 1 + (alpha - 1) * ?8 + (excluded.alpha - 1), beta = 1 + (beta - 1) * ?8 + (excluded.beta - 1),
        runs = runs + 1, cost = cost + excluded.cost, updated = excluded.updated`,
      role, cell, model, 1 + Number(success), 1 + Number(!success), cost, new Date().toISOString(), discount);
  }
}

/** Delete everything learned for a workspace. The knowledge bundle and the atlas are kept. */
export function resetLearning(workspace: string, location: AtlasLocation = {}): boolean {
  const path = learningPath(workspace, location);
  let removed = false;
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) { rmSync(path + suffix, { force: true }); removed = true; }
  }
  return removed;
}
