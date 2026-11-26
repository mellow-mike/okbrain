import type { StopReason, Usage } from "@earendil-works/pi-ai";
import type { UsageState } from "@earendil-works/pi-durable";
import { approvedSourceToolName, maxApprovedSourceLookups } from "./approved-source-tool.ts";
import { approvedSourceLookupRange, maxRecordedSourceLookups, type CodingSourceLookupReceipt } from "./approved-source-receipt.ts";
import type { CodingSessionStatusResult } from "./durable.ts";

const sessionName = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const requestName = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const modelName = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/u;
const openRouterModelName = /^~?[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u;
const projectName = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const digest = /^[0-9a-f]{64}$/u;
const revision = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const providers = new Set(["openai", "anthropic", "google", "openrouter"]);
const runStatuses = new Set(["queued", "placed", "running", "interrupted", "done", "unanswered", "failed", "cancelled"]);
const requestStatuses = new Set(["queued", "placed", "done", "unanswered"]);
const stopReasons = new Set<StopReason>(["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"]);
const contextCounters = ["estimatedTokens", "limitTokens", "modelWindowTokens", "maxOutputTokens"] as const;
const manifestCounters = ["tokenBudget", "estimatedTokens", "contextBytes", "trackedPaths", "candidateFiles", "scannedFiles", "matchedFiles"] as const;
const manifestLimits = ["trackedPaths", "scannedFiles", "fileBytes", "selectedFiles", "tokenBudget"] as const;
const maxFiles = 12;
const maxAtlasExcerpts = 32;
const maxDeferredExcerpts = 16;
const maxPackages = 3;

type Counters<K extends readonly string[]> = Partial<Record<K[number], number>>;
type FileRange = { path: string; startLine: number; endLine: number };
type RepositoryReport = Counters<typeof manifestCounters> & {
  id: string;
  workspaceRevision?: string;
  limitsReached?: Partial<Record<(typeof manifestLimits)[number], boolean>>;
  files: (FileRange & { sha256?: string })[];
  deferred?: (FileRange & { sha256?: string })[];
  index?: { indexedFiles: number; expandedFiles: number; limited: boolean };
};
type PackageReport = {
  project: string;
  requestId: string;
  status: "done" | "unanswered";
  usage?: Usage;
  sources?: FileRange[];
};
type RoutedCallReport = { model?: string; attempts: number; status: "done" | "unanswered"; usage?: Usage };
type OrchestrationReport = {
  mode: "single" | "fan-out";
  orders: (RoutedCallReport & { scope: string; requestId: string; sources: FileRange[] })[];
  synthesis?: RoutedCallReport;
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
    sourceLookup?: CodingSourceLookupReceipt;
    stopReason?: StopReason;
    usage?: Usage;
    repositoryContext?: RepositoryReport;
    files?: { path: string }[];
  };
  receipt?: { status: "done" | "unanswered"; stopReason?: StopReason; usage?: Usage; packageReviews?: PackageReport[]; orchestration?: OrchestrationReport };
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

function validModel(provider: string, model: unknown): boolean {
  return providers.has(provider) && (matches(model, modelName)
    || (provider === "openrouter" && matches(model, openRouterModelName) && model.length <= 256));
}

function modelKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const separator = value.indexOf("/");
  return separator > 0 && validModel(value.slice(0, separator), value.slice(separator + 1));
}

function ledger(value: UsageState): UsageState {
  const models = Object.fromEntries(Object.entries(value?.models ?? {}).flatMap(([key, raw]) => {
    const usage = modelKey(key) ? usageReport(raw) : undefined;
    return usage ? [[key, usage]] : [];
  }));
  const lookup = usageReport(value?.tools?.[approvedSourceToolName]);
  return { models, tools: lookup ? { [approvedSourceToolName]: lookup } : {} };
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
  const atlas = record(value.atlas) ? value.atlas : undefined;
  const ranges = (input: unknown, limit: number) => Array.isArray(input) ? input.slice(0, limit).flatMap((file) => {
    const range = fileRange(file);
    if (!range || !record(file)) return [];
    return [{ ...range, ...(matches(file.sha256, digest) ? { sha256: file.sha256 } : {}) }];
  }) : [];
  const files = ranges(value.files, atlas ? maxAtlasExcerpts : maxFiles);
  const deferred = ranges(atlas?.deferred, maxDeferredExcerpts);
  const limitsReached: NonNullable<RepositoryReport["limitsReached"]> = {};
  if (record(value.limitsReached)) for (const key of manifestLimits) {
    const limit = value.limitsReached[key];
    if (typeof limit === "boolean") limitsReached[key] = limit;
  }
  const index = value.index;
  return {
    id: value.id, files, ...(deferred.length ? { deferred } : {}), ...counters(value, manifestCounters),
    ...(matches(value.workspaceRevision, revision) ? { workspaceRevision: value.workspaceRevision } : {}),
    ...(Object.keys(limitsReached).length ? { limitsReached } : {}),
    ...(record(index) && count(index.indexedFiles) && count(index.expandedFiles) && typeof index.limited === "boolean" ? {
      index: { indexedFiles: index.indexedFiles, expandedFiles: index.expandedFiles, limited: index.limited },
    } : {}),
  };
}

