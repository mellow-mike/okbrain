import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addLesson, atlasStatus, forgetLearning, recordAtlasOutcome, selectAtlasContext, usedEvidence } from "../src/core/coding/atlas/context.ts";
import { importRepository } from "../src/core/coding/atlas/import.ts";
import { Learning, learningPath, type OutcomeInput } from "../src/core/coding/atlas/learn.ts";
import { defaultParams, parseParams } from "../src/core/coding/atlas/params.ts";
import type { RankedUnit } from "../src/core/coding/atlas/readout.ts";
import { Atlas } from "../src/core/coding/atlas/store.ts";
import { embedBag, terms } from "../src/core/coding/atlas/text.ts";
import { parse } from "../src/core/okf/document.ts";
import { buildMonorepo, evidenceRecall, type Fixture, type FixtureTask } from "./fixtures/monorepo.ts";

setDefaultTimeout(60_000);

let root: string;
let fixture: Fixture;
let workspace: string;
let paraphrased: FixtureTask;

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "okb-learn-")));
  fixture = await buildMonorepo(join(root, "repo"), 240);
  workspace = fixture.workspace;
  paraphrased = fixture.tasks.find(({ kind }) => kind === "paraphrased")!;
  await importRepository({ workspace });
});

afterAll(async () => { await rm(root, { force: true, recursive: true }); });

const unit = (path: string, name: string, lanes: Partial<RankedUnit["lanes"]>, startLine = 1): RankedUnit => ({
  path, name, startLine, endLine: startLine + 9, role: "impl", package: ".", region: "src", evidence: 0, slot: "impl", selected: false,
  lanes: { lexical: 0, dense: 0, exact: 0, graph: 0, experience: 0, ...lanes },
});
const outcome = (requestId: string, ranked: RankedUnit[], usedPath: string, extra: Partial<OutcomeInput> = {}): OutcomeInput => ({
  session: "s", requestId, outcome: "accepted", queryVector: embedBag(terms(`task ${requestId}`)), queryTerms: [], ranked,
  sent: ranked.map(({ path, startLine, endLine }) => ({ path, startLine, endLine })), used: [{ path: usedPath }], skills: [], withheldSkills: [], ...extra,
});

test("an answer's citations and diffs say which files and lines it needed", () => {
  const answer = "See packages/a/x.ts:12-18 and `packages/a/y.ts`. Not other/packages/a/y.ts.bak or packages/a/x.tsx.\n" +
    "--- a/packages/b/z.ts\n+++ b/packages/b/z.ts\n@@ -40,3 +40,5 @@\n context\n";
  expect(usedEvidence(answer, ["packages/a/x.ts", "packages/a/y.ts", "packages/a/unused.ts"])).toEqual([
    { path: "packages/a/x.ts", lines: [[12, 18]] }, { path: "packages/a/y.ts" }, { path: "packages/b/z.ts", lines: [[40, 42]] }]);
  expect(usedEvidence("nothing cited", ["a.ts"])).toEqual([]);
});

test("saved parameters are read defensively and stay inside their bounds", () => {
  const base = defaultParams();
  expect(parseParams(null)).toEqual(base);
  const parsed = parseParams({ version: 7, lanes: { lexical: 99, dense: -5, exact: "x", graph: 0.3 }, roleGain: [9, "a"], regionGain: NaN, slotUtility: [{ alpha: -1, beta: 2 }, { alpha: 5, beta: 1 }] });
  expect(parsed.version).toBe(7);
  expect(parsed.lanes).toEqual({ lexical: 3, dense: 0.05, exact: base.lanes.exact, graph: 0.3, experience: base.lanes.experience });
  expect(parsed.roleGain[0]).toBe(1.5);
  expect(parsed.roleGain[1]).toBe(base.roleGain[1]!);
  expect(parsed.regionGain).toBe(base.regionGain);
  expect(parsed.slotUtility[0]).toEqual(base.slotUtility[0]!);
  expect(parsed.slotUtility[1]).toEqual({ alpha: 5, beta: 1 });
});

