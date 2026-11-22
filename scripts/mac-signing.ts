import { join } from "node:path";

interface MacSigning {
  identity: string;
  profile: string;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

type RunCommand = (argv: string[]) => Promise<CommandResult>;

export function macSigningOptions(args: string[], env: NodeJS.ProcessEnv): MacSigning | null {
  if (!args.includes("--sign")) return null;
  const identity = env.OKB_MAC_SIGN_IDENTITY?.trim();
  const profile = env.OKB_MAC_NOTARY_PROFILE?.trim();
  if (!identity || !profile || /[\0\r\n]/.test(identity + profile))
    throw new Error("Signing requires OKB_MAC_SIGN_IDENTITY and OKB_MAC_NOTARY_PROFILE from Keychain.");
  return { identity, profile };
}

async function runMacCommand(argv: string[]): Promise<CommandResult> {
  const process = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function checked(run: RunCommand, argv: string[], action: string): Promise<string> {
  const result = await run(argv);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim().slice(0, 1000);
    throw new Error(`${action} failed (exit ${result.exitCode}).${detail ? " " + detail : ""}`);
  }
  return result.stdout;
}

export async function findDeveloperIdApplication(identity: string, run: RunCommand = runMacCommand): Promise<string> {
  const output = await checked(run, ["/usr/bin/security", "find-identity", "-v", "-p", "codesigning"], "Keychain identity lookup");
  const matches = new Set<string>();
  for (const line of output.split("\n")) {
    const pair = /^\s*\d+\)\s+([\dA-Fa-f]{40})\s+"(Developer ID Application: .+)"\s*$/.exec(line);
    if (!pair) continue;
    const hash = pair[1]!.toUpperCase();
    if (identity === pair[2] || identity.toUpperCase() === hash) matches.add(hash);
  }
  if (matches.size !== 1)
    throw new Error("Set OKB_MAC_SIGN_IDENTITY to the unique name or fingerprint of a valid Developer ID Application identity in Keychain.");
  return [...matches][0]!;
}

export async function signMacApp(
  app: string, executables: string, entitlements: string, identity: string, run: RunCommand = runMacCommand,
): Promise<void> {
  const codesign = ["/usr/bin/codesign", "--force", "--sign", identity, "--timestamp"];
  for (const library of ["vec0.dylib", "libsqlite3.dylib"])
    await checked(run, [...codesign, join(executables, library)], `Signing ${library}`);
  await checked(run, [
    ...codesign, "--options", "runtime", "--entitlements", entitlements, join(executables, "okb"),
  ], "Signing the bundled runtime");
  await checked(run, [...codesign, "--options", "runtime", app], "Signing the macOS app");
  await verifyMacApp(app, run);
}

async function verifyMacApp(app: string, run: RunCommand): Promise<void> {
  await checked(run, ["/usr/bin/codesign", "--verify", "--deep", "--strict", app], "Verifying the macOS signature");
}

export async function notarizeMacApp(
  app: string, archive: string, profile: string, run: RunCommand = runMacCommand,
): Promise<string> {
  await checked(run, ["/usr/bin/ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", app, archive], "Preparing the notarization archive");
  const { stdout, stderr, exitCode } = await run([
    "/usr/bin/xcrun", "notarytool", "submit", archive, "--keychain-profile", profile, "--wait", "--output-format", "json",
  ]);
  let report: { status?: unknown; id?: unknown } | null = null;
  try { report = JSON.parse(stdout); } catch { /* notarytool can fail before returning a report. */ }
  const id = typeof report?.id === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(report.id) ? report.id : null;
  if (exitCode !== 0 || report?.status !== "Accepted" || !id) {
    const detail = stderr.trim().slice(0, 1000);
    const log = id ? ` View Apple's report with xcrun notarytool log ${id} --keychain-profile <profile>.` : "";
    throw new Error(`Apple notarization did not return an accepted submission.${detail ? " " + detail : ""}${log}`);
  }
  await checked(run, ["/usr/bin/xcrun", "stapler", "staple", app], "Stapling the notarization ticket");
  await checked(run, ["/usr/bin/xcrun", "stapler", "validate", app], "Validating the notarization ticket");
  await verifyMacApp(app, run);
  return id;
}
