import assert from "node:assert/strict";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { createApiServer } from "../src/api.ts";
import { runCodingSession } from "../src/core/coding/durable.ts";
import type { CodingRunReport } from "../src/core/coding/run-report.ts";
import { loadConfig } from "../src/core/config.ts";
import { closeCacheClient, createCacheClient, readCacheSettings } from "../src/core/engine/cache-settings.ts";
import { parse } from "../src/core/okf/document.ts";
import { githubBranchBrowserFixture } from "./github-branch-browser-fixture.ts";

const root = await mkdtemp(join(tmpdir(), "okbrain-browser-smoke-"));
process.env.XDG_CONFIG_HOME = join(root, "config");
process.env.XDG_DATA_HOME = join(root, "data");
process.env.APPDATA = join(root, "config");
process.env.LOCALAPPDATA = join(root, "data");
const bundle = join(root, "brain");
const postgresFixture = process.env.OKB_SMOKE_CACHE_URL;
await mkdir(bundle);
const standaloneState = join(root, "standalone-coding");
const standaloneModels = createModels();
const standaloneFaux = fauxProvider({ provider: "openai", models: [{ id: "browser-coding-fixture" }] });
standaloneModels.setProvider(standaloneFaux.provider);
const projectModels = createModels();
const projectFaux = fauxProvider({
  provider: "openai", models: [{ id: "browser-project-fixture", contextWindow: 65_536, maxTokens: 4_096 }],
});
projectModels.setProvider(projectFaux.provider);
projectModels.setProvider(googleProvider());
const branchBefore = "export const sourceMarker = 'approved browser source';\n";
const branchAfter = "export const sourceMarker = \"<script>branch preview stays text</script>\";\n";
const githubFixture = githubBranchBrowserFixture("browser.ts", branchBefore, branchAfter);
const server = createApiServer({
  bundle, port: 0,
  coding: { stateDir: join(root, "coding-projects"), models: projectModels, githubFetch: githubFixture.fetch },
  standaloneCoding: { stateDir: standaloneState, models: standaloneModels },
});
const finishAnswer = Promise.withResolvers<void>();
const finishStandalone = Promise.withResolvers<void>();
const finishProject = Promise.withResolvers<void>();
let answerSource = "";
const chatFixture = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  const input = await req.json() as { stream?: boolean; model?: string; input?: string[] };
  if (new URL(req.url).pathname === "/embeddings") {
    assert.equal(input.model, "fixture-embedding-model");
    return Response.json({ data: input.input?.map(() => ({ embedding: [1, 0, 0, 0] })) });
  }
  assert.equal(input.stream, true);
  const encoder = new TextEncoder();
  function frame(content: string, finish_reason?: string) {
    return encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason }] })}\n\n`);
  }
  return new Response(new ReadableStream({ async start(controller) {
    controller.enqueue(frame("**Local answer**"));
    await finishAnswer.promise;
    controller.enqueue(frame(` [${answerSource}]`, "stop"));
    controller.close();
  } }), { headers: { "content-type": "text/event-stream" } });
} });
process.env.OKB_CHAT_PROVIDER = "ollama";
process.env.OKB_CHAT_BASE_URL = `http://127.0.0.1:${chatFixture.port}`;
process.env.OKB_EMBED_BASE_URL = `http://127.0.0.1:${chatFixture.port}`;
let browser: Browser | undefined;

async function selectGraphNote(page: Page, id: string) {
  const exists = (note: string) => {
    const { cy } = window as unknown as { cy?: { getElementById(id: string): { length: number; emit(event: string): void } } };
    return Boolean(cy?.getElementById(note).length);
  };
  await page.waitForFunction(exists, id);
  await page.evaluate(({ note }) => {
    const { cy } = window as unknown as { cy: { getElementById(id: string): { emit(event: string): void } } };
    cy.getElementById(note).emit("tap");
  }, { note: id });
}

