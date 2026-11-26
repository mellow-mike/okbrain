// What the harness adds to a selection beside source: short facts about the
// selected code. They are data, not procedure. The harness decides when one
// applies by checking its anchors against the selection, so nothing depends
// on the model remembering to ask.
//
// Built-in facts come straight from the atlas and are always current: which
// tests cover the selected files, which commands check the packages involved,
// and what usually changes alongside. Skills and lessons from the knowledge
// bundle are delivered while their status allows it. One marked `draft` is
// still on trial: an eligible request receives it or not by a fixed draw, and
// the review outcomes of both groups decide whether it stays (see learn.ts).

import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fmStatus, fmString, parse } from "../../okf/document.ts";
import type { SkillRecord, SkillState } from "./learn.ts";
import type { PackSkill, SkillRequest, SkillSelector } from "./readout.ts";
import { trackedAmong } from "./scan.ts";
import { Atlas, knowledgeDirectory, type AtlasLocation } from "./store.ts";
import { cosine, embedBag, terms, unitDraw } from "./text.ts";

export const builtinSkills = ["builtin/test-map", "builtin/checks", "builtin/change-coupling"] as const;
const maxSkillBytes = 360;
const maxBundleSkills = 256;
const semanticFloor = 0.4;
const maxTrialsPerRequest = 2;

export interface BundleSkill {
  id: string;
  kind: "skill" | "lesson";
  title: string;
  text: string;
  anchors: string[];
  state: SkillState;
}

