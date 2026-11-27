import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectAtlasContext } from "../src/core/coding/atlas/context.ts";
import { importRepository } from "../src/core/coding/atlas/import.ts";
import { detectPackages, internalDependencies, toolKind } from "../src/core/coding/atlas/packages.ts";
import { readAtlas } from "../src/core/coding/atlas/readout.ts";
import { parseCodeOwners } from "../src/core/coding/atlas/scan.ts";
import { Atlas, atlasDirectory, AtlasMissingError, removeAtlas } from "../src/core/coding/atlas/store.ts";
import { analyzeSource, languageOf, roleOf } from "../src/core/coding/atlas/structure.ts";
import { cosine, embedBag, ftsQuery, queryFeatures, splitIdentifier, stem, terms } from "../src/core/coding/atlas/text.ts";
import { parse } from "../src/core/okf/document.ts";
import { buildMonorepo, evidenceRecall, type Fixture } from "./fixtures/monorepo.ts";

setDefaultTimeout(60_000);

let root: string;
let fixture: Fixture;
let workspace: string;

function git(...args: string[]): void {
  const result = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: workspace, stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "okb-atlas-")));
  fixture = await buildMonorepo(join(root, "repo"), 320);
  workspace = fixture.workspace;
});

afterAll(async () => { await rm(root, { force: true, recursive: true }); });

test("identifier terms keep whole names and join plurals without a vocabulary", () => {
  expect(splitIdentifier("refreshSessionToken")).toEqual(["refresh", "Session", "Token"]);
  expect(splitIdentifier("HTTPServer2_handler")).toEqual(["HTTP", "Server", "2", "handler"]);
  expect([stem("sessions"), stem("retrying"), stem("class"), stem("policies")]).toEqual(["session", "retry", "class", "policy"]);
  const bag = terms("export function refreshSession(sessions: Session[])");
  expect(bag.has("refreshsession")).toBe(true);
  expect(bag.get("session")).toBeGreaterThanOrEqual(3);
  expect(bag.has("function")).toBe(false);
  const features = queryFeatures("why does refreshSession in packages/auth/src/session.ts:12 fail?");
  expect(features.identifiers).toEqual(["refreshsession"]);
  expect(features.paths).toContain("packages/auth/src/session.ts");
  // Punctuation in a task can never become a search operator.
  expect(ftsQuery(terms('NEAR("a" OR b) -c*'))).toMatch(/^("[\p{L}\p{N}_$]+"( OR )?)+$/u);
  const near = cosine(embedBag(terms("authenticate the user")), embedBag(terms("user authentication")));
  const far = cosine(embedBag(terms("authenticate the user")), embedBag(terms("parcel carrier label")));
  expect(near).toBeGreaterThan(far + 0.2);
});

test("structure extraction finds declarations, imports, and bounded units across languages", () => {
  const ts = analyzeSource("src/auth/session.ts", [
    "// Session lifecycle.", 'import { sign } from "./token";', "import {", "  type Harness, type TaskId,", '} from "pkg";', "",
    "/** Rotate the token. */", "export async function refreshSession(token: string) {", "  return sign(token);", "}", "",
    "export interface Session { token: string }", "export class Store {", "  get(id: string) {", "    return id;", "  }", "}"])!;
  expect(ts.symbols.map(({ name }) => name)).toEqual(["refreshSession", "Session", "Store", "get"]);
  expect(ts.imports).toEqual(["./token", "pkg"]);
  expect(ts.gist).toBe("Session lifecycle.");
  const refresh = ts.units.find(({ name }) => name === "refreshSession")!;
  expect([refresh.startLine, refresh.endLine]).toEqual([7, 10]);
  expect(refresh.gist).toContain("Rotate the token.");
  expect(ts.units.find(({ name }) => name === "Session")?.role).toBe("types");

  const py = analyzeSource("pkg/billing/invoice.py", ['"""Invoice totals."""', "from .tax import rate_for", "import os, sys", "", "MAX_LINES = 500", "",
    "class InvoiceService:", '    """Computes totals."""', "    def total(self, invoice):", "        return 1", "", "def _helper():", "    return 2"])!;
  expect(py.symbols.map(({ name, exported }) => [name, exported])).toEqual([["MAX_LINES", true], ["InvoiceService", true], ["total", true], ["_helper", false]]);
  expect(py.imports).toEqual([".tax", ".tax.rate_for", "os", "sys"]);
  expect(py.units.find(({ name }) => name === "InvoiceService")?.gist).toContain("Computes totals.");

  const go = analyzeSource("internal/queue/worker.go", ["package queue", "", "import (", '\t"context"', '\t"github.com/acme/mono/internal/store"', ")", "",
    "type Worker struct{}", "", "func (w *Worker) Run(ctx context.Context) error {", "\treturn nil", "}"])!;
  expect(go.symbols.map(({ name, kind }) => [name, kind])).toEqual([["Worker", "type"], ["Run", "function"]]);
  expect(go.imports).toEqual(["context", "github.com/acme/mono/internal/store"]);

  const rust = analyzeSource("crates/core/src/lib.rs", ["pub mod ledger;", "use crate::ledger::Entry;", "use serde::Serialize;", "", "pub struct Amount(pub i64);", "impl Amount {", "    pub fn zero() -> Self { Amount(0) }", "}"])!;
  expect(rust.imports).toEqual(["mod:ledger", "crate::ledger::Entry", "crate:serde"]);
  expect(rust.symbols.map(({ name }) => name)).toEqual(["ledger", "Amount", "Amount", "zero"]);

  const java = analyzeSource("app/src/main/java/com/acme/OrderService.java", ["package com.acme;", "import com.acme.model.Order;", "",
    "public class OrderService {", "    public Order place(Order order) {", "        return order;", "    }", "}"])!;
  expect(java.symbols.map(({ name }) => name)).toEqual(["OrderService", "place"]);
  expect(java.imports).toEqual(["com.acme.model.Order"]);

  const doc = analyzeSource("docs/guide.md", ["# Deploy guide", "", "How to ship.", "", "## Staging", "", "```", "# not a heading", "```"])!;
  expect(doc.symbols.map(({ name }) => name)).toEqual(["Deploy guide", "Staging"]);

  // A generated file with thousands of declarations still yields a bounded number of units.
  const many = analyzeSource("src/generated-api.ts", Array.from({ length: 5000 }, (_, index) => `export function call${index}() { return ${index}; }`))!;
  expect(many.units.length).toBeLessThanOrEqual(256);
  expect(languageOf("assets/logo.svg")).toBeUndefined();
  expect(languageOf("Dockerfile")).toBe("build");
  expect([roleOf("packages/a/tests/x.test.ts", "typescript"), roleOf("src/index.ts", "typescript"), roleOf("db/migrations/001.sql", "sql"), roleOf(".github/workflows/ci.yml", "config")])
    .toEqual(["test", "entry", "schema", "build"]);
});