try {
  browser = await chromium.launch({ executablePath: process.env.OKB_SMOKE_CHROMIUM || undefined });
  const page = await browser.newPage({ viewport: { width: 375, height: 700 }, reducedMotion: "reduce", locale: "en-US" });
  page.setDefaultTimeout(8000);
  const origin = new URL(server.url).origin;
  const errors: string[] = [];
  const outbound: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", async (route) => {
    if (new URL(route.request().url()).origin === origin) {
      await route.continue();
    } else {
      outbound.push(route.request().url());
      await route.abort();
    }
  });

  await page.goto(server.url);
  const nav = page.getByRole("navigation", { name: "okbrain" });
  const enable = page.getByRole("button", { name: "Enable search and review" });
  await enable.waitFor();
  await page.getByRole("heading", { name: "Start with a template" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Create starter guide" }).isDisabled(), true);
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Skip to content");
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "view");

  await page.getByRole("textbox", { name: "Quick note" }).focus();
  await page.keyboard.type("Offline orchid propagation");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await page.getByRole("link", { name: "Open saved note" }).waitFor();
  answerSource = decodeURIComponent((await page.getByRole("link", { name: "Open saved note" }).getAttribute("href"))!.slice("#concept/".length));
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Open saved note");
  await page.keyboard.press("Enter");
  await page.getByText("Offline orchid propagation", { exact: true }).first().waitFor();
  await nav.getByRole("link", { name: "Home", exact: true }).click();
  await enable.click();
  await page.getByRole("link", { name: "Search notes", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Search notes");
  await page.keyboard.press("Enter");

  await page.getByRole("searchbox", { name: "Search notes", exact: true }).focus();
  const semantic = page.getByRole("checkbox", { name: "Use configured semantic retrieval" });
  assert.equal(await semantic.isChecked(), false);
  await semantic.check();
  await page.getByRole("combobox", { name: "Retrieval profile" }).selectOption("lean");
  await semantic.uncheck();
  await page.getByRole("searchbox", { name: "Search notes", exact: true }).focus();
  await page.keyboard.type("orchid");
  await page.keyboard.press("Enter");
  await page.getByRole("link", { name: "Offline orchid propagation", exact: true }).waitFor();
  await page.locator("#sout mark", { hasText: "orchid" }).waitFor();
  await page.locator("#sout").getByRole("link", { name: "Focused map" }).click();
  await page.getByText("1 note, 0 links.").waitFor();
  await nav.getByRole("link", { name: "Ask", exact: true }).click();
  await page.getByRole("textbox", { name: "Question", exact: true }).fill("orchid");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await page.locator("#askout", { hasText: "**Local answer**" }).waitFor();
  await page.getByRole("button", { name: "Stop", exact: true }).waitFor();
  finishAnswer.resolve();
  await page.locator("#askout strong", { hasText: "Local answer" }).waitFor();
  await page.locator("#asksrc").getByRole("link", { name: "Offline orchid propagation", exact: true }).waitFor();
  await nav.getByRole("link", { name: "Review", exact: true }).click();
  await page.getByRole("button", { name: /Reviewed/ }).first().waitFor();
  await page.getByLabel("Queue size", { exact: true }).fill("1");
  await page.locator("#rprofile").selectOption("lean");
  await page.getByRole("button", { name: "Update queue" }).click();
  await page.locator("#rlist .card").waitFor();
  assert.equal(await page.locator("#rlist .card").count(), 1);
  await page.getByLabel("Snooze days", { exact: true }).fill("3");
  const snoozed = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/op/review_snooze");
  await page.getByRole("button", { name: "Snooze", exact: true }).click();
  assert.equal((await snoozed).request().postDataJSON().days, 3);
  await page.keyboard.press("/");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "qs-in");

  await nav.getByRole("link", { name: "Add", exact: true }).click();
  await page.locator("#cap-text").fill("Source notes about a pressed violet.");
  await page.locator("#cap-title").fill("Violet field notes");
  await page.locator("#capf").getByRole("button", { name: "Capture", exact: true }).click();
  await page.locator("#cap-out").getByRole("link", { name: "open", exact: true }).click();
  await page.getByRole("heading", { name: "Violet field notes", exact: true }).waitFor();
  await nav.getByRole("link", { name: "Add", exact: true }).click();
  await page.getByText("Highlights and tags", { exact: true }).click();
  await page.locator("#clipf").getByLabel("Quote", { exact: true }).waitFor();
  const markdown = join(root, "garden-card.md");
  await writeFile(markdown, "# Garden card\n\nFor the spring beds.\n");
  await page.locator("#imp-path").fill(markdown);
  await page.locator("#imp-type").fill("reference");
  await page.locator("#impf").getByRole("button", { name: "Import", exact: true }).click();
  await page.locator("#imp-out").getByText(/1 imported, 0 skipped/).waitFor();
  assert.match(await Bun.file(join(bundle, "garden-card.md")).text(), /^type: reference$/m);

  await nav.getByRole("link", { name: "Accounts", exact: true }).click();
  await page.getByText("No connected account is selected.").waitFor();
  await page.getByRole("link", { name: "Ask with ChatGPT", exact: true }).click();
  await page.getByText("Connect an eligible account to continue.").waitFor();
  await nav.getByRole("link", { name: "Settings", exact: true }).click();
  const cacheSettings = page.locator("#cache-settings");
  await cacheSettings.getByText("SQLite", { exact: true }).waitFor();
  await cacheSettings.getByText("Change cache backend", { exact: true }).click();
  const cacheConnection = cacheSettings.getByLabel("Local PostgreSQL connection URL", { exact: true });
  assert.equal(await cacheConnection.getAttribute("type"), "password");
  await cacheConnection.fill("postgresql://user:browser-fixture-secret@example.invalid/brain");
  await cacheSettings.getByRole("button", { name: "Connect and use PostgreSQL" }).click();
  await cacheSettings.getByRole("status").getByText(/loopback address/).waitFor();
  assert.doesNotMatch(await cacheSettings.getByRole("status").innerText(), /browser-fixture-secret/);
  await cacheSettings.getByText("SQLite", { exact: true }).waitFor();
  if (postgresFixture) {
    await cacheConnection.fill(postgresFixture);
    await cacheSettings.getByRole("button", { name: "Connect and use PostgreSQL" }).click();
    await cacheSettings.getByText("PostgreSQL with pgvector", { exact: true }).waitFor();
    assert.equal(await cacheConnection.inputValue(), "");
    const indexed = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/op/index");
    await page.getByRole("button", { name: "Re-index", exact: true }).click();
    assert.equal((await indexed).status(), 200);
    await nav.getByRole("link", { name: "Search", exact: true }).click();
    await page.getByRole("searchbox", { name: "Search notes", exact: true }).fill("orchid");
    await page.getByRole("searchbox", { name: "Search notes", exact: true }).press("Enter");
    await page.locator("#sout mark", { hasText: "orchid" }).first().waitFor();
    await nav.getByRole("link", { name: "Settings", exact: true }).click();
    await cacheSettings.getByText("Change cache backend", { exact: true }).click();
    await cacheSettings.getByRole("button", { name: "Use SQLite", exact: true }).click();
    await cacheSettings.getByText("SQLite", { exact: true }).waitFor();
  }
  await cacheSettings.getByText("Change cache backend", { exact: true }).click();
  await page.getByRole("button", { name: "Turn on local counts" }).click();
  await page.getByText("Counting local usage.", { exact: true }).waitFor();
  await page.evaluate((id) => { location.hash = "#concept/" + encodeURIComponent(id); }, answerSource);
  await page.getByText("1 open · 0 Ask citations").waitFor();
  await nav.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Turn off and clear counts" }).click();
  await page.getByText("Local counts are off.", { exact: true }).waitFor();
  await page.getByLabel("Folder path in this brain", { exact: true }).fill("inbox");
  await page.getByRole("button", { name: "Enable folder log" }).click();
  await page.getByText("inbox/log.md created.", { exact: true }).waitFor();
  assert.equal(await Bun.file(join(bundle, "inbox", "log.md")).text(), "# Log\n");
  await page.getByLabel("Index format", { exact: true }).selectOption("reference");
  await page.getByRole("button", { name: "Update index files" }).click();
  await page.getByText("Markdown index files updated.", { exact: true }).waitFor();
  assert.match(await Bun.file(join(bundle, "inbox", "index.md")).text(), /^# note$/m);
  assert.equal(await page.getByRole("checkbox", { name: "Include private drafts in graph export" }).isChecked(), false);
  await page.getByRole("checkbox", { name: "Embed app fonts in graph export" }).check();
  const exported = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/op/export_viz");
  await page.getByRole("button", { name: "Export viz.html" }).click();
  assert.equal((await exported).status(), 200);
  assert.match(await Bun.file(join(bundle, "viz.html")).text(), /data:font\/woff2;base64,/);
  const offlineViewer = await browser.newPage({ viewport: { width: 800, height: 560 }, reducedMotion: "reduce" });
  offlineViewer.on("pageerror", (error) => errors.push(error.message));
  await offlineViewer.route(/^https?:/, async (route) => { outbound.push(route.request().url()); await route.abort(); });
  try {
    await offlineViewer.goto(pathToFileURL(join(bundle, "viz.html")).href);
    await selectGraphNote(offlineViewer, answerSource);
    await offlineViewer.locator("#detail").getByRole("heading", { name: "Offline orchid propagation" }).waitFor();
    await offlineViewer.locator("#filters input[data-type=note]").uncheck();
    assert.equal(await offlineViewer.locator("#filters input[data-type=note]").isChecked(), false);
  } finally { await offlineViewer.close(); }
  const markdownExport = page.locator("#markdown-export");
  assert.equal(await markdownExport.getByRole("checkbox", { name: "Include private drafts in Markdown export" }).isChecked(), false);
  const vault = join(root, "exported vault");
  await markdownExport.getByLabel("New export folder (absolute path)").fill(vault);
  await markdownExport.getByRole("button", { name: "Export Markdown" }).click();
  await markdownExport.getByRole("status").getByText(/^Exported [1-9]\d* notes? to /).waitFor();
  assert.match(await Bun.file(join(vault, `${answerSource}.md`)).text(), /Offline orchid propagation/);
  const keys = page.locator("#provider-keys");
  await keys.getByRole("combobox", { name: "API provider" }).selectOption("openai");
  await keys.getByLabel("API key", { exact: true }).fill("fixture-key-for-browser-smoke");
  await keys.getByRole("button", { name: "Save key" }).click();
  await keys.getByText("Key saved locally.", { exact: false }).waitFor();
  await keys.getByRole("button", { name: "Remove saved key" }).click();
  await keys.getByText("No saved key.", { exact: false }).waitFor();

  const previousAi = loadConfig().ai;
  await page.getByRole("button", { name: "Use as default brain" }).click();
  await page.getByText("This folder is the default.", { exact: true }).waitFor();
  assert.equal(loadConfig().defaultBundle, bundle);
  assert.deepEqual(loadConfig().ai, previousAi);
  const providerForm = page.locator("#setf");
  await providerForm.getByLabel("Chat endpoint (optional)", { exact: true }).fill("http://127.0.0.1:21234/v1");
  await providerForm.getByLabel("Embedding endpoint (optional)", { exact: true }).fill("http://127.0.0.1:21235/v1");
  await providerForm.getByRole("button", { name: "Save", exact: true }).click();
  await page.locator("#set-out .notice").waitFor();
  assert.equal(loadConfig().ai?.baseUrl, "http://127.0.0.1:21234/v1");
  assert.equal(loadConfig().ai?.embedBaseUrl, "http://127.0.0.1:21235/v1");
  await providerForm.getByLabel("Restore default chat endpoint", { exact: true }).check();
  await providerForm.getByLabel("Restore default embedding endpoint", { exact: true }).check();
  await providerForm.getByRole("button", { name: "Save", exact: true }).click();
  await page.locator("#set-out .notice").waitFor();
  assert.equal(loadConfig().ai?.baseUrl, undefined);
  assert.equal(loadConfig().ai?.embedBaseUrl, undefined);

  const mounts = page.locator("#brain-mount-settings");
  await mounts.getByText("Add a brain folder", { exact: true }).click();
  await mounts.getByLabel("Mount name").fill("field-notes");
  await mounts.getByLabel("Folder action").selectOption("create");
  await mounts.getByLabel("Absolute folder path").fill(join(root, "field-notes"));
  await mounts.getByLabel("Default retrieval profile").selectOption("lean");
  await mounts.getByText("AI defaults for this brain", { exact: true }).click();
  await mounts.getByLabel("Brain chat provider").selectOption("llamacpp");
  await mounts.getByLabel("Brain chat model").fill("field-chat");
  await mounts.getByLabel("Brain embedding provider").selectOption("ollama");
  await mounts.getByLabel("Brain embedding model").fill("field-embed");
  await mounts.getByRole("button", { name: "Add brain folder" }).click();
  await page.getByRole("heading", { name: "field-notes", exact: true }).waitFor();
  assert.equal(await page.locator("#brain").inputValue(), "field-notes");
  assert.equal(await (await fetch(new URL("api/status", server.url), { headers: {
    "x-okb-token": server.token, "x-okb-brain": "field-notes",
  } })).json().then((data: { retrievalProfile: string }) => data.retrievalProfile), "lean");
  await page.getByLabel("Starter template").selectOption("projects");
  await page.getByText("This adds one editable Markdown guide.", { exact: false }).waitFor();
  await page.getByRole("button", { name: "Create starter guide" }).click();
  await page.getByRole("heading", { name: "Projects and decisions starter guide", exact: true }).waitFor();
  assert.match(await Bun.file(join(root, "field-notes", "start-here.md")).text(), /starter_template: projects/);
  await nav.getByRole("link", { name: "Settings", exact: true }).click();

  const privateSync = page.getByRole("region", { name: "Git sync", exact: true });
  const privateGitHub = privateSync.locator("[data-sync-github]");
  assert.equal(await privateGitHub.isVisible(), false);
  await privateSync.getByLabel("Origin HTTPS URL", { exact: true }).fill("https://github.com/fixture-owner/private-knowledge.git");
  await privateSync.getByRole("button", { name: "Connect origin", exact: true }).click();
  await privateGitHub.getByText("GitHub credentials", { exact: true }).click();
  await privateGitHub.getByText("fixture-owner/private-knowledge", { exact: true }).waitFor();
  const login = privateGitHub.getByLabel("GitHub login", { exact: true });
  const tokenInput = privateGitHub.getByLabel("GitHub personal access token", { exact: true });
  const fakeGitHubTokens = ["github_pat_" + "a".repeat(36), "github_pat_" + "b".repeat(36)];
  assert.equal(await tokenInput.getAttribute("type"), "password");
  for (const [index, fakeToken] of fakeGitHubTokens.entries()) {
    await login.fill("fixture-owner");
    await tokenInput.fill(fakeToken);
    const savedCredential = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/brains/sync-github" &&
      response.request().postDataJSON().action === "save");
    await privateGitHub.getByRole("button", { name: index === 0 ? "Save GitHub credential" : "Replace GitHub credential", exact: true }).click();
    const saved = await savedCredential;
    const receipt = await saved.text();
    assert.ok(saved.ok(), "GitHub credential save returned " + saved.status() + " " + receipt.replaceAll(fakeToken, "[credential]"));
    assert.equal(receipt.includes(fakeToken), false);
    await privateGitHub.getByText("GitHub credential saved.", { exact: true }).waitFor();
    assert.equal(await tokenInput.inputValue(), "");
  }
  const fieldBrain = join(root, "field-notes");
  const fieldConfig = await Bun.file(join(fieldBrain, ".git", "config")).text();
  for (const fakeToken of fakeGitHubTokens) assert.equal(fieldConfig.includes(fakeToken), false);
  assert.match(fieldConfig, /url = https:\/\/github\.com\/fixture-owner\/private-knowledge\.git/u);
  const changedGitHub = Bun.spawnSync(["git", "-C", fieldBrain, "remote", "set-url", "origin", "https://example.invalid/inactive.git"]);
  assert.equal(changedGitHub.exitCode, 0, changedGitHub.stderr.toString());
  await privateSync.getByRole("button", { name: "Refresh Git status", exact: true }).click();
  await privateGitHub.getByText("The saved credential for fixture-owner/private-knowledge is inactive.", { exact: true }).waitFor();
  assert.equal(await tokenInput.isVisible(), false);
  await privateGitHub.getByRole("button", { name: "Remove GitHub credential", exact: true }).click();
  await privateGitHub.getByText("GitHub credential removed.", { exact: true }).waitFor();
  assert.equal(await privateGitHub.getByRole("button", { name: "Remove GitHub credential", exact: true }).isVisible(), false);

  const restorePanel = mounts.locator("[data-mount-restore-panel]");
  const restoreName = restorePanel.getByLabel("Restored brain name", { exact: true });
  const restoreToken = restorePanel.getByLabel("GitHub personal access token", { exact: true });
  const rememberRestore = restorePanel.getByRole("checkbox", { name: "Save credential for future sync", exact: true });
  const restoreButton = restorePanel.getByRole("button", { name: "Restore brain", exact: true });
  const restoreOrigin = "https://github.com/fixture-owner/backup.git";
  const restoredPath = join(root, "restored-notes");
  const retainedPath = join(root, "retained-notes");
  const restoreCommit = "d".repeat(40);
  const restoreRequest = Promise.withResolvers<void>();
  const releaseRestore = Promise.withResolvers<void>();
  const restores: unknown[] = [];
  const restoreRoute = "**/api/brains";
  await page.route(restoreRoute, async (route) => {
    const request = route.request();
    if (request.method() !== "POST") { await route.continue(); return; }
    const input = request.postDataJSON() as Record<string, unknown>;
    assert.equal(request.headers()["x-okb-brain"], "field-notes");
    restores.push(input);
    if (restores.length === 1) {
      restoreRequest.resolve();
      await releaseRestore.promise;
      await route.fulfill({ status: 409, json: {
        error: `The validated checkout is at ${retainedPath}. Use Register an existing folder to add it after checking the mount settings.`,
      } });
      return;
    }
    await mkdir(restoredPath);
    await writeFile(join(restoredPath, "restored-note.md"), "---\ntype: note\ntitle: Restored note\ndescription: Offline fixture\n---\nRestored source.\n");
    const registered = await fetch(new URL("api/brains/mounts", server.url), {
      method: "POST",
      headers: { "x-okb-token": server.token, "x-okb-brain": "field-notes", "content-type": "application/json" },
      body: JSON.stringify({ action: "register", name: input.name, path: restoredPath, readonly: false }),
    });
    assert.ok(registered.ok, await registered.text());
    await route.fulfill({ json: { result: {
      brain: { name: input.name, path: restoredPath, readonly: false }, path: restoredPath,
      origin: restoreOrigin, branch: input.branch, commit: restoreCommit, credentialSaved: true,
      warning: "Re-index this restored brain to refresh search and graph.",
    } } });
  });
  try {
    await restorePanel.getByText("Restore from GitHub", { exact: true }).click();
    await restoreName.fill("retained-notes");
    await restorePanel.getByLabel("Existing parent folder", { exact: true }).fill(root);
    await restorePanel.getByLabel("GitHub HTTPS URL", { exact: true }).fill(restoreOrigin);
    await restorePanel.getByLabel("Branch", { exact: true }).fill("backup/reviewed");
    await restorePanel.getByText("Private repository", { exact: true }).click();
    assert.equal(await restoreToken.getAttribute("type"), "password");
    assert.equal(await restoreToken.inputValue(), "");
    assert.equal(await rememberRestore.isEnabled(), false);
    await restorePanel.getByLabel("GitHub login", { exact: true }).fill("fixture-owner");
    await restoreToken.fill(fakeGitHubTokens[0]!);
    await restoreButton.click();
    await restoreRequest.promise;
    assert.equal(await restoreToken.inputValue(), "");
    assert.equal(await restoreButton.isEnabled(), false);
    releaseRestore.resolve();
    await restorePanel.getByText(/Use Register an existing folder/).waitFor();
    assert.equal(await restoreName.inputValue(), "retained-notes");
    assert.equal(await restoreToken.inputValue(), "");

    await restoreName.fill("restored-notes");
    await restoreToken.fill(fakeGitHubTokens[1]!);
    await rememberRestore.check();
    await restoreButton.click();
    await mounts.getByText("Restored restored-notes.", { exact: true }).waitFor();
    assert.equal(await mounts.locator("[data-restored-branch]").textContent(), "backup/reviewed");
    assert.equal(await mounts.locator("[data-restored-path]").textContent(), restoredPath);
    assert.equal(await mounts.locator("[data-restored-commit]").textContent(), restoreCommit);
    await mounts.getByText("GitHub credential saved for this brain.", { exact: true }).waitFor();
    await mounts.getByText("Re-index this restored brain to refresh search and graph.", { exact: true }).waitFor();
    assert.equal(await page.locator("#brain").inputValue(), "field-notes");
    assert.deepEqual(restores, [
      { action: "restore", name: "retained-notes", parent: root, url: restoreOrigin, branch: "backup/reviewed",
        login: "fixture-owner", token: fakeGitHubTokens[0], saveCredential: false },
      { action: "restore", name: "restored-notes", parent: root, url: restoreOrigin, branch: "backup/reviewed",
        login: "fixture-owner", token: fakeGitHubTokens[1], saveCredential: true },
    ]);
  } finally {
    releaseRestore.resolve();
    await page.unroute(restoreRoute);
  }
  await mounts.getByRole("button", { name: "Open restored brain", exact: true }).click();
  await page.waitForFunction((name) => document.querySelector("#brain")?.value === name && document.querySelector("dl.kv")?.textContent?.includes(name),
    "restored-notes");
  const restoredCard = mounts.locator("[data-mount]").filter({ hasText: "restored-notes" });
  await restoredCard.getByText("restored-notes", { exact: true }).click();
  await restoredCard.getByRole("button", { name: "Remove mount", exact: true }).click();
  await mounts.getByText("Mount removed. Its files are still in the folder.", { exact: true }).waitFor();
  assert.match(await Bun.file(join(restoredPath, "restored-note.md")).text(), /Restored source/);
  await page.locator("#brain").selectOption("field-notes");
  await page.waitForFunction(() => document.querySelector("dl.kv")?.textContent?.includes("field-notes"));

  await page.getByLabel("Local port", { exact: true }).fill("0");
  await page.getByRole("button", { name: "Start MCP HTTP" }).click();
  await page.getByText("MCP HTTP started.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Stop MCP HTTP" }).click();
  await page.getByText("MCP HTTP stopped.", { exact: true }).waitFor();

  await mounts.getByText("field-notes", { exact: true }).click();
  const savedMount = mounts.locator("[data-mount-edit]");
  await savedMount.getByText("AI defaults for this brain", { exact: true }).click();
  assert.equal(await savedMount.getByLabel("Brain chat provider").inputValue(), "llamacpp");
  assert.equal(await savedMount.getByLabel("Brain chat model").inputValue(), "field-chat");
  assert.equal(await savedMount.getByLabel("Brain embedding provider").inputValue(), "ollama");
  assert.equal(await savedMount.getByLabel("Brain embedding model").inputValue(), "field-embed");
  await mounts.getByRole("button", { name: "Remove mount" }).click();
  await mounts.getByText("Mount removed. Its files are still in the folder.", { exact: true }).waitFor();
  assert.equal(await page.locator("#brain").inputValue(), "");

  const watcher = page.locator("#bundle-watch");
  await watcher.getByRole("button", { name: "Start watching" }).click();
  await watcher.getByText(/^Watching\. Last refresh/).waitFor();
  const refreshed = page.waitForResponse(async (response) => {
    if (new URL(response.url()).pathname !== "/api/brains/watch" || response.request().method() !== "GET") return false;
    return (await response.json()).result?.stats?.indexed === 1;
  });
  await writeFile(join(bundle, "external.md"), "---\ntype: note\ntitle: Watched field note\n---\nHellebore propagation\n\nSee [Graph waypoint](/graph-waypoint.md).\n");
  await refreshed;
  await watcher.getByRole("button", { name: "Stop watching" }).click();
  await watcher.getByText("Watching is off.", { exact: true }).waitFor();
  await writeFile(join(bundle, "graph-waypoint.md"), "---\ntype: note\ntitle: Graph waypoint\n---\nSee [Graph destination](/graph-destination.md).\n");
  await writeFile(join(bundle, "graph-destination.md"), "---\ntype: note\ntitle: Graph destination\n---\nThe end of the path.\n");
  assert.equal((await fetch(new URL("api/op/index", server.url), { method: "POST", headers: { "x-okb-token": server.token } })).status, 200);
  await nav.getByRole("link", { name: "Search", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search notes", exact: true }).fill("hellebore");
  await page.getByRole("searchbox", { name: "Search notes", exact: true }).press("Enter");
  await page.getByRole("link", { name: "Watched field note", exact: true }).waitFor();

  await nav.getByRole("link", { name: "Graph", exact: true }).click();
  await selectGraphNote(page, "external");
  await page.locator("#gdetail").getByRole("heading", { name: "Watched field note" }).waitFor();
  await page.locator("#gdetail").getByRole("link", { name: "Open", exact: true }).click();
  await page.locator(".concept-head").getByRole("heading", { name: "Watched field note" }).waitFor();
  await page.waitForFunction(() => !("cy" in window) || !window.cy);
  const neighbors = page.locator("#c-links");
  await neighbors.getByRole("link", { name: "Graph waypoint", exact: true }).waitFor();
  assert.equal(await neighbors.getByRole("link", { name: "Graph destination", exact: true }).count(), 0);
  await neighbors.getByLabel("Neighborhood depth", { exact: true }).fill("2");
  await neighbors.getByRole("button", { name: "Show links", exact: true }).click();
  await neighbors.getByRole("heading", { name: "2 hops away", exact: true }).waitFor();
  await neighbors.getByRole("link", { name: "Graph destination", exact: true }).waitFor();

  await nav.getByRole("link", { name: "Stats", exact: true }).click();
  await page.getByLabel("From concept ID", { exact: true }).fill("external");
  await page.getByLabel("To concept ID", { exact: true }).fill("graph-destination");
  const hops = page.getByLabel("Max path hops", { exact: true });
  const findPath = page.getByRole("button", { name: "Find path", exact: true });
  await hops.fill("1");
  await findPath.click();
  await page.getByText("No path found.", { exact: true }).waitFor();
  await hops.fill("2");
  await findPath.click();
  await page.locator("#p-out").getByRole("link", { name: "Graph destination", exact: true }).waitFor();

  await nav.getByRole("link", { name: "Settings", exact: true }).click();
  const enrichment = page.locator("#enrf");
  await page.route("**/api/op/enrich", async (route) => {
    assert.deepEqual(route.request().postDataJSON(), {
      task: "Review the selected pages", "web-seed": "https://example.invalid/guide", "allow-path": "/guide,/reference", "deny-path": "/admin",
    });
    await route.fulfill({ json: { result: { fetched: [], written: [], summary: "Scope saved", steps: 1 } } });
  });
  await enrichment.getByLabel("Task", { exact: true }).fill("Review the selected pages");
  await enrichment.getByLabel("Seed URLs", { exact: true }).fill("https://example.invalid/guide");
  await enrichment.getByLabel("Allowed path prefixes", { exact: true }).fill("/guide,/reference");
  await enrichment.getByLabel("Denied path prefixes", { exact: true }).fill("/admin");
  await enrichment.getByRole("button", { name: "Run enrich", exact: true }).click();
  await page.locator("#enr-out").getByText(/Scope saved/).waitFor();

  const legacyFile = join(bundle, "legacy-field-note.md");
  await writeFile(legacyFile, "---\ntype: note\ntitle: Legacy field note\ndescription: An earlier capture\ntimestamp: 2026-01-01T00:00:00Z\n---\nRecord the date.\n");
  const migration = page.locator("#mx-upgrade-form");
  await migration.getByLabel("Actor to credit (optional)").fill("human:field-editor");
  const previewUpgrade = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/op/upgrade");
  await migration.getByRole("button", { name: "Preview upgrade", exact: true }).click();
  assert.deepEqual((await previewUpgrade).request().postDataJSON(), { "dry-run": true, by: "human:field-editor" });
  await page.locator("#mx-out").getByText(/would upgrade legacy-field-note/).waitFor();
  assert.match(await Bun.file(legacyFile).text(), /^timestamp:/m);
  page.once("dialog", (dialog) => dialog.accept());
  await migration.getByRole("button", { name: "Upgrade bundle", exact: true }).click();
  await page.locator("#mx-out").getByText(/upgraded legacy-field-note/).waitFor();
  assert.match(await Bun.file(legacyFile).text(), /^  by: human:field-editor$/m);

  const embed = page.locator("#embedf");
  await embed.getByLabel("Provider override").fill("local");
  await embed.getByLabel("Model override").fill("fixture-embedding-model");
  await embed.getByLabel("Max notes this run").fill("1");
  await embed.getByRole("button", { name: "Embed", exact: true }).click();
  const embedResult = embed.locator(".notice");
  await embedResult.waitFor();
  const stats = JSON.parse((await embedResult.textContent())!);
  assert.equal(stats.provider, "ollama");
  assert.equal(stats.model, "fixture-embedding-model");
  assert.equal(stats.embedded, 1);
  assert.ok(stats.pending > 0);

  const scheduler = page.locator("#maintenance-schedule");
  await scheduler.getByText("Schedule maintenance", { exact: true }).click();
  await scheduler.getByText("No maintenance schedule.", { exact: true }).waitFor();
  await scheduler.getByText("No scheduled runs yet.", { exact: true }).waitFor();
  assert.equal(await scheduler.locator("[data-schedule-next]").textContent(), "Unscheduled");
  await scheduler.getByRole("combobox", { name: "Run schedule", exact: true }).selectOption("weekly");
  await scheduler.getByRole("checkbox", { name: "Doctor", exact: true }).uncheck();
  async function changeSchedule(label: string) {
    const reply = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/maintenance" &&
      response.request().method() === "POST");
    await scheduler.getByRole("button", { name: label, exact: true }).click();
    const response = await reply;
    const payload = await response.json();
    assert.ok(response.ok(), payload.error);
    return { input: response.request().postDataJSON(), schedule: payload.result.schedule };
  }
  const scheduled = await changeSchedule("Save schedule");
  assert.deepEqual(scheduled.input, { action: "save", cadence: "weekly", jobs: ["index", "review"] });
  assert.equal(scheduled.schedule.enabled, true);
  assert.ok(scheduled.schedule.nextAt > Date.now());
  await scheduler.getByText("Maintenance schedule active.", { exact: true }).waitFor();
  assert.equal(await scheduler.locator("[data-schedule-next]").textContent(),
    await page.evaluate((value) => new Date(value).toLocaleString(), scheduled.schedule.nextAt));
  assert.equal(await scheduler.locator("[data-schedule-jobs]").textContent(), "Re-index, Review queue");
  const paused = await changeSchedule("Pause schedule");
  assert.deepEqual(paused.input, { action: "pause" });
  assert.equal(paused.schedule.enabled, false);
  await scheduler.getByText("Maintenance schedule paused.", { exact: true }).waitFor();
  assert.equal(await scheduler.locator("[data-schedule-next]").textContent(), "Paused");
  const resumed = await changeSchedule("Resume schedule");
  assert.deepEqual(resumed.input, scheduled.input);
  assert.equal(resumed.schedule.enabled, true);
  const removed = await changeSchedule("Remove schedule");
  assert.deepEqual(removed.input, { action: "remove" });
  assert.equal(removed.schedule, null);
  await scheduler.getByText("Maintenance schedule removed.", { exact: true }).waitFor();
  assert.equal(await scheduler.locator("[data-schedule-next]").textContent(), "Unscheduled");

  async function setScheduledFeeds(feeds: string) {
    const response = await fetch(new URL("api/rss-settings", server.url), {
      method: "POST", headers: { "x-okb-token": server.token, "content-type": "application/json" },
      body: JSON.stringify({ feeds }),
    });
    assert.ok(response.ok, await response.text());
    const current = await fetch(new URL("api/maintenance", server.url), { headers: { "x-okb-token": server.token } });
    assert.ok(current.ok);
    return (await current.json()).result.rss;
  }
  const oldFeed = "https://example.invalid/maintenance.xml";
  const oldRss = await setScheduledFeeds(oldFeed);
  await scheduler.getByText("Schedule maintenance", { exact: true }).click();
  await scheduler.getByText("Schedule maintenance", { exact: true }).click();
  await scheduler.getByText("1 saved feed.", { exact: true }).waitFor();
  const pullScheduledFeeds = scheduler.getByRole("checkbox", { name: "Pull saved RSS feeds", exact: true });
  await pullScheduledFeeds.check();
  const newRss = await setScheduledFeeds(oldFeed + "\nhttps://example.invalid/second-maintenance.xml");
  const staleRss = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/maintenance" &&
    response.request().method() === "POST");
  await scheduler.getByRole("button", { name: "Save schedule", exact: true }).click();
  const staleRssResponse = await staleRss;
  assert.equal(staleRssResponse.status(), 409);
  assert.deepEqual(staleRssResponse.request().postDataJSON().approvals, { rss: oldRss.id });
  await scheduler.getByText("2 saved feeds.", { exact: true }).waitFor();
  assert.equal(await pullScheduledFeeds.isChecked(), false);
  await pullScheduledFeeds.check();
  const freshRss = await changeSchedule("Save schedule");
  assert.deepEqual(freshRss.input.approvals, { rss: newRss.id });
  assert.ok(freshRss.schedule.nextAt > Date.now());
  await changeSchedule("Remove schedule");
  await setScheduledFeeds("");

  const gitSync = page.getByRole("region", { name: "Git sync", exact: true });
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", bundle, ...args]);
    assert.equal(result.exitCode, 0, result.stderr.toString());
    return result.stdout.toString().trim();
  };
  await gitSync.getByLabel("Git name", { exact: true }).fill("Browser Smoke");
  await gitSync.getByLabel("Git email", { exact: true }).fill("smoke@example.invalid");
  await gitSync.getByRole("button", { name: "Save Git identity", exact: true }).click();
  await gitSync.getByText("Git identity saved for this brain.", { exact: true }).waitFor();
  assert.equal(git("config", "--local", "user.name"), "Browser Smoke");
  assert.equal(git("config", "--local", "user.email"), "smoke@example.invalid");
  assert.equal(Bun.spawnSync(["git", "-C", bundle, "rev-parse", "--verify", "HEAD"]).exitCode, 128);
  await gitSync.getByLabel("Commit message (optional)").fill("Sync browser notes");
  await gitSync.getByRole("button", { name: "Sync now", exact: true }).click();
  await gitSync.getByText(/Local commit saved/).waitFor();
  assert.equal(git("log", "-1", "--format=%s"), "Sync browser notes");

  let originRequests = 0;
  const originFixture = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: {
    open(socket) { originRequests++; socket.end(); },
    data() {},
  } });
  try {
    const originUrl = `https://127.0.0.1:${originFixture.port}/notes.git`;
    await gitSync.getByLabel("Origin HTTPS URL", { exact: true }).fill(originUrl);
    const originSaved = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/op/sync_settings" &&
      response.request().postDataJSON().action === "origin");
    await gitSync.getByRole("button", { name: "Connect origin", exact: true }).click();
    const saved = await originSaved;
    assert.equal(saved.ok(), true, await saved.text());
    await gitSync.getByText(/Origin saved/).waitFor();
    assert.equal(await gitSync.locator("[data-sync-fetch]").textContent(), originUrl);
    assert.equal(await gitSync.locator("[data-sync-push]").textContent(), originUrl);
    assert.equal(git("remote", "get-url", "origin"), originUrl);
    assert.equal(originRequests, 0);
  } finally { originFixture.stop(true); }

  const mergeOriginal = await Bun.file(legacyFile).text();
  const upstreamText = mergeOriginal.replace("Record the date.", "Record the <script>upstream date</script>.");
  const localText = mergeOriginal.replace("Record the date.", "Record the local date.");
  const gitBranch = git("branch", "--show-current");
  git("checkout", "-b", "browser-upstream");
  await writeFile(legacyFile, upstreamText);
  git("add", "--", "legacy-field-note.md");
  git("commit", "-m", "Change the upstream date");
  git("checkout", gitBranch);
  await writeFile(legacyFile, localText);
  git("add", "--", "legacy-field-note.md");
  git("commit", "-m", "Clarify the local date");
  const startRebase = Bun.spawnSync(["git", "-C", bundle, "rebase", "browser-upstream"]);
  assert.equal(startRebase.exitCode, 1, startRebase.stderr.toString());
  const conflictStatus = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/op/sync_recovery" &&
    response.request().postDataJSON().action === "status");
  await gitSync.getByRole("button", { name: "Refresh Git status", exact: true }).click();
  assert.deepEqual((await (await conflictStatus).json()).result?.conflicts, ["legacy-field-note.md"]);
  await gitSync.getByRole("heading", { name: "Resolve sync conflicts", exact: true }).waitFor();
  assert.equal(await gitSync.getByRole("button", { name: "Sync now", exact: true }).isEnabled(), false);
  assert.equal(await gitSync.getByLabel("Conflicting file", { exact: true }).inputValue(), "legacy-field-note.md");
  await gitSync.getByRole("button", { name: "Preview conflict", exact: true }).click();
  const conflictPreview = gitSync.locator("[data-conflict-preview]");
  await conflictPreview.getByText("Upstream changes", { exact: true }).waitFor();
  assert.equal(await conflictPreview.locator("details[open] pre").nth(0).textContent(), localText);
  assert.equal(await conflictPreview.locator("details[open] pre").nth(1).textContent(), upstreamText);
  assert.equal(await conflictPreview.locator("script").count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 375);
  await conflictPreview.getByLabel("Resolution", { exact: true }).selectOption("local");
  await conflictPreview.getByRole("button", { name: "Stage resolution", exact: true }).click();
  await gitSync.getByText("Staged the resolution for legacy-field-note.md.", { exact: true }).waitFor();
  page.once("dialog", (dialog) => dialog.accept());
  await gitSync.getByRole("button", { name: "Continue rebase", exact: true }).click();
  await gitSync.getByText(/Rebase complete/).waitFor();
  assert.equal(await Bun.file(legacyFile).text(), localText);
  assert.equal(git("status", "--porcelain"), "");
  assert.equal(git("log", "-1", "--format=%s"), "Clarify the local date");

  const feedUrl = "https://example.invalid/feed";
  const feedRequests: unknown[] = [];
  await page.route("**/api/op/rss", async (route) => {
    feedRequests.push(route.request().postDataJSON());
    await route.fulfill({ json: { result: [{ url: feedUrl, feed: "Sample feed", added: [], deduped: 0 }] } });
  });
  await nav.getByRole("link", { name: "Add", exact: true }).click();
  const savedFeeds = page.locator("#rss-settings");
  const feedUrls = savedFeeds.getByLabel("Feed URLs (one per line)");
  await savedFeeds.getByText("Manage saved feeds", { exact: true }).click();
  await feedUrls.fill(feedUrl);
  await savedFeeds.getByRole("button", { name: "Save feed URLs" }).click();
  await savedFeeds.getByText("Feed URLs saved.", { exact: true }).waitFor();
  assert.deepEqual(feedRequests, []);
  await nav.getByRole("link", { name: "Home", exact: true }).click();
  await nav.getByRole("link", { name: "Add", exact: true }).click();
  await savedFeeds.getByText("Manage saved feeds", { exact: true }).click();
  await savedFeeds.locator("textarea:enabled").waitFor();
  assert.equal(await feedUrls.inputValue(), feedUrl);
  const rss = page.locator("#rssf");
  await rss.getByLabel("Max new items per feed").fill("2");
  await rss.getByRole("button", { name: "Pull", exact: true }).click();
  await page.getByText("Sample feed: 0 added, 0 known", { exact: true }).waitFor();
  assert.deepEqual(feedRequests, [{ limit: 2 }]);

  await nav.getByRole("link", { name: "Sources", exact: true }).click();
  const conversations = page.locator("#source-form");
  const conversationRows = Array.from({ length: 52 }, (_, i) => ({
    uuid: `browser-conversation-${i + 1}`,
    name: `Browser conversation ${String(i + 1).padStart(2, "0")}`,
    created_at: "2026-01-02T03:04:05Z",
    updated_at: "2026-02-03T04:05:06Z",
    chat_messages: [{ sender: "human", text: "Private synthetic conversation excerpt." }],
  }));
  await conversations.getByLabel("Export provider").selectOption("claude");
  await conversations.getByLabel("Conversations file").setInputFiles({
    name: "conversations.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify([...conversationRows, ...conversationRows])),
  });
  await conversations.getByRole("button", { name: "Preview import", exact: true }).click();
  await conversations.getByText("52 drafts ready to import. 52 skipped.", { exact: true }).waitFor();
  const conversationReport = conversations.locator("#source-result");
  await conversationReport.getByText("Showing draft rows 1–50 of 52.", { exact: true }).waitFor();
  assert.equal(await conversationReport.locator(":scope > ol > li").count(), 50);
  await conversationReport.getByRole("button", { name: "Next draft rows" }).click();
  await conversationReport.getByText("Browser conversation 52", { exact: false }).waitFor();
  assert.equal(await conversationReport.locator(":scope > ol > li").count(), 2);
  await conversationReport.getByRole("button", { name: "Previous draft rows" }).click();
  await conversationReport.getByText("Browser conversation 01", { exact: false }).waitFor();
  const skippedConversations = conversationReport.locator("details");
  await skippedConversations.getByText("Skipped conversations", { exact: true }).click();
  await skippedConversations.getByRole("button", { name: "Next skipped rows" }).click();
  await skippedConversations.getByText("Showing skipped rows 51–52 of 52.", { exact: true }).waitFor();
  assert.equal(await skippedConversations.locator("li[value='104']").count(), 1);
  assert.equal(await conversationReport.getByText("Private synthetic conversation excerpt.", { exact: true }).count(), 0);
  await conversations.getByRole("button", { name: "Import drafts", exact: true }).click();
  await conversations.getByText("52 drafts imported. 52 skipped.", { exact: true }).waitFor();
  await conversationReport.getByRole("button", { name: "Next draft rows" }).click();
  const laterDraft = conversationReport.getByRole("link", { name: "Browser conversation 52", exact: true });
  await laterDraft.waitFor();
  const draftHref = decodeURIComponent(await laterDraft.getAttribute("href") || "");
  assert.match(draftHref, /^#concept\/db_only\/conversations\/claude\//);
  const draftFile = Bun.file(join(bundle, draftHref.slice("#concept/".length) + ".md"));
  const initialDraft = parse(await draftFile.text());
  const draftSources = initialDraft.frontmatter.sources;
  assert.deepEqual(draftSources, [{
    id: "export", resource: "claude-export:conversation", conversation_id: "browser-conversation-52",
    created_at: "2026-01-02T03:04:05Z", last_modified: "2026-02-03T04:05:06Z",
  }]);
  await laterDraft.click();
  const draftHeading = page.getByRole("heading", { name: "Browser conversation 52", exact: true });
  await draftHeading.waitFor();
  const editDraft = page.locator("#c-actions").getByRole("link", { name: "Edit", exact: true });
  const draftEditor = page.locator("#edf");
  const saveDraft = draftEditor.getByRole("button", { name: "Save", exact: true });
  await editDraft.click();
  const editedText = "This is a local addition to the imported conversation.";
  await draftEditor.getByLabel("Body (markdown; links normalize on save)", { exact: true }).fill(initialDraft.body + "\n" + editedText + "\n");
  const bodySave = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/op/write_concept");
  await saveDraft.click();
  assert.equal(Object.hasOwn((await bodySave).request().postDataJSON(), "sources"), false);
  await page.locator("#c-body").getByText(editedText, { exact: true }).waitFor();
  const editedDraft = parse(await draftFile.text());
  assert.match(editedDraft.body, /This is a local addition to the imported conversation\./);
  assert.deepEqual(editedDraft.frontmatter.sources, draftSources);
  assert.deepEqual(editedDraft.frontmatter.source_import, initialDraft.frontmatter.source_import);

  await editDraft.click();
  await draftEditor.locator("#ed-sources").getByPlaceholder("title", { exact: true }).fill("Original Claude conversation");
  await saveDraft.click();
  await draftHeading.waitFor();
  assert.deepEqual(parse(await draftFile.text()).frontmatter.sources, [{ ...draftSources[0], title: "Original Claude conversation" }]);

  const localSourceFiles = [
    { format: "email", name: "field.eml", title: "Trip email", mime: "message/rfc822",
      text: "Subject: Trip email\r\nContent-Type: text/html\r\n\r\n<p>Bring the seed packets</p><img src=\"https://example.invalid/pixel\">\r\n",
      excerpt: "Bring the seed packets" },
    { format: "calendar", name: "field.ics", title: "Field appointment", mime: "text/calendar",
      text: "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:field-appointment\r\nDTSTART;VALUE=DATE:20261122\r\nSUMMARY:Field appointment\r\nDESCRIPTION:Visit the seed bank\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
      excerpt: "Visit the seed bank" },
  ];
  for (const source of localSourceFiles) {
    await nav.getByRole("link", { name: "Sources", exact: true }).click();
    await page.getByRole("combobox", { name: /File format/ }).selectOption(source.format);
    await page.getByLabel("Export files", { exact: true }).setInputFiles({ name: source.name, mimeType: source.mime, buffer: Buffer.from(source.text) });
    await page.getByRole("button", { name: "Preview files", exact: true }).click();
    await page.getByText(source.excerpt, { exact: true }).waitFor();
    await page.getByRole("button", { name: "Import selected drafts", exact: true }).click();
    await page.getByText("1 private draft saved.", { exact: true }).waitFor();
    await page.locator("#source-files-result").getByRole("link", { name: source.title, exact: true }).click();
    await page.getByRole("heading", { name: source.title, exact: true }).waitFor();
    assert.equal(await page.locator("main img[src*='example.invalid']").count(), 0);
  }

  const localCsv = "year,cents\n2026,100\n2025,10\n2026,25\n";
  await mkdir(join(bundle, "data"), { recursive: true });
  await writeFile(join(bundle, "data", "revenue.csv"), localCsv);
  await page.evaluate(() => { location.hash = "#editor"; });
  await page.getByRole("heading", { name: "New concept", exact: true }).waitFor();
  const noteEditor = page.locator("#edf");
  await noteEditor.getByLabel("Type", { exact: true }).fill("Attested Computation");
  await noteEditor.getByLabel("Title", { exact: true }).fill("Reviewed CSV revenue");
  await noteEditor.getByLabel("Description", { exact: true }).fill("Aggregate the reviewed fixture.");
  await noteEditor.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("heading", { name: "Reviewed CSV revenue", exact: true }).waitFor();
  const computation = page.locator("#c-computation");
  await computation.getByRole("button", { name: "Save CSV contract", exact: true }).click();
  await computation.getByRole("spinbutton", { name: "year (integer)", exact: true }).fill("2026");
  await computation.getByRole("button", { name: "Preview computation", exact: true }).click();
  await computation.getByText("Exact CSV source", { exact: true }).waitFor();
  assert.equal(await computation.locator("[data-csv]").textContent(), localCsv);
  const runComputation = computation.getByRole("button", { name: "Run approved computation", exact: true });
  assert.equal(await runComputation.isEnabled(), false);
  await computation.getByRole("checkbox", { name: "Approve this contract, source, and parameter values", exact: true }).check();
  await runComputation.click();
  await computation.getByText("Computed 125 from 2 matching rows.", { exact: true }).waitFor();
  await computation.getByRole("button", { name: "Verify receipt", exact: true }).click();
  await computation.getByText("Recomputed and verified 125 from the original source.", { exact: true }).waitFor();
  const recordVerification = computation.getByRole("button", { name: "Record process verification", exact: true });
  assert.equal(await recordVerification.isEnabled(), false);
  await computation.getByRole("checkbox", { name: "Approve recording the verified result on this concept", exact: true }).check();
  await recordVerification.click();
  await page.getByText("process:okbrain-csv-aggregate-v1", { exact: true }).waitFor();
  assert.match(await Bun.file(join(bundle, "attested-computations", "reviewed-csv-revenue.md")).text(), /receipt_digest:/);

  await nav.getByRole("link", { name: "Coding", exact: true }).click();
  await page.getByText("Add a project", { exact: true }).waitFor();
  const teamAccess = page.locator(".coding-projects details").filter({
    has: page.getByText("Team browser access", { exact: true }),
  });
  await teamAccess.getByText("Team browser access", { exact: true }).click();
  await teamAccess.getByText("okbrain: Connect to Team Workspace", { exact: true }).waitFor();
  const editorTeamOrigin = "https://team.example.invalid";
  await teamAccess.getByLabel("Local port", { exact: true }).fill("0");
  await teamAccess.getByLabel("HTTPS proxy origin (optional)", { exact: true }).fill(editorTeamOrigin);
  const startedTeam = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/coding/team" &&
    response.request().method() === "POST");
  await teamAccess.getByRole("button", { name: "Start team listener", exact: true }).click();
  const teamListener = await startedTeam;
  assert.ok(teamListener.ok());
  const { url: teamPage, port: boundTeamPort } = (await teamListener.json()).result;
  const teamLink = teamAccess.getByRole("link", { name: editorTeamOrigin, exact: true });
  await teamLink.waitFor();
  assert.equal(await teamLink.getAttribute("href"), editorTeamOrigin);
  const landing = await (await fetch(teamPage)).text();
  assert.match(landing, /okbrain: Connect to Team Workspace/);
  assert.equal(landing.includes(server.token), false);
  async function teamStartupChange(label: string, action: string) {
    const request = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/coding/team/preferences" &&
      response.request().method() === "POST" && response.request().postDataJSON().action === action);
    await teamAccess.getByRole("button", { name: label, exact: true }).click();
    const response = await request;
    const payload = await response.json();
    assert.ok(response.ok(), payload.error);
    return { input: response.request().postDataJSON(), preferences: payload.result };
  }
  const enabled = await teamStartupChange("Enable startup", "enable");
  const assignedBinding = { port: boundTeamPort, publicOrigin: editorTeamOrigin };
  assert.deepEqual(enabled.input, { action: "enable", ...assignedBinding });
  assert.deepEqual(enabled.preferences.startup, assignedBinding);
  await teamAccess.getByText(/Startup enabled on local port/).waitFor();
  const disabled = await teamStartupChange("Disable startup", "disable");
  assert.equal(disabled.preferences.startup, null);
  assert.equal(await teamLink.isVisible(), true);
  assert.equal((await fetch(teamPage)).ok, true);
  await teamStartupChange("Enable startup", "enable");
  await teamAccess.getByRole("button", { name: "Stop listener", exact: true }).click();
  await teamLink.waitFor({ state: "hidden" });
  const teamPort = teamAccess.getByLabel("Local port", { exact: true });
  const atLaunch = teamAccess.getByRole("checkbox", { name: "Start on launch", exact: true });
  await teamPort.fill("0");
  await atLaunch.check();
  assert.equal(await teamPort.evaluate((input) => input.checkValidity()), false);
  await teamPort.fill(String(boundTeamPort));
  const fixedStart = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/coding/team" &&
    response.request().method() === "POST" && response.request().postDataJSON().action === "start");
  await teamAccess.getByRole("button", { name: "Start team listener", exact: true }).click();
  const fixedListener = await fixedStart;
  assert.equal(fixedListener.ok(), true);
  assert.deepEqual(fixedListener.request().postDataJSON(), { action: "start", startOnLaunch: true, ...assignedBinding });
  await teamAccess.getByText(/Startup enabled on local port/).waitFor();
  await teamAccess.getByRole("button", { name: "Stop listener", exact: true }).click();
  await teamAccess.getByText("Team listener stopped and startup disabled.", { exact: true }).waitFor();
  const persistedTeamPrefs = await fetch(new URL("api/coding/team/preferences", server.url), {
    headers: { "x-okb-token": server.token },
  });
  assert.ok(persistedTeamPrefs.ok);
  assert.equal((await persistedTeamPrefs.json()).result.startup, null);
  await page.getByRole("combobox", { name: "Provider", exact: true }).selectOption("google");
  assert.equal(await page.getByRole("combobox", { name: "Model", exact: true }).inputValue(), "gemini-3.5-flash-lite");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 375);

  process.env.OPENAI_API_KEY = "standalone-browser-fixture-only";
  const workspace = join(root, "coding-workspace");
  await mkdir(workspace);
  const file = join(workspace, "browser.ts");
  const snapshot = "export const sourceMarker = 'original browser fixture';\n";
  await writeFile(file, snapshot);
  const standaloneIdentity = { workspace, session: "existing-cli", provider: "openai", model: "browser-coding-fixture" };
  standaloneFaux.setResponses([fauxAssistantMessage("Saved CLI answer.")]);
  await runCodingSession({
    ...standaloneIdentity, requestId: "cli-complete", prompt: "Saved CLI task.", files: ["browser.ts"],
  }, { stateDir: standaloneState, models: standaloneModels });
  function waitForBudgetInspection(path: string, requestId: string) {
    return page.waitForResponse((response) => new URL(response.url()).pathname === "/api/coding" + path + "/inspect" &&
      response.request().postDataJSON().requestId === requestId);
  }
  async function verifyContextBudget(estimatedTokens: number, expectedLimits: string, compacted = false) {
    assert.ok(Number.isSafeInteger(estimatedTokens) && estimatedTokens >= 0);
    const budget = page.locator("[data-context-budget]");
    const estimate = `Estimated active context · ${estimatedTokens.toLocaleString("en-US")} tokens` +
      (compacted ? " · Older turns compacted" : "");
    await budget.getByText(estimate, { exact: true }).waitFor();
    await budget.getByText(expectedLimits, { exact: true }).waitFor();
    assert.equal(await budget.getByText(/^Request usage ·/).count(), 0);
    assert.equal(await page.locator(".coding-result").getByText(/^Request usage ·/).isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 375);
  }
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  async function copyRunReport(view: Page, session: string, requestId: string, privateText: string[]) {
    await view.getByRole("button", { name: "Copy run report", exact: true }).click();
    await view.getByText("Run report copied.", { exact: true }).waitFor();
    const json = await view.evaluate(() => navigator.clipboard.readText());
    for (const value of [...privateText, server.token, workspace, "standalone-browser-fixture-only"]) {
      assert.ok(!json.includes(JSON.stringify(value).slice(1, -1)), "Run report included private input or credentials.");
    }
    const report = JSON.parse(json) as CodingRunReport;
    assert.equal(report.version, 1);
    assert.equal(report.session, session);
    assert.equal(report.request.requestId, requestId);
    assert.equal(report.provider, "openai");
    assert.equal(await view.evaluate(() => document.documentElement.scrollWidth), 375);
    return { report, json };
  }
  const standaloneBudget = waitForBudgetInspection("/standalone", "cli-complete");
  await page.getByRole("link", { name: "Standalone sessions", exact: true }).click();
  await page.getByRole("heading", { name: "Standalone sessions", exact: true }).waitFor();
  await page.getByText("Saved CLI answer.", { exact: true }).waitFor();
  const savedContext = (await (await standaloneBudget).json()).result.pi.context;
  await verifyContextBudget(savedContext.estimatedTokens,
    "Input limit 32,768 tokens · Output reserve 8,192 tokens · Model window 128,000 tokens");
  const standaloneReport = await copyRunReport(page, "existing-cli", "cli-complete", ["Saved CLI task.", "Saved CLI answer.", snapshot.trim()]);
  assert.equal(standaloneReport.report.projectId, undefined);
  assert.equal(standaloneReport.report.model, "browser-coding-fixture");
  assert.equal(standaloneReport.report.runStatus, "done");
  assert.equal(standaloneReport.report.receipt?.status, "done");
  assert.equal(standaloneReport.report.context.estimatedTokens, savedContext.estimatedTokens);
  assert.ok((standaloneReport.report.usage.models["openai/browser-coding-fixture"]?.input ?? 0) > 0);
  assert.deepEqual(standaloneReport.report.request.files, [{ path: "browser.ts" }]);
  await page.getByRole("button", { name: "Copy response", exact: true }).click();
  await page.getByText("Response copied.", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "Saved CLI answer.");
  await page.evaluate(() => Object.defineProperty(navigator.clipboard, "writeText", {
    configurable: true, value: () => Promise.reject(new Error("Clipboard denied")),
  }));
  try {
    await page.getByRole("button", { name: "Copy run report", exact: true }).click();
    await page.getByText("Copy the selected JSON using your browser or system Copy command.", { exact: true }).waitFor();
    const fallback = page.getByRole("textbox", { name: "Run report JSON", exact: true });
    await fallback.waitFor();
    assert.equal(await fallback.inputValue(), standaloneReport.json);
    assert.deepEqual(await fallback.evaluate((element: HTMLTextAreaElement) => [
      element.readOnly, element === document.activeElement, element.selectionStart, element.selectionEnd,
    ]), [true, true, 0, standaloneReport.json.length]);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 375);
  } finally {
    await page.evaluate(() => Reflect.deleteProperty(navigator.clipboard, "writeText"));
  }
  await page.route("**/api/coding/standalone/inspect", async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.result.pi.context = { estimatedTokens: 0, historyCompacted: true };
    await route.fulfill({ response, json: payload });
  }, { times: 1 });
  await page.getByRole("button", { name: "Refresh sessions", exact: true }).click();
  await verifyContextBudget(0, "Model context budget unavailable", true);
  assert.equal(await page.getByRole("combobox", { name: "Saved session" }).inputValue(), "existing-cli");
  assert.equal(await page.getByRole("combobox", { name: "Model", exact: true }).isDisabled(), true);
  await page.getByText("Saved task and source", { exact: true }).click();
  await page.getByText("Saved CLI task.", { exact: true }).waitFor();
  await page.getByText("browser.ts", { exact: true }).click();
  await page.getByText(snapshot.trim(), { exact: true }).waitFor();

  const contextReset = page.locator("[data-context-controls]");
  const startFresh = contextReset.getByRole("button", { name: "Start fresh context", exact: true });
  const approveFresh = contextReset.getByRole("checkbox", { name: "Clear active context and keep saved run history", exact: true });
  const resetContext = contextReset.getByRole("button", { name: "Reset context", exact: true });
  const handoffInput = contextReset.getByRole("textbox", { name: "Handoff note (optional)", exact: true });
  const startCompaction = contextReset.getByRole("button", { name: "Compact context locally", exact: true });
  const approveCompaction = contextReset.getByRole("checkbox", { name: "Compact older context and keep saved run history", exact: true });
  async function verifyContextCompaction(prefix: string, session: string, { recovering = false, compacted = false } = {}) {
    const check = page.waitForResponse((response) => new URL(response.url()).pathname === prefix + "/compact-context-preview");
    await startCompaction.click();
    const preview = await check;
    assert.ok(preview.ok(), await preview.text());
    assert.deepEqual(preview.request().postDataJSON(), { session });
    const { version, recovering: pending } = (await preview.json()).result;
    assert.match(version, /^[a-f0-9]{64}$/u);
    assert.equal(pending === true, recovering);
    await contextReset.getByText((recovering ? "Finish the interrupted compaction in " : "Compact older context in ") + session +
      ". The recap is generated entirely on this device. Recent turns stay in context and the original runs remain in Run history. Short sessions may have too little history to compact.",
      { exact: true }).waitFor();
    const apply = contextReset.getByRole("button", { name: recovering ? "Finish compaction" : "Compact context", exact: true });
    assert.equal(await approveCompaction.isChecked(), false);
    assert.equal(await apply.isEnabled(), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 375);
    await approveCompaction.check();
    const confirm = page.waitForResponse((response) => new URL(response.url()).pathname === prefix + "/compact-context");
    await apply.click();
    const response = await confirm;
    assert.ok(response.ok(), await response.text());
    assert.deepEqual(response.request().postDataJSON(), { session, version });
    const result = (await response.json()).result;
    assert.equal(result.version, version);
    assert.equal(result.compacted, compacted);
    assert.ok(result.replayed === undefined || result.replayed === true);
    await contextReset.getByText(compacted ? "Older context compacted locally. Saved history is still available."
      : "This session has too little older context to compact.", { exact: true }).waitFor();
  }
  async function verifyContextReset(prefix: string, session: string, expectedHandoff?: string) {
    const input = { session, ...(expectedHandoff === undefined ? {} : { handoff: expectedHandoff }) };
    const check = page.waitForResponse((response) => new URL(response.url()).pathname === prefix + "/reset-context-preview");
    await startFresh.click();
    const preview = await check;
    assert.ok(preview.ok(), await preview.text());
    assert.deepEqual(preview.request().postDataJSON(), input);
    const { version, handoff } = (await preview.json()).result;
    assert.ok(version);
    assert.equal(handoff, expectedHandoff);
    await approveFresh.waitFor();
    const notePreview = contextReset.locator("[data-reset-handoff]");
    assert.equal(await notePreview.isVisible(), expectedHandoff !== undefined);
    if (expectedHandoff !== undefined) {
      assert.equal(await notePreview.textContent(), expectedHandoff);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 375);
      await contextReset.getByText("The note will accompany the next request in this session to OpenAI.", { exact: true }).waitFor();
    }
    assert.equal(await approveFresh.isChecked(), false);
    assert.equal(await resetContext.isEnabled(), false);
    await approveFresh.check();
    const commit = page.waitForResponse((response) => new URL(response.url()).pathname === prefix + "/reset-context");
    await resetContext.click();
    const result = await commit;
    assert.ok(result.ok(), await result.text());
    assert.deepEqual(result.request().postDataJSON(), { ...input, version });
    assert.equal((await result.json()).result.reset, true);
    await contextReset.getByText("Active context cleared. Saved history is still available.", { exact: true }).waitFor();
    assert.equal(await approveFresh.isVisible(), false);
    assert.equal(await contextReset.locator("[data-reset-note] textarea").inputValue(), "");
  }
  await startFresh.click();
  await approveFresh.check();
  const savedSessionChoice = page.getByRole("combobox", { name: "Saved session" });
  await savedSessionChoice.selectOption("");
  await approveFresh.waitFor({ state: "hidden" });
  await savedSessionChoice.selectOption("existing-cli");
  await page.getByText("Saved CLI answer.", { exact: true }).waitFor();
  await page.getByText("Saved task and source", { exact: true }).click();
  await verifyContextReset("/api/coding/standalone", "existing-cli");
  await page.getByText("Saved CLI answer.", { exact: true }).waitFor();
  await page.getByText("Saved CLI task.", { exact: true }).waitFor();
  const callsBeforeStandaloneCompaction = standaloneFaux.state.callCount;
  await startCompaction.click();
  await approveCompaction.check();
  await contextReset.getByRole("button", { name: "Cancel compaction", exact: true }).click();
  await approveCompaction.waitFor({ state: "hidden" });
  assert.equal(await startCompaction.evaluate((button) => button === document.activeElement), true);
  await verifyContextCompaction("/api/coding/standalone", "existing-cli");
  await page.getByText("Saved CLI answer.", { exact: true }).waitFor();
  await page.getByText("Saved CLI task.", { exact: true }).waitFor();
  assert.equal(standaloneFaux.state.callCount, callsBeforeStandaloneCompaction);

  await page.route("**/api/coding/standalone/inspect", async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.result.pi.context.compactionPending = true;
    await route.fulfill({ response, json: payload });
  }, { times: 1 });
  await page.getByRole("button", { name: "Refresh sessions", exact: true }).click();
  const sendBlocked = page.getByText("Finish local compaction in Run history before sending in this session.", { exact: true });
  await sendBlocked.waitFor();
  await startFresh.waitFor({ state: "hidden" });
  await page.getByLabel("Task", { exact: true }).fill("Keep this draft pending until compaction finishes.");
  await page.getByRole("button", { name: "Preview source", exact: true }).click();
  const pendingApproval = page.getByRole("checkbox", { name: /Approve sending the task, selected source/ });
  await pendingApproval.check();
  assert.equal(await page.getByRole("button", { name: "Send request", exact: true }).isEnabled(), false);
  await page.route("**/api/coding/standalone/compact-context-preview", async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.result.recovering = true;
    await route.fulfill({ response, json: payload });
  }, { times: 1 });
  await verifyContextCompaction("/api/coding/standalone", "existing-cli", { recovering: true });
  await sendBlocked.waitFor({ state: "hidden" });
  await pendingApproval.waitFor({ state: "hidden" });
  await startFresh.waitFor();

  const interrupted = Bun.spawn([process.execPath, "-e", `
    import { createModels, fauxProvider } from "@earendil-works/pi-ai";
    import { runCodingSession } from "./src/core/coding/durable.ts";
    const { options, stateDir } = JSON.parse(process.argv.at(-1));
    const models = createModels();
    const faux = fauxProvider({ provider: options.provider, models: [{ id: options.model }] });
    models.setProvider(faux.provider);
    faux.setResponses([() => {
      console.log("request-started");
      return new Promise(() => {});
    }]);
    const keepAlive = setInterval(() => {}, 1000);
    try { await runCodingSession(options, { stateDir, models }); }
    finally { clearInterval(keepAlive); }
  `, "--", JSON.stringify({
    stateDir: standaloneState, options: {
      ...standaloneIdentity, requestId: "cli-interrupted", prompt: "Resume this saved task.", files: ["browser.ts"],
    },
  })], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "inherit" });
  const startupTimeout = setTimeout(() => interrupted.kill("SIGKILL"), 8000);
  try {
    const reader = interrupted.stdout.getReader();
    const marker = await reader.read();
    reader.releaseLock();
    assert.equal(new TextDecoder().decode(marker.value).trim(), "request-started");
  } finally {
    clearTimeout(startupTimeout);
    interrupted.kill("SIGKILL");
    await interrupted.exited;
  }
  await rm(file);
  await page.getByRole("button", { name: "Refresh sessions", exact: true }).click();
  await page.getByRole("combobox", { name: "Saved request" }).selectOption("cli-interrupted");
  const resume = page.getByRole("button", { name: "Resume request", exact: true });
  await resume.waitFor();
  assert.equal(await resume.isEnabled(), false);
  assert.equal(await startFresh.isVisible(), false);
  await page.getByRole("heading", { name: "Saved Pi task state", exact: true }).waitFor();
  await page.getByText("Model response · 1 pending", { exact: true }).waitFor();
  const interruptedReport = await copyRunReport(page, "existing-cli", "cli-interrupted", ["Resume this saved task.", snapshot.trim()]);
  assert.equal(interruptedReport.report.request.status, "placed");
  assert.equal(interruptedReport.report.receipt, undefined);
  await page.getByText("Saved task and source", { exact: true }).click();
  await page.getByText("Resume this saved task.", { exact: true }).waitFor();
  await page.getByText("browser.ts", { exact: true }).click();
  await page.getByText(snapshot.trim(), { exact: true }).waitFor();
  assert.equal(standaloneFaux.state.callCount, 1);
  standaloneFaux.setResponses([(input) => {
    assert.match(JSON.stringify(input.messages), /original browser fixture/);
    return fauxAssistantMessage("Recovered with saved bytes.");
  }]);
  await page.getByRole("checkbox", { name: /Approve sending the saved task, source, and active history/ }).check();
  await resume.click();
  await page.getByText("Recovered with saved bytes.", { exact: true }).waitFor();
  assert.equal(standaloneFaux.state.callCount, 2);

  const newFile = branchBefore;
  await writeFile(file, newFile);
  for (const args of [["git", "init", "-q"], ["git", "add", "--", "browser.ts"]]) {
    const git = Bun.spawnSync(args, { cwd: workspace });
    assert.equal(git.exitCode, 0, git.stderr.toString());
  }
  await page.getByRole("combobox", { name: "Saved session" }).selectOption("");
  await page.getByLabel("Absolute workspace path").fill(workspace);
  await page.getByLabel("Session name", { exact: true }).fill("from-browser");
  await page.getByRole("combobox", { name: "Source", exact: true }).selectOption("repository");
  await page.getByLabel("Search source").fill("sourceMarker");
  const previewStandalone = page.getByRole("button", { name: "Preview source", exact: true });
  const sendStandalone = page.getByRole("button", { name: "Send request", exact: true });
  const approveStandalone = page.getByRole("checkbox", { name: /Approve sending the task, selected source/ });
  await previewStandalone.click();
  await page.getByText("browser.ts:1–1", { exact: true }).click();
  await page.getByText(newFile.trim(), { exact: true }).waitFor();
  assert.equal(await sendStandalone.isEnabled(), false);
  await page.getByLabel("Task", { exact: true }).fill("Review the tracked source.");
  await previewStandalone.click();
  await approveStandalone.check();
  assert.equal(await sendStandalone.isEnabled(), true);
  await page.getByLabel("Task", { exact: true }).fill("Review only the approved browser source.");
  assert.equal(await sendStandalone.isEnabled(), false);
  await previewStandalone.click();
  await approveStandalone.check();
  assert.equal(standaloneFaux.state.callCount, 2);
  standaloneFaux.setResponses([async (input) => {
    const prompt = JSON.stringify(input.messages);
    assert.match(prompt, /approved browser source/);
    assert.match(prompt, /Review only the approved browser source/);
    await finishStandalone.promise;
    return fauxAssistantMessage("Reviewed browser source.");
  }]);
  await sendStandalone.click();
  await page.getByRole("heading", { name: "Current Pi tasks", exact: true }).waitFor();
  await page.getByText("Model response · 1 running", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Copy run report", exact: true }).count(), 0);
  const deleteStandalone = page.locator("[data-delete-session]");
  await deleteStandalone.getByText("Delete standalone session", { exact: true }).click();
  assert.equal(await deleteStandalone.getByLabel("Type the session name to confirm", { exact: true }).isEnabled(), false);
  finishStandalone.resolve();
  await page.getByText("Reviewed browser source.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("heading", { name: "Current Pi tasks", exact: true }).count(), 0);
  assert.equal(await page.getByRole("combobox", { name: "Saved session" }).inputValue(), "from-browser");
  assert.equal(standaloneFaux.state.callCount, 3);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 375);
  const repositoryReport = await copyRunReport(page, "from-browser", await page.getByRole("combobox", { name: "Saved request" }).inputValue(),
    ["Review only the approved browser source.", "Reviewed browser source.", newFile.trim(), "sourceMarker"]);
  const manifest = repositoryReport.report.request.repositoryContext;
  assert.ok(manifest);
  assert.match(manifest.id, /^[a-f0-9]{64}$/u);
  assert.deepEqual(manifest.files.map(({ path, startLine, endLine }) =>
    ({ path, startLine, endLine })), [{ path: "browser.ts", startLine: 1, endLine: 1 }]);
  assert.match(manifest.files[0]?.sha256 ?? "", /^[a-f0-9]{64}$/u);
  await page.getByRole("button", { name: "Refresh sessions", exact: true }).click();
  await page.getByRole("combobox", { name: "Saved session" }).selectOption("existing-cli");
  await page.getByRole("combobox", { name: "Saved request" }).selectOption("cli-complete");
  await page.getByText("Saved CLI answer.", { exact: true }).waitFor();
  await page.getByText("Saved task and source", { exact: true }).click();
  await page.getByText("Saved CLI task.", { exact: true }).waitFor();
  const existingCliDirectory = join(standaloneState, "session-existing-cli");
  assert.ok((await readdir(existingCliDirectory)).includes("transcript.sqlite"));
  await deleteStandalone.getByText("Delete standalone session", { exact: true }).click();
  const deleteConfirmation = deleteStandalone.getByLabel("Type the session name to confirm", { exact: true });
  const deleteSession = deleteStandalone.getByRole("button", { name: "Delete session", exact: true });
  await deleteConfirmation.fill("wrong-session");
  assert.equal(await deleteSession.isEnabled(), false);
  await deleteConfirmation.fill("existing-cli");
  const deletionRequested = Promise.withResolvers<void>();
  const releaseDeletion = Promise.withResolvers<void>();
  await page.route("**/api/coding/standalone/delete-session", async (route) => {
    deletionRequested.resolve();
    await releaseDeletion.promise;
    await route.continue();
  }, { times: 1 });
  try {
    const deleted = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/coding/standalone/delete-session");
    await deleteSession.click();
    await deletionRequested.promise;
    assert.equal(await page.getByText("Saved CLI task.", { exact: true }).count(), 0);
    assert.equal(await page.getByText("Saved CLI answer.", { exact: true }).count(), 0);
    releaseDeletion.resolve();
    assert.deepEqual((await (await deleted).json()).result, { session: "existing-cli", deleted: true });
  } finally { releaseDeletion.resolve(); }
  await page.getByText("Deleted standalone session existing-cli.", { exact: true }).waitFor();
  assert.deepEqual(await readdir(existingCliDirectory), ["owner.sqlite"]);
  const savedSessions = page.getByRole("combobox", { name: "Saved session" });
  assert.equal(await savedSessions.locator('option[value="existing-cli"]').count(), 0);
  assert.equal(await savedSessions.locator('option[value="from-browser"]').count(), 1);

  async function codingFixture<T>(path: string, data: unknown): Promise<T> {
    const response = await fetch(new URL("api/coding" + path, server.url), {
      method: "POST", headers: { "x-okb-token": server.token, "content-type": "application/json" },
      body: JSON.stringify(data),
    });
    const payload = await response.json() as { result: T; error?: string };
    assert.ok(response.ok, payload.error);
    return payload.result;
  }
  const project = await codingFixture<{ id: string }>("/projects", {
    title: "Task progress fixture", workspace, scopes: ["."], provider: "openai", model: "browser-project-fixture",
  });
  const projectPath = "/projects/" + project.id;
  const projectSource = { source: "files", files: ["browser.ts"] };
  const projectPrompt = "Review <strong>the browser source</strong> in this project.";
  const patchPrefix = "diff --git a/browser.ts b/browser.ts\n--- a/browser.ts\n+++ b/browser.ts\n@@ -1 +1 @@\n-" + branchBefore + "+";
  const proposedPatch = patchPrefix + branchAfter;
  const alternatePatch = patchPrefix + "export const sourceMarker = 'alternate browser patch';\n";
  const projectAnswer = "Project response ready for review.\n\n```diff\n" + proposedPatch + "```\n\n```diff\n" + alternatePatch + "```";
  const sourceRequests: unknown[] = [];
  const proposalRequests: unknown[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith(projectPath + "/source-inspect")) sourceRequests.push(request.postDataJSON());
    if (new URL(request.url()).pathname.endsWith(projectPath + "/patch-proposals")) proposalRequests.push(request.postDataJSON());
  });
  const projectPreview = await codingFixture<{ id: string }>(projectPath + "/preview", projectSource);
  projectFaux.setResponses([async () => {
    await finishProject.promise;
    return fauxAssistantMessage(projectAnswer);
  }]);
  await codingFixture(projectPath + "/run", {
    ...projectSource, previewId: projectPreview.id, approved: true, session: "project-browser", requestId: "project-task-progress",
    prompt: projectPrompt,
  });
  await page.evaluate((id) => { location.hash = "#coding/" + id; }, project.id);
  const projectComposer = page.locator(".coding-composer");
  const presets = projectComposer.locator("[data-run-presets]");
  const presetSelector = presets.getByRole("combobox", { name: "Saved preset", exact: true });
  const presetName = presets.getByLabel("Preset name", { exact: true });
  const presetPrompt = "Summarize the browser source marker.";
  const task = projectComposer.getByLabel("Task", { exact: true });
  const query = projectComposer.locator('[name="query"]');
  await task.fill(presetPrompt);
  await query.fill("sourceMarker");
  const listingStarted = Promise.withResolvers<void>();
  const releaseListing = Promise.withResolvers<void>();
  await page.route("**" + projectPath + "/presets", async (route) => {
    listingStarted.resolve();
    await releaseListing.promise;
    await route.continue();
  }, { times: 1 });
  const saveNewPreset = presets.getByRole("button", { name: "Save new preset", exact: true });
  try {
    await presets.getByText("Run presets", { exact: true }).click();
    await listingStarted.promise;
    await presetName.fill("Review source marker");
    assert.equal(await saveNewPreset.isEnabled(), false);
  } finally { releaseListing.resolve(); }
  const presetCreated = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith(projectPath + "/presets") &&
    response.request().method() === "POST");
  await saveNewPreset.click();
  const presetResponse = await presetCreated;
  assert.ok(presetResponse.ok(), await presetResponse.text());
  await presets.getByText("Preset saved.", { exact: true }).waitFor();
  const savedPresetID = await presetSelector.inputValue();
  assert.ok(savedPresetID);

  const projectLookup = projectComposer.getByRole("checkbox", { name: /Let the model look up line numbers/ });
  const explicitApproval = projectComposer.locator("[data-approve] input");
  const sendProject = projectComposer.getByRole("button", { name: "Send request", exact: true });
  const previewProject = projectComposer.getByRole("button", { name: "Preview source", exact: true });
  await task.fill("A temporary task that must not replace the saved preset.");
  await projectLookup.check();
  await previewProject.click();
  await explicitApproval.check();
  assert.equal(await sendProject.isEnabled(), true);
  await presets.getByRole("button", { name: "Load preset", exact: true }).click();
  assert.equal(await task.inputValue(), presetPrompt);
  assert.equal(await query.inputValue(), "sourceMarker");
  assert.equal(await projectLookup.isChecked(), false);
  assert.equal(await explicitApproval.isChecked(), false);
  assert.equal(await sendProject.isEnabled(), false);
  await projectComposer.getByText("Scope and budget", { exact: true }).click();
  const profileField = projectComposer.getByLabel("Project profile (optional JSON)", { exact: true });
  const expectedProfile = { version: 1, name: "Review source marker", projects: ["."], tokenBudget: 4096 };
  assert.deepEqual(JSON.parse(await profileField.inputValue()), expectedProfile);

  await task.fill("Review source marker and cite the file.");
  await profileField.fill(JSON.stringify({ ...expectedProfile, guidance: "Cite repository paths." }));
  await previewProject.click();
  await explicitApproval.check();
  assert.equal(await sendProject.isEnabled(), true);
  await presetName.fill("Review source with citations");
  const editPreset = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith(projectPath + "/presets") &&
    response.request().method() === "POST");
  await presetName.press("Enter");
  assert.equal((await editPreset).ok(), true);
  await presets.getByText("Preset saved.", { exact: true }).waitFor();
  assert.equal(await presetSelector.inputValue(), savedPresetID);
  assert.equal(await sendProject.isEnabled(), false);
  assert.equal(await explicitApproval.isChecked(), false);
  await presets.getByRole("button", { name: "Load preset", exact: true }).click();
  assert.equal(JSON.parse(await profileField.inputValue()).guidance, "Cite repository paths.");
  assert.equal(await task.inputValue(), "Review source marker and cite the file.");

  const projectMode = projectComposer.getByRole("combobox", { name: "Source", exact: true });
  await projectMode.selectOption("files");
  const manualFiles = projectComposer.getByLabel("Files inside the permitted directories", { exact: true });
  await manualFiles.fill("browser.ts");
  assert.equal(await presets.isVisible(), false);
  await projectMode.selectOption("repository");
  assert.equal(await presetSelector.inputValue(), savedPresetID);
  page.once("dialog", (dialog) => dialog.accept());
  await presets.getByRole("button", { name: "Remove preset", exact: true }).click();
  await presets.getByText("Preset removed.", { exact: true }).waitFor();
  assert.equal(await presetSelector.locator("option").count(), 1);
  await projectMode.selectOption("files");
  assert.equal(await manualFiles.inputValue(), "browser.ts");

  await page.getByRole("button", { name: /project-task-progress/ }).click();
  await page.getByText("Model response · 1 running", { exact: true }).waitFor();
  const savedProjectSource = page.locator("[data-saved-request-source]");
  const viewSavedProjectSource = savedProjectSource.getByRole("button", { name: "View saved request source", exact: true });
  const hideSavedProjectSource = savedProjectSource.getByRole("button", { name: "Hide saved request source", exact: true });
  assert.equal(await viewSavedProjectSource.count(), 0);
  const cancelProject = page.getByRole("button", { name: "Cancel run", exact: true });
  await cancelProject.focus();
  await page.waitForResponse((res) => new URL(res.url()).pathname.endsWith(projectPath + "/inspect"));
  assert.equal(await cancelProject.evaluate((button) => button === document.activeElement), true);
  finishProject.resolve();
  const projectResponse = page.locator(".coding-activity [data-answer]");
  await projectResponse.waitFor();
  assert.equal(await projectResponse.textContent(), projectAnswer);
  const projectBudget = waitForBudgetInspection(projectPath, "project-task-progress");
  await page.locator(".coding-activity").getByRole("button", { name: "Refresh", exact: true }).click();
  const projectContext = (await (await projectBudget).json()).result.pi.context;
  await verifyContextBudget(projectContext.estimatedTokens,
    "Input limit 32,768 tokens · Output reserve 4,096 tokens · Model window 65,536 tokens");
  const reviewPatch = page.getByRole("button", { name: "Review proposed patch", exact: true });
  assert.equal(await reviewPatch.count(), 0);
  const acceptResult = page.getByRole("button", { name: "Accept result", exact: true });
  await acceptResult.waitFor();
  assert.equal(await page.getByRole("heading", { name: "Current Pi tasks", exact: true }).count(), 0);
  const accepted = page.waitForResponse((res) => new URL(res.url()).pathname.endsWith(projectPath + "/review"));
  await acceptResult.click();
  assert.equal((await accepted).ok(), true);
  await reviewPatch.waitFor();
  const reportCalls = projectFaux.state.callCount;
  const projectPrivateText = [projectPrompt, "Project response ready for review.", branchBefore.trim()];
  const projectReport = await copyRunReport(page, "project-browser", "project-task-progress", projectPrivateText);
  assert.equal(projectReport.report.projectId, project.id);
  assert.equal(projectReport.report.model, "browser-project-fixture");
  assert.equal(projectReport.report.runStatus, "done");
  assert.equal(projectReport.report.review, "accepted");
  assert.equal(projectReport.report.context.limitTokens, 32_768);
  assert.deepEqual(projectReport.report.request.files, [{ path: "browser.ts" }]);
  assert.ok((projectReport.report.rootUsage.models["openai/browser-project-fixture"]?.output ?? 0) > 0);
  assert.deepEqual(sourceRequests, []);
  assert.equal(projectFaux.state.callCount, reportCalls);
  await page.route("**/api/coding" + projectPath + "/inspect", async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.result.report.runStatus = "cancelled";
    await route.fulfill({ response, json: payload });
  }, { times: 1 });
  const refreshProjectRuns = page.locator(".coding-activity").getByRole("button", { name: "Refresh", exact: true });
  const copyProjectReport = page.getByRole("button", { name: "Copy run report", exact: true });
  await refreshProjectRuns.click();
  await copyProjectReport.waitFor({ state: "hidden" });
  await projectResponse.waitFor();
  await refreshProjectRuns.click();
  await copyProjectReport.waitFor();
  const reportMember = await codingFixture<{ token: string }>(projectPath + "/members", { name: "report-reviewer" });
  const reportTeam = await codingFixture<{ url: string }>("/team", { action: "start", port: 0 });
  const teamReportPage = await browser.newPage({ viewport: { width: 375, height: 700 }, reducedMotion: "reduce", locale: "en-US" });
  try {
    const reportOrigin = new URL(reportTeam.url).origin;
    await teamReportPage.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: reportOrigin });
    teamReportPage.setDefaultTimeout(8000);
    teamReportPage.on("pageerror", (error) => errors.push(error.message));
    await teamReportPage.route("**/*", async (route) => {
      if (new URL(route.request().url()).origin === reportOrigin) await route.continue();
      else {
        outbound.push(route.request().url());
        await route.abort();
      }
    });
    await teamReportPage.goto(reportTeam.url);
    await teamReportPage.getByLabel("Project token", { exact: true }).fill(reportMember.token);
    await teamReportPage.getByRole("button", { name: "Open project", exact: true }).click();
    await teamReportPage.getByRole("button", { name: /project-task-progress/ }).click();
    const copiedByMember = await copyRunReport(teamReportPage, "project-browser", "project-task-progress", [...projectPrivateText, reportMember.token]);
    assert.deepEqual(copiedByMember.report, projectReport.report);
  } finally {
    await teamReportPage.close();
    await codingFixture("/team", { action: "stop" });
  }
  assert.deepEqual(proposalRequests, []);
  assert.equal(await Bun.file(file).text(), branchBefore);
  const callsBeforeProjectCompaction = projectFaux.state.callCount;
  await verifyContextCompaction("/api/coding" + projectPath, "project-browser");
  assert.equal(projectFaux.state.callCount, callsBeforeProjectCompaction);
  await startFresh.click();
  await approveFresh.check();
  await contextReset.getByRole("button", { name: "Cancel reset", exact: true }).click();
  assert.equal(await approveFresh.isVisible(), false);
  const callsBeforeHandoff = projectFaux.state.callCount;
  await contextReset.getByText("Add a handoff note", { exact: true }).click();
  await handoffInput.fill("é".repeat(1025));
  assert.equal(await startFresh.isDisabled(), true);
  await handoffInput.fill("Discard this first draft.");
  await page.route("**" + projectPath + "/reset-context-preview", (route) => route.fulfill({
    json: { result: { version: "a".repeat(64) } },
  }), { times: 1 });
  await startFresh.click();
  await contextReset.getByText("The preview did not match your handoff note. Preview this session again before resetting.", { exact: true }).waitFor();
  assert.equal(await approveFresh.isVisible(), false);
  await startFresh.click();
  await approveFresh.check();
  assert.equal(await resetContext.isEnabled(), true);
  const handoff = `  Keep the patch under review.\nVerify café fixture ${"x".repeat(512)} before merging.  `;
  await handoffInput.fill(handoff);
  await approveFresh.waitFor({ state: "hidden" });
  await verifyContextReset("/api/coding" + projectPath, "project-browser", handoff);
  assert.equal(projectFaux.state.callCount, callsBeforeHandoff);
  assert.equal(await projectResponse.textContent(), projectAnswer);
  await reviewPatch.click();
  const proposalChoice = page.getByRole("combobox", { name: "Proposed diff", exact: true });
  await proposalChoice.waitFor();
  const targetPatch = { session: "project-browser", requestId: "project-task-progress" };
  assert.deepEqual(proposalRequests, [targetPatch]);
  const diffEditor = page.getByLabel("Git unified diff", { exact: true });
  const previewPatch = page.getByRole("button", { name: "Preview patch", exact: true });
  assert.equal(await diffEditor.inputValue(), "");
  assert.equal(await previewPatch.isEnabled(), false);
  assert.deepEqual(JSON.parse(await page.getByRole("combobox", { name: "Accepted result", exact: true }).inputValue()), targetPatch);
  await proposalChoice.selectOption("0");
  assert.equal(await diffEditor.inputValue(), proposedPatch);
  assert.equal(await Bun.file(file).text(), branchBefore);
  await previewPatch.click();
  const applyPatch = page.getByRole("button", { name: "Apply to worktree", exact: true });
  const approvePatch = page.getByRole("checkbox", { name: "Apply this exact diff to the listed files.", exact: true });
  await approvePatch.waitFor();
  assert.equal(await applyPatch.isEnabled(), false);
  const staleFile = "export const sourceMarker = 'worktree changed after patch preview';\n";
  await writeFile(file, staleFile);
  await approvePatch.check();
  const stalePatch = page.waitForResponse((res) => new URL(res.url()).pathname.endsWith(projectPath + "/patch-apply"));
  await applyPatch.click();
  assert.equal((await stalePatch).status(), 409);
  await approvePatch.waitFor({ state: "hidden" });
  assert.equal(await Bun.file(file).text(), staleFile);
  await writeFile(file, branchBefore);
  await previewPatch.click();
  await approvePatch.check();
  await applyPatch.click();
  await page.getByText(/Applied to the local worktree/).waitFor();
  assert.equal(await Bun.file(file).text(), branchAfter);

  await viewSavedProjectSource.waitFor();
  assert.deepEqual(sourceRequests, []);
  assert.equal(await savedProjectSource.locator("pre").count(), 0);
  await viewSavedProjectSource.click();
  await savedProjectSource.getByText(projectPrompt, { exact: true }).waitFor();
  assert.deepEqual(sourceRequests, [{ session: "project-browser", requestId: "project-task-progress" }]);
  assert.equal(await savedProjectSource.locator("pre strong").count(), 0);
  assert.equal(await projectResponse.isVisible(), true);
  await savedProjectSource.getByText("browser.ts", { exact: true }).click();
  assert.equal(await savedProjectSource.locator("details pre").textContent(), branchBefore);
  await hideSavedProjectSource.click();
  assert.equal(await savedProjectSource.locator("pre").count(), 0);

  const secondSource = { source: "files", files: [] };
  const secondPrompt = "Review the second request without attachments.";
  const secondPreview = await codingFixture<{ id: string }>(projectPath + "/preview", secondSource);
  projectFaux.setResponses([fauxAssistantMessage("Second project response.")]);
  await codingFixture(projectPath + "/run", {
    ...secondSource, previewId: secondPreview.id, approved: true, session: "project-browser-other", requestId: "project-prompt-only",
    prompt: secondPrompt,
  });
  await page.locator(".coding-activity").getByRole("button", { name: "Refresh", exact: true }).click();
  const secondRun = page.getByRole("button", { name: /project-prompt-only/ });
  await secondRun.waitFor();
  const heldSource = Promise.withResolvers<void>();
  const releaseSource = Promise.withResolvers<void>();
  await page.route("**" + projectPath + "/source-inspect", async (route) => {
    const response = await route.fetch();
    heldSource.resolve();
    await releaseSource.promise;
    await route.fulfill({ response });
  }, { times: 1 });
  const firstSourceResponse = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith(projectPath + "/source-inspect") &&
    response.request().postDataJSON().requestId === "project-task-progress");
  try {
    await viewSavedProjectSource.click();
    await heldSource.promise;
    await secondRun.click();
    await page.getByText("Second project response.", { exact: true }).waitFor();
    assert.equal(await savedProjectSource.locator("pre").count(), 0);
    await viewSavedProjectSource.click();
    await savedProjectSource.getByText(secondPrompt, { exact: true }).waitFor();
    await savedProjectSource.getByText("No source files were included in this request.", { exact: true }).waitFor();
  } finally {
    releaseSource.resolve();
  }
  const staleSource = await firstSourceResponse;
  assert.equal(staleSource.ok(), true);
  await staleSource.finished();
  assert.equal(await savedProjectSource.locator("pre").textContent(), secondPrompt);

  await page.evaluate((id) => { location.hash = "#coding/" + id + "/patch/project-browser/project-task-progress"; }, project.id);
  await proposalChoice.waitFor();
  assert.deepEqual(proposalRequests, [targetPatch, targetPatch]);
  assert.deepEqual(JSON.parse(await page.getByRole("combobox", { name: "Accepted result", exact: true }).inputValue()), targetPatch);

  const remote = Bun.spawnSync(["git", "remote", "add", "origin", `https://github.com/${githubFixture.repository}.git`], { cwd: workspace });
  assert.equal(remote.exitCode, 0, remote.stderr.toString());
  const github = page.locator("[data-coding-github]");
  await github.getByRole("button", { name: "Detect GitHub remotes", exact: true }).click();
  await github.getByRole("button", { name: "Save connection", exact: true }).click();
  await github.getByText("GitHub connection saved.", { exact: true }).waitFor();
  await github.getByText("Connection settings", { exact: true }).click();
  await github.getByLabel("Branch publishing token", { exact: true }).fill(githubFixture.branchToken);
  await github.getByRole("button", { name: "Save branch publishing token", exact: true }).click();
  await github.getByText("Branch publishing token saved.", { exact: true }).waitFor();
  await github.getByText("Connection settings", { exact: true }).click();
  await github.getByLabel("Pull request publishing token", { exact: true }).fill(githubFixture.pullToken);
  await github.getByRole("button", { name: "Save publishing token", exact: true }).click();
  await github.getByText("Pull request publishing token saved.", { exact: true }).waitFor();
  await github.getByText("Prepare GitHub review", { exact: true }).click();
  await github.getByLabel("Base branch", { exact: true }).fill(githubFixture.base);
  await github.getByLabel("Head branch", { exact: true }).fill(githubFixture.head);
  await github.getByText("Create branch from applied patch", { exact: true }).click();
  const commitMessage = github.getByLabel("Commit message", { exact: true });
  await commitMessage.fill(githubFixture.message);
  const previewBranch = github.getByRole("button", { name: "Preview branch", exact: true });
  const publishBranch = github.getByRole("button", { name: "Publish branch", exact: true });
  const branchConfirm = github.getByRole("checkbox", { name: /Approve sending these exact file contents/ });
  await previewBranch.click();
  await github.getByText(githubFixture.baseSha, { exact: false }).waitFor();
  assert.equal(await publishBranch.isEnabled(), false);
  await github.locator("[data-branch-files]").getByText("browser.ts", { exact: true }).click();
  assert.equal(await github.locator("[data-branch-files] pre").textContent(), branchAfter);
  assert.equal(await github.locator("[data-branch-files] script").count(), 0);
  await branchConfirm.check();
  assert.equal(await publishBranch.isEnabled(), true);
  await commitMessage.fill("A different commit message");
  assert.equal(await publishBranch.count(), 0);
  assert.deepEqual(githubFixture.writes, []);
  await commitMessage.fill(githubFixture.message);
  await previewBranch.click();
  await branchConfirm.check();
  await publishBranch.click();
  const branchLink = github.getByRole("link", { name: "Open branch on GitHub", exact: true });
  await branchLink.waitFor();
  await github.getByText(githubFixture.commitSha, { exact: false }).waitFor();
  assert.equal(await github.getByLabel("Head branch", { exact: true }).inputValue(), githubFixture.head);
  await github.getByLabel("Head branch", { exact: true }).fill("different-branch");
  await github.getByRole("button", { name: "Find or recover branch", exact: true }).click();
  await branchLink.waitFor();
  assert.equal(await github.getByLabel("Head branch", { exact: true }).inputValue(), githubFixture.head);
  await github.getByLabel("Pull request title", { exact: true }).fill("Browser review");
  await github.getByLabel("Pull request Markdown", { exact: true }).fill("Approved branch for review.");
  assert.equal(await branchLink.isVisible(), true);
  await github.getByRole("button", { name: "Preview pull request", exact: true }).click();
  await github.getByRole("checkbox", { name: "Approve this exact title, Markdown and branch comparison", exact: true }).check();
  await github.getByRole("button", { name: "Publish to GitHub", exact: true }).click();
  const pullLink = github.getByRole("link", { name: "Open pull request #22", exact: true });
  await pullLink.waitFor();
  assert.equal(await pullLink.getAttribute("href"), `https://github.com/${githubFixture.repository}/pull/22`);
  assert.deepEqual(githubFixture.writes, ["/git/blobs", "/git/trees", "/git/commits", "/git/refs", "/pulls"]);
  assert.equal(await Bun.file(file).text(), branchAfter);

  await page.evaluate(() => { location.hash = "#concept/%ZZ"; });
  await page.getByRole("textbox", { name: "Quick note" }).waitFor();
  assert.deepEqual(outbound, []);
  assert.deepEqual(errors, []);
  console.log("375px browser smoke passed with keyboard navigation and outbound requests blocked.");
} finally {
  finishAnswer.resolve();
  finishStandalone.resolve();
  finishProject.resolve();
  await chatFixture.stop(true);
  await browser?.close();
  await server.stop();
  const namespace = postgresFixture ? readCacheSettings(bundle)?.namespace : null;
  if (postgresFixture && namespace) {
    const client = createCacheClient(postgresFixture);
    try { await client`DROP SCHEMA IF EXISTS ${client(namespace)} CASCADE`; }
    finally { await closeCacheClient(client); }
  }
  await rm(root, { recursive: true, force: true });
}