function sourceLookupReport(value: unknown, sources: FileRange[] | undefined, files: { path: string }[] | undefined): CodingSourceLookupReceipt | undefined {
  if (!record(value)) return;
  const { refused, incomplete } = value;
  if (!count(refused) || !count(incomplete) || refused + incomplete > maxRecordedSourceLookups || !Array.isArray(value.served)) return;
  const served = value.served.slice(0, maxApprovedSourceLookups).flatMap((item) => {
    const range = approvedSourceLookupRange(item);
    if (!range) return [];
    const approved = sources ? sources.some((file) =>
      file.path === range.path && range.startLine >= file.startLine && range.endLine <= file.endLine)
      : files?.some((file) => file.path === range.path);
    return approved ? [range] : [];
  });
  return { served, refused, incomplete, ...(value.truncated === true || served.length !== value.served.length ? { truncated: true } : {}) };
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

function orchestrationReport(value: unknown, parentId: string): OrchestrationReport | undefined {
  if (!record(value) || (value.mode !== "single" && value.mode !== "fan-out") || !Array.isArray(value.orders)) return;
  function call(result: Record<string, unknown>, answer: unknown): RoutedCallReport {
    const usage = usageReport(result.usage);
    return {
      ...(modelKey(result.model) ? { model: result.model } : {}), attempts: count(result.attempts) ? result.attempts : 0,
      status: typeof answer === "string" && answer.trim() ? "done" : "unanswered", ...(usage ? { usage } : {}),
    };
  }
  const validIds = new Set(value.mode === "single" ? [`${parentId}-work`] : [1, 2, 3, 4].map((part) => `${parentId}-work-${part}`));
  const orders = value.orders.slice(0, validIds.size).flatMap((order) => {
    if (!record(order) || (order.scope !== "." && !safePath(order.scope)) || typeof order.requestId !== "string" || !validIds.delete(order.requestId)) return [];
    const sources = Array.isArray(order.sources) ? order.sources.slice(0, maxAtlasExcerpts).flatMap((file) => fileRange(file) ?? []) : [];
    return [{ scope: order.scope, requestId: order.requestId, sources, ...call(order, order.report) }];
  });
  return orders.length ? { mode: value.mode, orders, ...(record(value.synthesis) ? { synthesis: call(value.synthesis, value.synthesis.text) } : {}) } : undefined;
}

export function codingRunReport(
  pi: CodingSessionStatusResult | undefined,
  run: { requestId: string; status: string; projectId?: string; review?: string | null },
): CodingRunReport | undefined {
  const request = pi?.request;
  if (!pi || !request || run.requestId !== request.requestId || !matches(run.requestId, requestName) || !matches(pi.session, sessionName) ||
      !validModel(pi.provider, pi.model) || !runStatuses.has(run.status) || !requestStatuses.has(request.status)) return;

  const saved = request.receipt;
  const receipt = saved?.requestId === request.requestId && saved.session === pi.session && saved.status === request.status ? saved : undefined;
  const manifest = repositoryReport(request.repositoryContext ?? receipt?.repositoryContext);
  const savedFiles = request.savedSource?.source === "files" ? request.savedSource.files : undefined;
  const explicitPaths = Array.isArray(request.sourcePaths) ? request.sourcePaths
    : Array.isArray(savedFiles) ? savedFiles.slice(0, maxFiles).flatMap((file) => record(file) ? [file.path] : []) : undefined;
  const files = explicitPaths?.slice(0, maxFiles).filter(safePath).map((path) => ({ path }));
  const sourceLookup = request.status === "done" && request.approvedSourceLookup === true
    ? sourceLookupReport(request.sourceLookup, manifest && [...manifest.files, ...manifest.deferred ?? []], files) : undefined;
  const requestUsage = usageReport(request.usage);
  const receiptUsage = usageReport(receipt?.status === "done" ? receipt.usage : undefined);
  const packages = packageReports(receipt?.packageReviews, run.requestId);
  const orchestration = orchestrationReport(receipt?.orchestration, run.requestId);

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
      ...(sourceLookup ? { sourceLookup } : {}),
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
      ...(orchestration ? { orchestration } : {}),
    } } : {}),
    usage: ledger(pi.usage), rootUsage: ledger(pi.rootUsage),
  };
}
