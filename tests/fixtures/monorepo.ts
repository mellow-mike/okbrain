// A generated monorepo with known answers, for tests and the scale benchmark.
// Every task names the files that hold its evidence, so a selection can be
// scored without a model. The background files share the domain's vocabulary
// on purpose: finding `refreshSession` among files that all say "session" is
// the realistic part.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface FixtureTask {
  id: string;
  query: string;
  /** Files whose text holds the evidence, with a marker that must be in the selected excerpt. */
  evidence: { path: string; marker: string }[];
  /** How the task names what it wants. */
  kind: "identifier" | "cross-package" | "ambiguous" | "described" | "paraphrased" | "tests";
}

export interface Fixture {
  workspace: string;
  files: number;
  tasks: FixtureTask[];
}

const packages = ["auth", "billing", "catalog", "shipping", "notifications", "search", "analytics", "inventory"];
const nouns: Record<string, string[]> = {
  auth: ["session", "token", "login", "password", "role", "permission"],
  billing: ["invoice", "payment", "charge", "ledger", "tax", "subscription"],
  catalog: ["product", "category", "price", "variant", "listing", "media"],
  shipping: ["parcel", "carrier", "label", "route", "tracking", "address"],
  notifications: ["email", "template", "digest", "channel", "delivery", "preference"],
  search: ["query", "ranking", "facet", "index", "suggestion", "synonym"],
  analytics: ["event", "funnel", "cohort", "metric", "dashboard", "report"],
  inventory: ["stock", "warehouse", "reservation", "batch", "supplier", "threshold"],
};
const verbs = ["load", "store", "validate", "format", "merge", "list", "archive", "count", "export", "sync"];
const capital = (word: string) => word[0]!.toUpperCase() + word.slice(1);

async function write(workspace: string, path: string, body: string): Promise<void> {
  const target = join(workspace, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, body);
}

