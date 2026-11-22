import { randomUUID } from "node:crypto";
import type { OpContext } from "../operations.ts";
import { inDbOnlyDir } from "../okf/paths.ts";
import { answerFromContext, prepareLocalContext, type AskResult, type PreparedContext } from "../retrieval/ask.ts";
import { PROFILES } from "../retrieval/profiles.ts";
import { createChatgptPlan, type ChatgptPlanStatus, type PlanOptions } from "./chatgpt-plan.ts";

interface Preview {
  bundle: string;
  account: string;
  model: string;
  question: string;
  context: PreparedContext;
  expires: number;
  answer?: Promise<AskResult>;
}

type SignInResult = { state: "pending" | "cancelled" } | { state: "done"; status: ChatgptPlanStatus } | { state: "failed"; error: string };

interface SignIn {
  id: string;
  controller: AbortController;
  result: SignInResult;
}

export class BrowserPlanInputError extends Error {}

function required(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new BrowserPlanInputError(`${label} must contain between 1 and ${max} characters.`);
  return value.trim();
}

/** Browser-only consent and short-lived source snapshots. Credentials stay in the plan store. */
export function createBrowserPlan(options: Pick<PlanOptions, "path" | "fetch"> = {}) {
  const plan = createChatgptPlan(options);
  const previews = new Map<string, Preview>();
  let signIn: SignIn | undefined;

  async function selectAccount(value: unknown): Promise<string> {
    const account = required(value, "Account", 40);
    const status = await plan.status();
    if (!status.connected || !status.sharing || status.account !== account)
      throw new BrowserPlanInputError("Select a connected ChatGPT account in Accounts.");
    return account;
  }

  return {
    status: plan.status,
    async connect(value: unknown) {
      const account = value === undefined || value === "" ? undefined : required(value, "Account label", 40);
      if (signIn?.result.state === "pending") throw new BrowserPlanInputError("A sign-in is already in progress.");
      const next: SignIn = { id: randomUUID(), controller: new AbortController(), result: { state: "pending" } };
      signIn = next;
      const ready = Promise.withResolvers<string>();
      void createChatgptPlan({
        ...options,
        signal: next.controller.signal,
        authorize: (url) => { ready.resolve(url); },
      }).connect(account).then((status) => { next.result = { state: "done", status }; }, (error: Error) => {
        next.result = next.controller.signal.aborted ? { state: "cancelled" } : { state: "failed", error: error.message };
        ready.reject(error);
      });
      return { id: next.id, url: await ready.promise };
    },
    signIn(id: unknown, cancel = false): SignInResult {
      if (!signIn || id !== signIn.id) throw new BrowserPlanInputError("Start a new ChatGPT sign-in.");
      if (cancel && signIn.result.state === "pending") signIn.controller.abort();
      return signIn.result;
    },
    async use(value: unknown) {
      return plan.use(required(value, "Account", 40));
    },
    async disconnect(value: unknown) {
      return plan.disconnect(required(value, "Account", 40));
    },
    async models(value: unknown) {
      return plan.models(await selectAccount(value));
    },
    async preview(ctx: OpContext, input: Record<string, unknown>) {
      const account = await selectAccount(input.account);
      const model = required(input.model, "Model", 150);
      const question = required(input.question, "Question", 8000);
      const context = await prepareLocalContext(question, ctx.bundle, { engine: ctx.engine() },
        { ...PROFILES.balanced!, rerank: false }, (hit) => input.includePrivate === true || !inDbOnlyDir(hit.id));
      for (const [id, preview] of previews) if (preview.expires <= Date.now()) previews.delete(id);
      if (previews.size >= 16) previews.delete(previews.keys().next().value!);
      const id = randomUUID();
      previews.set(id, { account, question, model, context, bundle: ctx.bundle, expires: Date.now() + 10 * 60_000 });
      return { id, account, model, sources: context.context.map((citation, i) => ({ ...citation, text: context.blocks[i] })) };
    },
    async answer(ctx: OpContext, id: unknown) {
      const key = required(id, "Preview ID", 40);
      const preview = previews.get(key);
      if (!preview || preview.bundle !== ctx.bundle || preview.expires <= Date.now())
        throw new BrowserPlanInputError("Preview sources again for this brain.");
      preview.answer ??= answerFromContext(preview.question, preview.context, {
        chat: async (messages) => ({ ...(await plan.complete(messages, preview.model, preview.account)), provider: "chatgpt-plan" }),
      });
      return preview.answer;
    },
    close() {
      signIn?.controller.abort();
      previews.clear();
    },
  };
}

export type BrowserPlan = ReturnType<typeof createBrowserPlan>;
