import { expect, test } from "bun:test";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCodingSession } from "../src/core/coding/durable.ts";
import type { RepositoryContextSelection } from "../src/core/coding/repository-context.ts";
import { mcpOps } from "../src/mcp/server.ts";

test("preview, recoverable repository receipt, and CLI status share one confirmed selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "okb-coding-e2e-"));
  const workspace = join(root, "workspace");
  const project = join(workspace, "packages", "auth");
  const data = join(root, "data");
  const session = { workspace, session: "auth", provider: "openai", model: "gpt-5-mini", requestId: "auth-review" };
  const stateDir = join(data, "okbrain", "coding");
  const cli = async (...args: string[]) => {
    const command = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/cli.ts"), ...args], {
      env: { ...process.env, XDG_DATA_HOME: data, LOCALAPPDATA: data, OPENAI_API_KEY: "" },
      stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([command.exited, command.stdout.text(), command.stderr.text()]);
    return { code, stdout, stderr };
  };

  try {
    const source = join(project, "session.ts");
    await mkdir(project, { recursive: true });
    await writeFile(source, "export const refreshSession = 'original';\n");
    for (const args of [["init", "--quiet"], ["add", "--", "."]]) {
      const result = Bun.spawnSync(["git", ...args], { cwd: workspace });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
    }
    const selection = ["--workspace", workspace, "--projects", "packages/auth", "--query", "refreshSession", "--context-tokens", "300"];
    const defaultPreview = await cli("code", "context", ...selection, "--json");
    expect(defaultPreview.code, defaultPreview.stderr).toBe(0);
    const { manifest } = JSON.parse(defaultPreview.stdout) as RepositoryContextSelection;
    expect(defaultPreview.stdout).not.toContain("'original'");
    expect(manifest.files).toMatchObject([{ path: "packages/auth/session.ts", startLine: 1, endLine: 1 }]);
    const fullPreview = await cli("code", "context", ...selection, "--show-content", "--json");
    expect(fullPreview.code, fullPreview.stderr).toBe(0);
    const { excerpts } = JSON.parse(fullPreview.stdout) as RepositoryContextSelection;

    const models = createModels();
    const faux = fauxProvider({ provider: session.provider, models: [{ id: session.model }] });
    models.setProvider(faux.provider);
    const request = { ...session, prompt: "Review refreshSession", repository: {
      projects: ["packages/auth"], query: "refreshSession", tokenBudget: 300, id: manifest.id,
    } };
    await writeFile(source, "export const refreshSession = 'edited';\n");
    await expect(runCodingSession(request, { stateDir, models })).rejects.toThrow("Repository context changed");
    expect(faux.state.callCount).toBe(0);
    const missingId = await cli("code", "run", ...selection, "--session", session.session, "--request-id", session.requestId,
      "--provider", session.provider, "--model", session.model, "--prompt", request.prompt);
    expect(missingId.stderr).toContain("Use --projects, --query, and --context-id together");

    await writeFile(source, "export const refreshSession = 'original';\n");
    faux.setResponses([(input) => {
      const message = input.messages.findLast((candidate) => candidate.role === "user");
      expect(message?.content).toBe(JSON.stringify({ task: request.prompt, excerpts }));
      return fauxAssistantMessage("See packages/auth/session.ts:1.");
    }]);
    const receipt = await runCodingSession(request, { stateDir, models });
    expect(receipt).toMatchObject({ status: "done", repositoryContext: manifest });
    await rm(source);
    expect(await runCodingSession(session, { stateDir, models })).toEqual(receipt);
    expect(faux.state.callCount).toBe(1);

    const saved = await cli("code", "status", "--workspace", workspace, "--session", session.session,
      "--request-id", session.requestId, "--provider", session.provider, "--model", session.model, "--json");
    expect(saved.code, saved.stderr).toBe(0);
    expect(JSON.parse(saved.stdout)).toMatchObject({ pendingRequestIds: [], request: { status: "done", repositoryContext: manifest } });
    expect(saved.stdout).not.toContain("'original'");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test("trusted MCP discovery excludes coding operations", () => {
  expect(mcpOps(true).filter((op) => op.name.startsWith("code_"))).toEqual([]);
});
