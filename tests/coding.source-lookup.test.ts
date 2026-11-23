import { expect, test } from "bun:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvedSourceToolName } from "../src/core/coding/approved-source-tool.ts";
import { createCodingBranch, getCodingSessionStatus, previewCodingAttachments, previewCodingBranch,
  runCodingSession, type CodingSessionIdentity,
} from "../src/core/coding/durable.ts";

test("Pi serves and verifies approved lookup ranges inside the selected root or branch request after checkout removal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "okb-source-lookup-conversation-"));
  const checkout = join(directory, "worktree");
  const parentFile = "original.ts";
  const branchFile = "alternative.ts";
  const originalBody = "export const parentFixture = true;";
  const alternativeBody = "export const branchFixture = true;";
  try {
    await mkdir(checkout);
    const workspace = await realpath(checkout);
    await writeFile(join(workspace, parentFile), originalBody + "\n");
    await writeFile(join(workspace, branchFile), alternativeBody + "\n");
    const models = createModels();
    const faux = fauxProvider({ provider: "openai", models: [{ id: "lookup-conversation-fixture" }] });
    models.setProvider(faux.provider);
    const dependencies = { stateDir: join(directory, "private-state"), workspaceBinding: workspace, models };
    const root: CodingSessionIdentity = { workspace, provider: "openai", model: "lookup-conversation-fixture", session: "parent" };
    const rootRequest = { ...root, requestId: "same-id" };
    const { id: rootPreview } = await previewCodingAttachments(workspace, [parentFile]);
    const lookup = (path: string, id: string) => fauxToolCall(approvedSourceToolName, { path, startLine: 1, endLine: 1 }, { id });
    faux.setResponses([
      fauxAssistantMessage(lookup(parentFile, "same-call-id"), { stopReason: "toolUse" }),
      fauxAssistantMessage("Original saved lookup."),
      (input) => {
        expect(getCurrentTools(input.messages).map(({ name }) => name)).toEqual([approvedSourceToolName]);
        return fauxAssistantMessage([
          lookup(branchFile, "same-call-id"), lookup(parentFile, "original-outside-current-approval"),
        ], { stopReason: "toolUse" });
      },
      (input) => {
        const selected = input.messages.slice(input.messages.findLastIndex(({ role }) => role === "user") + 1);
        const results = selected.filter((message) => message.role === "toolResult");
        expect(results.map(({ toolCallId, isError }) => ({ toolCallId, isError }))).toEqual([
          { toolCallId: "same-call-id", isError: false }, { toolCallId: "original-outside-current-approval", isError: true },
        ]);
        expect(JSON.stringify(results)).toContain(alternativeBody);
        expect(JSON.stringify(results)).not.toContain(originalBody);
        return fauxAssistantMessage("Branch saved lookup.");
      },
    ]);

    const done = await runCodingSession({
      ...rootRequest, prompt: "Review the original attachment.", files: [parentFile], filePreviewId: rootPreview, approvedSourceLookup: true,
    }, dependencies);
    expect(done).toMatchObject({ status: "done", text: "Original saved lookup." });
    const fork = await previewCodingBranch(root, rootRequest.requestId, dependencies);
    await createCodingBranch(root, rootRequest.requestId, fork.version, dependencies, () => {});
    const branch = {
      ...root, session: `alt-${fork.branchId.slice(0, 60)}`, requestId: rootRequest.requestId,
      branch: { parentSession: root.session, id: fork.branchId, contextVersion: fork.version },
    };
    const { id: branchPreview } = await previewCodingAttachments(workspace, [branchFile]);
    expect(await runCodingSession({
      ...branch, prompt: "Review the new attachment.", files: [branchFile], filePreviewId: branchPreview, approvedSourceLookup: true,
    }, dependencies)).toMatchObject({ status: "done", text: "Branch saved lookup." });

    await rename(workspace, join(directory, "detached"));
    const base = await getCodingSessionStatus({ ...rootRequest, includeReceipt: true }, dependencies);
    const alternative = await getCodingSessionStatus({ ...branch, includeReceipt: true }, dependencies);
    expect(base.request?.sourceLookup).toEqual({
      served: [{ path: parentFile, startLine: 1, endLine: 1 }], refused: 0, incomplete: 0,
    });
    expect(alternative.request?.sourceLookup).toEqual({
      served: [{ path: branchFile, startLine: 1, endLine: 1 }], refused: 1, incomplete: 0,
    });
    const visible = JSON.stringify(alternative.request?.sourceLookup);
    for (const privateValue of [parentFile, originalBody, alternativeBody, "same-call-id", "original-outside-current-approval"])
      expect(visible).not.toContain(privateValue);
    expect(faux.state.callCount).toBe(4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