function clip(text: string, bytes: number): string {
  const compact = text.replace(/[\x00-\x1f\x7f]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (Buffer.byteLength(compact) <= bytes) return compact;
  let end = Math.min(compact.length, bytes);
  while (end > 0 && Buffer.byteLength(compact.slice(0, end)) > bytes - 3) end--;
  return `${compact.slice(0, end).trimEnd()}…`;
}

/** Skills and lessons in the knowledge bundle, with the state measurement or their own status gives them. */
export function readBundleSkills(directory: string, records: ReadonlyMap<string, SkillRecord> = new Map()): BundleSkill[] {
  const skills: BundleSkill[] = [];
  for (const kind of ["lesson", "skill"] as const) {
    const folder = join(knowledgeDirectory(directory), `${kind}s`);
    let names: string[];
    try { names = readdirSync(folder).filter((name) => name.endsWith(".md") && name !== "index.md" && name !== "log.md").sort(); }
    catch { continue; }
    for (const name of names) {
      if (skills.length >= maxBundleSkills) break;
      const id = `${kind}s/${name.slice(0, -3)}`;
      try {
        const document = parse(readFileSync(join(folder, name), "utf8"));
        const title = fmString(document.frontmatter.title);
        if (!title) continue;
        const anchors = Array.isArray(document.frontmatter.anchors)
          ? document.frontmatter.anchors.filter((anchor): anchor is string => typeof anchor === "string" && anchor.length > 0 && anchor.length <= 512).slice(0, 8) : [];
        const body = document.body.split(/\r?\n/u).filter((line) => line.trim() && !/^#/u.test(line)).map((line) => line.replace(/^\s*[-*]\s+/u, "").trim()).join(" ");
        const status = fmStatus(document.frontmatter);
        const recorded = records.get(id)?.state;
        // A person's status in the file wins over the measured one, except while the file still says draft.
        const state: SkillState = recorded === "disabled" ? "disabled" : status === "deprecated" ? "retired" : status === "stable" ? "established" : recorded ?? "trial";
        skills.push({ id, kind, title, text: clip(`${title}. ${body}`, maxSkillBytes), anchors, state });
      } catch { /* An unreadable note is skipped, not fatal. */ }
    }
  }
  return skills;
}

function anchored(anchors: readonly string[], request: SkillRequest): boolean {
  return anchors.some((anchor) => anchor === "." || request.packages.includes(anchor)
    || request.paths.some((path) => path === anchor || path.startsWith(`${anchor}/`)));
}

/** Build the selector the readout calls once it knows which files and packages a request touches. */
export function createSkillSelector(workspace: string, records: ReadonlyMap<string, SkillRecord>, location: AtlasLocation = {}): SkillSelector {
  return async (request: SkillRequest) => {
    const delivered: PackSkill[] = [];
    const withheld: string[] = [];
    let remaining = request.budgetBytes;
    const offer = (skill: PackSkill): boolean => {
      const bytes = Buffer.byteLength(JSON.stringify(skill.text)) + 1;
      if (bytes > remaining) return false;
      delivered.push(skill);
      remaining -= bytes;
      return true;
    };
    const enabled = (id: string) => records.get(id)?.state !== "disabled";
    const sources = request.paths.slice(0, 24);
    let atlas: Atlas;
    try { atlas = Atlas.open(workspace, location); } catch { return { skills: [], withheld: [] }; }
    try {
      // The built-in facts name files linked to the selection. Git is asked which of those are
      // still tracked, so a fact never names a file that has left the index since the import.
      let links = enabled("builtin/test-map") && sources.length ? atlas.all<{ source: string; test: string }>(
        `SELECT s.path AS source, t.path AS test FROM file_edges e JOIN files t ON t.id = e.src JOIN files s ON s.id = e.dst
         WHERE e.kind = 'test' AND s.path IN (${sources.map(() => "?").join(",")}) ORDER BY s.path, t.path LIMIT 24`, ...sources) : [];
      let coupled = enabled("builtin/change-coupling") && sources.length ? atlas.all<{ a: string; b: string; weight: number }>(
        `SELECT fa.path AS a, fb.path AS b, e.weight FROM file_edges e JOIN files fa ON fa.id = e.src JOIN files fb ON fb.id = e.dst
         WHERE e.kind = 'cochange' AND (fa.path IN (${sources.map(() => "?").join(",")}) OR fb.path IN (${sources.map(() => "?").join(",")}))
         ORDER BY e.weight DESC, fa.path, fb.path LIMIT 24`, ...sources, ...sources) : [];
      const selectedPaths = new Set(sources);
      const named = [...new Set([...links.map(({ test }) => test), ...coupled.flatMap(({ a, b }) => [a, b])])].filter((path) => !selectedPaths.has(path));
      // The selected files were confirmed by the readout. Without an answer from Git, no other file is named.
      const stillTracked = named.length ? await trackedAmong(workspace, named).catch(() => new Set<string>()) : new Set<string>();
      const current = (path: string) => selectedPaths.has(path) || stillTracked.has(path);
      links = links.filter(({ test }) => current(test));
      coupled = coupled.filter(({ a, b }) => current(a) && current(b));

      const bundle = readBundleSkills(atlas.directory, records);
      const queryBag = terms(request.query, 256);
      const queryVector = embedBag(queryBag);
      const applies = (skill: BundleSkill) => anchored(skill.anchors, request)
        || (skill.kind === "lesson" && !skill.anchors.length && cosine(queryVector, embedBag(terms(skill.text))) >= semanticFloor);

      for (const skill of bundle) if (skill.kind === "lesson" && skill.state === "established" && applies(skill)) offer({ id: skill.id, title: skill.title, text: skill.text });
      // Skills on trial are drawn before the built-in facts spend the budget, so the two
      // groups being compared differ by the draw alone and never by what happened to fit.
      let trials = 0;
      for (const skill of bundle) {
        if (skill.state !== "trial" || trials >= maxTrialsPerRequest || !applies(skill)) continue;
        if (Buffer.byteLength(JSON.stringify(skill.text)) + 1 > remaining) continue;
        trials++;
        // A fixed, reproducible coin, so a preview and its send agree.
        if (unitDraw(`${request.seed}:${skill.id}`) < 0.5) offer({ id: skill.id, title: skill.title, text: skill.text, trial: true });
        else withheld.push(skill.id);
      }

      if (enabled("builtin/test-map") && links.length) {
        const bySource = new Map<string, string[]>();
        for (const { source, test } of links) {
          const list = bySource.get(source);
          if (list) { if (list.length < 2) list.push(test); }
          else bySource.set(source, [test]);
        }
        if (bySource.size) offer({
          id: "builtin/test-map", title: "Tests for the selected files",
          text: clip(`Tests that cover the selected files: ${[...bySource].slice(0, 6).map(([source, tests]) => `${source} is tested by ${tests.join(" and ")}`).join("; ")}.`, maxSkillBytes),
        });
      }
      if (enabled("builtin/checks") && request.packages.length) {
        const parts: string[] = [];
        for (const root of request.packages.slice(0, 3)) {
          const tools = atlas.all<{ kind: string; argv: string; source_path: string; source_line: number }>(
            `SELECT t.kind, t.argv, t.source_path, t.source_line FROM tools t JOIN packages p ON p.id = t.package
             WHERE p.root = ? AND t.kind IN ('test', 'typecheck', 'lint') ORDER BY CASE t.kind WHEN 'test' THEN 0 WHEN 'typecheck' THEN 1 ELSE 2 END, length(t.argv) LIMIT 3`, root);
          const commands = tools.flatMap(({ argv, source_path, source_line }) => {
            try { return [`\`${(JSON.parse(argv) as string[]).join(" ")}\` (${source_path}:${source_line})`]; } catch { return []; }
          });
          if (commands.length) parts.push(`${root === "." ? "repository root" : root}: ${commands.join(", ")}`);
        }
        if (parts.length) offer({ id: "builtin/checks", title: "Checks the project runs", text: clip(`Commands this project uses to check a change. ${parts.join(". ")}.`, maxSkillBytes) });
      }
      if (enabled("builtin/change-coupling") && coupled.length) {
        const selected = selectedPaths;
        const pairs = coupled.filter(({ a, b }) => selected.has(a) !== selected.has(b)).slice(0, 4);
        if (pairs.length) offer({
          id: "builtin/change-coupling", title: "Files that change together",
          text: clip(`In this repository's history these usually change together: ${pairs.map(({ a, b }) => selected.has(a) ? `${a} with ${b}` : `${b} with ${a}`).join("; ")}.`, maxSkillBytes),
        });
      }
      for (const skill of bundle) {
        if (skill.kind === "lesson" || skill.state !== "established" || !applies(skill)) continue;
        offer({ id: skill.id, title: skill.title, text: skill.text });
      }
    } finally {
      atlas.close();
    }
    return { skills: delivered, withheld };
  };
}

/** Skills as an operator sees them: built-ins, bundle skills, and what has been measured. */
export function listSkills(workspace: string, records: ReadonlyMap<string, SkillRecord>, location: AtlasLocation = {}) {
  const atlas = Atlas.open(workspace, location);
  try {
    const bundle = readBundleSkills(atlas.directory, records);
    const rows = [
      ...builtinSkills.map((id) => ({ id, kind: "built-in", title: id.slice(posix.dirname(id).length + 1), anchors: [] as string[], state: records.get(id)?.state === "disabled" ? "disabled" as const : "established" as const })),
      ...bundle.map(({ id, kind, title, anchors, state }) => ({ id, kind, title, anchors, state })),
    ];
    return rows.map((row) => {
      const record = records.get(row.id);
      return { ...row, shown: record?.shown ?? 0, shownAccepted: record?.shownAccepted ?? 0, withheld: record?.withheld ?? 0,
        withheldAccepted: record?.withheldAccepted ?? 0, ...(record?.confidence !== undefined ? { confidence: record.confidence } : {}) };
    });
  } finally {
    atlas.close();
  }
}
