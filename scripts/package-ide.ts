import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
const extension = join(root, "integrations", "vscode");
const stage = await mkdtemp(join(tmpdir(), "okbrain-vsix-"));
try {
  await mkdir(dist, { recursive: true });
  await copyFile(join(root, "LICENSE"), join(stage, "LICENSE"));
  for (const file of await readdir(extension)) await copyFile(join(extension, file), join(stage, file));
  const manifestPath = join(stage, "package.json");
  const manifest = await Bun.file(manifestPath).json();
  const { version } = await Bun.file(join(root, "package.json")).json();
  await writeFile(manifestPath, JSON.stringify({ ...manifest, version }, null, 2) + "\n");
  const output = join(dist, "okbrain-coding.vsix");
  await $`bunx --package @vscode/vsce@3.7.1 vsce package --no-dependencies --out ${output}`.cwd(stage);
} finally { await rm(stage, { recursive: true, force: true }); }
