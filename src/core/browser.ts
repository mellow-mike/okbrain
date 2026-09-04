// Open a URL in the user's default browser (`okb serve --open`). One small
// per-OS opener table, spawned by argv (no shell strings); best-effort — a
// missing opener logs a hint and never fails the server.

import { spawn } from "node:child_process";
import { log } from "./log.ts";

const opener = (platform: NodeJS.Platform, url: string): [string, string[]] =>
  platform === "darwin"
    ? ["open", [url]]
    : platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];

export function openInBrowser(url: string, platform: NodeJS.Platform = process.platform): void {
  const [cmd, args] = opener(platform, url);
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", (e) => log.warn(`could not open a browser (${e.message}) — visit ${url}`));
    child.unref();
  } catch (e) {
    log.warn(`could not open a browser (${(e as Error).message}) — visit ${url}`);
  }
}
