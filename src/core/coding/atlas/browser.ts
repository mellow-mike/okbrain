import { log } from "../../log.ts";
import { excludedPath, readRevision } from "../repository-context.ts";
import { importRepository, type ImportOptions, type ImportProgress, type ImportReport } from "./import.ts";
import type { CommandTool } from "./packages.ts";
import { AtlasScanError, listTrackedPaths, readBranch, trackedAmong } from "./scan.ts";
import { Atlas, AtlasError, AtlasMissingError, type AtlasLocation } from "./store.ts";

type ImportView = {
  status: "idle" | "running" | "cancelling" | "completed" | "cancelled" | "failed";
  progress?: ImportProgress;
  report?: ImportReport;
  error?: string;
};

type ActiveImport = { view: ImportView; cancel: AbortController; done: Promise<void> };

export function browserImportOptions(input: Record<string, unknown>): Pick<ImportOptions, "full" | "historyCommits"> {
  const { full, historyCommits } = input;
  if (full !== undefined && typeof full !== "boolean") throw new AtlasError("Choose whether to rebuild the repository map.");
  if (historyCommits !== undefined && (typeof historyCommits !== "number" || !Number.isInteger(historyCommits) || historyCommits < 0 || historyCommits > 20_000))
    throw new AtlasError("Choose a history depth between 0 and 20,000 commits.");
  return { ...(full === undefined ? {} : { full }), ...(historyCommits === undefined ? {} : { historyCommits }) };
}

/** Browser polling and cancellation for the same leased imports the CLI uses. */
export class RepositoryImports {
  #imports = new Map<string, ActiveImport>();

  view(key: string): ImportView { return this.#imports.get(key)?.view ?? { status: "idle" }; }

  start(key: string, options: Omit<ImportOptions, "signal" | "progress">, location: AtlasLocation, completed?: () => void): ImportView {
    const current = this.#imports.get(key);
    if (current && (current.view.status === "running" || current.view.status === "cancelling")) return current.view;
    const cancel = new AbortController();
    const view: ImportView = { status: "running" };
    const done = importRepository({
      ...options, signal: cancel.signal, progress: (progress) => { view.progress = progress; },
    }, location).then((report) => {
      view.status = "completed";
      view.report = report;
      try { completed?.(); }
      catch (error) { log.warn("repository import audit was not recorded", { error: error instanceof Error ? error.message : "unknown" }); }
    }, (error: unknown) => {
      view.status = cancel.signal.aborted ? "cancelled" : "failed";
      if (view.status === "cancelled") return;
      view.error = error instanceof AtlasError ? error.message : "The repository import stopped before it finished. Try again.";
      if (!(error instanceof AtlasError)) log.warn("repository import failed", { error: error instanceof Error ? error.message : "unknown" });
    });
    this.#imports.delete(key);
    this.#imports.set(key, { view, cancel, done });
    for (const [previous, entry] of this.#imports) {
      if (this.#imports.size <= 64) break;
      if (previous !== key && entry.view.status !== "running" && entry.view.status !== "cancelling") this.#imports.delete(previous);
    }
    return view;
  }

  cancel(key: string): ImportView {
    const state = this.#imports.get(key);
    if (state?.view.status === "running") {
      state.view.status = "cancelling";
      state.cancel.abort();
    }
    return this.view(key);
  }

  async close(): Promise<void> {
    for (const key of this.#imports.keys()) this.cancel(key);
    await Promise.allSettled([...this.#imports.values()].map(({ done }) => done));
    this.#imports.clear();
  }
}

export async function browserRepositoryFiles(workspace: string, scopes: string[], location: AtlasLocation): Promise<{
  paths: string[]; limited: boolean; commands: CommandTool[]; branch?: string; revision?: string;
}> {
  try {
    const [{ paths, limited }, commands, branch, revision] = await Promise.all([
      listTrackedPaths(workspace, scopes, { maxPaths: 4000, timeoutMs: 20_000 }), declaredCommands(workspace, scopes, location),
      readBranch(workspace), readRevision(workspace).catch(() => undefined),
    ]);
    return { paths: paths.filter((path) => !excludedPath(path)), limited, commands, ...(branch ? { branch } : {}), ...(revision ? { revision: revision.slice(0, 12) } : {}) };
  } catch (error) {
    if (error instanceof AtlasScanError) throw new AtlasError(error.message, { cause: error });
    throw error;
  }
}

async function declaredCommands(workspace: string, scopes: string[], location: AtlasLocation): Promise<CommandTool[]> {
  let atlas: Atlas;
  try { atlas = Atlas.open(workspace, location); }
  catch (error) {
    if (error instanceof AtlasMissingError) return [];
    throw error;
  }
  const includes = (path: string) => scopes.some((scope) => scope === "." || path === scope || path.startsWith(`${scope}/`));
  const commands: CommandTool[] = [];
  try {
    using statement = atlas.prepare<{
      id: string; root: string; kind: CommandTool["kind"]; name: string; cwd: string; argv: string; source_path: string; source_line: number;
    }>(`SELECT t.id, p.root, t.kind, t.name, t.cwd, t.argv, t.source_path, t.source_line FROM tools t
         JOIN packages p ON p.id = t.package ORDER BY t.source_path, t.source_line, t.id`);
    for (const row of statement.iterate()) {
      if (!includes(row.source_path) || excludedPath(row.source_path)) continue;
      commands.push({ id: row.id, package: row.root, kind: row.kind, name: row.name, cwd: row.cwd,
        argv: JSON.parse(row.argv) as string[], source: { path: row.source_path, line: row.source_line } });
      if (commands.length === 128) break;
    }
  } finally { atlas.close(); }
  if (!commands.length) return commands;
  const tracked = await trackedAmong(workspace, commands.map(({ source }) => source.path));
  return commands.filter(({ source }) => tracked.has(source.path));
}
