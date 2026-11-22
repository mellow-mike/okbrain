import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { createApiServer } from "../src/api.ts";

const root = await mkdtemp(join(tmpdir(), "okbrain-browser-smoke-"));
process.env.XDG_CONFIG_HOME = join(root, "config");
process.env.XDG_DATA_HOME = join(root, "data");
process.env.APPDATA = join(root, "config");
process.env.LOCALAPPDATA = join(root, "data");
const bundle = join(root, "brain");
await mkdir(bundle);
const server = createApiServer({ bundle, port: 0 });
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
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Skip to content");
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "view");

  await page.getByRole("textbox", { name: "Quick note" }).focus();
  await page.keyboard.type("Offline orchid propagation");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await page.getByRole("link", { name: "Open saved note" }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Open saved note");
  await page.keyboard.press("Enter");
  await page.getByText("Offline orchid propagation", { exact: true }).first().waitFor();
  await nav.getByRole("link", { name: "Home", exact: true }).click();
  await enable.click();
  await page.getByRole("link", { name: "Search notes", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Search notes");
  await page.keyboard.press("Enter");

  await page.getByRole("searchbox", { name: "Search notes", exact: true }).focus();
  await page.keyboard.type("orchid");
  await page.keyboard.press("Enter");
  await page.getByRole("link", { name: "Offline orchid propagation", exact: true }).waitFor();
  await page.locator("#sout").getByRole("link", { name: "Focused map" }).click();
  await page.getByText("1 note, 0 links.").waitFor();
  await nav.getByRole("link", { name: "Review", exact: true }).click();
  await page.getByRole("button", { name: /Reviewed/ }).first().waitFor();
  await page.keyboard.press("/");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "qs-in");

  await nav.getByRole("link", { name: "Accounts", exact: true }).click();
  await page.getByText("No connected account is selected.").waitFor();
  await page.getByRole("link", { name: "Ask with ChatGPT", exact: true }).click();
  await page.getByText("Connect an eligible account to continue.").waitFor();
  await nav.getByRole("link", { name: "Settings", exact: true }).click();
  const keys = page.locator("#provider-keys");
  await keys.getByRole("combobox", { name: "API provider" }).selectOption("openai");
  await keys.getByLabel("API key", { exact: true }).fill("fixture-key-for-browser-smoke");
  await keys.getByRole("button", { name: "Save key" }).click();
  await keys.getByText("Key saved locally.", { exact: false }).waitFor();
  await keys.getByRole("button", { name: "Remove saved key" }).click();
  await keys.getByText("No saved key.", { exact: false }).waitFor();

  const mounts = page.locator("#brain-mount-settings");
  await mounts.getByText("Add a brain folder", { exact: true }).click();
  await mounts.getByLabel("Mount name").fill("field-notes");
  await mounts.getByLabel("Folder action").selectOption("create");
  await mounts.getByLabel("Absolute folder path").fill(join(root, "field-notes"));
  await mounts.getByRole("button", { name: "Add brain folder" }).click();
  await mounts.getByText("Brain folder added.", { exact: true }).waitFor();
  assert.equal(await page.locator("#brain").inputValue(), "field-notes");

  await page.getByLabel("Local port", { exact: true }).fill("0");
  await page.getByRole("button", { name: "Start MCP HTTP" }).click();
  await page.getByText("MCP HTTP started.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Stop MCP HTTP" }).click();
  await page.getByText("MCP HTTP stopped.", { exact: true }).waitFor();

  await mounts.getByText("field-notes", { exact: true }).click();
  await mounts.getByRole("button", { name: "Remove mount" }).click();
  await mounts.getByText("Mount removed. Its files are still in the folder.", { exact: true }).waitFor();
  assert.equal(await page.locator("#brain").inputValue(), "");

  await nav.getByRole("link", { name: "Coding", exact: true }).click();
  await page.getByText("Add a project", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 375);
  await page.evaluate(() => { location.hash = "#concept/%ZZ"; });
  await page.getByRole("textbox", { name: "Quick note" }).waitFor();
  assert.deepEqual(outbound, []);
  assert.deepEqual(errors, []);
  console.log("375px browser smoke passed with keyboard navigation and outbound requests blocked.");
} finally {
  await browser?.close();
  await server.stop();
  await rm(root, { recursive: true, force: true });
}
