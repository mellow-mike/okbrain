// Hermetic test environment (bunfig [test].preload): tests must never read
// the developer's real okbrain config, bundle override, or provider keys —
// otherwise a local config.json (review weights, default bundle) or an
// exported API key would change test behavior per machine.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "okb-test-config-"));
process.env.XDG_CONFIG_HOME = dir; // linux/macOS configDir
process.env.APPDATA = join(dir, "roaming"); // windows configDir
process.env.LOCALAPPDATA = join(dir, "local"); // windows dataDir

for (const key of Object.keys(process.env))
  if (key.startsWith("OKB_")) delete process.env[key];
for (const key of [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "VOYAGE_API_KEY",
])
  delete process.env[key];