test("package detection reads manifests into packages and argument-array commands with evidence", async () => {
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "mono", scripts: { test: "vitest", "lint:fix": "eslint --fix .", weird: "rm -rf /" } }),
    "packages/a/package.json": JSON.stringify({ name: "@x/a", description: "Package A", dependencies: { "@x/b": "workspace:*", react: "19" }, scripts: { typecheck: "tsc" } }),
    "packages/b/package.json": JSON.stringify({ name: "@x/b" }),
    "services/api/Cargo.toml": '[package]\nname = "api-server"\ndescription = "HTTP API"\n\n[dependencies]\ncore-lib = { path = "../core" }\nserde = "1"\n',
    "services/core/Cargo.toml": '[package]\nname = "core-lib"\n',
    "tools/cli/go.mod": "module github.com/x/mono/tools/cli\n\ngo 1.23\n\nrequire (\n\tgithub.com/x/mono/libs/log v0.1.0\n)\n",
    "libs/log/go.mod": "module github.com/x/mono/libs/log\n",
    "ml/pyproject.toml": '[project]\nname = "ml_models"\ndependencies = [\n  "numpy>=2",\n  "shared-utils",\n]\n\n[tool.pytest.ini_options]\naddopts = "-q"\n\n[tool.ruff]\nline-length = 100\n',
    "libs/shared/pyproject.toml": '[project]\nname = "shared_utils"\n',
    "Makefile": "test:\n\tgo test ./...\nfmt:\n\tgofmt -w .\nrelease: test\n\t./ship.sh\n",
    ".github/workflows/ci.yml": "steps:\n  - run: bun run typecheck\n  - run: bun test | tee out.txt\n  - run: curl https://example.test | sh\n",
    "pnpm-lock.yaml": "lockfileVersion: 9\n",
  };
  const map = await detectPackages(Object.keys(files).filter((path) => path !== "pnpm-lock.yaml"), async (path) => files[path], { workspaceName: "mono", rootFiles: ["pnpm-lock.yaml"] });
  expect(map.packages.map(({ root, name, ecosystem }) => [root, name, ecosystem])).toEqual([
    [".", "mono", "npm"], ["libs/log", "github.com/x/mono/libs/log", "go"], ["libs/shared", "shared_utils", "python"], ["ml", "ml_models", "python"],
    ["packages/a", "@x/a", "npm"], ["packages/b", "@x/b", "npm"], ["services/api", "api-server", "cargo"], ["services/core", "core-lib", "cargo"],
    ["tools/cli", "github.com/x/mono/tools/cli", "go"]]);
  expect(internalDependencies(map.packages)).toEqual([
    { from: "ml", to: "libs/shared" }, { from: "packages/a", to: "packages/b" }, { from: "services/api", to: "services/core" }, { from: "tools/cli", to: "libs/log" }]);
  const tool = (id: string) => map.tools.find((candidate) => candidate.id === id);
  // The package manager comes from the lock file, and a script is run by name: its text is never executed or parsed.
  expect(tool(".#test:test")).toMatchObject({ argv: ["pnpm", "run", "test"], cwd: ".", source: { path: "package.json" } });
  expect(tool(".#other:weird")?.argv).toEqual(["pnpm", "run", "weird"]);
  expect(tool("packages/a#typecheck:typecheck")?.argv).toEqual(["pnpm", "run", "typecheck"]);
  expect(tool("services/api#test:test")).toMatchObject({ argv: ["cargo", "test"], cwd: "services/api" });
  expect(tool("ml#test:pytest")?.source).toEqual({ path: "ml/pyproject.toml", line: 8 });
  expect(tool("ml#lint:ruff")?.argv).toEqual(["ruff", "check", "."]);
  expect(tool(".#format:fmt")?.argv).toEqual(["make", "fmt"]);
  expect(map.tools.find(({ source, name }) => source.path === "Makefile" && name === "test")?.argv).toEqual(["make", "test"]);
  expect(new Set(map.tools.map(({ id }) => id)).size).toBe(map.tools.length);
  // CI steps with pipes, substitutions or downloads are not offered as commands.
  expect(map.tools.filter(({ source }) => source.path.endsWith("ci.yml")).map(({ argv }) => argv.join(" "))).toEqual(["bun run typecheck"]);
  expect([toolKind("test:unit"), toolKind("type-check"), toolKind("deploy")]).toEqual(["test", "typecheck", "other"]);
  expect(parseCodeOwners("# c\n*  @org/all\n/packages/billing/ @org/pay @bad!\n*.js @org/js\n")).toEqual([
    { prefix: ".", owners: ["@org/all"] }, { prefix: "packages/billing", owners: ["@org/pay"] }]);
});

