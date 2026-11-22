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
//   bun run package --sign                            Windows publisher build with timestamping

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import * as sqliteVec from "sqlite-vec";
import { signWindowsBinaries, windowsSigningOptions } from "./windows-signing.ts";

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
const signing = windowsSigningOptions(args, process.platform, process.env);
const signtool = signing ? Bun.which("signtool.exe") : null;
if (signing && !signtool) throw new Error("Windows publisher signing requires Windows SDK signtool.exe on PATH.");
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

const targets = local ? [hostTarget()] : TARGETS;
if (!signing) rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
const destination = signing ? await mkdtemp(join(dist, ".windows-signing-")) : dist;
try {
  const sums: string[] = [];
  const completed: string[] = [];
  for (const t of targets) {
    const label = `okb-${version}-${t.os}-${t.arch}${signing ? "-signed" : ""}`;
    const stage = join(destination, label);
    mkdirSync(stage, { recursive: true });
    console.log(`\n=== ${label} (${t.bunTarget}, vec0 ${vecVersion}${local ? ", local" : ""}) ===`);

    const executable = join(stage, t.exe);
    const extension = join(stage, t.vec);
    await $`bun build --compile --target=${t.bunTarget} --outfile ${executable} ${join(root, "src", "cli.ts")}`;
    if (local) {
      await copyFile(sqliteVec.getLoadablePath(), extension);
    } else {
      const work = join(destination, `.vec-${t.os}-${t.arch}`);
      mkdirSync(work, { recursive: true });
      await copyFile(await fetchVec(t, work), extension);
      rmSync(work, { recursive: true, force: true });
    }
    if (signing && signtool) await signWindowsBinaries(signtool, [executable, extension], signing);
    for (const f of ["LICENSE", "README.md"]) await copyFile(join(root, f), join(stage, f));
    await copyFile(join(root, "packaging", "OFFLINE-IMPORT-NOTICES.md"), join(stage, "OFFLINE-IMPORT-NOTICES.md"));
    mkdirSync(join(stage, "docs"));
    for (const f of ["PERSONAL.md", "CODING.md", "PRODUCT-PLAN.md"])
      await copyFile(join(root, "docs", f), join(stage, "docs", f));

    const archive = t.os === "windows" ? `${label}.zip` : `${label}.tar.gz`;
    const archivePath = join(destination, archive);
    if (t.os === "windows")
      // `zip` on the Linux runner; bsdtar (`tar -a`) on a Windows host building locally.
      await (process.platform === "win32"
        ? $`tar -a -cf ${archivePath} -C ${stage} .`
        : $`cd ${stage} && zip -qr ${archivePath} .`);
    else await $`tar -czf ${archivePath} -C ${stage} .`;
    rmSync(stage, { recursive: true, force: true });

    const digest = createHash("sha256").update(await readFile(archivePath)).digest("hex");
    sums.push(`${digest}  ${archive}`);
    completed.push(archive);
  }
  const manifest = signing ? "SHA256SUMS-windows-signed.txt" : "SHA256SUMS.txt";
  writeFileSync(join(destination, manifest), sums.join("\n") + "\n");
  if (signing) {
    for (const file of [...completed, manifest]) await rename(join(destination, file), join(dist, file));
  }
  for (const sum of sums) console.log(sum);
  console.log(`\nwrote ${completed.length + 1} files to dist/`);
} finally {
  if (signing) await rm(destination, { recursive: true, force: true });
}
