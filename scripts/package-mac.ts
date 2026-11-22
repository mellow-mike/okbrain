import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import * as sqliteVec from "sqlite-vec";

if (process.platform !== "darwin") throw new Error("The macOS app must be built on a macOS host with Xcode tools.");

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
const { version } = await Bun.file(join(root, "package.json")).json();
const appName = `okbrain-${version}-macos-${process.arch}`;
const app = join(dist, "okbrain.app");
const contents = join(app, "Contents");
const executables = join(contents, "MacOS");
const resources = join(contents, "Resources");
const staging = await mkdtemp(join(tmpdir(), "okbrain-macos-"));
try {
  await rm(app, { recursive: true, force: true });
  await mkdir(executables, { recursive: true });
  await mkdir(resources);
  await copyFile(join(root, "packaging", "OFFLINE-IMPORT-NOTICES.md"), join(resources, "OFFLINE-IMPORT-NOTICES.md"));
  await copyFile(join(root, "packaging", "macos", "Info.plist"), join(contents, "Info.plist"));
  await $`/usr/libexec/PlistBuddy -c ${`Set :CFBundleShortVersionString ${version}`} ${join(contents, "Info.plist")}`;
  const target = `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx13.0`;
  await $`xcrun swiftc -O -parse-as-library -target ${target} -o ${join(executables, "Okbrain")} ${join(root, "packaging", "macos", "Okbrain.swift")}`;
  await $`bun build --compile --outfile ${join(executables, "okb")} ${join(root, "src", "cli.ts")}`;
  await copyFile(sqliteVec.getLoadablePath(), join(executables, "vec0.dylib"));

  // Apple’s system SQLite cannot load sqlite-vec. Package the upstream amalgamation.
  const sqlite = "sqlite-amalgamation-3540100";
  const zip = join(staging, `${sqlite}.zip`);
  await $`curl --fail --silent --show-error --connect-timeout 15 --max-time 45 --retry 2 --retry-connrefused --output ${zip} ${`https://www.sqlite.org/2026/${sqlite}.zip`}`;
  const archive = Buffer.from(await Bun.file(zip).arrayBuffer());
  const hash = createHash("sha3-256").update(archive).digest("hex");
  if (hash !== "92281c86e2957f9b9305890f9ac04204caa7b677cc868dc326d942689df28e30")
    throw new Error("The SQLite download failed its published checksum.");
  await $`unzip -q ${zip} -d ${staging}`;
  await $`xcrun clang -target ${target} -dynamiclib -O2 -DSQLITE_ENABLE_FTS5 -DSQLITE_ENABLE_COLUMN_METADATA -o ${join(executables, "libsqlite3.dylib")} ${join(staging, sqlite, "sqlite3.c")}`;
  for (const file of ["okb", "vec0.dylib", "libsqlite3.dylib"])
    await $`codesign --force --sign - ${join(executables, file)}`;
  await $`codesign --force --sign - ${app}`;
  await $`codesign --verify --deep --strict ${app}`;

  if (process.argv.includes("--smoke")) {
    const child = Bun.spawn([join(executables, "Okbrain"), "--smoke-test"], { stdout: "inherit", stderr: "inherit" });
    const timer = setTimeout(() => child.kill(), 25_000);
    try {
      if (await child.exited) throw new Error("The packaged macOS app did not load its local web interface.");
    } finally { clearTimeout(timer); }
  }

  const output = join(dist, `${appName}.zip`);
  await rm(output, { force: true });
  await $`ditto -c -k --sequesterRsrc --keepParent ${app} ${output}`;
  console.log(output);
} finally {
  await rm(staging, { recursive: true, force: true });
}