test("import maps the repository, links files, and writes a readable knowledge bundle", async () => {
  // Creating a link needs a privilege the Windows runner lacks. The exclusion below holds either way.
  if (process.platform !== "win32") {
    await symlink("/etc/hostname", join(workspace, "packages/auth/src/linked.ts"));
    git("add", "--", "packages/auth/src/linked.ts");
  }
  const report = await importRepository({ workspace });
  expect(report.files).toBeGreaterThan(fixture.files);
  expect(report.packages).toBe(12);
  expect(report.changedFiles).toBe(report.files);
  expect(report.historyCommits).toBe(3);
  expect(report.limitsReached).toEqual({ trackedPaths: false, files: false, packages: false, fileBytes: 0 });

  const atlas = Atlas.open(workspace);
  try {
    const paths = new Set(atlas.all<{ path: string }>("SELECT path FROM files").map(({ path }) => path));
    // Secrets, lock files and links are never read into the map.
    expect(paths.has("packages/billing/.env") || paths.has("bun.lock") || paths.has("packages/auth/src/linked.ts")).toBe(false);
    expect(paths.has("packages/auth/src/session.ts")).toBe(true);
    const edge = (kind: string, src: string, dst: string) => atlas.get<{ weight: number }>(
      "SELECT e.weight FROM file_edges e JOIN files s ON s.id = e.src JOIN files d ON d.id = e.dst WHERE e.kind = ? AND s.path = ? AND d.path = ?", kind, src, dst);
    expect(edge("import", "packages/auth/src/session.ts", "packages/auth/src/token-signer.ts")).toBeDefined();
    // A workspace package import resolves across packages, and a test links to the file it exercises.
    expect(edge("import", "packages/billing/src/publish.ts", "packages/contracts/src/index.ts")).toBeDefined();
    expect(edge("test", "packages/auth/tests/session.test.ts", "packages/auth/src/session.ts")).toBeDefined();
    expect(edge("cochange", "packages/billing/src/publish.ts", "packages/contracts/src/index.ts")?.weight).toBe(1);
    expect(atlas.get<{ owners: string }>("SELECT owners FROM packages WHERE root = 'packages/billing'")?.owners).toBe('["@acme/payments"]');
    expect(atlas.all<{ src: string; dst: string }>(
      "SELECT s.root AS src, d.root AS dst FROM package_edges e JOIN packages s ON s.id = e.src JOIN packages d ON d.id = e.dst WHERE e.kind = 'declared' AND s.root = 'packages/auth'"))
      .toEqual([{ src: "packages/auth", dst: "packages/contracts" }]);
    expect(atlas.get<{ argv: string }>("SELECT argv FROM tools WHERE id = 'packages/billing#test:test'")?.argv).toBe('["bun","run","test"]');
    expect(atlas.meta()).toMatchObject({ files: report.files, units: report.units, generation: 1, limited: false });
  } finally { atlas.close(); }

  const knowledge = report.knowledge.directory;
  const card = parse(readFileSync(join(knowledge, "packages", "packages-billing.md"), "utf8"));
  expect(card.frontmatter).toMatchObject({ type: "code package", title: "@acme/billing", root: "packages/billing" });
  expect((card.frontmatter.generated as { by: string }).by).toStartWith("okb-import/");
  expect(card.body).toContain("[@acme/contracts](/packages/packages-contracts.md)");
  expect(card.body).toContain("`bun run test` in `packages/billing` (from `packages/billing/package.json:");
  expect(card.body).toContain("`@acme/payments`");
  expect(existsSync(join(knowledge, "index.md"))).toBe(true);
  // Nothing from an ignored secret file reaches the bundle.
  expect(readFileSync(join(knowledge, "packages", "packages-billing.md"), "utf8")).not.toContain("STRIPE_SECRET");
});