function git(workspace: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-c", "user.name=okbrain Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args],
    { cwd: workspace, stdout: "ignore", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

/** One background module: a few small functions in the package's own vocabulary. */
function background(pkg: string, index: number): string {
  const words = nouns[pkg]!;
  const noun = words[index % words.length]!;
  const other = words[(index * 7 + 3) % words.length]!;
  const lines = [`// ${capital(noun)} helpers for the ${pkg} package (module ${index}).`];
  for (let part = 0; part < 3; part++) {
    const verb = verbs[(index + part * 3) % verbs.length]!;
    const name = `${verb}${capital(noun)}${capital(other)}${index}x${part}`;
    lines.push("", `/** ${capital(verb)} the ${noun} ${other} records for batch ${index}. */`,
      `export function ${name}(items: string[]): string[] {`,
      `  const ${noun}Limit = ${index % 17 + 2};`,
      `  return items.filter((item) => item.length < ${noun}Limit).map((item) => \`${other}:\${item}\`);`,
      "}");
  }
  return lines.join("\n") + "\n";
}

/** Build the fixture and commit it. `backgroundFiles` sets the scale; the tasks stay the same. */
export async function buildMonorepo(workspace: string, backgroundFiles = 400): Promise<Fixture> {
  await mkdir(workspace, { recursive: true });
  git(workspace, "init", "--quiet");
  await write(workspace, "package.json", JSON.stringify({ name: "acme-monorepo", private: true, workspaces: ["packages/*", "apps/*"],
    scripts: { test: "bun test", typecheck: "tsc --noEmit" } }, null, 2) + "\n");
  await write(workspace, "bun.lock", "{}\n");
  await write(workspace, "README.md", "# Acme monorepo\n\nApps and packages for the Acme storefront.\n\n## Layout\n\nApps live in `apps/`, shared code in `packages/`.\n");
  await write(workspace, ".github/CODEOWNERS", "/packages/billing/ @acme/payments\n/packages/auth/ @acme/identity\n");
  await write(workspace, ".github/workflows/ci.yml", "jobs:\n  test:\n    steps:\n      - run: bun install --frozen-lockfile\n      - run: bun run typecheck\n      - run: bun test\n");
  for (const pkg of packages) {
    await write(workspace, `packages/${pkg}/package.json`, JSON.stringify({
      name: `@acme/${pkg}`, description: `${capital(pkg)} domain logic for the storefront.`, main: "./src/index.ts",
      scripts: { test: "bun test", typecheck: "tsc --noEmit" }, dependencies: pkg === "contracts" ? {} : { "@acme/contracts": "workspace:*" },
    }, null, 2) + "\n");
  }
  await write(workspace, "packages/contracts/package.json", JSON.stringify({ name: "@acme/contracts", description: "Schemas shared between packages.", main: "./src/index.ts" }, null, 2) + "\n");
  for (const app of ["customer", "internal"]) {
    await write(workspace, `apps/${app}/package.json`, JSON.stringify({ name: `@acme/${app}-app`, description: `The ${app} web app.`,
      scripts: { test: "bun test", dev: "bun run src/main.ts" }, dependencies: { "@acme/contracts": "workspace:*", "@acme/billing": "workspace:*" } }, null, 2) + "\n");
  }

  const perPackage = Math.max(1, Math.floor(backgroundFiles / packages.length));
  let files = 0;
  for (const pkg of packages) {
    const names: string[] = [];
    for (let start = 0; start < perPackage; start += 64) {
      const batch = Array.from({ length: Math.min(64, perPackage - start) }, (_, offset) => start + offset);
      await Promise.all(batch.map((index) => write(workspace, `packages/${pkg}/src/${nouns[pkg]![index % 6]}/module-${String(index).padStart(5, "0")}.ts`, background(pkg, index))));
      files += batch.length;
    }
    for (let index = 0; index < Math.min(perPackage, 6); index++) names.push(`./${nouns[pkg]![index % 6]}/module-${String(index).padStart(5, "0")}`);
    await write(workspace, `packages/${pkg}/src/index.ts`, names.map((name, index) => `export * as part${index} from "${name}";`).join("\n") + "\n");
  }

  // ----- The files the tasks are about -----
  await write(workspace, "packages/auth/src/session.ts", [
    "// Session lifecycle for signed-in customers.", 'import { signToken } from "./token-signer";', 'import type { SessionRecord } from "@acme/contracts";', "",
    "/** Rotate the refresh token and extend the session. */",
    "export async function refreshSession(record: SessionRecord): Promise<SessionRecord> {",
    '  if (record.expired) throw new Error("SESSION_EXPIRED");', "  return { ...record, token: signToken(record.user), marker: \"AUTH_REFRESH\" };", "}", "",
    "export function endSession(record: SessionRecord): SessionRecord {", "  return { ...record, expired: true };", "}", ""].join("\n"));
  await write(workspace, "packages/auth/src/token-signer.ts", [
    "/** Sign a short-lived token for a user. */", "export function signToken(user: string): string {", '  return `SIGNED_TOKEN:${user}`;', "}", ""].join("\n"));
  await write(workspace, "packages/auth/tests/session.test.ts", [
    'import { expect, test } from "bun:test";', 'import { refreshSession } from "../src/session";', "",
    'test("refreshSession rotates the token", async () => {', '  const next = await refreshSession({ user: "u1", token: "old", expired: false });',
    '  expect(next.marker).toBe("AUTH_REFRESH_TEST");', "});", ""].join("\n"));
  await write(workspace, "packages/contracts/src/index.ts", [
    "// Shapes shared across packages. Changing one affects every importer.",
    "export interface SessionRecord { user: string; token: string; expired: boolean; marker?: string }", "",
    "/** The published invoice payload. */", 'export const InvoiceSchema = { version: 3, fields: ["id", "total", "currency"], marker: "CONTRACT_INVOICE_V3" };', ""].join("\n"));
  await write(workspace, "packages/billing/src/publish.ts", [
    'import { InvoiceSchema } from "@acme/contracts";', "",
    "/** Publish a finalized invoice to subscribers. */", "export function publishInvoice(id: string, total: number) {",
    '  return { schema: InvoiceSchema.version, id, total, marker: "BILLING_PUBLISH" };', "}", ""].join("\n"));
  await write(workspace, "packages/billing/src/capture-retry.ts", [
    "// Retry a declined card charge with exponential backoff.", "const maxAttempts = 4;", "",
    "/** Try the capture again after a soft decline. Gives up after four attempts. */",
    "export async function reattemptCapture(chargeId: string, attempt = 1): Promise<string> {",
    '  if (attempt > maxAttempts) return "CAPTURE_ABANDONED";', "  await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 100));",
    '  return `CAPTURE_RETRY:${chargeId}:${attempt}`;', "}", ""].join("\n"));
  await write(workspace, "packages/billing/src/reversal.ts", [
    "// Reverse a settled charge and restore the ledger.", "",
    "export function reverseSettledCharge(chargeId: string, amount: number) {",
    '  return { chargeId, credited: amount, marker: "LEDGER_REVERSAL" };', "}", ""].join("\n"));
  await write(workspace, "packages/billing/src/tax.ts", [
    "/** Compute the tax owed for an amount in a region. */", "export function computeTax(amount: number, region: string): number {",
    '  const rate = region === "EU" ? 0.2 : 0.07;', "  return Math.round(amount * rate); // TAX_RULES", "}", ""].join("\n"));
  await write(workspace, "packages/billing/tests/tax.test.ts", [
    'import { expect, test } from "bun:test";', 'import { computeTax } from "../src/tax";', "",
    'test("computeTax applies the regional rate", () => {', '  expect(computeTax(100, "EU")).toBe(20); // TAX_TEST', "});", ""].join("\n"));
  await write(workspace, "apps/customer/src/customer-lookup.ts", [
    "/** Resolve the signed-in customer for the storefront. */", "export function resolveCustomer(id: string) {",
    '  return { id, source: "CUSTOMER_APP_LOOKUP" };', "}", ""].join("\n"));
  await write(workspace, "apps/internal/src/customer-lookup.ts", [
    "/** Resolve a customer for support staff. */", "export function resolveCustomer(id: string) {",
    '  return { id, source: "INTERNAL_APP_LOOKUP" };', "}", "", ...Array.from({ length: 120 }, (_, line) => `// Support tooling note ${line}.`), ""].join("\n"));
  await write(workspace, "apps/customer/src/main.ts", 'import { resolveCustomer } from "./customer-lookup";\nimport { publishInvoice } from "@acme/billing/publish";\n\nexport const start = () => [resolveCustomer("c1"), publishInvoice("i1", 10)];\n');
  await write(workspace, "packages/billing/.env", "STRIPE_SECRET=never-index-this\n");
  files += 14;

  git(workspace, "add", "--", ".");
  git(workspace, "commit", "--quiet", "-m", "Initial fixture");
  // Two focused commits that change the invoice contract and its publisher together.
  for (const revision of [1, 2]) {
    await write(workspace, "packages/contracts/src/index.ts", [
      "// Shapes shared across packages. Changing one affects every importer.",
      "export interface SessionRecord { user: string; token: string; expired: boolean; marker?: string }", "",
      "/** The published invoice payload. */",
      `export const InvoiceSchema = { version: 3, fields: ["id", "total", "currency"], marker: "CONTRACT_INVOICE_V3", revision: ${revision} };`, ""].join("\n"));
    await write(workspace, "packages/billing/src/publish.ts", [
      'import { InvoiceSchema } from "@acme/contracts";', "",
      "/** Publish a finalized invoice to subscribers. */", "export function publishInvoice(id: string, total: number) {",
      `  return { schema: InvoiceSchema.version, id, total, marker: "BILLING_PUBLISH", revision: ${revision} };`, "}", ""].join("\n"));
    git(workspace, "add", "--", ".");
    git(workspace, "commit", "--quiet", "-m", `Revise the invoice payload (${revision})`);
  }

  const tasks: FixtureTask[] = [
    { id: "identifier", kind: "identifier", query: "refreshSession", evidence: [{ path: "packages/auth/src/session.ts", marker: "AUTH_REFRESH" }] },
    { id: "cross-package", kind: "cross-package", query: "publishInvoice payload shape",
      evidence: [{ path: "packages/billing/src/publish.ts", marker: "BILLING_PUBLISH" }, { path: "packages/contracts/src/index.ts", marker: "CONTRACT_INVOICE_V3" }] },
    { id: "ambiguous", kind: "ambiguous", query: "resolveCustomer in apps/customer", evidence: [{ path: "apps/customer/src/customer-lookup.ts", marker: "CUSTOMER_APP_LOOKUP" }] },
    { id: "described", kind: "described", query: "where do we retry a declined card charge", evidence: [{ path: "packages/billing/src/capture-retry.ts", marker: "CAPTURE_RETRY" }] },
    { id: "tests", kind: "tests", query: "computeTax and its tests",
      evidence: [{ path: "packages/billing/src/tax.ts", marker: "TAX_RULES" }, { path: "packages/billing/tests/tax.test.ts", marker: "TAX_TEST" }] },
    // Nothing in the answer's own words: only use can teach the map what "refund" means here.
    { id: "paraphrased", kind: "paraphrased", query: "give a shopper their money back after a refund request", evidence: [{ path: "packages/billing/src/reversal.ts", marker: "LEDGER_REVERSAL" }] },
  ];
  return { workspace, files, tasks };
}

/** Share of a task's evidence present in a selection. */
export function evidenceRecall(task: FixtureTask, excerpts: readonly { path: string; content: string }[]): number {
  const found = task.evidence.filter(({ path, marker }) => excerpts.some((excerpt) => excerpt.path === path && excerpt.content.includes(marker)));
  return found.length / task.evidence.length;
}
