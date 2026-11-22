import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createModels, fauxAssistantMessage, fauxProvider, getCurrentTools,
  type FauxModelDefinition, type TranscriptContext } from "@earendil-works/pi-ai";
import { chmod, mkdir, mkdtemp, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CodingError, CodingSessionBusyError, CodingSessionMissingError, deleteStandaloneCodingSession, getCodingSessionStatus,
  inspectStandaloneCodingSession, previewCodingAttachments, previewCodingContextReset, previewStandaloneCodingContextReset,
  resetCodingContext, resetStandaloneCodingContext, runCodingSession, type CodingSessionOptions,
} from "../src/core/coding/durable.ts";

let testDirectory: string;
let workspace: string;
let stateDir: string;
let options: CodingSessionOptions;

beforeEach(async () => {
  testDirectory = await mkdtemp(join(tmpdir(), "okb-coding-test-"));
  workspace = join(testDirectory, "workspace");
  stateDir = join(testDirectory, "state");
  await mkdir(workspace);
  options = {
    workspace,
    session: "review",
    requestId: "review-1",
    provider: "openai",
    model: "test-model",
  };
});

afterEach(async () => { await rm(testDirectory, { force: true, recursive: true }); });

function provider(limits: Omit<FauxModelDefinition, "id"> = {}) {
  const models = createModels();
  const faux = fauxProvider({ provider: options.provider, models: [{ id: options.model, ...limits }] });
  models.setProvider(faux.provider);
  return { models, faux };
}