test("a second import reads only what changed and keeps a person's notes and edits", async () => {
  const knowledge = join(atlasDirectory(workspace), "knowledge");
  const billing = join(knowledge, "packages", "packages-billing.md");
  await writeFile(billing, `${(await readFile(billing, "utf8")).trimEnd()}\n\n## Notes\n\nRefunds are owned by the ledger team.\n`);
  const auth = join(knowledge, "packages", "packages-auth.md");
  await writeFile(auth, (await readFile(auth, "utf8")).replace(/by: okb-import\/\S+/u, "by: human:maintainer").replace("# @acme/auth", "# Auth, rewritten by hand"));

  await writeFile(join(workspace, "packages/auth/src/session.ts"), [
    "/** Rotate the refresh token. */", "export async function refreshSession(record: { user: string }) {", '  return { ...record, marker: "AUTH_REFRESH_V2" };', "}", "",
    "export function revokeAllSessions() {", '  return "REVOKED";', "}", ""].join("\n"));
  await writeFile(join(workspace, "packages/billing/src/dunning.ts"), "export function scheduleDunning() { return 1; }\n");
  git("add", "--", "packages/billing/src/dunning.ts");
  await unlink(join(workspace, "packages/billing/src/tax.ts"));

  const report = await importRepository({ workspace });
  expect([report.changedFiles, report.removedFiles]).toEqual([2, 1]);
  expect(report.unchangedFiles).toBe(report.files - 2);
  expect(report.reembedded).toBe(false);
  const atlas = Atlas.open(workspace);
  try {
    expect(atlas.all<{ name: string }>("SELECT u.name FROM units u JOIN files f ON f.id = u.file WHERE f.path = 'packages/auth/src/session.ts' ORDER BY u.ord").map(({ name }) => name))
      .toEqual(["refreshSession", "revokeAllSessions"]);
    expect(atlas.get("SELECT 1 FROM files WHERE path = 'packages/billing/src/tax.ts'")).toBeUndefined();
    expect(atlas.get("SELECT 1 FROM symbols WHERE name = 'computetax'")).toBeUndefined();
    expect(atlas.meta().generation).toBe(2);
  } finally { atlas.close(); }
  expect(await readFile(billing, "utf8")).toContain("Refunds are owned by the ledger team.");
  // The generated part was refreshed around the note: one more file than before.
  expect(await readFile(billing, "utf8")).toContain("Kind: npm, 47 files");
  expect(await readFile(auth, "utf8")).toContain("# Auth, rewritten by hand");
  expect(report.knowledge.kept).toBe(1);
  await writeFile(join(workspace, "packages/billing/src/tax.ts"), [
    "/** Compute the tax owed for an amount in a region. */", "export function computeTax(amount: number, region: string): number {",
    '  const rate = region === "EU" ? 0.2 : 0.07;', "  return Math.round(amount * rate); // TAX_RULES", "}", ""].join("\n"));
  await importRepository({ workspace });
});

