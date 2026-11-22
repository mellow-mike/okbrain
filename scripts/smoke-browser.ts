import assert from "node:assert/strict";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { createApiServer } from "../src/api.ts";
import { runCodingSession } from "../src/core/coding/durable.ts";
import { loadConfig } from "../src/core/config.ts";
import { closeCacheClient, createCacheClient, readCacheSettings } from "../src/core/engine/cache-settings.ts";
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
const projectFaux = fauxProvider({ provider: "openai", models: [{ id: "browser-project-fixture" }] });
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
  const page = await browser.newPage({ viewport: { width: 375, height: 700 }, reducedMotion: "reduce" });
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

  for (const args of [["init", "--quiet"], ["config", "user.name", "Browser Smoke"], ["config", "user.email", "smoke@example.invalid"]]) {
    assert.equal(Bun.spawnSync(["git", "-C", bundle, ...args]).exitCode, 0);
  }
  await page.getByLabel("Commit message (optional)").fill("Sync browser notes");
  await page.getByRole("button", { name: "Sync now", exact: true }).click();
  await page.locator("#sync-out .notice").waitFor();
  const gitLog = Bun.spawnSync(["git", "-C", bundle, "log", "-1", "--format=%s"]);
  assert.equal(gitLog.exitCode, 0);
  assert.equal(gitLog.stdout.toString().trim(), "Sync browser notes");

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
  assert.match(decodeURIComponent(await laterDraft.getAttribute("href") || ""), /^#concept\/db_only\/conversations\/claude\//);

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
  await page.getByRole("link", { name: "Standalone sessions", exact: true }).click();
  await page.getByRole("heading", { name: "Standalone sessions", exact: true }).waitFor();
  await page.getByText("Saved CLI answer.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("combobox", { name: "Saved session" }).inputValue(), "existing-cli");
  assert.equal(await page.getByRole("combobox", { name: "Model", exact: true }).isDisabled(), true);
  await page.getByText("Saved task and source", { exact: true }).click();
  await page.getByText("Saved CLI task.", { exact: true }).waitFor();
  await page.getByText("browser.ts", { exact: true }).click();
  await page.getByText(snapshot.trim(), { exact: true }).waitFor();

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
  await page.getByRole("heading", { name: "Saved Pi task state", exact: true }).waitFor();
  await page.getByText("Model response · 1 pending", { exact: true }).waitFor();
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
  await page.getByLabel("Session name").fill("from-browser");
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
  finishStandalone.resolve();
  await page.getByText("Reviewed browser source.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("heading", { name: "Current Pi tasks", exact: true }).count(), 0);
  assert.equal(await page.getByRole("combobox", { name: "Saved session" }).inputValue(), "from-browser");
  assert.equal(standaloneFaux.state.callCount, 3);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 375);
  await page.getByRole("button", { name: "Refresh sessions", exact: true }).click();
  await page.getByRole("combobox", { name: "Saved session" }).selectOption("existing-cli");
  await page.getByRole("combobox", { name: "Saved request" }).selectOption("cli-complete");
  await page.getByText("Saved CLI answer.", { exact: true }).waitFor();

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
  const projectPreview = await codingFixture<{ id: string }>(projectPath + "/preview", projectSource);
  projectFaux.setResponses([async () => {
    await finishProject.promise;
    return fauxAssistantMessage("Project response ready for review.");
  }]);
  await codingFixture(projectPath + "/run", {
    ...projectSource, previewId: projectPreview.id, approved: true, session: "project-browser", requestId: "project-task-progress",
    prompt: "Review the browser source in this project.",
  });
  await page.evaluate((id) => { location.hash = "#coding/" + id; }, project.id);
  await page.getByRole("button", { name: /project-task-progress/ }).click();
  await page.getByText("Model response · 1 running", { exact: true }).waitFor();
  const cancelProject = page.getByRole("button", { name: "Cancel run", exact: true });
  await cancelProject.focus();
  await page.waitForResponse((res) => new URL(res.url()).pathname.endsWith(projectPath + "/inspect"));
  assert.equal(await cancelProject.evaluate((button) => button === document.activeElement), true);
  finishProject.resolve();
  await page.getByText("Project response ready for review.", { exact: true }).waitFor();
  const acceptResult = page.getByRole("button", { name: "Accept result", exact: true });
  await acceptResult.waitFor();
  assert.equal(await page.getByRole("heading", { name: "Current Pi tasks", exact: true }).count(), 0);
  const accepted = page.waitForResponse((res) => new URL(res.url()).pathname.endsWith(projectPath + "/review"));
  await acceptResult.click();
  assert.equal((await accepted).ok(), true);

  const remote = Bun.spawnSync(["git", "remote", "add", "origin", `https://github.com/${githubFixture.repository}.git`], { cwd: workspace });
  assert.equal(remote.exitCode, 0, remote.stderr.toString());
  await page.getByText("Apply a reviewed patch", { exact: true }).click();
  await page.getByLabel("Git unified diff", { exact: true }).fill(
    "diff --git a/browser.ts b/browser.ts\n--- a/browser.ts\n+++ b/browser.ts\n@@ -1 +1 @@\n-" +
    branchBefore + "+" + branchAfter,
  );
  await page.getByRole("button", { name: "Preview patch", exact: true }).click();
  await page.getByRole("checkbox", { name: "Apply this exact diff to the listed files.", exact: true }).check();
  await page.getByRole("button", { name: "Apply to worktree", exact: true }).click();
  await page.getByText(/Applied to the local worktree/).waitFor();
  assert.equal(await Bun.file(file).text(), branchAfter);
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
