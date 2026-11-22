import { afterEach, beforeEach, expect, test } from "bun:test";
import { createModels, fauxAssistantMessage, fauxProvider, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CodingError, runCodingSession, type CodingSessionOptions } from "../src/core/coding/durable.ts";

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

afterEach(async () => {
  // Windows can briefly keep the crashed child's SQLite files locked.
  await rm(testDirectory, { force: true, recursive: true, maxRetries: 8, retryDelay: 100 });
});

function provider() {
  const models = createModels();
  const faux = fauxProvider({ provider: options.provider, models: [{ id: options.model }] });
  models.setProvider(faux.provider);
  return { models, faux };
}

test("persists a coding conversation and its answer across separate harness openings", async () => {
  const { models, faux } = provider();
  const requests: TranscriptContext[] = [];
  const sessionDirectory = join(stateDir, `session-${options.session}`);
  if (process.platform !== "win32") {
    await mkdir(sessionDirectory, { recursive: true });
    await chmod(sessionDirectory, 0o755);
  }
  await writeFile(join(workspace, "example.ts"), "export const count = 1;\n");
  faux.setResponses([(input) => {
    requests.push(input);
    return fauxAssistantMessage("The constant is defined in example.ts.");
  }]);
  const result = await runCodingSession({ ...options, prompt: "Review this file", files: ["example.ts"] }, { stateDir, models });
  expect(result).toEqual({
    session: options.session,
    requestId: options.requestId,
    status: "done",
    text: "The constant is defined in example.ts.",
  });
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

  faux.setResponses([(input) => {
    expect(input.messages.some((message) => message.role === "assistant")).toBe(true);
    return fauxAssistantMessage("A follow-up answer.");
  }]);
  expect(await runCodingSession({ ...options, requestId: "follow-up", prompt: "What next?" }, { stateDir, models }))
    .toMatchObject({ status: "done", text: "A follow-up answer." });

  await expect(runCodingSession({ ...options, workspace: testDirectory }, { stateDir, models }))
    .rejects.toThrow("different workspace or model");
  await expect(runCodingSession({ ...options, model: "another-model" }, { stateDir, models }))
    .rejects.toThrow("different workspace or model");
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
  } finally {
    clearTimeout(startupTimeout);
    child.kill("SIGKILL");
    await child.exited;
  }

  await rm(attachment);
  faux.setResponses([(input) => {
    expect(JSON.stringify(input.messages)).toContain("original bytes");
    return fauxAssistantMessage("Recovered from the saved request.");
  }]);
  expect(await runCodingSession(options, { stateDir, models })).toMatchObject({
    status: "done",
    text: "Recovered from the saved request.",
  });
  expect(faux.state.callCount).toBe(1);
}, 15_000);