test("scoped ingestion uses tracked root markers and keeps stable partial-file counts", async () => {
  const repo = join(root, "scoped-markers");
  const location = { stateDir: join(root, "scoped-markers-map") };
  const packagePath = join(repo, "packages", "app");
  await mkdir(packagePath, { recursive: true });
  await mkdir(join(repo, "services", "kernel"), { recursive: true });
  const source = join(packagePath, "large.ts");
  const shortSource = "export const known = true;\n";
  await Promise.all([
    writeFile(join(repo, "pnpm-lock.yaml"), "lockfileVersion: 9\n"),
    writeFile(join(repo, "MODULE.bazel"), "module(name = 'fixture')\n"),
    writeFile(join(repo, "private.ts"), "export const outsideScope = true;\n"),
    writeFile(join(packagePath, "package.json"), '{"name":"fixture-app","scripts":{"test":"exit 1"}}'),
    writeFile(join(repo, "services", "kernel", "BUILD.bazel"), '# fixture\n'),
    writeFile(source, shortSource + "x".repeat(512 * 1024)),
  ]);
  for (const args of [["init", "--quiet"], ["add", "--", "."]]) {
    const result = Bun.spawnSync(["git", ...args], { cwd: repo, stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  }
  const workspace = await realpath(repo);
  const options = { workspace, scopes: ["packages/app", "services/kernel"], historyCommits: 0 };
  const first = await importRepository(options, location);
  expect(first.limitsReached.fileBytes).toBe(1);
  const atlas = Atlas.open(workspace, location);
  try {
    expect(atlas.get("SELECT argv FROM tools WHERE id = ?", "packages/app#test:test")).toMatchObject({ argv: '["pnpm","run","test"]' });
    expect(atlas.get("SELECT ecosystem FROM packages WHERE root = ?", "services/kernel")).toMatchObject({ ecosystem: "bazel" });
    expect(atlas.all<{ path: string }>("SELECT path FROM files").map(({ path }) => path)).not.toContain("private.ts");
    expect(atlas.get("SELECT path FROM files WHERE path = 'MODULE.bazel'")).toBeUndefined();
  } finally { atlas.close(); }
  const unchanged = await importRepository(options, location);
  expect(unchanged.changedFiles).toBe(0);
  expect(unchanged.limitsReached.fileBytes).toBe(1);
  // The indexed text is byte-for-byte equivalent when the previously clipped tail is removed.
  await writeFile(source, shortSource);
  const shortened = await importRepository(options, location);
  expect(shortened.changedFiles).toBe(0);
  expect(shortened.limitsReached.fileBytes).toBe(0);
});

test("the readout finds each task's evidence inside the budget and says why", async () => {
  for (const task of fixture.tasks.filter(({ kind }) => kind !== "paraphrased")) {
    const context = await selectAtlasContext({ workspace, query: task.query, tokenBudget: 2000 });
    expect(evidenceRecall(task, context.excerpts), task.id).toBe(1);
    expect(context.manifest.estimatedTokens, task.id).toBeLessThanOrEqual(2000);
    expect(context.manifest.contextBytes).toBeGreaterThanOrEqual(Buffer.byteLength(JSON.stringify(context.excerpts)));
    expect(JSON.stringify(context.manifest)).not.toContain("AUTH_REFRESH");
  }
  const identifier = await selectAtlasContext({ workspace, query: "refreshSession", tokenBudget: 2000 });
  expect(identifier.manifest.files[0]).toMatchObject({ path: "packages/auth/src/session.ts", reason: "Declares refreshSession" });
  // The test that exercises the symbol is reached through its link, not through shared words alone.
  expect(identifier.manifest.files.find(({ path }) => path === "packages/auth/tests/session.test.ts")?.reason).toBeDefined();
  expect(identifier.skills.find(({ id }) => id === "builtin/test-map")?.text).toContain("packages/auth/src/session.ts is tested by packages/auth/tests/session.test.ts");
  expect(identifier.map[0]).toContain("packages/auth — @acme/auth");
  expect(identifier.map[0]).toContain("checks: bun run test");
  // The cross-package task reaches the contract through the import, with no shared words in the contract's name.
  const crossPackage = await selectAtlasContext({ workspace, query: "publishInvoice", tokenBudget: 2000 });
  expect(crossPackage.manifest.files.find(({ path }) => path === "packages/contracts/src/index.ts")?.reason).toContain("packages/billing/src/publish.ts");
  // The same name in two apps: the named directory wins.
  const ambiguous = await selectAtlasContext({ workspace, query: "resolveCustomer", projects: ["apps/customer"], tokenBudget: 1200 });
  expect(ambiguous.manifest.files.every(({ path }) => path.startsWith("apps/customer/"))).toBe(true);
  expect(ambiguous.manifest.projects).toEqual(["apps/customer"]);
});

test("a selection is reproducible, bounded, and never padded with weak matches", async () => {
  const first = await selectAtlasContext({ workspace, query: "where do we retry a declined card charge", tokenBudget: 1500 });
  const second = await selectAtlasContext({ workspace, query: "where do we retry a declined card charge", tokenBudget: 1500 });
  expect(second.manifest.id).toBe(first.manifest.id);
  expect(second.excerpts).toEqual(first.excerpts);
  const narrower = await selectAtlasContext({ workspace, query: "where do we retry a declined card charge", tokenBudget: 300 });
  expect(narrower.manifest.id).not.toBe(first.manifest.id);
  expect(narrower.manifest.estimatedTokens).toBeLessThanOrEqual(300);
  // Words this repository never uses select nothing, rather than its least bad files.
  const nothing = await selectAtlasContext({ workspace, query: "kubernetes ingress annotations for the zeppelin fleet" });
  expect(nothing.excerpts).toEqual([]);
  expect(nothing.manifest.matchedFiles).toBe(0);
  await expect(selectAtlasContext({ workspace, query: "   " })).rejects.toThrow("Enter a task or search text");
  await expect(selectAtlasContext({ workspace, query: "x", tokenBudget: 99999 })).rejects.toThrow("budget from 1 to 16384");
  await expect(selectAtlasContext({ workspace, query: "x", projects: ["../outside"] })).rejects.toThrow("workspace-relative");
  await expect(selectAtlasContext({ workspace: root, query: "refreshSession" })).rejects.toBeInstanceOf(AtlasMissingError);
});

test("an excerpt always comes from the current worktree, even when the map is behind", async () => {
  const path = join(workspace, "packages/billing/src/capture-retry.ts");
  const original = await readFile(path, "utf8");
  await writeFile(path, `// A new header line pushed everything down.\n// And another.\n${original.replace("CAPTURE_RETRY", "CAPTURE_RETRY_EDITED")}`);
  try {
    const context = await selectAtlasContext({ workspace, query: "reattemptCapture", tokenBudget: 1500 });
    const excerpt = context.excerpts.find((candidate) => candidate.path === "packages/billing/src/capture-retry.ts")!;
    expect(excerpt.content).toContain("CAPTURE_RETRY_EDITED");
    expect(excerpt.content).toContain("export async function reattemptCapture");
    expect(context.manifest.atlas?.staleFiles).toBe(1);
    // The manifest binds the bytes that would be sent, so an edit changes the context ID.
    await writeFile(path, original);
    expect((await selectAtlasContext({ workspace, query: "reattemptCapture", tokenBudget: 1500 })).manifest.id).not.toBe(context.manifest.id);
  } finally { await writeFile(path, original); }
});

test("a deleted declaration does not select unrelated current lines from its old file", async () => {
  const path = join(workspace, "packages/auth/src/token-signer.ts");
  const original = await readFile(path, "utf8");
  const options = { workspace, query: "signToken", projects: ["packages/auth/src"], tokenBudget: 1500 };
  const before = await selectAtlasContext(options);
  expect(before.manifest.files.some(({ path, reason }) => path.endsWith("/token-signer.ts") && reason === "Declares signToken")).toBe(true);
  await writeFile(path, 'export function computeShippingCost() { return "UNRELATED"; }\n');
  try {
    const after = await selectAtlasContext({ ...options, deferred: true });
    expect([...after.excerpts, ...after.deferred].every(({ path }) => !path.endsWith("/token-signer.ts"))).toBe(true);
    expect(after.manifest.atlas?.staleFiles).toBe(1);
    expect(after.ranked.find(({ path }) => path.endsWith("/token-signer.ts"))?.selected).toBe(false);
  } finally { await writeFile(path, original); }
});

test("deferred excerpts are approved and saved but named apart from what is sent", async () => {
  const context = await selectAtlasContext({ workspace, query: "session token", tokenBudget: 600, deferred: true });
  expect(context.deferred.length).toBeGreaterThan(0);
  expect(context.manifest.atlas?.deferred.map(({ path, startLine }) => `${path}:${startLine}`))
    .toEqual(context.deferred.map(({ path, startLine }) => `${path}:${startLine}`));
  for (const excerpt of context.deferred)
    expect(context.excerpts.some((sent) => sent.path === excerpt.path && sent.startLine <= excerpt.startLine && sent.endLine >= excerpt.endLine)).toBe(false);
  expect(context.map.filter((line) => line.startsWith("on request: ")).length).toBe(context.deferred.length);
  const without = await selectAtlasContext({ workspace, query: "session token", tokenBudget: 600 });
  expect(without.deferred).toEqual([]);
  expect(without.manifest.id).not.toBe(context.manifest.id);

  const tiny = { workspace, query: "refreshSession", tokenBudget: 1 };
  const emptyDeferred = await selectAtlasContext({ ...tiny, deferred: true });
  expect(emptyDeferred.deferred).toEqual([]);
  expect(emptyDeferred.manifest.id).not.toBe((await selectAtlasContext(tiny)).manifest.id);
});

test("merging nearby excerpts cannot spend the budget on an oversized gap", async () => {
  const repo = join(root, "excerpt-gap");
  await mkdir(repo);
  const run = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: repo, stderr: "pipe" });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  };
  const body = (name: string) => [`export function ${name}() {`, ...Array<string>(10).fill("  prepareRecord();"), "}"].join("\n");
  await writeFile(join(repo, "records.ts"), `${body("loadRecord")}\n${" ".repeat(3500)}\n${body("saveRecord")}\n`);
  run("init", "--quiet");
  run("add", "--", "records.ts");
  const location = { stateDir: join(root, "excerpt-gap-atlas") };
  await importRepository({ workspace: repo, historyCommits: 0 }, location);
  const { manifest, excerpts } = await readAtlas({ workspace: repo, query: "loadRecord saveRecord", tokenBudget: 800 }, {}, location);
  expect(excerpts.map(({ content }) => content.split("\n")[0])).toEqual(["export function loadRecord() {", "export function saveRecord() {"]);
  expect(manifest.estimatedTokens).toBeLessThanOrEqual(800);
});