test("reviews teach the map a task's vocabulary, but only after a second confirmation", async () => {
  const before = await selectAtlasContext({ workspace, query: paraphrased.query, tokenBudget: 1500 });
  expect(evidenceRecall(paraphrased, before.excerpts)).toBe(0);
  const used = [{ path: "packages/billing/src/reversal.ts", lines: [[3, 5]] as [number, number][] }];
  const record = (requestId: string, query: string) => recordAtlasOutcome({
    workspace, session: "reviews", requestId, outcome: "accepted", used, manifest: { ...before.manifest, query },
  });
  const first = await record("r1", paraphrased.query);
  expect(first).toMatchObject({ learned: true, aliases: 0, missedPaths: [] });
  // One accepted answer may be luck. Its words are noted, not yet searchable.
  const unrelated = "process a refund for a shopper";
  expect(evidenceRecall(paraphrased, (await selectAtlasContext({ workspace, query: unrelated, tokenBudget: 1500 })).excerpts)).toBe(0);
  const status = await atlasStatus(workspace);
  expect(status.imported && status.learning).toMatchObject({ episodes: 1, accepted: 1, aliases: 0 });
  expect(status.imported && status.learning!.pendingAliases).toBeGreaterThan(0);
  // The same task asked again is recognised from the episode itself.
  const repeat = await selectAtlasContext({ workspace, query: paraphrased.query, tokenBudget: 1500 });
  expect(evidenceRecall(paraphrased, repeat.excerpts)).toBe(1);
  expect(repeat.manifest.files.find(({ path }) => path === "packages/billing/src/reversal.ts")?.reason).toBe("Used in similar accepted requests");

  const second = await record("r2", "refund money to the shopper who asked for it back");
  expect(second?.aliases).toBeGreaterThan(0);
  // A differently worded task now finds the code through words the reviews attached to it.
  const after = await selectAtlasContext({ workspace, query: unrelated, tokenBudget: 1500 });
  expect(evidenceRecall(paraphrased, after.excerpts)).toBe(1);
  expect(after.manifest.atlas?.params).toBe(2);
  const atlas = Atlas.open(workspace);
  try {
    const alias = atlas.get<{ alias: string }>(
      "SELECT t.alias FROM unit_text t JOIN units u ON u.id = t.rowid JOIN files f ON f.id = u.file WHERE f.path = 'packages/billing/src/reversal.ts' AND u.name = 'reverseSettledCharge'");
    expect(alias?.alias.split(" ")).toContain("refund");
    expect(alias?.alias.split(" ")).toContain("shopper");
  } finally { atlas.close(); }

  // Recording the same review again learns nothing new.
  expect(await record("r2", "refund money to the shopper who asked for it back")).toMatchObject({ learned: false, params: 2 });
  // Aliases live in learned state, so a full rebuild of the map lays them back.
  await importRepository({ workspace, full: true });
  expect(evidenceRecall(paraphrased, (await selectAtlasContext({ workspace, query: unrelated, tokenBudget: 1500 })).excerpts)).toBe(1);
});

