import { expect, test } from "bun:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvedSourceToolName } from "../src/core/coding/approved-source-tool.ts";
import { getCodingSessionStatus, previewCodingAttachments, runCodingSession } from "../src/core/coding/durable.ts";
import { parseCodingTaskProgress, type CodingTaskProgress } from "../src/core/coding/task-progress.ts";

test("worker task progress copies only bounded known labels and counters", () => {
  const stage = { kind: "model", pending: 0, running: 1, waiting: 0, completing: 0 } as const;
  const input = {
    checkpoint: { authorization: "fixture secret" },
    stages: [{ ...stage, arguments: ["fixture secret"], taskId: 11 }, {
      kind: "package-work", pending: 1, running: 0, waiting: 0, completing: 0,
    }],
  };
  const parsed = parseCodingTaskProgress(input);
  expect(parsed).toEqual({ stages: [{ kind: "package-work", pending: 1, running: 0, waiting: 0, completing: 0 }, stage] });
  expect(JSON.stringify(parsed)).not.toContain("fixture secret");
  expect(parseCodingTaskProgress({ stages: [] })).toEqual({ stages: [] });
  for (const invalid of [null, { stages: [stage, stage] }, { stages: [{ ...stage, running: -1 }] },
    { stages: [{ ...stage, running: 1000 }] }, { stages: [{ ...stage, running: 0.5 }] }, { stages: [{ ...stage, kind: "unexpected" }] }])
    expect(parseCodingTaskProgress(invalid)).toBeUndefined();
});

test("Pi restores the selected saved model task and reports the approved lookup round without its contents", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "okb-task-progress-")));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const models = createModels();
  const provider = "openai";
  const model = "progress-test";
  const faux = fauxProvider({ provider, models: [{ id: model }] });
  models.setProvider(faux.provider);
  const session = { workspace, provider, model, session: "task-progress" };
  const dependencies = { models, stateDir: join(root, "state") };
  const progress: CodingTaskProgress[] = [];
  try {
    const file = "selected.ts";
    const source = "export const fixture = 'private preview text';";
    await writeFile(join(workspace, file), source);
    faux.setResponses([fauxAssistantMessage("Earlier result.")]);
    const earlier = { ...session, requestId: "earlier" };
    await runCodingSession({ ...earlier, prompt: "Read the earlier task." }, dependencies);
    const { id } = await previewCodingAttachments(workspace, [file]);
    const selected = { ...session, requestId: "selected" };
    await expect(runCodingSession({
      ...selected, prompt: "Private saved task.", files: [file], filePreviewId: id, approvedSourceLookup: true,
    }, {
      ...dependencies, admitted: () => { throw new Error("fixture interrupted before waiting"); },
    })).rejects.toThrow("Could not open Pi Durable session");
    const saved = await getCodingSessionStatus(selected, dependencies);
    expect(saved.request?.taskProgress?.stages).toEqual([{ kind: "model", pending: 1, running: 0, waiting: 0, completing: 0 }]);
    const unrelated = await getCodingSessionStatus(earlier, dependencies);
    expect(unrelated.request?.taskProgress).toBeUndefined();
    expect(faux.state.callCount).toBe(1);
    await rm(join(workspace, file));
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall(approvedSourceToolName, { path: file, startLine: 1, endLine: 1 })], { stopReason: "toolUse" }),
      (input) => {
        expect(JSON.stringify(input)).toContain("private preview text");
        return fauxAssistantMessage("Selected response.");
      },
    ]);
    const settled = await runCodingSession(selected, {
      ...dependencies,
      taskProgress: (update) => { if (update) progress.push(update); },
    });
    expect(settled.status).toBe("done");
    expect(progress.some(({ stages }) => stages.some(({ kind, running }) => kind === "model" && running > 0))).toBe(true);
    expect(progress.some(({ stages }) => stages.some(({ kind }) => kind === "source-lookup"))).toBe(true);
    expect(progress.at(-1)).toEqual({ stages: [] });
    expect(JSON.stringify(progress)).not.toMatch(/private|selected\.ts|checkpoint|taskId|conversationId/i);
    expect((await getCodingSessionStatus(selected, dependencies)).request?.taskProgress).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
