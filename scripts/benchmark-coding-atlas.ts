// Measure the repository map on generated monorepos of growing size.
//
//   bun run scripts/benchmark-coding-atlas.ts [--scales 400,4000,20000] [--budget 2000] [--json]
//
// Everything here is local and deterministic: no model is called. The script
// reports how long an import takes, how much one request's selection costs as
// the repository grows, whether the selection holds each task's evidence, and
// what two accepted reviews change. It does not measure answer quality.

import { mkdtemp, readdir, rm, stat, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordAtlasOutcome, selectAtlasContext } from "../src/core/coding/atlas/context.ts";
import { importRepository } from "../src/core/coding/atlas/import.ts";
import { atlasDirectory } from "../src/core/coding/atlas/store.ts";
import { selectRepositoryContext } from "../src/core/coding/repository-context.ts";
import { buildMonorepo, evidenceRecall, type FixtureTask } from "../tests/fixtures/monorepo.ts";

const args = process.argv.slice(2);
const flag = (name: string) => { const at = args.indexOf(`--${name}`); return at < 0 ? undefined : args[at + 1]; };
const scales = (flag("scales") ?? "400,4000,20000").split(",").map(Number).filter((value) => Number.isInteger(value) && value > 0);
const budget = Number(flag("budget") ?? 2000);
const asJson = args.includes("--json");
const repeats = 7;
if (!scales.length || !Number.isInteger(budget) || budget < 256) {
  console.error("Use --scales with positive file counts and --budget with a token budget of at least 256.");
  process.exit(2);
}

const round = (value: number, digits = 1) => Number(value.toFixed(digits));
const percentile = (values: number[], share: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * share))]!;

async function directoryBytes(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    total += entry.isDirectory() ? await directoryBytes(path) : (await stat(path)).size;
  }
  return total;
}

async function timed<T>(action: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await action();
  return { value, ms: performance.now() - started };
}

interface TaskResult {
  task: string; kind: FixtureTask["kind"];
  map: number; mapTokens: number; mapFiles: number; mapPrecision: number;
  lexical: number; lexicalTokens: number; lexicalFiles: number; lexicalPrecision: number;
}

/** Share of the selected files that hold the task's evidence. Linked context a task did not name counts against it. */
function precision(task: FixtureTask, excerpts: readonly { path: string }[]): { files: number; precision: number } {
  const selected = new Set(excerpts.map(({ path }) => path));
  const evidence = new Set(task.evidence.map(({ path }) => path));
  return { files: selected.size, precision: selected.size ? [...selected].filter((path) => evidence.has(path)).length / selected.size : 0 };
}