test("map facts stay in request scope and are dropped when their source leaves Git", async () => {
  const repo = await buildMonorepo(join(root, "map-sources"), 48);
  const location = { stateDir: join(root, "map-sources-atlas") };
  const options = { workspace: repo.workspace, query: "refreshSession", tokenBudget: 3000 };
  await importRepository({ workspace: repo.workspace }, location);
  const select = (scope: Pick<Parameters<typeof selectAtlasContext>[0], "projects" | "exclude"> = {}) =>
    selectAtlasContext({ ...options, ...scope }, location);
  const navigation = ({ map, skills }: Awaited<ReturnType<typeof selectAtlasContext>>) => JSON.stringify([map, skills]);
  const before = navigation(await select({ projects: ["packages/auth"] }));
  expect(before).toContain("packages/auth/tests");
  expect(before).toContain("packages/auth/package.json");
  expect(before).not.toContain("@acme/contracts");
  const narrow = navigation(await select({ projects: ["packages/auth/src"] }));
  expect(narrow).not.toContain("packages/auth/tests");
  expect(narrow).not.toContain("packages/auth/package.json");
  expect(narrow).not.toContain("checks:");
  expect(narrow).not.toContain("Auth domain logic for the storefront");
  const excluded = navigation(await select({ projects: ["packages/auth"], exclude: ["packages/auth/tests"] }));
  expect(excluded).not.toContain("packages/auth/tests");
  expect(excluded).toContain("packages/auth/package.json");

  const result = Bun.spawnSync(["git", "rm", "--cached", "--quiet", "--", "packages/auth/package.json", "packages/auth/tests/session.test.ts"], { cwd: repo.workspace, stderr: "pipe" });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const refreshed = await select({ projects: ["packages/auth"] });
  expect(refreshed.excerpts.some(({ path }) => path === "packages/auth/src/session.ts")).toBe(true);
  const after = navigation(refreshed);
  expect(after).not.toContain("packages/auth/tests");
  expect(after).not.toContain("packages/auth/package.json");
  expect(after).not.toContain("checks:");
  expect(after).not.toContain("Auth domain logic for the storefront");
});

