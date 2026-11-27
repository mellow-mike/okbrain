// The atlas as the rest of the coding harness uses it: select context for a
// request, learn from a reviewed one, and record what a person wants future
// requests to know.

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { ensureExtensionCapableSqlite } from "../../engine/custom-sqlite.ts";
import { writeConcept } from "../../okf/write.ts";
import { isActor } from "../../okf/document.ts";
import { profilePath } from "../project-profile.ts";
import type { RepositoryContextManifest } from "../repository-context.ts";
import { applyAliases } from "./aliases.ts";
import { knowledgeSlug, lessonType } from "./knowledge.ts";
import { Learning, resetLearning, type Outcome, type OutcomeReport, type UsedEvidence } from "./learn.ts";
import { readAtlas, type AtlasContext, type RankedUnit, type ReadoutOptions } from "./readout.ts";
import { createSkillSelector, listSkills } from "./skills.ts";
import { acquireAtlasLease, Atlas, AtlasBusyError, AtlasError, AtlasMissingError, atlasDirectory, knowledgeDirectory, type AtlasLocation } from "./store.ts";

export { AtlasBusyError, AtlasError, AtlasMissingError } from "./store.ts";
export type { AtlasContext, RankedUnit, ReadoutOptions } from "./readout.ts";
export type { OutcomeReport, UsedEvidence } from "./learn.ts";

const maxLessonBytes = 600;

/** Select a request's context from the imported atlas, using whatever has been learned so far. */
export async function selectAtlasContext(options: ReadoutOptions, location: AtlasLocation = {}): Promise<AtlasContext> {
  const workspace = await realpath(options.workspace).catch(() => options.workspace);
  const learning = Atlas.exists(workspace, location) ? Learning.open(workspace, location) : undefined;
  try {
    const selector = createSkillSelector(workspace, learning?.skillRecords() ?? new Map(), location);
    const { probe: _probe, ...context } = await readAtlas({ ...options, workspace }, { learning, skills: selector }, location);
    return context;
  } finally {
    learning?.close();
  }
}

/**
 * Files from `candidates` that an answer names, with the line ranges it cites
 * (`src/a.ts:12-18`), plus the files and old-side hunks of any unified diff in it.
 */
export function usedEvidence(answer: string, candidates: Iterable<string>): UsedEvidence[] {
  const used = new Map<string, [number, number][]>();
  const note = (path: string, range?: [number, number]) => {
    const ranges = used.get(path) ?? [];
    if (range && ranges.length < 32) ranges.push(range);
    used.set(path, ranges);
  };
  const inPath = /[\w./-]/u;
  for (const path of candidates) {
    for (let index = answer.indexOf(path); index >= 0; index = answer.indexOf(path, index + 1)) {
      const before = index > 0 ? answer[index - 1]! : " ";
      const rest = answer.slice(index + path.length, index + path.length + 24);
      const after = rest[0] ?? " ";
      // `src/a.ts:12` and a sentence ending in `src/a.ts.` name the file. `src/a.ts.bak` and `x/src/a.ts` do not.
      if (inPath.test(before) || /[\w/-]/u.test(after) || (after === "." && /\w/u.test(rest[1] ?? " "))) continue;
      const cited = /^:(\d{1,7})(?:[-–](\d{1,7}))?/u.exec(rest);
      const start = cited ? Number(cited[1]) : undefined;
      note(path, start === undefined ? undefined : [start, Math.max(start, cited![2] ? Number(cited![2]) : start)]);
    }
  }
  let file: string | undefined;
  for (const line of answer.split("\n")) {
    const header = /^(?:\+\+\+|---) [ab]\/(\S+)$/u.exec(line);
    if (header) { file = header[1]!; note(file); continue; }
    const hunk = file === undefined ? null : /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/u.exec(line);
    if (hunk) note(file!, [Number(hunk[1]), Number(hunk[1]) + Math.max(0, Number(hunk[2] ?? 1) - 1)]);
  }
  return [...used.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([path, lines]) => ({ path, ...(lines.length ? { lines } : {}) }));
}

export interface OutcomeRequest {
  workspace: string;
  session: string;
  requestId: string;
  outcome: Outcome;
  /** The manifest saved with the request. Only atlas-backed selections are learned from. */
  manifest: RepositoryContextManifest;
  used: UsedEvidence[];
}

/**
 * Learn from one reviewed request. The saved manifest holds the task text the
 * selection was made from, so the candidates are scored again against the
 * current atlas. No request text or source is copied into learned state.
 */
