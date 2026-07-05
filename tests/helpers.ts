// Shared CLI test harness: capture stdout/stderr and run `okb` in-process.

import { runCli, type Io } from "../src/cli.ts";

export interface Capture extends Io {
  stdout: string;
  stderr: string;
}

export function capture(): Capture {
  const c = {
    stdout: "",
    stderr: "",
    out: (t: string) => void (c.stdout += t),
    err: (t: string) => void (c.stderr += t),
  };
  return c;
}

export async function okb(args: string[]): Promise<{ code: number } & Capture> {
  const io = capture();
  const code = await runCli(args, io);
  return Object.assign(io, { code });
}
