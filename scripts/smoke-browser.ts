import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { createApiServer } from "../src/api.ts";
import { loadConfig } from "../src/core/config.ts";

const root = await mkdtemp(join(tmpdir(), "okbrain-browser-smoke-"));
process.env.XDG_CONFIG_HOME = join(root, "config");
process.env.XDG_DATA_HOME = join(root, "data");
process.env.APPDATA = join(root, "config");
process.env.LOCALAPPDATA = join(root, "data");
const bundle = join(root, "brain");
await mkdir(bundle);
const server = createApiServer({ bundle, port: 0 });
const finishAnswer = Promise.withResolvers<void>();
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
  assert.equal(await page.getByRole("checkbox", { name: "Include private drafts in graph export" }).isChecked(), false);
  await page.getByRole("checkbox", { name: "Embed app fonts in graph export" }).check();
  const exported = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/op/export_viz");
  await page.getByRole("button", { name: "Export viz.html" }).click();
  assert.equal((await exported).status(), 200);
  assert.match(await Bun.file(join(bundle, "viz.html")).text(), /data:font\/woff2;base64,/);
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
  await writeFile(join(bundle, "external.md"), "---\ntype: note\ntitle: Watched field note\n---\nHellebore propagation\n");
  await refreshed;
  await watcher.getByRole("button", { name: "Stop watching" }).click();
  await watcher.getByText("Watching is off.", { exact: true }).waitFor();
  await nav.getByRole("link", { name: "Search", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search notes", exact: true }).fill("hellebore");
  await page.getByRole("searchbox", { name: "Search notes", exact: true }).press("Enter");
  await page.getByRole("link", { name: "Watched field note", exact: true }).waitFor();

  await nav.getByRole("link", { name: "Settings", exact: true }).click();
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

  await nav.getByRole("link", { name: "Coding", exact: true }).click();
  await page.getByText("Add a project", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 375);
  await page.evaluate(() => { location.hash = "#concept/%ZZ"; });
  await page.getByRole("textbox", { name: "Quick note" }).waitFor();
  assert.deepEqual(outbound, []);
  assert.deepEqual(errors, []);
  console.log("375px browser smoke passed with keyboard navigation and outbound requests blocked.");
} finally {
  finishAnswer.resolve();
  await chatFixture.stop(true);
  await browser?.close();
  await server.stop();
  await rm(root, { recursive: true, force: true });
}