test("scope filters exact declaration matches before the candidate limit", async () => {
  const repo = join(root, "scoped-matches");
  await mkdir(join(repo, "background"), { recursive: true });
  await mkdir(join(repo, "target"));
  const declaration = "export function sharedLookup() { return 1; }\n";
  for (let start = 0; start < 264; start += 24) {
    await Promise.all(Array.from({ length: 24 }, (_, offset) =>
      writeFile(join(repo, "background", `file-${start + offset}.ts`), declaration)));
  }
  await writeFile(join(repo, "target", "lookup.ts"), declaration);
  for (const args of [["init", "--quiet"], ["add", "--", "."]]) {
    const result = Bun.spawnSync(["git", ...args], { cwd: repo, stderr: "pipe" });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  }
  const location = { stateDir: join(root, "scoped-matches-atlas") };
  const { files } = await importRepository({ workspace: repo, historyCommits: 0 }, location);
  expect(files).toBe(265);
  const { manifest } = await readAtlas({ workspace: repo, query: "sharedLookup", projects: ["target"] }, {}, location);
  expect(manifest.files).toMatchObject([{ path: "target/lookup.ts", reason: "Declares sharedLookup" }]);
});

test("re-import applies a narrower history limit even when the checkout is unchanged", async () => {
  const repo = await buildMonorepo(join(root, "history-limit"), 48);
  const location = { stateDir: join(root, "history-limit-atlas") };
  const options = { workspace: repo.workspace };
  expect(await importRepository({ ...options, historyCommits: 3 }, location)).toMatchObject({ historyCommits: 3, couplingEdges: 1 });
  expect(await importRepository({ ...options, historyCommits: 1 }, location)).toMatchObject({ historyCommits: 1, couplingEdges: 0, changedFiles: 0 });
  expect(await importRepository({ ...options, historyCommits: 2 }, location)).toMatchObject({ historyCommits: 2, couplingEdges: 1, changedFiles: 0 });
  expect(await importRepository({ workspace: join(repo.workspace, "packages"), historyCommits: 2 }, location))
    .toMatchObject({ historyCommits: 2, couplingEdges: 1 });
});

test("the readout's cost does not grow with the repository", async () => {
  const large = await buildMonorepo(join(root, "large"), 2400);
  await importRepository({ workspace: large.workspace, historyCommits: 0 });
  const small = await readAtlas({ workspace, query: "refreshSession", tokenBudget: 1500 });
  const big = await readAtlas({ workspace: large.workspace, query: "refreshSession", tokenBudget: 1500 });
  expect(big.manifest.scannedFiles).toBeGreaterThan(small.manifest.scannedFiles * 5);
  // Seven times the units, the same budget, the same evidence.
  expect(big.manifest.estimatedTokens).toBeLessThanOrEqual(1500);
  expect(evidenceRecall(large.tasks[0]!, big.excerpts)).toBe(1);
  expect(removeAtlas(large.workspace)).toBe(true);
  await expect(selectAtlasContext({ workspace: large.workspace, query: "refreshSession" })).rejects.toBeInstanceOf(AtlasMissingError);
  // Removing the derived map leaves the knowledge bundle in place.
  expect(existsSync(join(atlasDirectory(large.workspace), "knowledge", "index.md"))).toBe(true);
});

