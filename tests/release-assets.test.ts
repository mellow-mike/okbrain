import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkReleaseAssets, releaseAssetNames, verifyReleaseTag } from "../scripts/release-assets.ts";

const version = "0.1.0";
const { cli, interfaces } = releaseAssetNames(version);
const checksum = (name: string, data = name) => `${createHash("sha256").update(data).digest("hex")}  ${name}\n`;
const original = cli.map((name) => checksum(name)).join("");
const combined = original + interfaces.map((name) => checksum(name)).join("");

async function candidate(assert: (directory: string, manifest: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "okbrain-release-assets-"));
  const manifest = join(directory, "SHA256SUMS.txt");
  try {
    await Promise.all([writeFile(manifest, original), ...[...cli, ...interfaces].map((name) => writeFile(join(directory, name), name))]);
    await assert(directory, manifest);
  } finally { await rm(directory, { force: true, recursive: true }); }
}

test("the release tag must equal the checked package version", () => {
  verifyReleaseTag(version, "v0.1.0");
  verifyReleaseTag("1.2.3-alpha.2+build", "v1.2.3-alpha.2+build");
  for (const tag of [undefined, "0.1.0", "v0.1.1", "v0.1.0\n", "v0.1.0$(echo)"]) {
    expect(() => verifyReleaseTag(version, tag)).toThrow("must match");
  }
  for (const value of ["0.1.0-01", "0.1.0/other", "01.2.3", "0.1.0\n", undefined]) {
    expect(() => releaseAssetNames(value)).toThrow("valid release version");
  }
  expect(cli).toEqual([
    "okb-0.1.0-linux-x64.tar.gz", "okb-0.1.0-linux-arm64.tar.gz", "okb-0.1.0-darwin-x64.tar.gz",
    "okb-0.1.0-darwin-arm64.tar.gz", "okb-0.1.0-windows-x64.zip",
  ]);
  expect(interfaces).toEqual(["okbrain-0.1.0-macos-arm64.zip", "okbrain-0.1.0-macos-x64.zip", "okbrain-coding.vsix"]);
});

test("assembly checks the CLI manifest and verification checks each staged archive", async () => {
  await candidate(async (directory, manifest) => {
    await expect(checkReleaseAssets(directory, version, "verify")).rejects.toThrow("complete checksum manifest");
    expect(await checkReleaseAssets(directory, version, "assemble")).toBe(8);
    expect(await readFile(manifest, "utf8")).toBe(combined);
    expect(await checkReleaseAssets(directory, version, "verify")).toBe(8);
    await writeFile(join(directory, interfaces[2]!), "changed editor artifact");
    await expect(checkReleaseAssets(directory, version, "verify")).rejects.toThrow("complete checksum manifest");
  });
});

test("assembly rejects a CLI checksum mismatch without changing the manifest", async () => {
  await candidate(async (directory, manifest) => {
    await writeFile(join(directory, cli[0]!), "changed CLI archive");
    await expect(checkReleaseAssets(directory, version, "assemble")).rejects.toThrow("CLI release assets");
    expect(await readFile(manifest, "utf8")).toBe(original);
    await writeFile(manifest, "x".repeat(4097));
    await expect(checkReleaseAssets(directory, version, "assemble")).rejects.toThrow("manifest exceeds");
  });
});

test("asset names must be exact and refer to nonempty regular files", async () => {
  await candidate(async (directory) => {
    const name = interfaces[0]!;
    const path = join(directory, name);
    await rm(path);
    await writeFile(join(directory, "okbrain-0.0.9-macos-arm64.zip"), name);
    await expect(checkReleaseAssets(directory, version, "assemble")).rejects.toThrow("Expected these regular files");
    await rm(join(directory, "okbrain-0.0.9-macos-arm64.zip"));
    if (process.platform !== "win32") {
      await symlink(interfaces[1]!, path);
      await expect(checkReleaseAssets(directory, version, "assemble")).rejects.toThrow("Expected these regular files");
      await rm(path);
    }
    await writeFile(path, "");
    await expect(checkReleaseAssets(directory, version, "assemble")).rejects.toThrow("asset is empty");
    await writeFile(path, name);
    await writeFile(join(directory, "unpublished-extra.zip"), name);
    await expect(checkReleaseAssets(directory, version, "assemble")).rejects.toThrow("Expected these regular files");
  });
});
