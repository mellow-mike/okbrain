import { expect, test } from "bun:test";
import type { Usage } from "@earendil-works/pi-ai";
import type { CodingSessionStatusResult } from "../src/core/coding/durable.ts";
import { approvedSourceToolName } from "../src/core/coding/approved-source-tool.ts";
import { codingRunReport } from "../src/core/coding/run-report.ts";

const privateText = "fixture-private-credential-or-content";
const requestId = "review-17";
const session = "review";
const projectId = "6e39edb6-44b6-4ec2-9304-6cf428763cf5";
const modelKey = "anthropic/claude-sonnet-4-6";
const usage: Usage = {
  input: 300, output: 80, cacheRead: 90, cacheWrite: 30, cacheWrite1h: 25, reasoning: 10, totalTokens: 500,
  cost: { input: 1.2, output: 0.4, cacheRead: 0.1, cacheWrite: 0.1, total: 1.8 },
};
const nonemptyLedger = { models: { [modelKey]: usage }, tools: {} };
const context = { estimatedTokens: 799, limitTokens: 4096, modelWindowTokens: 8192, maxOutputTokens: 1024, historyCompacted: true };

function snapshot(request?: CodingSessionStatusResult["request"]): CodingSessionStatusResult {
  return { session, provider: "anthropic", model: "claude-sonnet-4-6", pendingRequestIds: [privateText],
    usage: nonemptyLedger, rootUsage: nonemptyLedger, context, request };
}

test("run reports keep only known receipt, repository, budget, and usage fields", () => {
  const sha256 = "d".repeat(64);
  const id = "b".repeat(64);
  const workspaceRevision = "a".repeat(40);
  const counters = { tokenBudget: 1000, estimatedTokens: 30, contextBytes: 60, trackedPaths: 10, candidateFiles: 5, scannedFiles: 4, matchedFiles: 2 };
  const limitsReached = { trackedPaths: true, scannedFiles: false, fileBytes: false, selectedFiles: false, tokenBudget: false };
  const index = { indexedFiles: 10, expandedFiles: 3, limited: false };
  const source = { path: "packages/core/index.ts", startLine: 5, endLine: 12, sha256 };
  const unsafeManifest = {
    id, workspaceRevision, projects: [privateText], query: privateText, ...counters,
    limitsReached: { ...limitsReached, privateField: privateText }, index: { ...index, details: privateText },
    profile: { version: 1 as const, name: privateText, id, sharedProjects: [privateText] },
    files: [{ ...source, reason: privateText, content: privateText }],
  };
  const unsafeUsage = { ...usage, cost: { ...usage.cost, privateField: privateText }, privateField: privateText };
  const approvedLookup = { path: source.path, startLine: 8, endLine: 9 };
  const unsafeRequest = {
    requestId, status: "done" as const, approvedSourceLookup: true as const, stopReason: "stop" as const,
    sourceLookup: { served: [
      { ...approvedLookup, content: privateText },
      { ...approvedLookup, path: `/home/${privateText}` },
      { ...approvedLookup, path: `src/${privateText}` },
      { ...approvedLookup, startLine: 1 },
    ], refused: 2, incomplete: 0, rawError: privateText },
    usage: unsafeUsage, repositoryContext: unsafeManifest, reason: privateText, savedPrompt: privateText,
    receipt: { session, requestId, status: "done" as const, text: privateText, stopReason: "stop" as const, usage: unsafeUsage },
    savedSource: { source: "repository" as const, manifest: unsafeManifest, guidance: privateText, excerpts: [{ ...source, content: privateText }] },
  };
  const unsafeSnapshot = {
    ...snapshot(unsafeRequest), workspace: `/home/fixture/${privateText}`, apiKey: privateText,
    context: { ...context, compactionPending: true as const, transcript: privateText },
    usage: { models: { [modelKey]: unsafeUsage, [privateText]: usage }, tools: { [approvedSourceToolName]: unsafeUsage, [privateText]: usage } },
  };
  const metadata = { requestId, status: "done", projectId, review: "accepted", reviewer: privateText, error: privateText };
  const report = codingRunReport(unsafeSnapshot, metadata);
  expect(report).toEqual({
    version: 1, projectId, session, provider: "anthropic", model: "claude-sonnet-4-6", runStatus: "done", review: "accepted",
    context: { ...context, compactionPending: true },
    request: { requestId, status: "done", approvedSourceLookup: true, stopReason: "stop", usage,
      sourceLookup: { served: [approvedLookup], refused: 2, incomplete: 0, truncated: true },
      repositoryContext: { id, workspaceRevision, ...counters, limitsReached, index, files: [source] } },
    receipt: { status: "done", stopReason: "stop", usage },
    usage: { models: { [modelKey]: usage }, tools: { [approvedSourceToolName]: usage } }, rootUsage: nonemptyLedger,
  });
  expect(JSON.stringify(report)).not.toContain(privateText);
});