export async function recordAtlasOutcome(input: OutcomeRequest, location: AtlasLocation = {}): Promise<OutcomeReport | undefined> {
  const { manifest } = input;
  if (!manifest.atlas) return undefined;
  const workspace = await realpath(input.workspace).catch(() => input.workspace);
  if (!Atlas.exists(workspace, location)) return undefined;
  const learning = Learning.open(workspace, location, true)!;
  try {
    let readout;
    try {
      readout = await readAtlas({
        workspace, query: manifest.query, tokenBudget: manifest.tokenBudget,
        ...(manifest.projects.length && !manifest.projects.includes(".") ? { projects: manifest.projects } : {}),
      }, { learning }, location);
    } catch (error) {
      if (error instanceof AtlasError) return undefined;
      throw error;
    }
    const sentRanges = manifest.files.map(({ path, startLine, endLine }) => ({ path, startLine, endLine }));
    const report = learning.recordOutcome({
      session: input.session, requestId: input.requestId, outcome: input.outcome, queryVector: readout.probe.vector, queryTerms: readout.probe.terms,
      ranked: [...readout.ranked, ...unrankedUnits(workspace, readout.ranked, sentRanges, input.used, location)], sent: manifest.files.map(({ path, startLine, endLine }) => ({ path, startLine, endLine })), used: input.used,
      skills: manifest.atlas.skills.map(({ id, trial }) => ({ id, ...(trial ? { trial } : {}) })), withheldSkills: manifest.atlas.withheld ?? [],
    });
    if (report.aliases > 0) writeAliases(workspace, learning, location);
    return report;
  } finally {
    learning.close();
  }
}

/**
 * Units the answer needed that the readout did not rank: the ones under the
 * cited lines, or under what was sent of a cited file. Naming them lets a
 * localization miss teach the index which code the task's words belong to.
 */
function unrankedUnits(
  workspace: string, ranked: readonly RankedUnit[], sent: readonly { path: string; startLine: number; endLine: number }[],
  used: readonly UsedEvidence[], location: AtlasLocation,
): RankedUnit[] {
  const known = new Set(ranked.map((unit) => `${unit.path}\0${unit.name}`));
  const found: RankedUnit[] = [];
  let atlas: Atlas;
  try { atlas = Atlas.open(workspace, location); } catch { return found; }
  try {
    for (const { path, lines } of used.slice(0, 32)) {
      const ranges = lines?.length ? lines : sent.filter((range) => range.path === path).map(({ startLine, endLine }) => [startLine, endLine] as [number, number]);
      for (const [start, end] of ranges.slice(0, 8)) {
        for (const unit of atlas.all<{ name: string; start_line: number; end_line: number; role: RankedUnit["role"] }>(
          `SELECT u.name, u.start_line, u.end_line, u.role FROM units u JOIN files f ON f.id = u.file
           WHERE f.path = ? AND u.start_line <= ? AND u.end_line >= ? ORDER BY u.ord LIMIT 4`, path, end, start)) {
          const key = `${path}\0${unit.name}`;
          if (known.has(key) || found.length >= 32) continue;
          known.add(key);
          found.push({
            path, name: unit.name, startLine: unit.start_line, endLine: unit.end_line, role: unit.role, package: ".", region: "", evidence: 0,
            lanes: { lexical: 0, dense: 0, exact: 0, graph: 0, experience: 0 }, slot: unit.role, selected: false,
          });
        }
      }
    }
  } finally {
    atlas.close();
  }
  return found;
}

function writeAliases(workspace: string, learning: Learning, location: AtlasLocation): void {
  const path = join(atlasDirectory(workspace, location), "atlas.sqlite");
  if (!existsSync(path)) return;
  ensureExtensionCapableSqlite();
  const db = new Database(path, { strict: true, readwrite: true, create: false });
  try {
    db.exec("PRAGMA busy_timeout = 2000");
    applyAliases(db, learning.admittedAliases());
  } catch (error) {
    // An import in progress owns the index and lays the aliases over it when it finishes.
    if ((error as { code?: string }).code !== "SQLITE_BUSY") throw error;
  } finally {
    db.close(true);
  }
}

export interface LessonInput {
  workspace: string;
  text: string;
  /** Workspace-relative directories or files the lesson is about. Without any, it is matched by meaning. */
  anchors?: string[];
  /** The person recording the lesson, in OKF actor form. */
  actor: string;
}

/**
 * Record something a person wants future requests in this repository to know.
 * It starts as a draft and is measured like any other skill before it is
 * delivered to every eligible request.
 */
