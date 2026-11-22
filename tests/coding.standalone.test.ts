import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { copyFile, link, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodingSessionBusyError, getCodingSessionStatus, getStandaloneCodingIdentity, inspectStandaloneCodingSession,
  listStandaloneCodingRequests, listStandaloneCodingSessions, runCodingSession,
} from "../src/core/coding/durable.ts";
import { selectRepositoryContext } from "../src/core/coding/repository-context.ts";
import { ensureExtensionCapableSqlite } from "../src/core/engine/custom-sqlite.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "okb-standalone-"));
  const folder = join(root, "workspace");
  await mkdir(folder);
  const workspace = await realpath(folder);
  const provider = "openai" as const;
  const model = "standalone-test";
  const models = createModels();
  const faux = fauxProvider({ provider, models: [{ id: model }] });
  models.setProvider(faux.provider);
  return {
    root, options: { session: "legacy", requestId: "legacy-1", workspace, provider, model },
    dependencies: { stateDir: join(root, "coding"), models }, faux,
  };
}

test("discovers existing Pi records and inspects saved source without rereading a detached workspace", async () => {
  const { root, options, dependencies, faux } = await fixture();
  try {
    expect(await listStandaloneCodingSessions(dependencies)).toEqual([]);
    const source = "export const exact = 'Approved bytes';\r\n";
    await writeFile(join(options.workspace, "source.ts"), source);
    const prompt = "Review the original source.";
    faux.setResponses([fauxAssistantMessage("Legacy answer"), fauxAssistantMessage("Newer answer")]);
    const original = await runCodingSession({ ...options, prompt, files: ["source.ts"] }, dependencies);
    await expect(runCodingSession({ ...options, prompt: "Different input with the same ID" }, {
      ...dependencies, requireNewRequest: true,
    })).rejects.toThrow("This request ID is already saved.");
    expect(await runCodingSession(options, dependencies)).toEqual(original);
    const plain = await getCodingSessionStatus({ ...options, includeReceipt: true }, dependencies);
    expect(plain.request?.savedSource).toBeUndefined();
    await runCodingSession({ ...options, requestId: "legacy-2", prompt: "A follow-up" }, dependencies);

    await writeFile(join(options.workspace, "source.ts"), "This was never approved.");
    await rename(options.workspace, join(root, "moved-workspace"));
    const { requestId: _, ...identity } = options;
    expect(await listStandaloneCodingSessions(dependencies)).toEqual([{ state: "ready", ...identity }]);
    expect(await listStandaloneCodingRequests(options.session, dependencies)).toEqual({
      identity, requests: [
        { requestId: "legacy-2", kind: "request", status: "done" },
        { requestId: options.requestId, kind: "request", status: "done" },
      ],
    });
    const inspected = await inspectStandaloneCodingSession(options.session, options.requestId, dependencies);
    expect(inspected.request).toMatchObject({
      requestId: options.requestId, status: "done", savedPrompt: prompt,
      receipt: { text: "Legacy answer" },
      savedSource: { source: "files", files: [{ path: "source.ts", content: source }] },
    });
    expect(faux.state.callCount).toBe(2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("identifies busy sessions from the existing SQLite lease", async () => {
  const { root, options, dependencies, faux } = await fixture();
  try {
    faux.setResponses([fauxAssistantMessage("Approved answer")]);
    await runCodingSession({ ...options, prompt: "Show the lease" }, dependencies);
    ensureExtensionCapableSqlite();
    const lease = new Database(join(dependencies.stateDir, "session-legacy", "owner.sqlite"), { readwrite: true, create: false });
    try {
      lease.exec("BEGIN IMMEDIATE");
      expect(await listStandaloneCodingSessions(dependencies)).toEqual([{ session: "legacy", state: "busy" }]);
      await expect(getStandaloneCodingIdentity("legacy", dependencies)).rejects.toBeInstanceOf(CodingSessionBusyError);
    } finally { lease.close(); }
    expect((await listStandaloneCodingSessions(dependencies))[0]?.state).toBe("ready");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("returns the archived repository preview exactly after tracked source changes", async () => {
  const { root, options, dependencies, faux } = await fixture();
  try {
    const path = join(options.workspace, "source.ts");
    await writeFile(path, "export const reviewedRepositoryFixture = 1;\n");
    for (const args of [["init", "--quiet"], ["add", "--", "source.ts"]]) {
      const git = Bun.spawnSync(["git", ...args], { cwd: options.workspace });
      expect(git.exitCode, git.stderr.toString()).toBe(0);
    }
    const selection = { projects: ["."], query: "reviewedRepositoryFixture", tokenBudget: 500 };
    const preview = await selectRepositoryContext({ ...selection, workspace: options.workspace });
    expect(preview.excerpts).toHaveLength(1);
    faux.setResponses([fauxAssistantMessage("The saved repository preview was reviewed.")]);
    await runCodingSession({ ...options, prompt: "Assess this repository source",
      repository: { ...selection, id: preview.manifest.id } }, dependencies);
    await writeFile(path, "export const reviewedRepositoryFixture = 'never approved';\n");
    const inspected = await inspectStandaloneCodingSession(options.session, options.requestId, dependencies);
    expect(inspected.request?.savedSource).toEqual({ source: "repository", manifest: preview.manifest, excerpts: preview.excerpts });
    expect(faux.state.callCount).toBe(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects aliases to private standalone database paths and isolates invalid entries", async () => {
  const { root, options, dependencies, faux } = await fixture();
  try {
    faux.setResponses([fauxAssistantMessage("Approved answer")]);
    await runCodingSession({ ...options, prompt: "Protect the transcript" }, dependencies);
    const sessionDir = join(dependencies.stateDir, "session-legacy");
    const copied = join(root, "outside.sqlite");
    await copyFile(join(sessionDir, "transcript.sqlite"), copied);
    const other = join(dependencies.stateDir, "session-other");
    await mkdir(other);
    await link(copied, join(other, "transcript.sqlite"));
    expect(await listStandaloneCodingSessions(dependencies)).toMatchObject([
      { session: "legacy", state: "ready" }, { session: "other", state: "unavailable" },
    ]);
    await expect(inspectStandaloneCodingSession("other", options.requestId, dependencies)).rejects.toThrow("regular private files");
    const unsafeLease = join(dependencies.stateDir, "session-lease");
    await mkdir(unsafeLease);
    await link(copied, join(unsafeLease, "owner.sqlite"));
    await expect(runCodingSession({ ...options, session: "lease", prompt: "Refuse alias" }, dependencies))
      .rejects.toThrow("regular private files");
    await expect(getStandaloneCodingIdentity("../workspace", dependencies)).rejects.toThrow("Use a session name");
    if (process.platform !== "win32") {
      await symlink(sessionDir, join(dependencies.stateDir, "session-alias"), "dir");
      await expect(getStandaloneCodingIdentity("alias", dependencies)).rejects.toThrow("must be a directory");
      const rootAlias = join(root, "coding-alias");
      await symlink(dependencies.stateDir, rootAlias, "dir");
      await expect(listStandaloneCodingSessions({ stateDir: rootAlias })).rejects.toThrow("must be a local directory");
      const sidecar = join(dependencies.stateDir, "session-sidecar");
      await mkdir(sidecar);
      await symlink(copied, join(sidecar, "transcript.sqlite-wal"));
      await expect(runCodingSession({ ...options, session: "sidecar", prompt: "Refuse sidecar alias" }, dependencies))
        .rejects.toThrow("regular private files");
    }
    expect(faux.state.callCount).toBe(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