test("a lane-weight update that would rank past requests worse is rejected", () => {
  const scratch = join(root, "gate");
  Learning.open(scratch, { stateDir: scratch }, true)!.close();
  // Six accepted requests on record, each answered by the unit that matched the task's words, by a thin margin.
  const db = new Database(learningPath(scratch, { stateDir: scratch }));
  for (let index = 0; index < 6; index++) {
    db.run("INSERT INTO episodes(session, request, at, outcome, vector, params, units) VALUES ('s', ?, ?, 'accepted', ?, 0, ?)", [
      `past-${index}`, new Date().toISOString(), new Uint8Array(256),
      JSON.stringify([{ p: `src/used-${index}.ts`, n: "used", l: [0.5, 0, 0, 0, 0], u: 1, s: 1 }, { p: `src/near-${index}.ts`, n: "near", l: [0.4, 0.15, 0, 0, 0], u: 0, s: 1 }]),
    ]);
  }
  db.close();
  const learning = Learning.open(scratch, { stateDir: scratch })!;
  try {
    const settled = structuredClone(learning.params.lanes);
    // One request where a merely similar unit happened to be the answer would, if followed, flip all six.
    const misleading = learning.recordOutcome(outcome("odd", [
      unit("src/odd.ts", "odd", { lexical: 0.1, dense: 0.9 }), unit("src/a.ts", "a", { lexical: 0.9 }), unit("src/b.ts", "b", { lexical: 0.9 }),
    ], "src/odd.ts"));
    expect(misleading.laneUpdate).toBe("rejected");
    expect(misleading.panel).toMatchObject({ episodes: 6, before: 1 });
    expect(misleading.panel!.after).toBeLessThan(1);
    expect(learning.params.lanes).toEqual(settled);
    // The episode itself is still remembered, and the version still advances.
    expect(learning.summary()).toMatchObject({ episodes: 7, accepted: 7 });
    expect(learning.params.version).toBe(1);
    // A request that agrees with the record is committed, and the best snapshot is kept for rollback.
    const consistent = learning.recordOutcome(outcome("next", [
      unit("src/next.ts", "next", { lexical: 0.8 }), unit("src/other.ts", "other", { lexical: 0.3, dense: 0.2 }),
    ], "src/next.ts"));
    expect(consistent.laneUpdate).toBe("committed");
    expect(consistent.panel!.after).toBeGreaterThanOrEqual(consistent.panel!.before);
    expect(learning.params.lanes.lexical).toBeGreaterThan(settled.lexical);
    expect(learning.params.lanes.dense).toBeLessThan(settled.dense);
    const best = learning.summary().best;
    expect(best.version).toBe(2);
    expect(learning.rollback().lanes).toEqual(best.lanes);
    // A review that asks for changes records the episode but teaches no ranking.
    expect(learning.recordOutcome(outcome("rework", [unit("src/x.ts", "x", { lexical: 0.9 })], "src/x.ts", { outcome: "changes_requested" })))
      .toMatchObject({ learned: true, laneUpdate: "skipped", aliases: 0 });
    // A remembered task brings back the unit that answered it.
    const [remembered] = learning.experience(embedBag(terms("task next")));
    expect(remembered).toMatchObject({ path: "src/next.ts", name: "next" });
    expect(remembered!.weight).toBeGreaterThan(0.95);
    expect(learning.forgetSession("s")).toBe(9);
    expect(learning.summary().episodes).toBe(0);
    expect(learning.experience(embedBag(terms("task next")))).toEqual([]);
  } finally { learning.close(); }
});

test("a skill on trial is kept or retired by what reviews show, not by its own claims", () => {
  const scratch = join(root, "skills");
  const learning = Learning.open(scratch, { stateDir: scratch }, true)!;
  try {
    const ranked = [unit("src/a.ts", "a", { lexical: 0.5 })];
    // Requests that received the helpful skill were accepted. Those that did not were sent back.
    for (let index = 0; index < 5; index++) {
      learning.recordOutcome(outcome(`with-${index}`, ranked, "src/a.ts", { skills: [{ id: "skills/helpful", trial: true }, { id: "builtin/checks" }], withheldSkills: ["skills/harmful"] }));
      learning.recordOutcome(outcome(`without-${index}`, ranked, "src/a.ts", { outcome: "changes_requested", skills: [{ id: "skills/harmful", trial: true }], withheldSkills: ["skills/helpful"] }));
    }
    const records = learning.skillRecords();
    expect(records.get("skills/helpful")).toMatchObject({ state: "established", shown: 5, shownAccepted: 5, withheld: 5, withheldAccepted: 0 });
    expect(records.get("skills/harmful")).toMatchObject({ state: "retired", shown: 5, shownAccepted: 0 });
    expect(records.get("skills/helpful")!.confidence).toBeGreaterThan(0.9);
    // A built-in fact is counted but never put on trial.
    expect(records.get("builtin/checks")).toMatchObject({ state: "trial", shown: 5, withheld: 0 });
    expect(records.get("builtin/checks")!.confidence).toBeUndefined();
    // Too little evidence decides nothing.
    learning.recordOutcome(outcome("few", ranked, "src/a.ts", { skills: [{ id: "skills/new", trial: true }] }));
    expect(learning.skillRecords().get("skills/new")?.state).toBe("trial");
    learning.setSkillState("skills/helpful", "disabled");
    expect(learning.skillRecords().get("skills/helpful")?.state).toBe("disabled");
  } finally { learning.close(); }
});

