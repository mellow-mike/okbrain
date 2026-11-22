import { expect, test } from "bun:test";
import { join } from "node:path";
import { findDeveloperIdApplication, macSigningOptions, notarizeMacApp, signMacApp } from "../scripts/mac-signing.ts";

const identity = "Developer ID Application: Example Publisher (ABC123DEFG)";
const fingerprint = "0123456789ABCDEF0123456789ABCDEF01234567";
const profile = "okbrain release";
const submissionId = "01234567-abcd-4321-aaaa-0123456789ab";
const app = join("dist", "okbrain.app");
const executables = join(app, "Contents", "MacOS");
const entitlements = join("packaging", "macos", "okb.entitlements.plist");
const submission = join("staging", "submission.zip");
const ok = { exitCode: 0, stdout: "", stderr: "" };

test("macOS signing needs a flag and both existing Keychain selectors", () => {
  const env = { OKB_MAC_SIGN_IDENTITY: identity, OKB_MAC_NOTARY_PROFILE: profile };
  expect(macSigningOptions(["--smoke"], env)).toBeNull();
  expect(() => macSigningOptions(["--sign"], {})).toThrow("requires OKB_MAC_SIGN_IDENTITY and OKB_MAC_NOTARY_PROFILE");
  expect(macSigningOptions(["--sign", "--smoke"], env)).toEqual({ identity, profile });
});

test("only a unique valid Developer ID Application identity can sign the release", async () => {
  const otherFingerprint = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const otherName = "Apple Development: Other User (AAAAABBBBB)";
  const stdout = `  1) ${fingerprint} "${identity}"\n  2) ${otherFingerprint} "${otherName}"\n  2 valid identities found`;
  const keychain = async () => ({ ...ok, stdout });
  expect(await findDeveloperIdApplication(identity, keychain)).toBe(fingerprint);
  expect(await findDeveloperIdApplication(fingerprint.toLowerCase(), keychain)).toBe(fingerprint);
  await expect(findDeveloperIdApplication(otherFingerprint, keychain)).rejects.toThrow("Developer ID Application");
  await expect(findDeveloperIdApplication(identity, async () => ({
    ...ok, stdout: stdout + `\n  3) ${otherFingerprint} "${identity}"`,
  }))).rejects.toThrow("unique");
});

test("signs the nested code first, notarizes a ZIP, then validates the stapled app", async () => {
  const commands: string[][] = [];
  async function run(argv: string[]) {
    commands.push(argv);
    return argv[1] === "notarytool"
      ? { ...ok, stdout: JSON.stringify({ id: submissionId, status: "Accepted" }) }
      : ok;
  }
  await signMacApp(app, executables, entitlements, fingerprint, run);
  expect(await notarizeMacApp(app, submission, profile, run)).toBe(submissionId);
  const codesign = ["/usr/bin/codesign", "--force", "--sign", fingerprint, "--timestamp"];
  const verify = ["/usr/bin/codesign", "--verify", "--deep", "--strict", app];
  expect(commands).toEqual([
    [...codesign, join(executables, "vec0.dylib")],
    [...codesign, join(executables, "libsqlite3.dylib")],
    [...codesign, "--options", "runtime", "--entitlements", entitlements, join(executables, "okb")],
    [...codesign, "--options", "runtime", app],
    verify,
    ["/usr/bin/ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", app, submission],
    ["/usr/bin/xcrun", "notarytool", "submit", submission, "--keychain-profile", profile, "--wait", "--output-format", "json"],
    ["/usr/bin/xcrun", "stapler", "staple", app],
    ["/usr/bin/xcrun", "stapler", "validate", app],
    verify,
  ]);
  const plist = await Bun.file(new URL("../packaging/macos/okb.entitlements.plist", import.meta.url)).text();
  expect([...plist.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1])).toEqual([
    "com.apple.security.cs.allow-jit",
    "com.apple.security.cs.allow-unsigned-executable-memory",
  ]);
});

test("an invalid or incomplete Apple response never reaches stapling", async () => {
  for (const response of [
    { ...ok, stdout: JSON.stringify({ id: submissionId, status: "Invalid" }) },
    { ...ok, stdout: JSON.stringify({ status: "Accepted" }) },
    { ...ok, exitCode: 1, stdout: JSON.stringify({ id: submissionId, status: "Accepted" }) },
  ]) {
    const commands: string[][] = [];
    await expect(notarizeMacApp(app, submission, profile, async (argv) => {
      commands.push(argv);
      return argv[1] === "notarytool" ? response : ok;
    })).rejects.toThrow("did not return an accepted submission");
    expect(commands).toHaveLength(2);
  }
});
