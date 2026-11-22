import type { StopReason, Usage } from "@earendil-works/pi-ai";
import type { UsageState } from "@earendil-works/pi-durable";
import { approvedSourceToolName } from "./approved-source-tool.ts";
import type { CodingSessionStatusResult } from "./durable.ts";

const sessionName = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const requestName = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const modelName = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/u;
const projectName = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const digest = /^[0-9a-f]{64}$/u;
const revision = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const providers = new Set(["openai", "anthropic", "google"]);
const runStatuses = new Set(["queued", "placed", "running", "interrupted", "done", "unanswered", "failed", "cancelled"]);
const requestStatuses = new Set(["queued", "placed", "done", "unanswered"]);
const stopReasons = new Set<StopReason>(["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"]);
const contextCounters = ["estimatedTokens", "limitTokens", "modelWindowTokens", "maxOutputTokens"] as const;
const manifestCounters = ["tokenBudget", "estimatedTokens", "contextBytes", "trackedPaths", "candidateFiles", "scannedFiles", "matchedFiles"] as const;
const manifestLimits = ["trackedPaths", "scannedFiles", "fileBytes", "selectedFiles", "tokenBudget"] as const;
const maxFiles = 12;
const maxPackages = 3;

type Counters<K extends readonly string[]> = Partial<Record<K[number], number>>;
type FileRange = { path: string; startLine: number; endLine: number };
type RepositoryReport = Counters<typeof manifestCounters> & {
  id: string;
  workspaceRevision?: string;
  limitsReached?: Partial<Record<(typeof manifestLimits)[number], boolean>>;
  files: (FileRange & { sha256?: string })[];
  index?: { indexedFiles: number; expandedFiles: number; limited: boolean };
};
type PackageReport = {
  project: string;
  requestId: string;
  status: "done" | "unanswered";
  usage?: Usage;
  sources?: FileRange[];
};