test("a lesson is written as a readable draft and delivered on a fixed, measurable draw", async () => {
  const lesson = await addLesson({ workspace, text: "Ledger reversals must be idempotent. Check for an existing reversal before crediting.", anchors: ["packages/billing/src"], actor: "human:reviewer" });
  expect(lesson.id).toStartWith("lessons/ledger-reversals-must-be-idempotent-");
  const note = parse(await readFile(lesson.path, "utf8"));
  expect(note.frontmatter).toMatchObject({ type: "code lesson", status: "draft", anchors: ["packages/billing/src"], generated: { by: "human:reviewer" } });
  expect(note.body).toContain("Check for an existing reversal before crediting.");
  await expect(addLesson({ workspace, text: "x".repeat(700), actor: "human:reviewer" })).rejects.toThrow("1–600 UTF-8 bytes");
  await expect(addLesson({ workspace, text: "ok", anchors: ["../x"], actor: "human:reviewer" })).rejects.toThrow("workspace-relative");
  await expect(addLesson({ workspace, text: "ok", actor: "not an actor" })).rejects.toThrow("actor convention");
  await expect(addLesson({ workspace: root, text: "ok", actor: "human:reviewer" })).rejects.toThrow("Import this repository");

  // On trial: across many tasks touching its anchor, roughly half receive it, and each task always gets the same answer.
  let delivered = 0;
  let withheld = 0;
  for (let index = 0; index < 24; index++) {
    const query = `reverseSettledCharge ledger credit case ${index}`;
    const context = await selectAtlasContext({ workspace, query, tokenBudget: 1200 });
    const sent = context.skills.some(({ id, trial }) => id === lesson.id && trial === true);
    const held = context.manifest.atlas!.withheld?.includes(lesson.id) ?? false;
    expect(sent !== held, query).toBe(true);
    if (sent) delivered++; else withheld++;
    expect((await selectAtlasContext({ workspace, query, tokenBudget: 1200 })).manifest.id).toBe(context.manifest.id);
  }
  expect(delivered).toBeGreaterThanOrEqual(5);
  expect(withheld).toBeGreaterThanOrEqual(5);
  // A task elsewhere in the repository is not eligible at all.
  const elsewhere = await selectAtlasContext({ workspace, query: "refreshSession", projects: ["packages/auth"], tokenBudget: 1200 });
  expect(elsewhere.skills.some(({ id }) => id === lesson.id) || (elsewhere.manifest.atlas!.withheld ?? []).includes(lesson.id)).toBe(false);
  // A person who marks it stable takes it off trial.
  await writeFile(lesson.path, readFileSync(lesson.path, "utf8").replace("status: draft", "status: stable"));
  for (let index = 0; index < 4; index++) {
    const context = await selectAtlasContext({ workspace, query: `reverseSettledCharge ledger credit case ${index}`, tokenBudget: 1200 });
    expect(context.skills.find(({ id }) => id === lesson.id)).toMatchObject({ text: expect.stringContaining("Ledger reversals must be idempotent") });
    expect(context.skills.find(({ id }) => id === lesson.id)?.trial).toBeUndefined();
  }
});

test("forgetting removes what was learned and leaves the map and the bundle", async () => {
  const unrelated = "process a refund for a shopper";
  expect((await forgetLearning(workspace, {}, "reviews")).episodes).toBe(2);
  // The episodes are gone. What was already learned from them is not undone by this alone.
  expect(evidenceRecall(paraphrased, (await selectAtlasContext({ workspace, query: unrelated, tokenBudget: 1500 })).excerpts)).toBe(1);
  expect(await forgetLearning(workspace)).toEqual({ reset: true });
  const status = await atlasStatus(workspace);
  expect(status.imported && status.learning).toBeUndefined();
  expect(evidenceRecall(paraphrased, (await selectAtlasContext({ workspace, query: unrelated, tokenBudget: 1500 })).excerpts)).toBe(0);
  expect((await selectAtlasContext({ workspace, query: "refreshSession", tokenBudget: 1500 })).manifest.atlas?.params).toBe(0);
  expect(await forgetLearning(workspace)).toEqual({ reset: false });
  expect(status.imported && status.skills.some(({ kind }) => kind === "lesson")).toBe(true);
});
