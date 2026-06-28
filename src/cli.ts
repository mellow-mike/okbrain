#!/usr/bin/env bun
// Entry point for the `okb` CLI. In Stage 0.5 this becomes a thin adapter
// generated from the operations contract (core/operations.ts). For now it is a
// minimal, honest stub so the `bin` reference resolves and the binary builds.

import { log } from "./core/log.ts";
import { resolveBundlePath } from "./core/config.ts";

const USAGE = `okb — OKF-native personal knowledge manager

usage: okb <command> [options]

Commands are generated from the operations contract in Stage 0.5
(search, read, list, graph, doctor, index, rebuild, export viz).

bundle: ${resolveBundlePath()}`;

function main(argv: string[]): number {
  const cmd = argv[0];
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(USAGE + "\n");
    return 0;
  }
  log.error(`unknown command: ${cmd} (no commands wired yet; see ROADMAP 0.5)`);
  return 2;
}

process.exit(main(process.argv.slice(2)));
