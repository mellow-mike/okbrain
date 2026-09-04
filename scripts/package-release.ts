// Build per-OS release archives (Stage 5 packaging): cross-compile the okb
// binary for every supported target, pair each with its platform's vec0
// loadable extension (fetched from the npm registry at the version pinned by
// this repo's sqlite-vec dependency), and emit tar.gz/zip archives plus a
// SHA256SUMS.txt into dist/. Runs on the Linux release runner (uses tar/zip);
// the app itself stays free of platform-only shell commands.
//
//   bun run scripts/package-release.ts [version]      all five targets (needs network)
//   bun run scripts/package-release.ts --local        this machine only, fully offline:
//                                                     vec0 comes from node_modules
//                                                     (`bun run package`)

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { copyFile, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import * as sqliteVec from "sqlite-vec";

interface Target {
  bunTarget: string;
  os: "linux" | "darwin" | "windows";
  arch: "x64" | "arm64";
  vec: string;
  exe: string;
}

const TARGETS: Target[] = [
  { bunTarget: "bun-linux-x64", os: "linux", arch: "x64", vec: "vec0.so", exe: "okb" },
  { bunTarget: "bun-linux-arm64", os: "linux", arch: "arm64", vec: "vec0.so", exe: "okb" },
  { bunTarget: "bun-darwin-x64", os: "darwin", arch: "x64", vec: "vec0.dylib", exe: "okb" },
  { bunTarget: "bun-darwin-arm64", os: "darwin", arch: "arm64", vec: "vec0.dylib", exe: "okb" },
  { bunTarget: "bun-windows-x64", os: "windows", arch: "x64", vec: "vec0.dll", exe: "okb.exe" },
];

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  version: string;
  dependencies: Record<string, string>;
};
const args = process.argv.slice(2);
const local = args.includes("--local");
const version = (args.find((a) => !a.startsWith("--")) ?? pkg.version).replace(/^v/, "");
const vecVersion = (
  JSON.parse(readFileSync(join(root, "node_modules", "sqlite-vec", "package.json"), "utf8")) as {
    version: string;
  }
).version;

/** The target matching this machine (for `--local`). */
function hostTarget(): Target {
  const os = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
  const t = TARGETS.find((x) => x.os === os && x.arch === process.arch);
  if (!t) throw new Error(`no release target for ${process.platform}/${process.arch}`);
  return t;
}

/** Fetch and unpack one sqlite-vec platform tarball; returns the vec0 path. */
async function fetchVec(t: Target, into: string): Promise<string> {
  const name = `sqlite-vec-${t.os}-${t.arch}`;
  const url = `https://registry.npmjs.org/${name}/-/${name}-${vecVersion}.tgz`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const tgz = join(into, `${name}.tgz`);
  writeFileSync(tgz, new Uint8Array(await res.arrayBuffer()));
  await $`tar -xzf ${tgz} -C ${into}`;
  return join(into, "package", t.vec);
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
const sums: string[] = [];

for (const t of local ? [hostTarget()] : TARGETS) {
  const label = `okb-${version}-${t.os}-${t.arch}`;
  const stage = join(dist, label);
  mkdirSync(stage, { recursive: true });
  console.log(`\n=== ${label} (${t.bunTarget}, vec0 ${vecVersion}${local ? ", local" : ""}) ===`);

  await $`bun build --compile --target=${t.bunTarget} --outfile ${join(stage, t.exe)} ${join(root, "src", "cli.ts")}`;
  if (local) {
    await copyFile(sqliteVec.getLoadablePath(), join(stage, t.vec));
  } else {
    const work = join(dist, `.vec-${t.os}-${t.arch}`);
    mkdirSync(work, { recursive: true });
    await copyFile(await fetchVec(t, work), join(stage, t.vec));
    rmSync(work, { recursive: true, force: true });
  }
  for (const f of ["LICENSE", "README.md"]) await copyFile(join(root, f), join(stage, f));

  const archive = t.os === "windows" ? `${label}.zip` : `${label}.tar.gz`;
  if (t.os === "windows")
    // `zip` on the Linux runner; bsdtar (`tar -a`) on a Windows host building locally.
    await (process.platform === "win32"
      ? $`tar -a -cf ${join(dist, archive)} -C ${stage} .`
      : $`cd ${stage} && zip -qr ${join(dist, archive)} .`);
  else await $`tar -czf ${join(dist, archive)} -C ${stage} .`;
  rmSync(stage, { recursive: true, force: true });

  const digest = createHash("sha256")
    .update(await readFile(join(dist, archive)))
    .digest("hex");
  sums.push(`${digest}  ${archive}`);
  console.log(`${digest}  ${archive}`);
}

writeFileSync(join(dist, "SHA256SUMS.txt"), sums.join("\n") + "\n");
console.log(`\nwrote ${(await readdir(dist)).length} files to dist/`);