async function measure(backgroundFiles: number) {
  const root = await mkdtemp(join(tmpdir(), "okb-atlas-bench-"));
  try {
    const fixture = await buildMonorepo(join(root, "repo"), backgroundFiles);
    const location = { stateDir: join(root, "atlas") };
    const { workspace } = fixture;

    const full = await timed(() => importRepository({ workspace }, location));
    const unchanged = await timed(() => importRepository({ workspace }, location));
    // Ten edited files, the size of an ordinary change.
    for (let index = 0; index < 10; index++)
      await appendFile(join(workspace, `packages/search/src/query/module-${String(index * 6).padStart(5, "0")}.ts`), `\nexport const touched${index} = ${index};\n`);
    const edited = await timed(() => importRepository({ workspace }, location));

    const tasks: TaskResult[] = [];
    const mapMs: number[] = [];
    const lexicalMs: number[] = [];
    for (const task of fixture.tasks) {
      let map = await selectAtlasContext({ workspace, query: task.query, tokenBudget: budget }, location);
      for (let run = 0; run < repeats; run++) {
        const result = await timed(() => selectAtlasContext({ workspace, query: task.query, tokenBudget: budget }, location));
        mapMs.push(result.ms);
        map = result.value;
      }
      let lexical = await selectRepositoryContext({ workspace, projects: ["."], query: task.query, tokenBudget: budget });
      for (let run = 0; run < 3; run++) {
        const result = await timed(() => selectRepositoryContext({ workspace, projects: ["."], query: task.query, tokenBudget: budget }));
        lexicalMs.push(result.ms);
        lexical = result.value;
      }
      const mapPrecision = precision(task, map.excerpts);
      const lexicalPrecision = precision(task, lexical.excerpts);
      tasks.push({
        task: task.id, kind: task.kind, map: evidenceRecall(task, map.excerpts), mapTokens: map.manifest.estimatedTokens,
        mapFiles: mapPrecision.files, mapPrecision: round(mapPrecision.precision, 3),
        lexical: evidenceRecall(task, lexical.excerpts), lexicalTokens: lexical.manifest.estimatedTokens,
        lexicalFiles: lexicalPrecision.files, lexicalPrecision: round(lexicalPrecision.precision, 3),
      });
    }

    // What two accepted reviews teach. The test query shares no wording with either review's task.
    const paraphrased = fixture.tasks.find(({ kind }) => kind === "paraphrased")!;
    const heldOut = "process a refund for a shopper";
    const before = await selectAtlasContext({ workspace, query: heldOut, tokenBudget: budget }, location);
    const used = [{ path: "packages/billing/src/reversal.ts", lines: [[3, 5]] as [number, number][] }];
    const reviews = [paraphrased.query, "refund money to the shopper who asked for it back"];
    let learnMs = 0;
    for (const [index, query] of reviews.entries()) {
      const manifest = (await selectAtlasContext({ workspace, query, tokenBudget: budget }, location)).manifest;
      learnMs += (await timed(() => recordAtlasOutcome({ workspace, session: "bench", requestId: `r${index}`, outcome: "accepted", used, manifest }, location))).ms;
    }
    const after = await selectAtlasContext({ workspace, query: heldOut, tokenBudget: budget }, location);
    const others = fixture.tasks.filter((task) => task !== paraphrased);
    const kept = await Promise.all(others.map(async (task) => evidenceRecall(task, (await selectAtlasContext({ workspace, query: task.query, tokenBudget: budget }, location)).excerpts)));

    return {
      backgroundFiles, trackedFiles: full.value.trackedPaths, files: full.value.files, units: full.value.units, packages: full.value.packages,
      import: {
        fullMs: round(full.ms), filesPerSecond: Math.round(full.value.files / (full.ms / 1000)), unchangedMs: round(unchanged.ms),
        tenEditedMs: round(edited.ms), reread: edited.value.changedFiles, diskBytes: await directoryBytes(atlasDirectory(workspace, location)),
      },
      readout: {
        budget, p50Ms: round(percentile(mapMs, 0.5)), p95Ms: round(percentile(mapMs, 0.95)),
        meanTokens: Math.round(tasks.reduce((sum, { mapTokens }) => sum + mapTokens, 0) / tasks.length),
        maxTokens: Math.max(...tasks.map(({ mapTokens }) => mapTokens)),
        recall: round(tasks.reduce((sum, { map }) => sum + map, 0) / tasks.length, 3),
        precision: round(tasks.reduce((sum, { mapPrecision }) => sum + mapPrecision, 0) / tasks.length, 3),
      },
      lexicalPreview: {
        p50Ms: round(percentile(lexicalMs, 0.5)), p95Ms: round(percentile(lexicalMs, 0.95)),
        meanTokens: Math.round(tasks.reduce((sum, { lexicalTokens }) => sum + lexicalTokens, 0) / tasks.length),
        recall: round(tasks.reduce((sum, { lexical }) => sum + lexical, 0) / tasks.length, 3),
        precision: round(tasks.reduce((sum, { lexicalPrecision }) => sum + lexicalPrecision, 0) / tasks.length, 3),
      },
      tasks,
      learning: {
        heldOutQuery: heldOut, recallBefore: evidenceRecall(paraphrased, before.excerpts), recallAfter: evidenceRecall(paraphrased, after.excerpts),
        reviews: reviews.length, recordMs: round(learnMs / reviews.length),
        otherTasksRecallAfter: round(kept.reduce((sum, value) => sum + value, 0) / kept.length, 3),
      },
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const results = [];
for (const scale of scales) {
  if (!asJson) console.error(`Measuring ${scale.toLocaleString()} background files…`);
  results.push(await measure(scale));
}

if (asJson) {
  console.log(JSON.stringify({ budget, repeats, platform: `${process.platform}-${process.arch}`, bun: Bun.version, results }, null, 2));
} else {
  const megabytes = (bytes: number) => `${round(bytes / (1024 * 1024))} MB`;
  console.log(`\nRepository map benchmark (${process.platform}-${process.arch}, Bun ${Bun.version}). Budget ${budget} tokens per request. No model calls.\n`);
  console.log("Import");
  console.log("| Files | Units | Full import | Files/s | Unchanged | 10 files edited | On disk |");
  console.log("| ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const { files, units, import: imported } of results)
    console.log(`| ${files.toLocaleString()} | ${units.toLocaleString()} | ${round(imported.fullMs / 1000, 2)} s | ${imported.filesPerSecond.toLocaleString()} | ${imported.unchangedMs} ms | ${imported.tenEditedMs} ms | ${megabytes(imported.diskBytes)} |`);
  console.log("\nOne request's selection");
  console.log("| Files | Map p50 | Map p95 | Map tokens (mean / max) | Map recall | Map precision | Lexical p50 | Lexical tokens (mean) | Lexical recall | Lexical precision |");
  console.log("| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const { files, readout, lexicalPreview } of results)
    console.log(`| ${files.toLocaleString()} | ${readout.p50Ms} ms | ${readout.p95Ms} ms | ${readout.meanTokens} / ${readout.maxTokens} | ${readout.recall} | ${readout.precision} | ${lexicalPreview.p50Ms} ms | ${lexicalPreview.meanTokens} | ${lexicalPreview.recall} | ${lexicalPreview.precision} |`);
  console.log("\nPrecision is the share of selected files that hold the task's evidence. Linked context the task did not name counts against it.");
  console.log("\nEvidence recall by task (map / lexical preview)");
  console.log(`| Task | ${results.map(({ files }) => `${files.toLocaleString()} files`).join(" | ")} |`);
  console.log(`| --- | ${results.map(() => "---:").join(" | ")} |`);
  for (const [index, { task }] of results[0]!.tasks.entries())
    console.log(`| ${task} | ${results.map(({ tasks }) => `${tasks[index]!.map} / ${tasks[index]!.lexical}`).join(" | ")} |`);
  console.log("\nLearning from two accepted reviews, tested on a query worded differently from both");
  console.log("| Files | Recall before | Recall after | Other tasks after | Time to record a review |");
  console.log("| ---: | ---: | ---: | ---: | ---: |");
  for (const { files, learning } of results)
    console.log(`| ${files.toLocaleString()} | ${learning.recallBefore} | ${learning.recallAfter} | ${learning.otherTasksRecallAfter} | ${learning.recordMs} ms |`);
}
