import { expect, test } from "bun:test";
import { signWindowsBinaries, windowsSigningOptions } from "../scripts/windows-signing.ts";

const thumbprint = "0123456789ABCDEF0123456789ABCDEF01234567";
const timestampUrl = "https://timestamp.example.invalid/rfc3161";
const env = { OKB_WINDOWS_SIGN_THUMBPRINT: thumbprint, OKB_WINDOWS_TIMESTAMP_URL: timestampUrl };
const settings = { thumbprint, timestampUrl };
const tool = "C:\\Windows Kits\\signtool.exe";
const binaries = ["C:\\build output\\okb.exe", "C:\\build output\\vec0.dll"] as const;
const ok = { exitCode: 0, stdout: "", stderr: "" };

test("Windows signing is explicit and requires a local build on Windows", () => {
  expect(windowsSigningOptions(["--local"], "win32", env)).toBeNull();
  expect(() => windowsSigningOptions(["--local", "--sign"], "linux", env)).toThrow("requires --local on a native Windows host");
  expect(() => windowsSigningOptions(["--sign"], "win32", env)).toThrow("requires --local on a native Windows host");
  expect(windowsSigningOptions(["--local", "--sign"], "win32", env)).toEqual(settings);
});

test("Windows signing validates the certificate thumbprint and explicit HTTPS endpoint", () => {
  const args = ["--local", "--sign"];
  expect(() => windowsSigningOptions(args, "win32", { ...env, OKB_WINDOWS_SIGN_THUMBPRINT: "ABCD" })).toThrow("40-digit hexadecimal");
  expect(windowsSigningOptions(args, "win32", {
    ...env, OKB_WINDOWS_SIGN_THUMBPRINT: "01 23 45 67 89 ab cd ef 01 23 45 67 89 ab cd ef 01 23 45 67",
  })).toEqual(settings);
  for (const value of [
    undefined, "not a URL", "http://timestamp.example.invalid", "https://user:key@timestamp.example.invalid",
    "https://timestamp.example.invalid#digest",
  ]) {
    expect(() => windowsSigningOptions(args, "win32", { ...env, OKB_WINDOWS_TIMESTAMP_URL: value })).toThrow("HTTPS RFC 3161");
  }
});

test("Windows packaging explicitly signs both PE files and verifies their timestamped Authenticode signatures", async () => {
  const commands: string[][] = [];
  await signWindowsBinaries(tool, binaries, settings, async (argv) => {
    commands.push(argv);
    return ok;
  });
  expect(commands).toEqual([
    [tool, "sign", "/s", "My", "/sha1", thumbprint, "/fd", "SHA256", "/tr", timestampUrl, "/td", "SHA256", ...binaries],
    [tool, "verify", "/pa", "/all", "/tw", binaries[0]],
    [tool, "verify", "/pa", "/all", "/tw", binaries[1]],
  ]);
});

test("Windows packaging rejects a SignTool warning for an unverified or untimestamped DLL", async () => {
  await expect(signWindowsBinaries(tool, binaries, settings, async (argv) =>
    argv[1] === "verify" && argv.at(-1) === binaries[1]
      ? { ...ok, exitCode: 2, stdout: "The signature is not timestamped." }
      : ok,
  )).rejects.toThrow("SignTool exit 2");
});
