// Turning a person's review of a finished request into something the harness
// learns from. Called after the decision is recorded and never able to block
// or change it: a failure here loses one lesson, not a review.

import { recordAtlasOutcome, usedEvidence, type OutcomeReport, type UsedEvidence } from "./atlas/context.ts";
import { Learning, type Outcome } from "./atlas/learn.ts";
import type { AtlasLocation } from "./atlas/store.ts";
import type { CodingSessionResult } from "./durable.ts";
import type { RepositoryContextManifest } from "./repository-context.ts";
import { routeCell } from "./router.ts";

export interface CodingOutcomeInput {
  workspace: string;
  session: string;
  requestId: string;
  outcome: Outcome;
  /** The finished request as the runner reported it. */
  receipt: CodingSessionResult;
  /** Files changed by a patch the reviewer approved, beyond what the answer itself names. */
  appliedPaths?: string[];
}

export interface CodingOutcomeReport {
  learned: (OutcomeReport & { requestId: string })[];
  routes: number;
}

function candidates(manifest: RepositoryContextManifest): string[] {
  return [...new Set([...manifest.files.map(({ path }) => path), ...(manifest.atlas?.deferred.map(({ path }) => path) ?? [])])];
}

function evidence(text: string, manifest: RepositoryContextManifest, applied: readonly string[]): UsedEvidence[] {
  const used = usedEvidence(text, candidates(manifest));
  const known = new Set(used.map(({ path }) => path));
  for (const path of applied) if (!known.has(path)) used.push({ path });
  return used;
}

/** Learn from a reviewed request. Requests whose source did not come from the repository map teach nothing here. */
export async function recordCodingOutcome(input: CodingOutcomeInput, location: AtlasLocation = {}): Promise<CodingOutcomeReport> {
  const { receipt } = input;
  const report: CodingOutcomeReport = { learned: [], routes: 0 };
  if (receipt.status !== "done") return report;
  const applied = input.appliedPaths ?? [];
  const learn = async (requestId: string, manifest: RepositoryContextManifest | undefined, text: string) => {
    if (!manifest?.atlas) return;
    const learned = await recordAtlasOutcome({
      workspace: input.workspace, session: input.session, requestId, outcome: input.outcome, manifest, used: evidence(text, manifest, applied),
    }, location);
    if (learned) report.learned.push({ ...learned, requestId });
  };
  if (!receipt.orchestration) {
    await learn(input.requestId, receipt.repositoryContext, receipt.text);
    return report;
  }
  const { orders, synthesis } = receipt.orchestration;
  for (const order of orders) {
    // A worker's own report and the combined answer both show what it needed.
    if (order.report) await learn(order.requestId, order.manifest, `${order.report}\n${receipt.text}`);
  }
  // Route statistics: each model that produced a part of the reviewed result shares its outcome.
  const firstTime = report.learned.some(({ learned }) => learned) || !orders.some(({ manifest }) => manifest?.atlas);
  if (firstTime) {
    const learning = Learning.open(input.workspace, location, true);
    if (learning) try {
      const accepted = input.outcome === "accepted";
      for (const order of orders) {
        if (!order.model || !order.report) continue;
        learning.recordRoute("worker", routeCell(order.manifest?.estimatedTokens ?? 0), order.model, accepted, (order.modelUsage ?? order.usage)?.cost.total ?? 0);
        report.routes++;
      }
      if (synthesis?.model && synthesis.text) {
        learning.recordRoute("orchestrator", routeCell(Math.min(8000, 400 + orders.length * 1500)), synthesis.model, accepted, (synthesis.modelUsage ?? synthesis.usage)?.cost.total ?? 0);
        report.routes++;
      }
    } finally {
      learning.close();
    }
  }
  return report;
}
