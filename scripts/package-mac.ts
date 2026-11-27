import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import * as sqliteVec from "sqlite-vec";
import { findDeveloperIdApplication, macSigningOptions, notarizeMacApp, signMacApp } from "./mac-signing.ts";

if (process.platform !== "darwin") throw new Error("The macOS app must be built on a macOS host with Xcode tools.");

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
const { version } = await Bun.file(join(root, "package.json")).json();
const appName = `okbrain-${version}-macos-${process.arch}`;
const signing = macSigningOptions(process.argv.slice(2), process.env);
const identity = signing ? await findDeveloperIdApplication(signing.identity) : null;
const output = join(dist, `${appName}${signing ? "-notarized" : ""}.zip`);
const pendingOutput = join(dist, `.${appName}-${randomUUID()}.zip`);
const staging = await mkdtemp(join(tmpdir(), "okbrain-macos-"));
// Build and sign on the system volume. External volumes can create AppleDouble
// files inside a bundle during compilation, which invalidates the signature.
const app = join(staging, "okbrain.app");
const contents = join(app, "Contents");
const executables = join(contents, "MacOS");
const resources = join(contents, "Resources");
try {
  await mkdir(dist, { recursive: true });
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
  if (identity) {
    await signMacApp(app, executables, join(root, "packaging", "macos", "okb.entitlements.plist"), identity);
  } else {
    for (const file of ["okb", "vec0.dylib", "libsqlite3.dylib"])
      await $`codesign --force --sign - ${join(executables, file)}`;
    await $`codesign --force --sign - ${app}`;
    await $`codesign --verify --deep --strict ${app}`;
  }

  if (process.argv.includes("--smoke")) {
    const child = Bun.spawn([join(executables, "Okbrain"), "--smoke-test"], { stdout: "inherit", stderr: "inherit" });
    // Allow time for the app to save both graph exports and report a specific failure.
    const timer = setTimeout(() => child.kill(), 45_000);
    try {
      if (await child.exited) throw new Error("The packaged macOS app did not pass its smoke test.");
    } finally { clearTimeout(timer); }
  }

  if (signing) {
    const submission = await notarizeMacApp(app, join(staging, "submission.zip"), signing.profile);
    console.log(`Apple accepted notarization submission ${submission}.`);
  }
  await $`ditto -c -k --sequesterRsrc --keepParent ${app} ${pendingOutput}`;
  await rename(pendingOutput, output);
  console.log(output);
} finally {
  await Promise.all([
    rm(pendingOutput, { force: true }),
    rm(staging, { recursive: true, force: true }),
  ]);
}
