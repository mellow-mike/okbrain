import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { previewCodingAttachments, runCodingSession, type CodingSessionOptions } from "../src/core/coding/durable.ts";
import type { CodingProjectProfile } from "../src/core/coding/project-profile.ts";
import { selectRepositoryContext } from "../src/core/coding/repository-context.ts";

const fixtureVersion = 1;
const backgroundFiles = 1024;
const router = "apps/customer/module/routes.ts";
const provider = "openai";
const model = "context-fixture";
const contract = "packages/contracts/src/index.ts";
const service = "apps/customer/module/z-owned.ts";
const decoy = "apps/internal/module/service.ts";
const profile: CodingProjectProfile = {
  version: 1, name: "Customer workspace", projects: ["apps/customer"], sharedProjects: ["packages/contracts"],
};

interface Task {
  query: string;
  required: { path: string; marker: string }[];
  attachments: string[];
}

const crossPackage: Task = {
  query: "publishUpdate",
  required: [{ path: router, marker: "PUBLISH_PATH" }, { path: contract, marker: "CONTRACT_V1" }],
  attachments: [router, contract],
};
const similarService: Task = {
  query: "resolveCustomer",
  required: [{ path: service, marker: "CUSTOMER_SERVICE" }],
  attachments: [service, decoy],
};
const edited: Task = {
  query: "resolveCustomerV2",
  required: [{ path: service, marker: "CUSTOMER_SERVICE_V2" }],
  attachments: [service, decoy],
};

async function write(workspace: string, path: string, body: string): Promise<void> {
  const target = join(workspace, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, body);
}

function git(workspace: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd: workspace });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

async function buildFixture(workspace: string): Promise<void> {
  for (let start = 0; start < backgroundFiles; start += 64) {
    const batch = Array.from({ length: 64 }, (_, i) => start + i);
    await Promise.all(batch.map((i) => write(workspace, `apps/customer/module/routine-${String(i).padStart(4, "0")}.ts`,
      `export const routine${i} = () => ${i};\n${"// Background fixture text.\n".repeat(60)}`)));
  }
  await write(workspace, router, 'import { schema } from "@fixture/contracts";\nexport function publishUpdate() { return ["PUBLISH_PATH", schema]; }\n');
  await write(workspace, "packages/contracts/package.json", '{"name":"@fixture/contracts","main":"./src/index.ts"}\n');
  await write(workspace, contract, 'export const schema = "CONTRACT_V1";\n');
  await write(workspace, service, 'export function resolveCustomer() { return "CUSTOMER_SERVICE"; }\n');
  await write(workspace, decoy, `export function resolveCustomer() { return "INTERNAL_DECOY"; }\n${"// Another team's service.\n".repeat(600)}`);
  git(workspace, "init", "--quiet");
  git(workspace, "add", "--", ".");
  git(workspace, "-c", "user.name=okbrain Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "Pinned benchmark fixture");
}

const strategies = ["explicit", "lexical", "indexed"] as const;
type Strategy = typeof strategies[number];

interface Measurements {
  latency: number[];
  relevant: number;
  expected: number;
  contextBytes: number;
  attempts: number;
  accepted: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number };
}

function measurements(): Measurements {
  return { latency: [], relevant: 0, expected: 0, contextBytes: 0, attempts: 0, accepted: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } };
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.ceil(sorted.length * fraction) - 1]!.toFixed(2));
}

function evidenceIn(task: Task, files: { path: string; content: string }[]): string[] {
  return task.required.filter(({ path, marker }) => files.some((file) => file.path === path && file.content.includes(marker))).map(({ path }) => path);
}

async function benchmark(root: string): Promise<void> {
  const workspace = join(root, "worktree");
  await buildFixture(workspace);
  const models = createModels();
  const faux = fauxProvider({ provider, models: [{ id: model }] });
  models.setProvider(faux.provider);
  const results = { explicit: measurements(), lexical: measurements(), indexed: measurements() };
  const tasks = [crossPackage, similarService, crossPackage, similarService, edited, edited, edited, edited];
  for (const [i, task] of tasks.entries()) {
    if (i === 4) await write(workspace, service, 'export function resolveCustomerV2() { return "CUSTOMER_SERVICE_V2"; }\n');
    for (const strategy of strategies) {
      const result = results[strategy];
      const options: CodingSessionOptions = {
        workspace, session: strategy, provider, model, requestId: `task-${i + 1}`,
        prompt: `Trace ${task.query} and cite the supplied evidence paths.`,
      };
      let files: { path: string; content: string }[];
      const started = performance.now();
      if (strategy === "explicit") {
        const preview = await previewCodingAttachments(workspace, task.attachments);
        options.files = task.attachments;
        options.filePreviewId = preview.id;
        files = preview.files;
      } else {
        const args = strategy === "lexical" ? { projects: profile.projects } : { profile };
        const selection = { ...args, query: task.query };
        const preview = await selectRepositoryContext({ workspace, ...selection });
        options.repository = { ...selection, id: preview.manifest.id };
        files = preview.excerpts;
      }
      result.latency.push(performance.now() - started);
      result.contextBytes += Buffer.byteLength(JSON.stringify(files));
      result.expected += task.required.length;
      result.relevant += evidenceIn(task, files).length;
      if (!files.length) continue;
      result.attempts++;
      faux.setResponses([(input) => {
        const latest = input.messages.findLast(({ role }) => role === "user");
        const payload = latest?.role === "user" && typeof latest.content === "string" ? JSON.parse(latest.content) : {};
        return fauxAssistantMessage(evidenceIn(task, payload.excerpts ?? payload.files ?? []).join("\n"));
      }]);
      const receipt = await runCodingSession(options, { models, stateDir: join(root, "sessions") });
      if (receipt.status !== "done") throw new Error(`Expected the fixture provider to settle ${strategy} task ${i + 1}.`);
      if (receipt.text.split("\n").length === task.required.length && task.required.every(({ path }) => receipt.text.split("\n").includes(path))) result.accepted++;
      for (const kind of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) result.tokens[kind] += receipt.usage[kind];
    }
  }
  const summary = Object.fromEntries(strategies.map((strategy: Strategy) => {
    const result = results[strategy];
    return [strategy, {
      p50PreviewMs: percentile(result.latency, 0.5), p95PreviewMs: percentile(result.latency, 0.95),
      firstPreviewMs: Number(result.latency[0]?.toFixed(2)),
      relevantEvidence: result.relevant, expectedEvidence: result.expected, meanContextBytes: Math.round(result.contextBytes / tasks.length),
      attempted: result.attempts, accepted: result.accepted, totalTokensPerAccepted: result.accepted ? Math.round(result.tokens.totalTokens / result.accepted) : null,
      tokens: result.tokens,
    }];
  }));
  console.log(JSON.stringify({ fixtureVersion, backgroundFiles, tasks: tasks.length, accounting: "Pi faux provider, deterministic evidence checks", ...summary }, null, 2));
}

const root = await mkdtemp(join(tmpdir(), "okb-coding-benchmark-"));
process.env.XDG_DATA_HOME = join(root, "data");
process.env.LOCALAPPDATA = join(root, "data");
try {
  await benchmark(root);
} finally {
  await rm(root, { recursive: true, force: true });
}