export interface CodingRunReport {
  version: 1;
  projectId?: string;
  session: string;
  provider: string;
  model: string;
  runStatus: string;
  review?: "accepted" | "changes_requested";
  context: Counters<typeof contextCounters> & { historyCompacted?: boolean; compactionPending?: true };
  request: {
    requestId: string;
    status: string;
    approvedSourceLookup?: true;
    stopReason?: StopReason;
    usage?: Usage;
    repositoryContext?: RepositoryReport;
    files?: { path: string }[];
  };
  receipt?: { status: "done" | "unanswered"; stopReason?: StopReason; usage?: Usage; packageReviews?: PackageReport[] };
  usage: UsageState;
  rootUsage: UsageState;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function amount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function counters<K extends readonly string[]>(value: unknown, keys: K): Counters<K> {
  const result: Counters<K> = {};
  if (record(value)) for (const key of keys) {
    const counter = value[key];
    if (count(counter)) result[key as K[number]] = counter;
  }
  return result;
}

function usageReport(value: unknown): Usage | undefined {
  if (!record(value) || !record(value.cost)) return;
  const { input, output, cacheRead, cacheWrite, totalTokens, cacheWrite1h, reasoning } = value;
  if (!count(input) || !count(output) || !count(cacheRead) || !count(cacheWrite) || !count(totalTokens)) return;
  const cost = value.cost;
  if (!amount(cost.input) || !amount(cost.output) || !amount(cost.cacheRead) || !amount(cost.cacheWrite) || !amount(cost.total)) return;
  return {
    input, output, cacheRead, cacheWrite, totalTokens,
    ...(count(cacheWrite1h) ? { cacheWrite1h } : {}),
    ...(count(reasoning) ? { reasoning } : {}),
    cost: { input: cost.input, output: cost.output, cacheRead: cost.cacheRead, cacheWrite: cost.cacheWrite, total: cost.total },
  };
}

function ledger(value: UsageState, modelKey: string): UsageState {
  // Coding binds each root and its package reviews to one model and one known lookup tool.
  const model = usageReport(value?.models?.[modelKey]);
  const lookup = usageReport(value?.tools?.[approvedSourceToolName]);
  return { models: model ? { [modelKey]: model } : {}, tools: lookup ? { [approvedSourceToolName]: lookup } : {} };
}

function safePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 4096 && !/[:\\\x00-\x1f\x7f]/u.test(value) &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function fileRange(value: unknown): FileRange | undefined {
  if (!record(value)) return;
  const { path, startLine, endLine } = value;
  if (safePath(path) && count(startLine) && startLine > 0 && count(endLine) && endLine >= startLine) {
    return { path, startLine, endLine };
  }
}

function repositoryReport(value: unknown): RepositoryReport | undefined {
  if (!record(value) || !matches(value.id, digest)) return;
  const files = Array.isArray(value.files) ? value.files.slice(0, maxFiles).flatMap((file) => {
    const range = fileRange(file);
    if (!range || !record(file)) return [];
    return [{ ...range, ...(matches(file.sha256, digest) ? { sha256: file.sha256 } : {}) }];
  }) : [];
  const limitsReached: NonNullable<RepositoryReport["limitsReached"]> = {};
  if (record(value.limitsReached)) for (const key of manifestLimits) {
    const limit = value.limitsReached[key];
    if (typeof limit === "boolean") limitsReached[key] = limit;
  }
  const index = value.index;
  return {
    id: value.id, files, ...counters(value, manifestCounters),
    ...(matches(value.workspaceRevision, revision) ? { workspaceRevision: value.workspaceRevision } : {}),
    ...(Object.keys(limitsReached).length ? { limitsReached } : {}),
    ...(record(index) && count(index.indexedFiles) && count(index.expandedFiles) && typeof index.limited === "boolean" ? {
      index: { indexedFiles: index.indexedFiles, expandedFiles: index.expandedFiles, limited: index.limited },
    } : {}),
  };
}

function packageReports(value: unknown, parentId: string): PackageReport[] | undefined {
  if (!Array.isArray(value)) return;
  const validIds = new Set([1, 2, 3].map((part) => `${parentId}-package-${part}`));
  const packages = value.slice(0, maxPackages).flatMap((child): PackageReport[] => {
    if (!record(child) || !safePath(child.project) || typeof child.requestId !== "string" || !validIds.delete(child.requestId)) return [];
    const usage = usageReport(child.usage);
    const sources = Array.isArray(child.sources) ? child.sources.slice(0, maxFiles).flatMap((source) => fileRange(source) ?? []) : undefined;
    return [{
      project: child.project, requestId: child.requestId, status: typeof child.summary === "string" && child.summary.trim() ? "done" : "unanswered",
      ...(usage ? { usage } : {}), ...(sources ? { sources } : {}),
    }];
  });
  return packages.length ? packages : undefined;
}

export function codingRunReport(
  pi: CodingSessionStatusResult | undefined,
  run: { requestId: string; status: string; projectId?: string; review?: string | null },
): CodingRunReport | undefined {
  const request = pi?.request;
  if (!pi || !request || run.requestId !== request.requestId || !matches(run.requestId, requestName) || !matches(pi.session, sessionName) ||
      !providers.has(pi.provider) || !matches(pi.model, modelName) || !runStatuses.has(run.status) || !requestStatuses.has(request.status)) return;

  const saved = request.receipt;
  const receipt = saved?.requestId === request.requestId && saved.session === pi.session && saved.status === request.status ? saved : undefined;
  const manifest = repositoryReport(request.repositoryContext ?? receipt?.repositoryContext);
  const savedFiles = request.savedSource?.source === "files" ? request.savedSource.files : undefined;
  const explicitPaths = Array.isArray(request.sourcePaths) ? request.sourcePaths
    : Array.isArray(savedFiles) ? savedFiles.slice(0, maxFiles).flatMap((file) => record(file) ? [file.path] : []) : undefined;
  const files = explicitPaths?.slice(0, maxFiles).filter(safePath).map((path) => ({ path }));
  const requestUsage = usageReport(request.usage);
  const receiptUsage = usageReport(receipt?.status === "done" ? receipt.usage : undefined);
  const packages = packageReports(receipt?.packageReviews, run.requestId);
  const modelKey = `${pi.provider}/${pi.model}`;

  return {
    version: 1, session: pi.session, provider: pi.provider, model: pi.model, runStatus: run.status,
    ...(matches(run.projectId, projectName) ? { projectId: run.projectId } : {}),
    ...(run.review === "accepted" || run.review === "changes_requested" ? { review: run.review } : {}),
    context: {
      ...counters(pi.context, contextCounters),
      ...(typeof pi.context?.historyCompacted === "boolean" ? { historyCompacted: pi.context.historyCompacted } : {}),
      ...(pi.context?.compactionPending === true ? { compactionPending: true } : {}),
    },
    request: {
      requestId: request.requestId, status: request.status,
      ...(request.approvedSourceLookup === true ? { approvedSourceLookup: true } : {}),
      ...(request.stopReason && stopReasons.has(request.stopReason) ? { stopReason: request.stopReason } : {}),
      ...(requestUsage ? { usage: requestUsage } : {}),
      ...(manifest ? { repositoryContext: manifest } : {}),
      ...(files ? { files } : {}),
    },
    ...(receipt ? { receipt: {
      status: receipt.status,
      ...(receipt.status === "done" && stopReasons.has(receipt.stopReason) ? { stopReason: receipt.stopReason } : {}),
      ...(receiptUsage ? { usage: receiptUsage } : {}),
      ...(packages ? { packageReviews: packages } : {}),
    } } : {}),
    usage: ledger(pi.usage, modelKey), rootUsage: ledger(pi.rootUsage, modelKey),
  };
}
