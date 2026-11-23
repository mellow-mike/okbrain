interface WindowsSigning {
  thumbprint: string;
  timestampUrl: string;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

type RunCommand = (argv: string[]) => Promise<CommandResult>;

export function windowsSigningOptions(
  args: string[], platform: NodeJS.Platform, env: NodeJS.ProcessEnv,
): WindowsSigning | null {
  if (!args.includes("--sign")) return null;
  if (!args.includes("--local") || platform !== "win32")
    throw new Error("Windows publisher signing requires --local on a native Windows host.");
  const thumbprint = env.OKB_WINDOWS_SIGN_THUMBPRINT?.trim().replaceAll(" ", "").toUpperCase();
  if (!thumbprint || !/^[0-9A-F]{40}$/.test(thumbprint))
    throw new Error("Set OKB_WINDOWS_SIGN_THUMBPRINT to the 40-digit hexadecimal thumbprint of a code-signing certificate in your Windows Personal certificate store.");
  const rawUrl = env.OKB_WINDOWS_TIMESTAMP_URL?.trim();
  let timestamp: URL | undefined;
  try { if (rawUrl) timestamp = new URL(rawUrl); } catch { /* Report a configuration error below. */ }
  if (!timestamp || timestamp.protocol !== "https:" || timestamp.username || timestamp.password || timestamp.hash)
    throw new Error("Set OKB_WINDOWS_TIMESTAMP_URL to an HTTPS RFC 3161 timestamp endpoint without credentials or a fragment.");
  return { thumbprint, timestampUrl: timestamp.href };
}

async function runSignTool(argv: string[]): Promise<CommandResult> {
  const process = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function checked(run: RunCommand, argv: string[], action: string): Promise<void> {
  const result = await run(argv);
  if (result.exitCode !== 0) {
    const detail = (result.stderr.trim() || result.stdout.trim()).slice(0, 1000);
    throw new Error(`${action} failed (SignTool exit ${result.exitCode}).${detail ? " " + detail : ""}`);
  }
}

export async function signWindowsBinaries(
  tool: string, binaries: readonly [string, string], settings: WindowsSigning, run: RunCommand = runSignTool,
): Promise<void> {
  await checked(run, [
    tool, "sign", "/s", "My", "/sha1", settings.thumbprint, "/fd", "SHA256",
    "/tr", settings.timestampUrl, "/td", "SHA256", ...binaries,
  ], "Signing the Windows runtime and sqlite-vec extension");
  for (const binary of binaries)
    await checked(run, [tool, "verify", "/pa", "/all", "/tw", binary], `Verifying ${binary}`);
}