test("Pi submits a Gemini request with the selected project key and reopens its durable receipt", async () => {
  const input = { ...options, provider: "google", model: "gemini-3.5-flash-lite", prompt: "Review the selected fixture." };
  const sent: { url: string; key: string | null; body: string }[] = [];
  const fixtureFetch = async (args: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const req = args instanceof Request ? new Request(args, init) : new Request(String(args), init);
    sent.push({ url: req.url, key: req.headers.get("x-goog-api-key"), body: await req.text() });
    const reply = {
      candidates: [{ content: { role: "model", parts: [{ text: "Gemini fixture result." }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4, totalTokenCount: 16 },
    };
    return new Response(`data: ${JSON.stringify(reply)}\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  };
  const transport = spyOn(globalThis, "fetch").mockImplementation(Object.assign(fixtureFetch, {
    preconnect() { throw new Error("Gemini test must stay offline."); },
  }));
  try {
    await expect(runCodingSession(input, { stateDir, allowEnvKey: false })).rejects.toThrow("Set a project API key");
    const result = await runCodingSession(input, { stateDir, apiKey: "fixture-gemini-key", allowEnvKey: false });
    expect(result).toMatchObject({ status: "done", text: "Gemini fixture result.", usage: { totalTokens: 16 } });
    expect(sent).toHaveLength(1);
    expect(new URL(sent[0]!.url).hostname).toBe("generativelanguage.googleapis.com");
    expect(sent[0]!.url).toContain("/models/gemini-3.5-flash-lite:streamGenerateContent");
    expect(sent[0]!.key).toBe("fixture-gemini-key");
    expect(sent[0]!.body).toContain(input.prompt);
    expect(sent[0]!.body).not.toContain("fixture-gemini-key");
    expect(await runCodingSession(input, { stateDir, allowEnvKey: false })).toEqual(result);
    expect(await getCodingSessionStatus(input, { stateDir, allowEnvKey: false })).toMatchObject({
      provider: "google", model: input.model, usage: { models: { ["google/" + input.model]: { totalTokens: 16 } } },
    });
    expect(sent).toHaveLength(1);
  } finally { transport.mockRestore(); }
});

test("persists a coding conversation and its answer across separate harness openings", async () => {
  const { models, faux } = provider();
  const requests: TranscriptContext[] = [];
  let sessionAffinity: string | undefined;
  const sessionDirectory = join(stateDir, `session-${options.session}`);
  if (process.platform !== "win32") {
    await mkdir(sessionDirectory, { recursive: true });
    await chmod(sessionDirectory, 0o755);
  }
  await writeFile(join(workspace, "example.ts"), "export const count = 1;\n");
  faux.setResponses([(input, stream) => {
    requests.push(input);
    sessionAffinity = stream?.sessionId;
    return fauxAssistantMessage("The constant is defined in example.ts.");
  }]);
  const result = await runCodingSession({ ...options, prompt: "Review this file", files: ["example.ts"] }, { stateDir, models });
  expect(result).toMatchObject({
    session: options.session,
    requestId: options.requestId,
    status: "done",
    text: "The constant is defined in example.ts.",
    stopReason: "stop",
    usage: { input: expect.any(Number), output: expect.any(Number), totalTokens: expect.any(Number) },
  });
  expect(sessionAffinity).toMatch(/^[0-9a-f]{64}$/u);
  if (process.platform !== "win32") expect((await stat(sessionDirectory)).mode & 0o777).toBe(0o700);
  const messages = requests[0]?.messages ?? [];
  expect(getCurrentTools(messages)).toEqual([]);
  expect(messages.findLast((message) => message.role === "user")).toMatchObject({
    role: "user",
    content: JSON.stringify({
      task: "Review this file",
      files: [{ path: "example.ts", content: "export const count = 1;\n" }],
    }),
  });
  await rm(join(workspace, "example.ts"));
  expect(await runCodingSession({ ...options, files: ["example.ts"] }, { stateDir, models })).toEqual(result);
  expect(faux.state.callCount).toBe(1);

  faux.setResponses([(input, stream) => {
    expect(input.messages.some((message) => message.role === "assistant")).toBe(true);
    expect(stream?.sessionId).toBe(sessionAffinity);
    return fauxAssistantMessage("A follow-up answer.");
  }]);
  expect(await runCodingSession({ ...options, requestId: "follow-up", prompt: "What next?" }, { stateDir, models }))
    .toMatchObject({ status: "done", text: "A follow-up answer.", usage: { cacheRead: expect.any(Number) } });
  const status = await getCodingSessionStatus({ ...options, requestId: "follow-up" }, { stateDir, models });
  expect(status.request?.usage?.cacheRead ?? 0).toBeGreaterThan(0);

  await expect(runCodingSession({ ...options, workspace: testDirectory }, { stateDir, models }))
    .rejects.toThrow("different workspace or model");
  await expect(runCodingSession({ ...options, model: "another-model" }, { stateDir, models }))
    .rejects.toThrow("different workspace or model");
});

test("persisted session usage includes a failed provider attempt alongside completed request usage", async () => {
  const { models, faux } = provider();
  const dependencies = { stateDir, models };
  faux.setResponses([fauxAssistantMessage("A completed answer.")]);
  const completed = await runCodingSession({ ...options, prompt: "Complete the first request." }, dependencies);
  if (completed.status !== "done") throw new Error(completed.reason);

  faux.setResponses([fauxAssistantMessage("Partial output from the failed attempt.", {
    stopReason: "error", errorMessage: "Invalid credentials",
  })]);
  const failed = await runCodingSession({ ...options, requestId: "failed-1", prompt: "Inspect a later request." }, dependencies);
  expect(failed.status).toBe("unanswered");
  const calls = faux.state.callCount;
  const saved = await getCodingSessionStatus({ ...options, includeReceipt: true }, dependencies);
  expect(saved.request?.usage).toEqual(completed.usage);
  expect(saved.rootUsage).toEqual(saved.usage);
  expect(saved.usage.models["openai/test-model"]?.totalTokens ?? 0).toBeGreaterThan(completed.usage.totalTokens);
  expect((await getCodingSessionStatus({ ...options, requestId: "failed-1" }, dependencies)).usage).toEqual(saved.usage);
  expect(faux.state.callCount).toBe(calls);
});

test("uses Pi threshold compaction locally and keeps old answers and committed usage accessible", async () => {
  const { models, faux } = provider({ contextWindow: 3200, maxTokens: 400 });
  const dependencies = { stateDir, models };
  const expired = "old-source-body".repeat(390);
  const retained = "current-source-body".repeat(300);
  await writeFile(join(workspace, "old.ts"), expired);
  await writeFile(join(workspace, "current.ts"), retained);
  await expect(getCodingSessionStatus(options, dependencies)).rejects.toThrow("No coding session");
  faux.setResponses([
    (_input, stream) => {
      expect(stream?.maxTokens).toBe(400);
      return fauxAssistantMessage("Initial review details.");
    },
    (input) => {
      const messages = JSON.stringify(input.messages);
      expect(messages).not.toContain(expired);
      expect(messages).toContain(retained);
      expect(messages).toContain("Older coding turns are retained locally");
      expect(messages).toContain("Initial review details");
      expect(messages).toContain("old.ts");
      return fauxAssistantMessage("Follow-up review.", { stopReason: "length" });
    },
  ]);
  const first = await runCodingSession({ ...options, prompt: "Review old source", files: ["old.ts"] }, dependencies);
  const second = await runCodingSession({
    ...options, requestId: "follow-up", prompt: "Review current source", files: ["current.ts"],
  }, dependencies);
  if (first.status !== "done" || second.status !== "done") throw new Error("The requests should succeed");
  expect(second.stopReason).toBe("length");
  expect(await runCodingSession(options, dependencies)).toEqual(first);
  expect(await getCodingSessionStatus(options, dependencies)).toMatchObject({
    pendingRequestIds: [],
    request: { requestId: options.requestId, status: "done", usage: first.usage },
    context: { historyCompacted: true, limitTokens: 2400, maxOutputTokens: 400, modelWindowTokens: 3200 },
    usage: { models: { "openai/test-model": { totalTokens: first.usage.totalTokens + second.usage.totalTokens } } },
  });
  expect(faux.state.callCount).toBe(2);
});

test("fresh context preserves archived receipts and safely replays a confirmed reset after later work", async () => {
  const { models, faux } = provider();
  const dependencies = { stateDir, models };
  const original = "original evidence before a deliberate context reset";
  const revised = "different evidence selected after the context reset";
  const source = join(workspace, "evidence.txt");
  await writeFile(source, original);
  const first = { ...options, prompt: "Check the first fixture", files: ["evidence.txt"] };
  faux.setResponses([fauxAssistantMessage("Archived first answer.")]);
  const receipt = await runCodingSession(first, dependencies);
  expect(receipt).toMatchObject({ status: "done", text: "Archived first answer." });

  const confirmed = await previewCodingContextReset(options, dependencies);
  expect(confirmed.version).toMatch(/^[a-f0-9]{64}$/u);
  expect(await previewCodingContextReset(options, dependencies)).toEqual(confirmed);
  await expect(previewCodingContextReset({ ...options, model: "another-model" }, dependencies)).rejects.toThrow("different workspace or model");
  const denied = new Error("The selected mount became read-only.");
  const authorize = () => { throw denied; };
  await expect(resetCodingContext({ ...options, ...confirmed }, dependencies, authorize)).rejects.toBe(denied);
  expect(await previewCodingContextReset(options, dependencies)).toEqual(confirmed);
  expect(await resetCodingContext({ ...options, ...confirmed }, dependencies)).toEqual({ reset: true, ...confirmed });
  expect(faux.state.callCount).toBe(1);

  const stale = await previewCodingContextReset(options, dependencies);
  expect(stale.version).not.toBe(confirmed.version);
  await writeFile(source, revised);
  const archived = await getCodingSessionStatus({ ...options, includeReceipt: true, includeSavedSource: true }, dependencies);
  expect(archived).toMatchObject({ request: { receipt, savedSource: { files: [{ path: "evidence.txt", content: original }] } } });
  expect(faux.state.callCount).toBe(1);

  const providerInputs: string[] = [];
  faux.setResponses([
    (input) => { providerInputs.push(JSON.stringify(input.messages)); return fauxAssistantMessage("Second answer after reset."); },
    (input) => { providerInputs.push(JSON.stringify(input.messages)); return fauxAssistantMessage("Third answer after replay."); },
  ]);
  const second = { ...first, requestId: "second", prompt: "Check the new fixture" };
  expect(await runCodingSession(second, dependencies)).toMatchObject({ status: "done", text: "Second answer after reset." });
  expect(providerInputs[0]).toContain(revised);
  expect(providerInputs[0]).not.toContain(original);
  expect(providerInputs[0]).not.toContain(first.prompt);
  expect(providerInputs[0]).not.toContain("Archived first answer.");

  const current = await previewCodingContextReset(options, dependencies);
  await expect(resetCodingContext({ ...options, ...stale }, dependencies)).rejects.toThrow("context changed");
  expect(await resetCodingContext({ ...options, ...confirmed }, dependencies, authorize)).toEqual({ reset: true, ...confirmed, replayed: true });
  expect(await previewCodingContextReset(options, dependencies)).toEqual(current);
  expect(faux.state.callCount).toBe(2);
  expect(await runCodingSession({ ...options, requestId: "third", prompt: "Continue with the new fixture" }, dependencies))
    .toMatchObject({ status: "done" });
  expect(providerInputs[1]).toContain("Second answer after reset.");
  expect(providerInputs[1]).not.toContain("Archived first answer.");
  expect(faux.state.callCount).toBe(3);
});

test("standalone reset uses the saved binding and rejects a preview from a deleted transcript", async () => {
  const { models, faux } = provider();
  const dependencies = { stateDir, models };
  const request = { ...options, prompt: "Fixture task" };
  faux.setResponses([fauxAssistantMessage("Fixture answer."), fauxAssistantMessage("Fixture answer.")]);
  const receipt = await runCodingSession(request, dependencies);
  const confirmed = await previewStandaloneCodingContextReset(options.session, dependencies);
  const moved = join(testDirectory, "workspace-moved");
  await rename(workspace, moved);
  expect(await resetStandaloneCodingContext(options.session, confirmed.version, dependencies))
    .toEqual({ reset: true, ...confirmed });
  expect(await inspectStandaloneCodingSession(options.session, options.requestId, dependencies))
    .toMatchObject({ request: { receipt } });
  expect(faux.state.callCount).toBe(1);

  expect(await deleteStandaloneCodingSession(options.session, dependencies)).toBe(true);
  await expect(previewStandaloneCodingContextReset(options.session, dependencies)).rejects.toBeInstanceOf(CodingSessionMissingError);
  await expect(resetStandaloneCodingContext(options.session, confirmed.version, dependencies)).rejects.toBeInstanceOf(CodingSessionMissingError);
  await rename(moved, workspace);
  expect(await runCodingSession(request, dependencies)).toMatchObject({ status: "done" });
  await expect(resetStandaloneCodingContext(options.session, confirmed.version, dependencies)).rejects.toThrow("context changed");
  expect(faux.state.callCount).toBe(2);
});

test("refuses a new request that cannot fit the model budget before admission", async () => {
  const { models, faux } = provider({ contextWindow: 3200, maxTokens: 400 });
  const dependencies = { stateDir, models };
  await expect(runCodingSession({ ...options, prompt: "text ".repeat(2000) }, dependencies))
    .rejects.toThrow("new coding request exceeds the 2400-token input budget");
  await expect(runCodingSession(options, dependencies)).rejects.toThrow("No saved request");
  expect(faux.state.callCount).toBe(0);
});

test("rejects attachments outside the workspace and caps selected text before calling the model", async () => {
  const { models, faux } = provider();
  const request = { ...options, prompt: "Review this file" };
  const outside = join(testDirectory, "outside.txt");
  await writeFile(outside, "private text");
  await expect(runCodingSession({ ...request, files: ["../outside.txt"] }, { stateDir, models }))
    .rejects.toThrow("inside the coding workspace");
  await expect(runCodingSession({ ...request, files: [outside] }, { stateDir, models }))
    .rejects.toThrow("workspace-relative");
  if (process.platform !== "win32") {
    await symlink(outside, join(workspace, "link.txt"));
    await expect(runCodingSession({ ...request, files: ["link.txt"] }, { stateDir, models }))
      .rejects.toThrow("inside the coding workspace");
  }
  await writeFile(join(workspace, "large.txt"), "a".repeat(32 * 1024 + 1));
  await expect(runCodingSession({ ...request, files: ["large.txt"] }, { stateDir, models }))
    .rejects.toThrow("context size limit");
  await writeFile(join(workspace, "binary"), Buffer.from([0xff, 0xfe]));
  await expect(runCodingSession({ ...request, files: ["binary"] }, { stateDir, models }))
    .rejects.toThrow("as text");
  await expect(runCodingSession(options, { stateDir, models })).rejects.toBeInstanceOf(CodingError);
  expect(faux.state.callCount).toBe(0);
});

test("resumes an interrupted Pi Durable request using the original attachment bytes", async () => {
  const { models, faux } = provider();
  const priorOptions = { ...options, requestId: "completed" };
  faux.setResponses([fauxAssistantMessage("A saved answer.")]);
  const prior = await runCodingSession({ ...priorOptions, prompt: "Review the plan" }, { stateDir, models });
  const resetPreview = await previewCodingContextReset(options, { stateDir, models });
  const attachment = join(workspace, "original.txt");
  await writeFile(attachment, "original bytes");
  const script = `
    import { createModels, fauxProvider } from "@earendil-works/pi-ai";
    import { runCodingSession } from "./src/core/coding/durable.ts";
    const { options, stateDir } = JSON.parse(process.argv.at(-1));
    const models = createModels();
    const faux = fauxProvider({ provider: options.provider, models: [{ id: options.model }] });
    models.setProvider(faux.provider);
    faux.setResponses([() => {
      console.log("generation-started");
      return new Promise(() => {});
    }]);
    const keepAlive = setInterval(() => {}, 1000);
    try { await runCodingSession(options, { stateDir, models }); }
    finally { clearInterval(keepAlive); }
  `;
  const processArgs = JSON.stringify({ stateDir, options: { ...options, prompt: "Read this", files: ["original.txt"] } });
  const child = Bun.spawn([process.execPath, "-e", script, "--", processArgs], {
    cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "inherit",
  });
  const startupTimeout = setTimeout(() => child.kill("SIGKILL"), 10_000);

  try {
    const reader = child.stdout.getReader();
    const marker = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(marker.value).trim()).toBe("generation-started");
    await expect(runCodingSession(options, { stateDir, models })).rejects.toThrow("already open");
    await expect(previewCodingContextReset(options, { stateDir, models })).rejects.toBeInstanceOf(CodingSessionBusyError);
    await expect(resetCodingContext({ ...options, ...resetPreview }, { stateDir, models })).rejects.toBeInstanceOf(CodingSessionBusyError);
  } finally {
    clearTimeout(startupTimeout);
    child.kill("SIGKILL");
    await child.exited;
  }

  await rm(attachment);
  expect(await runCodingSession(priorOptions, { stateDir, models })).toEqual(prior);
  expect(await getCodingSessionStatus(options, { stateDir, models })).toMatchObject({
    pendingRequestIds: [options.requestId],
    request: { requestId: options.requestId, status: "placed" },
  });
  await expect(previewCodingContextReset(options, { stateDir, models })).rejects.toThrow("Finish or cancel pending coding work");
  await expect(resetCodingContext({ ...options, ...resetPreview }, { stateDir, models })).rejects.toThrow("Finish or cancel pending coding work");
  expect(faux.state.callCount).toBe(1);
  faux.setResponses([(input) => {
    expect(JSON.stringify(input.messages)).toContain("original bytes");
    return fauxAssistantMessage("Recovered from the saved request.");
  }]);
  expect(await runCodingSession(options, { stateDir, models })).toMatchObject({
    status: "done",
    text: "Recovered from the saved request.",
  });
  expect(faux.state.callCount).toBe(2);
}, 15_000);

test("replays an interrupted approved-source tool using the saved input with no checkout", async () => {
  const { models, faux } = provider();
  const bound = { ...options, workspace: await realpath(workspace) };
  const original = "const first = 1;\nconst second = 2;\n";
  await writeFile(join(bound.workspace, "approved.ts"), original);
  const files = ["approved.ts"];
  const { id } = await previewCodingAttachments(bound.workspace, files);
  const script = `
    import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
    import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
    import { runCodingSession } from "./src/core/coding/durable.ts";
    import { approvedSourceToolName } from "./src/core/coding/approved-source-tool.ts";
    const { options, stateDir } = JSON.parse(process.argv.at(-1));
    const models = createModels();
    const faux = fauxProvider({ provider: options.provider, models: [{ id: options.model }] });
    models.setProvider(faux.provider);
    let emitted = false;
    faux.setResponses([() => {
      emitted = true;
      return fauxAssistantMessage(fauxToolCall(approvedSourceToolName, {
        path: "approved.ts", startLine: 2, endLine: 2,
      }, { id: "durable-lookup" }), { stopReason: "toolUse" });
    }]);
    const entry = SqliteStorage.prototype.entry;
    SqliteStorage.prototype.entry = async function (...args) {
      const result = await entry.apply(this, args);
      const user = result?.entry.model?.[0];
      if (emitted && user?.role === "user" && typeof user.content === "string" && JSON.parse(user.content).approvedSourceLookup) {
        console.log("lookup-reading-saved-input");
        return new Promise(() => {});
      }
      return result;
    };
    const keepAlive = setInterval(() => {}, 1000);
    try { await runCodingSession(options, { stateDir, models, workspaceBinding: options.workspace }); }
    finally { clearInterval(keepAlive); }
  `;
  const input = { ...bound, prompt: "Check the second line.", files, filePreviewId: id, approvedSourceLookup: true };
  const child = Bun.spawn([process.execPath, "-e", script, "--", JSON.stringify({ stateDir, options: input })], {
    cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "inherit",
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    const reader = child.stdout.getReader();
    const marker = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(marker.value).trim()).toBe("lookup-reading-saved-input");
  } finally {
    clearTimeout(timeout);
    child.kill("SIGKILL");
    await child.exited;
  }

  await rename(bound.workspace, join(testDirectory, "checkout-moved"));
  const dependencies = { stateDir, models, workspaceBinding: bound.workspace };
  expect(await getCodingSessionStatus(bound, dependencies)).toMatchObject({ request: { status: "placed" } });
  faux.setResponses([(input, options) => {
    expect(options?.toolChoice).toBe("none");
    const results = input.messages.filter((message) => message.role === "toolResult");
    expect(results.map(({ toolCallId, isError }) => ({ toolCallId, isError })))
      .toEqual([{ toolCallId: "durable-lookup", isError: false }]);
    const result = results[0]?.content[0];
    expect(result?.type === "text" && JSON.parse(result.text)).toEqual({
      path: "approved.ts", startLine: 2, endLine: 2, content: "const second = 2;",
    });
    return fauxAssistantMessage("Recovered safely from the approved lookup.");
  }]);
  const settled = await runCodingSession(bound, dependencies);
  expect(settled).toMatchObject({ status: "done", text: "Recovered safely from the approved lookup." });
  if (settled.status !== "done") throw new Error("The replay must complete.");
  const status = await getCodingSessionStatus({ ...bound, includeReceipt: true }, dependencies);
  expect(status.request?.receipt).toEqual(settled);
  expect(status.usage.models["openai/test-model"]?.totalTokens).toBe(settled.usage.totalTokens);
  expect(faux.state.callCount).toBe(1);
}, 15_000);