export async function addLesson(input: LessonInput, location: AtlasLocation = {}): Promise<{ id: string; path: string; created: boolean }> {
  const workspace = await realpath(input.workspace).catch(() => input.workspace);
  if (!Atlas.exists(workspace, location)) throw new AtlasMissingError("Import this repository before recording lessons for it.");
  const text = input.text.replace(/\r\n?/gu, "\n").trim();
  if (!text || Buffer.byteLength(text) > maxLessonBytes || /[\x00-\x08\x0b-\x1f\x7f-\x9f]/u.test(text) || !text.isWellFormed())
    throw new AtlasError(`Write the lesson as 1–${maxLessonBytes} UTF-8 bytes of plain text.`);
  if (!isActor(input.actor)) throw new AtlasError("The lesson's author must follow the actor convention, such as human:<id>.");
  if ((input.anchors?.length ?? 0) > 8) throw new AtlasError("A lesson can have at most eight anchors.");
  const uniqueAnchors = new Set<string>();
  for (const anchor of input.anchors ?? []) {
    const path = typeof anchor === "string" && Buffer.byteLength(anchor) <= 512 ? profilePath(anchor) : undefined;
    if (!path) throw new AtlasError(`Lesson anchor ${JSON.stringify(anchor)} must be a workspace-relative path.`);
    uniqueAnchors.add(path);
  }
  const anchors = [...uniqueAnchors].sort();
  const sentence = text.split(/(?<=[.!?])\s|\n/u)[0]!.trim();
  const characters = [...sentence];
  const title = characters.length > 90 ? `${characters.slice(0, 89).join("").trimEnd()}…` : sentence;
  const digest = createHash("sha256").update(JSON.stringify([text, anchors])).digest("hex").slice(0, 8);
  const id = `lessons/${knowledgeSlug(title.split(/\s+/u).slice(0, 6).join(" "), "lesson")}-${digest}`;
  const directory = knowledgeDirectory(atlasDirectory(workspace, location));
  const result = await writeConcept(directory, {
    id, type: lessonType, title, description: `A lesson recorded for future coding requests${anchors.length ? ` touching ${anchors.join(", ")}` : ""}.`,
    tags: ["code", "lesson"], body: text, status: "draft", actor: input.actor, extra: { anchors },
  }, { createOnly: true });
  return { id, path: result.path, created: result.created };
}

/** What has been imported and learned for a workspace, for display. */
export async function atlasStatus(workspaceInput: string, location: AtlasLocation = {}) {
  const workspace = await realpath(workspaceInput).catch(() => workspaceInput);
  if (!Atlas.exists(workspace, location)) return { workspace, imported: false as const };
  let atlas: Atlas;
  try { atlas = Atlas.open(workspace, location); }
  catch (error) {
    // A first import that has not finished yet has nothing to show.
    if (error instanceof AtlasMissingError) return { workspace, imported: false as const };
    throw error;
  }
  let meta;
  let packages;
  let directory;
  try {
    meta = atlas.meta();
    directory = atlas.directory;
    packages = atlas.all<{ root: string; name: string; ecosystem: string; files: number; units: number }>(
      "SELECT root, name, ecosystem, files, units FROM packages ORDER BY files DESC, root LIMIT 20");
  } finally {
    atlas.close();
  }
  const learning = Learning.open(workspace, location);
  try {
    return {
      workspace, imported: true as const, directory, knowledge: knowledgeDirectory(directory), meta, packages,
      learning: learning?.summary(), skills: await listSkills(workspace, learning?.skillRecords() ?? new Map(), location),
    };
  } finally {
    learning?.close();
  }
}

/** Remove one session's learning using its canonical workspace key. */
export function forgetLearningSession(workspace: string, location: AtlasLocation, session: string): number {
  const learning = Learning.open(workspace, location);
  if (!learning) return 0;
  try { return learning.forgetSession(session); } finally { learning.close(); }
}

/** Forget one session or reset a workspace's learning, including its aliases. */
export async function forgetLearning(workspaceInput: string, location: AtlasLocation = {}, session?: string): Promise<{ episodes?: number; reset?: boolean }> {
  const workspace = await realpath(workspaceInput).catch(() => workspaceInput);
  if (session !== undefined) return { episodes: forgetLearningSession(workspace, location, session) };
  const directory = atlasDirectory(workspace, location);
  if (!existsSync(directory)) return { reset: false };
  // The importer can stage a copy of the old aliases for publication. Hold its lease until both stores are clear.
  const lease = acquireAtlasLease(workspace, location);
  try {
    const path = join(directory, "atlas.sqlite");
    if (existsSync(path)) {
      const db = new Database(path, { strict: true, readwrite: true, create: false });
      try {
        db.exec("PRAGMA busy_timeout = 0");
        applyAliases(db, new Map(), true);
      } catch (error) {
        if ((error as { code?: string }).code === "SQLITE_BUSY") throw new AtlasBusyError(error);
        throw error;
      } finally { db.close(true); }
    }
    return { reset: resetLearning(workspace, location) };
  } finally { lease.close(true); }
}
