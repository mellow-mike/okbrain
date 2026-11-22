import type { Context } from "@earendil-works/chord";
import {
  LiveDoc, type ConversationId, type Harness, type LiveState, type SubmissionId,
  type TaskGraph, type TaskGraphNode, type TaskId,
} from "@earendil-works/pi-durable";
import { approvedSourceToolName } from "./approved-source-tool.ts";
import { packageReviewTaskName } from "./package-review.ts";

const kinds = ["package-review", "package-work", "context", "model", "source-lookup", "work"] as const;
const maxCount = 64;

type ProgressKind = typeof kinds[number];

export interface CodingTaskProgress {
  stages: {
    kind: ProgressKind;
    pending: number;
    running: number;
    waiting: number;
    completing: number;
  }[];
}

type Stage = CodingTaskProgress["stages"][number];
type SelectedRun = { task: TaskId } | { conversation: ConversationId; submission: SubmissionId };
type Publish = (progress: CodingTaskProgress | undefined) => void | Promise<void>;

const emptyProgress = (): CodingTaskProgress => ({ stages: [] });

function stageKind(task: TaskGraphNode, lookups: ReadonlySet<TaskId>): ProgressKind {
  switch (task.kind) {
    case packageReviewTaskName: return "package-review";
    case "okbrain.review-package": return "package-work";
    case "pi.compaction": return "context";
    case "pi.generation": return "model";
    case "pi.tool": return lookups.has(task.id) ? "source-lookup" : "work";
    default: return "work";
  }
}

function projectTaskProgress(graph: TaskGraph, root: TaskId, lookups: ReadonlySet<TaskId>): CodingTaskProgress {
  const first = graph.tasks[String(root)];
  if (!first) return emptyProgress();
  const childTasks = new Map<TaskId, TaskGraphNode[]>();
  const conversationTasks = new Map<ConversationId, TaskGraphNode[]>();
  for (const task of Object.values(graph.tasks)) {
    if (task.background) continue;
    if (task.owner !== undefined) {
      const owned = childTasks.get(task.owner) ?? [];
      owned.push(task);
      childTasks.set(task.owner, owned);
    } else {
      const owned = conversationTasks.get(task.conversationId) ?? [];
      owned.push(task);
      conversationTasks.set(task.conversationId, owned);
    }
  }
  const stages = new Map<ProgressKind, Stage>();
  const visited = new Set<TaskId>();
  const pending = [first];
  while (pending.length) {
    const task = pending.pop()!;
    if (task.background || visited.has(task.id)) continue;
    visited.add(task.id);
    const kind = stageKind(task, lookups);
    const stage = stages.get(kind) ?? { kind, pending: 0, running: 0, waiting: 0, completing: 0 };
    const status = task.state.status;
    stage[status] = Math.min(maxCount, stage[status] + 1);
    stages.set(kind, stage);
    for (const child of childTasks.get(task.id) ?? []) pending.push(child);
    for (const id of task.conversations)
      for (const child of conversationTasks.get(id) ?? []) pending.push(child);
  }
  return { stages: kinds.flatMap((kind) => stages.get(kind) ?? []) };
}

function view(graph: TaskGraph, selection: SelectedRun, live?: Readonly<LiveState> | null): CodingTaskProgress {
  if ("task" in selection) return projectTaskProgress(graph, selection.task, new Set());
  if (!live?.run?.inputs.includes(selection.submission)) return emptyProgress();
  const lookups = new Set(live.tools?.flatMap(({ name, taskId }) =>
    name === approvedSourceToolName && taskId !== undefined ? [taskId] : []) ?? []);
  return projectTaskProgress(graph, live.run.taskId, lookups);
}

function numberOfTasks(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= maxCount;
}

/** Copy only known counts and labels from a worker message. */
export function parseCodingTaskProgress(value: unknown): CodingTaskProgress | undefined {
  if (!value || typeof value !== "object" || !("stages" in value) || !Array.isArray(value.stages) || value.stages.length > kinds.length)
    return undefined;
  const stages = new Map<ProgressKind, Stage>();
  for (const row of value.stages) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return undefined;
    const { kind, pending, running, waiting, completing } = row as Record<string, unknown>;
    const knownKind = kinds.find((entry) => entry === kind);
    if (!knownKind || stages.has(knownKind) || !numberOfTasks(pending) || !numberOfTasks(running)
      || !numberOfTasks(waiting) || !numberOfTasks(completing)) return undefined;
    stages.set(knownKind, { kind: knownKind, pending, running, waiting, completing });
  }
  return { stages: kinds.flatMap((kind) => stages.get(kind) ?? []) };
}

/** Inspect durable progress without enabling task scheduling. */
export async function readCodingTaskProgress(harness: Harness, selection: SelectedRun, context: Context): Promise<CodingTaskProgress | undefined> {
  const live = "submission" in selection ? await harness.snapshot(LiveDoc, selection.conversation, context) : undefined;
  if ("submission" in selection && !live?.run?.inputs.includes(selection.submission)) return;
  const graph = await harness.taskGraph(context);
  try {
    const result = view(graph.value, selection, live);
    return result.stages.length ? result : undefined;
  } finally {
    graph.dispose();
  }
}

/** Observe changes from committed task state and the selected submission's ownership link. */
export async function observeCodingTaskProgress(
  harness: Harness, selection: SelectedRun, publish: Publish, context: Context,
): Promise<() => Promise<void>> {
  const live = "submission" in selection ? await harness.documentState(LiveDoc, selection.conversation, context) : undefined;
  let graph;
  try { graph = await harness.taskGraph(context); }
  catch (error) {
    live?.dispose();
    throw error;
  }
  const state = graph;
  let closed = false;
  let last = JSON.stringify(emptyProgress());
  let hasTasks = false;
  let delivery = Promise.resolve();

  function update() {
    if (closed) return;
    const result = view(state.value, selection, live?.value);
    const key = JSON.stringify(result);
    if (key === last) return;
    last = key;
    delivery = delivery.then(async () => {
      if (closed) return;
      hasTasks = result.stages.length > 0;
      await publish(result);
    }).catch(() => {});
    return delivery;
  }

  const unsubscribe = state.subscribe(update);
  const unsubscribeLive = live?.subscribe(update);
  return async () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    unsubscribeLive?.();
    state.dispose();
    live?.dispose();
    await delivery;
    if (hasTasks) {
      try { await publish(emptyProgress()); } catch { /* Progress delivery is advisory. */ }
    }
  };
}