test("an interrupted import never leaves a half-updated map in use", async () => {
  const repo = await buildMonorepo(join(root, "interrupted"), 96);
  const location = { stateDir: join(root, "interrupted-atlas") };
  const identifier = repo.tasks[0]!;
  const stopAt = (phase: string) => {
    const cancel = new AbortController();
    return { signal: cancel.signal, progress: (progress: { phase: string }) => { if (progress.phase === phase) cancel.abort(); } };
  };

  // Nothing can read a first import before it is published, so its progress is kept and the next run resumes.
  await expect(importRepository({ workspace: repo.workspace, ...stopAt("link") }, location)).rejects.toThrow("The repository import was cancelled.");
  await expect(selectAtlasContext({ workspace: repo.workspace, query: identifier.query }, location)).rejects.toBeInstanceOf(AtlasMissingError);
  const first = await importRepository({ workspace: repo.workspace }, location);
  expect(first).toMatchObject({ generation: 1, changedFiles: 0, unchangedFiles: first.files });
  const before = await selectAtlasContext({ workspace: repo.workspace, query: identifier.query, tokenBudget: 1200 }, location);
  expect(evidenceRecall(identifier, before.excerpts)).toBe(1);

  // Edit the very file a request needs, then stop the next import after it has re-read that file.
  const session = join(repo.workspace, "packages/auth/src/session.ts");
  await writeFile(session, `${await readFile(session, "utf8")}\nexport function touchedSession(): string { return "TOUCHED_MARKER"; }\n`);
  for (const phase of ["link", "embed", "publish"]) {
    await expect(importRepository({ workspace: repo.workspace, ...stopAt(phase) }, location)).rejects.toThrow("The repository import was cancelled.");
    // The published map is untouched: same generation, and the edited file is still found through it.
    const during = await selectAtlasContext({ workspace: repo.workspace, query: identifier.query, tokenBudget: 1200 }, location);
    expect(during.manifest.atlas).toMatchObject({ generation: 1, staleFiles: 1 });
    expect(evidenceRecall(identifier, during.excerpts)).toBe(1);
  }
  expect(readdirSync(atlasDirectory(repo.workspace, location)).filter((name) => name.endsWith(".vec"))).toContain("units-1.vec");

  const beforeCommit = new AbortController();
  await expect(importRepository({ workspace: repo.workspace, signal: beforeCommit.signal, progress: ({ phase, done, total }) => {
    if (phase === "publish" && done === total) beforeCommit.abort();
  } }, location)).rejects.toThrow("The repository import was cancelled.");
  const unchanged = await selectAtlasContext({ workspace: repo.workspace, query: identifier.query }, location);
  expect(unchanged.manifest.atlas?.generation).toBe(1);

  const fromEventLoop = new AbortController();
  await expect(importRepository({ workspace: repo.workspace, signal: fromEventLoop.signal, progress: ({ phase }) => {
    if (phase === "embed") setImmediate(() => fromEventLoop.abort());
  } }, location)).rejects.toThrow("The repository import was cancelled.");
  expect((await selectAtlasContext({ workspace: repo.workspace, query: identifier.query }, location)).manifest.atlas?.generation).toBe(1);

  const afterCommit = new AbortController();
  const second = await importRepository({ workspace: repo.workspace, signal: afterCommit.signal, progress: ({ phase }) => {
    if (phase === "knowledge") afterCommit.abort();
  } }, location);
  expect(second).toMatchObject({ generation: 2, changedFiles: 1 });
  expect(readdirSync(atlasDirectory(repo.workspace, location)).filter((name) => name.endsWith(".vec"))).toEqual(["units-2.vec"]);
  const after = await selectAtlasContext({ workspace: repo.workspace, query: "touchedSession", tokenBudget: 1200 }, location);
  expect(after.excerpts.some(({ path, content }) => path === "packages/auth/src/session.ts" && content.includes("TOUCHED_MARKER"))).toBe(true);
  expect(after.manifest.atlas).toMatchObject({ generation: 2, staleFiles: 0 });
});

test("a file that leaves the Git index after import is never read, named, or sent", async () => {
  const repo = await buildMonorepo(join(root, "untracked"), 48);
  const location = { stateDir: join(root, "untracked-atlas") };
  const run = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: repo.workspace, stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  };
  await importRepository({ workspace: repo.workspace }, location);
  const identifier = repo.tasks[0]!;
  const select = (extra: { deferred?: true } = {}) => selectAtlasContext({ workspace: repo.workspace, query: "refreshSession signToken", tokenBudget: 1500, ...extra }, location);
  const before = await select();
  expect(evidenceRecall(identifier, before.excerpts)).toBe(1);
  expect(before.manifest.atlas?.untrackedFiles).toBeUndefined();

  // The file stays on disk, as it does when someone untracks a file that should never have been committed.
  run("rm", "--cached", "--quiet", "--", "packages/auth/src/session.ts");
  expect(existsSync(join(repo.workspace, "packages/auth/src/session.ts"))).toBe(true);
  for (const context of [await select(), await select({ deferred: true })]) {
    const sent = JSON.stringify([context.excerpts, context.deferred, context.map, context.skills, context.manifest.files, context.manifest.atlas?.deferred]);
    expect(sent).not.toContain("packages/auth/src/session.ts");
    // Text that only that file holds. The tracked test still names the function it calls.
    expect(sent).not.toContain("SESSION_EXPIRED");
    expect(sent).not.toContain("Rotate the refresh token");
    expect(sent).not.toContain("endSession");
    expect(context.manifest.atlas?.untrackedFiles).toBe(1);
    // Code that is still tracked is found as before.
    expect(context.excerpts.some(({ path }) => path === "packages/auth/src/token-signer.ts")).toBe(true);
  }

  // Tracking it again restores it without another import, and a new import drops what stays untracked.
  run("add", "--", "packages/auth/src/session.ts");
  const restored = await select();
  expect(evidenceRecall(identifier, restored.excerpts)).toBe(1);
  expect(JSON.stringify(restored.skills)).toContain("packages/auth/src/session.ts is tested by packages/auth/tests/session.test.ts");
  // A fact about the selection never names a linked file that has left the index either.
  run("rm", "--cached", "--quiet", "--", "packages/auth/tests/session.test.ts");
  const withoutTest = await select();
  expect(evidenceRecall(identifier, withoutTest.excerpts)).toBe(1);
  expect(JSON.stringify([withoutTest.excerpts, withoutTest.map, withoutTest.skills, withoutTest.manifest.files])).not.toContain("packages/auth/tests/session.test.ts");
  run("add", "--", "packages/auth/tests/session.test.ts");
  run("rm", "--cached", "--quiet", "--", "packages/auth/src/session.ts");
  await importRepository({ workspace: repo.workspace }, location);
  const after = await select();
  expect(after.manifest.atlas?.untrackedFiles).toBeUndefined();
  expect(JSON.stringify(after)).not.toContain("packages/auth/src/session.ts");

  // Outside a Git checkout the map cannot confirm anything, so it selects nothing.
  await rm(join(repo.workspace, ".git"), { recursive: true, force: true });
  await expect(select()).rejects.toThrow("Git could not confirm");
});