test("package reports derive status while keeping only admitted relative references and usage", () => {
  const source = { path: "packages/data/read.ts", startLine: 4, endLine: 10 };
  const reviews = [
    { project: "packages/data", requestId: `${requestId}-package-1`, conversationId: 55, summary: privateText, usage,
      sources: [{ ...source, text: privateText }, { path: `/home/${privateText}`, startLine: 1, endLine: 2 }] },
    { project: "packages/tooling", requestId: `${requestId}-package-2`, conversationId: 56, reason: privateText },
    { project: `C:\\Users\\${privateText}`, requestId: `${requestId}-package-3`, summary: privateText },
  ];
  const pi = snapshot({ requestId, status: "done", receipt: { session, requestId, status: "done", stopReason: "stop", usage,
    text: privateText, packageReviews: reviews } });
  const report = codingRunReport(pi, { requestId, status: "done", review: null });
  expect(report?.receipt?.packageReviews).toEqual([
    { project: "packages/data", requestId: `${requestId}-package-1`, status: "done", usage, sources: [source] },
    { project: "packages/tooling", requestId: `${requestId}-package-2`, status: "unanswered" },
  ]);
  expect(JSON.stringify(report)).not.toContain(privateText);
});

test("an admitted interrupted request can describe its saved paths without a terminal receipt", () => {
  const paths = ["src/explicit 👋.ts", `/${privateText}`, `C:/${privateText}`, `src/../${privateText}`, `src\\${privateText}`];
  const pi = snapshot({ requestId, status: "placed", savedPrompt: privateText, sourcePaths: paths,
    savedSource: { source: "files", files: [{ path: "legacy.ts", content: privateText }] } });
  const run = { requestId, status: "interrupted", projectId, review: privateText };
  expect(codingRunReport(pi, run)).toMatchObject({ runStatus: "interrupted", request: { requestId, status: "placed", files: [{ path: paths[0]! }] } });
  expect(codingRunReport(pi, run)?.receipt).toBeUndefined();
  if (!pi.request) throw new Error("Fixture request missing.");
  delete pi.request.sourcePaths;
  expect(codingRunReport(pi, run)?.request.files).toEqual([{ path: "legacy.ts" }]);
  expect(JSON.stringify(codingRunReport(pi, run))).not.toContain(privateText);
});

test("reports require matching saved requests and discard invalid identity and numeric values", () => {
  const run = { requestId, status: "unanswered", projectId: `/private/${privateText}` };
  expect(codingRunReport(undefined, run)).toBeUndefined();
  expect(codingRunReport(snapshot(), run)).toBeUndefined();
  expect(codingRunReport(snapshot({ requestId: "other-request", status: "done" }), run)).toBeUndefined();
  const pi = snapshot({ requestId, status: "unanswered", reason: privateText, usage: { ...usage, input: Number.NaN },
    receipt: { session: "unrelated-session", requestId, status: "unanswered", reason: privateText } });
  pi.context = { ...context, estimatedTokens: Infinity, maxOutputTokens: -1 };
  expect(codingRunReport({ ...pi, session: `/private/${privateText}` }, run)).toBeUndefined();
  expect(codingRunReport({ ...pi, model: `C:/private/${privateText}` }, run)).toBeUndefined();
  const report = codingRunReport(pi, run);
  expect(report?.projectId).toBeUndefined();
  expect(report?.receipt).toBeUndefined();
  expect(report?.request.usage).toBeUndefined();
  expect(report?.context).toEqual({ limitTokens: 4096, modelWindowTokens: 8192, historyCompacted: true });
  expect(JSON.stringify(report)).not.toContain(privateText);
});

test("OpenRouter reports preserve routed model usage and deferred lookup ranges", () => {
  const deferred = { path: "src/later.ts", startLine: 7, endLine: 9, sha256: "d".repeat(64) };
  const { sha256: _, ...lookup } = deferred;
  const repositoryContext = {
    id: "b".repeat(64), files: [], atlas: { deferred: [{ ...deferred, content: privateText }] },
  } as unknown as NonNullable<NonNullable<CodingSessionStatusResult["request"]>["repositoryContext"]>;
  const request = { requestId, status: "done" as const, repositoryContext, approvedSourceLookup: true as const,
    sourceLookup: { served: [lookup], refused: 0, incomplete: 0 } };
  const model = "~anthropic/claude-sonnet-latest";
  const routed = { ...snapshot(request), provider: "openrouter" as const, model,
    usage: { models: { [`openrouter/${model}`]: usage, "openrouter/vendor/model:free": usage, [modelKey]: usage }, tools: {} } };
  const report = codingRunReport(routed, { requestId, status: "done" });
  expect(report?.request.repositoryContext?.deferred).toEqual([deferred]);
  expect(report?.request.sourceLookup?.served).toEqual([lookup]);
  expect(report?.usage.models).toEqual(routed.usage.models);
  expect(JSON.stringify(report)).not.toContain(privateText);
});
