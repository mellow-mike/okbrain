import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const checksumFile = "SHA256SUMS.txt";
const maxChecksumFileBytes = 4096;
const versionPattern = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

function checkedVersion(version: unknown): string {
  const match = typeof version === "string" && version.length <= 64 && version === version.trim() && versionPattern.exec(version);
  if (!match || match[1]?.split(".").some((component) => /^0[0-9]+$/u.test(component)))
    throw new Error("Set a valid release version in package.json.");
  return match[0];
}

export function verifyReleaseTag(version: unknown, tag: string | undefined): void {
  if (tag !== `v${checkedVersion(version)}`)
    throw new Error("The release tag must match the version in package.json with a leading v.");
}

export function releaseAssetNames(packageVersion: unknown) {
  const version = checkedVersion(packageVersion);
  const cli = [
    `okb-${version}-linux-x64.tar.gz`,
    `okb-${version}-linux-arm64.tar.gz`,
    `okb-${version}-darwin-x64.tar.gz`,
    `okb-${version}-darwin-arm64.tar.gz`,
    `okb-${version}-windows-x64.zip`,
  ];
  const interfaces = [`okbrain-${version}-macos-arm64.zip`, `okbrain-${version}-macos-x64.zip`, "okbrain-coding.vsix"];
  return { cli, interfaces };
}

async function checksumLine(directory: string, name: string): Promise<string> {
  const hash = createHash("sha256");
  const path = join(directory, name);
  if ((await stat(path)).size === 0) throw new Error(`Release asset is empty: ${name}`);
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return `${hash.digest("hex")}  ${name}\n`;
}

export async function checkReleaseAssets(
  directory: string, version: unknown, mode: "assemble" | "verify",
): Promise<number> {
  const { cli, interfaces } = releaseAssetNames(version);
  const assets = [...cli, ...interfaces];
  const expected = new Set([...assets, checksumFile]);
  const present = await readdir(directory, { withFileTypes: true });
  if (present.length !== expected.size || present.some((entry) => !entry.isFile() || !expected.has(entry.name)))
    throw new Error(`Expected these regular files in the release directory: ${[...expected].join(", ")}`);

  const manifest = join(directory, checksumFile);
  if ((await stat(manifest)).size > maxChecksumFileBytes) throw new Error("Release checksum manifest exceeds its size limit.");
  const recorded = await readFile(manifest, "utf8");
  const cliChecksums = (await Promise.all(cli.map((name) => checksumLine(directory, name)))).join("");
  if (mode === "assemble" && recorded !== cliChecksums)
    throw new Error("CLI release assets do not match their checksum manifest.");
  const combined = cliChecksums + (await Promise.all(interfaces.map((name) => checksumLine(directory, name)))).join("");
  if (mode === "verify") {
    if (recorded !== combined) throw new Error("Release assets do not match the complete checksum manifest.");
  } else {
    const temporary = join(directory, `.release-checksums-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, combined, { flag: "wx" });
      await rename(temporary, manifest);
    } finally { await rm(temporary, { force: true }); }
  }
  return assets.length;
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const { version } = await Bun.file(join(root, "package.json")).json();
  const mode = process.argv[2];
  if (process.argv.length !== 3) throw new Error("Use release-assets.ts validate-tag, assemble, or verify.");
  if (mode === "validate-tag") {
    verifyReleaseTag(version, process.env.OKB_RELEASE_TAG);
  } else if (mode === "assemble" || mode === "verify") {
    const count = await checkReleaseAssets(join(root, "dist"), version, mode);
    console.log(`Verified ${count} release assets for v${version}.`);
  } else throw new Error("Use release-assets.ts validate-tag, assemble, or verify.");
}
