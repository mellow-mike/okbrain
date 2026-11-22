import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type, createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { CompactionEntry, CompactionTask, Harness, UsageDoc, UserEntry, createRegistry, defineExtension, defineTool, type Conversation } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  forkConversationBranch, previewConversationBranch, previewConversationBranchAdmission,
  readConversationBranch, verifyConversationBranchAdmission, type CodingBranchSession,
} from "../src/core/coding/conversation-branch.ts";
import { openDurableDatabase } from "../src/core/coding/sqlite.ts";

async function withFixture<T>(run: (fixture: {
  directory: string;
  faux: ReturnType<typeof fauxProvider>;
  open: () => Promise<CodingBranchSession>;
}) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "okb-native-branch-"));
  const transcript = join(directory, "transcript.sqlite");
  const faux = fauxProvider({ provider: "openai", models: [{ id: "branch-model" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  const lookup = defineTool({
    name: "lookup_example", description: "Read a fixture.", parameters: Type.Object({ path: Type.String() }), replay: "safe",
    execute: async ({ path }) => ({ content: [{ type: "text", text: "Reviewed text from " + path }] }),
  });
  const extension = defineExtension({ name: "fixture-branch-tool", tools: [lookup] });
  registry.install(extension);
  let active: Harness | undefined;
  try {
    return await run({ directory, faux, open: async () => {
      await active?.close(context);
      const storage = await SqliteStorage.open(openDurableDatabase(transcript));
      const harness = await Harness.open(storage, { models, registry }, context);
      active = harness;
      const root = await harness.root(context, { agent: {
        model: { provider: "openai", modelId: "branch-model" }, cwd: directory, instructions: "Review example files.", tools: [lookup],
      } });
      return { root, harness, storage, session: "test", transcript };
    } });
  } finally {
    await active?.close(context);
    await rm(directory, { recursive: true, force: true });
  }
}

async function runInput(conversation: Conversation, requestId: string, content: string) {
  const finished = await (await conversation.submit({ type: "input", requestId, content, whenBusy: "reject" }, context)).wait(context);
  if (finished.status !== "done" || finished.answer === undefined) throw new Error("Fixture request did not finish.");
  return finished.answer;
}

test("fork receipt persists and binds a portable inherited projection without copying work or usage", async () => {
  await withFixture(async ({ directory, open, faux }) => {
    const onProvider: string[] = [];
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("lookup_example", { path: "src/main.ts" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Initial approved answer."),
      fauxAssistantMessage("New parent answer."),
      fauxAssistantMessage("Alternative branch answer."),
    ].map((response) => (input) => { onProvider.push(JSON.stringify(input.messages)); return response; }));
    let session = await open();
    const anchor = await runInput(session.root, "accepted", JSON.stringify({
      task: "Review the accepted task", excerpts: [{ path: "src/main.ts", text: "Approved source bytes." }],
      repositoryContext: { digest: "LOCAL_MANIFEST_ONLY" },
    }));
    const preview = await previewConversationBranch(session, "accepted");
    expect(preview.activeEntries).toBeGreaterThan(2);
    expect(preview.estimatedTokens).toBeGreaterThan(0);
    expect(preview.providerContinuity).toBe(false);
    expect(preview.version).toBe(preview.branchId);
    expect(JSON.stringify(preview.history)).toContain("Approved source bytes.");
    expect(JSON.stringify(preview.history)).toContain("Tool call lookup_example");
    expect(JSON.stringify(preview.history)).toContain("src/main.ts");
    expect(JSON.stringify(preview.history)).toContain("Reviewed text from src/main.ts");
    expect(JSON.stringify(preview.history)).not.toContain("LOCAL_MANIFEST_ONLY");

    const forbid = () => { throw new Error("Mount became read-only."); };
    await expect(forkConversationBranch(session, "accepted", preview.version, forbid)).rejects.toThrow("read-only");
    expect(await readConversationBranch(session, preview.branchId)).toBeUndefined();
    const receipt = await forkConversationBranch(session, "accepted", preview.version);
    expect(receipt.anchor).toBe(anchor);
    expect(receipt.conversationId).not.toBe(session.root.id);
    expect(onProvider).toHaveLength(2);
    expect((await session.root.entries({}, 1, undefined, context)).items[0]?.id).toBe(anchor);
    const fork = await session.harness.conversation(receipt.conversationId, context);
    expect((await fork?.agent(context))?.tools).toEqual([]);
    expect(await session.harness.snapshot(UsageDoc, receipt.conversationId, context)).toEqual({ models: {}, tools: {} });
    expect(await session.storage.submissionByRequest(receipt.conversationId, "accepted", context)).toBeUndefined();
    expect((await session.harness.inspect(context)).tasks).toEqual([]);
    await runInput(session.root, "parent-only", "New parent work must stay out of the branch.");

    session = await open();
    expect(await forkConversationBranch(session, "accepted", preview.version, forbid)).toEqual({ ...receipt, replayed: true });
    await expect(forkConversationBranch(session, "parent-only", preview.version)).rejects.toThrow("verified");
    // The worker's mount can expose a different path. The fork proof uses its SDK data.
    const mounted = { ...session, transcript: join(directory, "a-different-worker-mount") };
    expect(await readConversationBranch(mounted, preview.branchId)).toEqual(receipt);
    expect(await previewConversationBranchAdmission(mounted, preview.branchId)).toEqual(preview);
    const admission = await verifyConversationBranchAdmission(mounted, preview.branchId, preview.version);
    expect(admission.firstAdmission).toBe(true);
    await runInput(admission.conversation, "alternative", "Try an alternative implementation.");
    expect(onProvider).toHaveLength(4);
    expect(onProvider.at(-1)).toContain("Approved source bytes.");
    expect(onProvider.at(-1)).not.toContain("New parent work");
    expect(JSON.stringify((await session.root.context(context)).messages)).not.toContain("alternative implementation");
    const later = await previewConversationBranchAdmission(mounted, preview.branchId);
    expect(later.version).not.toBe(preview.version);
    await expect(verifyConversationBranchAdmission(mounted, preview.branchId, preview.version)).rejects.toThrow("context changed");
    expect((await verifyConversationBranchAdmission(mounted, preview.branchId, later.version)).firstAdmission).toBe(false);
    expect(onProvider).toHaveLength(4);
  });
});

test("branch preview refuses stale agent bindings, archived answers, and unsettled work", async () => {
  await withFixture(async ({ open, faux }) => {
    faux.setResponses(["Old reviewed answer.", "Retained answer.", "Newest reviewed answer."].map((text) => fauxAssistantMessage(text)));
    let session = await open();
    await runInput(session.root, "older", "Older raw source.");
    const anchor = await runInput(session.root, "retained", "Retained task.");
    const preview = await previewConversationBranch(session, "retained");
    await session.root.configure({ instructions: "Updated review ceiling." }, context);
    await expect(forkConversationBranch(session, "retained", preview.version)).rejects.toThrow("binding changed");
    await expect(previewConversationBranch(session, "older")).rejects.toThrow("latest completed answer");
    const marker = await session.root.submit({ type: "write", entry: {
      kind: CompactionEntry.kind, head: anchor, data: { reason: "manual" },
      model: [{ role: "user", content: "Locally compacted summary.", timestamp: Date.now() }],
    } }, context);
    expect((await marker.status(context)).status).toBe("done");
    expect((await session.root.context(context)).entries.some(({ id }) => id === anchor)).toBe(true);
    await expect(previewConversationBranch(session, "retained")).rejects.toThrow("latest completed answer");
    await runInput(session.root, "latest", "Newly accepted task.");
    const current = await previewConversationBranch(session, "latest");
    expect(JSON.stringify(current.history)).toContain("Locally compacted summary.");
    expect(JSON.stringify(current.history)).not.toContain("Older raw source.");
    session = await open();
    await session.root.commit((tx) => tx.createTask(CompactionTask, { reason: "manual" }, { ownership: { kind: "conversation" } }), context);
    await expect(previewConversationBranch(session, "latest")).rejects.toThrow("other work");
  });
});

test("branch preview discloses provider continuity and refuses unreviewable media", async () => {
  await withFixture(async ({ open, faux }) => {
    faux.setResponses([
      fauxAssistantMessage([{ type: "text", text: "Written answer.", textSignature: "PRIVATE_PROVIDER_SIGNATURE" }]),
      fauxAssistantMessage("Reviewed an older media input."),
    ]);
    const session = await open();
    await runInput(session.root, "signed", "A text-only request.");
    const preview = await previewConversationBranch(session, "signed");
    expect(preview.providerContinuity).toBe(true);
    expect(JSON.stringify(preview.history)).toContain("Written answer.");
    expect(JSON.stringify(preview)).not.toContain("PRIVATE_PROVIDER_SIGNATURE");
    await session.root.commit((tx) => tx.appendEntry(UserEntry, session.root.id, { model: [{
      role: "user", timestamp: Date.now(), content: [{ type: "image", mimeType: "image/png", data: "Zml4dHVyZQ==" }],
    }] }), context);
    await runInput(session.root, "after-media", "A later text request.");
    await expect(previewConversationBranch(session, "after-media")).rejects.toThrow("cannot display");
  });
});
