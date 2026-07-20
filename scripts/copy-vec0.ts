// Place the current platform's vec0 loadable extension next to the compiled
// binary (Stage 5 packaging): a shipped `okb` looks for vec0 beside itself
// (core/engine/vectors.ts), so `bun run build` and the release archives both
// ship the pair together. Usage: bun run scripts/copy-vec0.ts <dest-dir>

import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as sqliteVec from "sqlite-vec";
import { vec0Filename } from "../src/core/engine/vectors.ts";

const dest = process.argv[2];
if (!dest) {
  console.error("usage: bun run scripts/copy-vec0.ts <dest-dir>");
  process.exit(2);
}
mkdirSync(dest, { recursive: true });
const target = join(dest, vec0Filename());
copyFileSync(sqliteVec.getLoadablePath(), target);
console.log(`copied vec0 → ${target}`);
