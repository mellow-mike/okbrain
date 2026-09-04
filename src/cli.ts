#!/usr/bin/env bun
// Thin CLI adapter over the operations contract (CLAUDE.md invariant 2):
// commands, arg parsing, and help are generated from `operations`; nothing here
// reaches the bundle or engine except through an op. Local CLI calls are
// trusted. Exit codes: 0 ok · 1 op failure or unhealthy result (op-defined,
// e.g. `doctor` on a non-conformant bundle) · 2 usage error.

import { existsSync, statSync } from "node:fs";
import { ConfigError, resolveBrain, resolveBundlePath } from "./core/config.ts";
import { AiError } from "./core/ai/gateway.ts";
import { openLocalContext, type LocalContext } from "./core/context.ts";
import { EngineError } from "./core/engine/sqlite.ts";
import { SyncError } from "./core/sync.ts";
import { VERSION } from "./core/version.ts";
import {
  OpError,
  operations,
  runOp,
  type Operation,
  type ParamSpec,
} from "./core/operations.ts";

export interface Io {
  out(text: string): void;
  err(text: string): void;
  /** Read piped stdin for `stdinFallback` params; absent in tests. */
  stdin?(): Promise<string>;
}

const defaultIo: Io = {
  out: (t) => process.stdout.write(t),
  err: (t) => process.stderr.write(t),
  stdin: () => Bun.stdin.text(),
};

const paramUsage = (s: ParamSpec): string => {
  const inner = s.positional
    ? `<${s.name}>`
    : s.type === "boolean"
      ? `--${s.name}`
      : `--${s.name} <${s.type}>`;
  return s.required ? inner : `[${inner}]`;
};

const usageFor = (op: Operation): string =>
  [op.cliName, ...op.params.map(paramUsage)].join(" ");

function helpText(): string {
  const lines = [
    "okb — OKF-native personal knowledge manager",
    "",
    "usage: okb <command> [args] [--json] [--bundle <path>]",
    "",
    "commands:",
    ...operations.map((op) => `  ${usageFor(op).padEnd(44)} ${op.summary}`),
    "",
    "global options:",
    "  --json             machine-readable output",
    "  --bundle <path>    bundle root (default: $OKB_BUNDLE or cwd)",
    "  --brain <name>     use a configured brain mount (also $OKB_BRAIN)",
    "  --version          print okbrain's version",
    "",
    "`okb help <command>` shows a command's options.",
    `current bundle: ${currentBundleLabel()}`,
  ];
  return lines.join("\n");
}

function currentBundleLabel(): string {
  try {
    return resolveBundlePath();
  } catch (e) {
    if (e instanceof ConfigError) return `(unreadable config: ${e.message})`;
    throw e;
  }
}

function opHelp(op: Operation): string {
  const lines = [`usage: okb ${usageFor(op)}`, "", op.summary, ""];
  for (const s of op.params)
    lines.push(`  ${paramUsage(s).padEnd(28)} ${s.description}`);
  return lines.join("\n").trimEnd();
}

export async function runCli(argv: string[], io: Io = defaultIo): Promise<number> {
  let json = false;
  let help = false;
  let bundleArg: string | undefined;
  let brainArg: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") json = true;
    else if (a === "--help" || a === "-h") help = true;
    else if (a === "--version" || a === "-v") rest.unshift("version");
    else if (a === "--bundle") {
      bundleArg = argv[++i];
      if (bundleArg === undefined) {
        io.err("--bundle requires a path\n");
        return 2;
      }
    } else if (a === "--brain") {
      brainArg = argv[++i];
      if (brainArg === undefined) {
        io.err("--brain requires a name (see `okb brains`)\n");
        return 2;
      }
    } else rest.push(a);
  }
  if (brainArg !== undefined && bundleArg !== undefined) {
    io.err("--brain and --bundle are mutually exclusive\n");
    return 2;
  }

  let cmd = rest.shift();
  if (cmd === "help") {
    help = true;
    cmd = rest.shift();
  }
  if (cmd === undefined) {
    io.out(helpText() + "\n");
    return 0;
  }
  if (cmd === "version") {
    io.out((json ? JSON.stringify({ version: VERSION }) : `okb ${VERSION}`) + "\n");
    return 0;
  }
  // Two-word commands ("review done", "inbox read") win over a one-word op
  // reading the second word as a positional.
  let op = operations.find((o) => o.cliName === `${cmd} ${rest[0]}`);
  if (op) rest.shift();
  else op = operations.find((o) => o.cliName === cmd);
  if (!op) {
    io.err(`unknown command: ${cmd} (see \`okb help\`)\n`);
    return 2;
  }
  if (help) {
    io.out(opHelp(op) + "\n");
    return 0;
  }

  const raw: Record<string, unknown> = {};
  const positionals = op.params.filter((s) => s.positional);
  let pos = 0;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) {
      const spec = op.params.find((s) => `--${s.name}` === a);
      if (!spec) {
        io.err(`unknown option ${a} for ${cmd} (see \`okb help ${cmd}\`)\n`);
        return 2;
      }
      if (spec.type === "boolean") raw[spec.name] = true;
      else {
        const v = rest[++i];
        if (v === undefined) {
          io.err(`--${spec.name} requires a value\n`);
          return 2;
        }
        raw[spec.name] = v;
      }
    } else {
      const spec = positionals[pos++];
      if (!spec) {
        io.err(`unexpected argument: ${a}\n`);
        return 2;
      }
      raw[spec.name] = a;
    }
  }

  for (const spec of op.params)
    if (spec.stdinFallback && raw[spec.name] === undefined && io.stdin && !process.stdin.isTTY)
      raw[spec.name] = await io.stdin();

  let bundle: string;
  let readonly = false;
  try {
    const brainName = brainArg ?? (bundleArg === undefined ? process.env.OKB_BRAIN : undefined);
    if (brainName !== undefined) {
      const brain = resolveBrain(brainName);
      bundle = brain.path;
      readonly = brain.readonly;
    } else {
      bundle = resolveBundlePath(bundleArg);
    }
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    io.err(e.message + "\n");
    return 1;
  }
  if (!existsSync(bundle) || !statSync(bundle).isDirectory()) {
    io.err(`bundle directory not found: ${bundle}\n`);
    return 1;
  }

  let local: LocalContext | undefined;
  try {
    local = openLocalContext(bundle, true, readonly);
    const result = await runOp(op, local.ctx, raw);
    io.out((json ? JSON.stringify(result, null, 2) : op.render(result)) + "\n");
    return op.exitCode?.(result) ?? 0;
  } catch (e) {
    if (e instanceof OpError) {
      io.err(e.message + "\n");
      return e.code === "bad_params" ? 2 : 1;
    }
    if (
      e instanceof EngineError ||
      e instanceof SyncError ||
      e instanceof ConfigError ||
      e instanceof AiError
    ) {
      io.err(e.message + "\n");
      return 1;
    }
    throw e;
  } finally {
    local?.close();
  }
}

if (import.meta.main) process.exit(await runCli(process.argv.slice(2)));
