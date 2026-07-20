// Stage 5: multi-brain mounts — config `brains` resolution (string + object
// forms, ~ expansion, absolute-path rule), the read-only access policy
// enforced in the ops layer, and the CLI `--brain` / $OKB_BRAIN flow.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ConfigError,
  listBrains,
  loadConfig,
  resolveBrain,
  saveConfig,
  type OkbConfig,
  type Platform,
} from "../src/core/config.ts";
import { getOp, OpError, runOp, type OpContext } from "../src/core/operations.ts";
import { okb } from "./helpers.ts";

let work: string; // writable mount
let ref: string; // readonly mount
let savedConfig: OkbConfig;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "okb-brain-work-"));
  ref = await mkdtemp(join(tmpdir(), "okb-brain-ref-"));
  await writeFile(
    join(work, "alpha.md"),
    "---\ntype: note\ntitle: Alpha\ndescription: a\n---\nBody.\n",
  );
  await writeFile(
    join(ref, "beta.md"),
    "---\ntype: note\ntitle: Beta\ndescription: b\n---\nBody.\n",
  );
  savedConfig = loadConfig();
});

afterAll(async () => {
  saveConfig(savedConfig);
  await rm(work, { recursive: true, force: true });
  await rm(ref, { recursive: true, force: true });
});

describe("config resolution (pure, injected platform)", () => {
  const platformWith = (brains: unknown): Platform => {
    const dir = join(tmpdir(), `okb-brains-cfg-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(dir, "okbrain"), { recursive: true });
    writeFileSync(join(dir, "okbrain", "config.json"), JSON.stringify({ brains }));
    return { os: "linux", env: { XDG_CONFIG_HOME: dir }, home: resolve("/home/u"), cwd: resolve("/") };
  };

  test("string and object forms, readonly flag", () => {
    const p = platformWith({ a: resolve("/brains/a"), b: { path: resolve("/brains/b"), readonly: true } });
    expect(listBrains(p)).toEqual([
      { name: "a", path: resolve("/brains/a"), readonly: false },
      { name: "b", path: resolve("/brains/b"), readonly: true },
    ]);
    expect(resolveBrain("b", p).readonly).toBe(true);
  });

  test("~ expands to home; other relative paths are refused", () => {
    const p = platformWith({ t: "~/brains/t" });
    expect(listBrains(p)[0]!.path).toBe(resolve("/home/u", "brains", "t"));
    expect(() => listBrains(platformWith({ r: "relative/x" }))).toThrow(ConfigError);
  });

  test("unknown brain names what exists; empty config says how to start", () => {
    const p = platformWith({ a: resolve("/brains/a") });
    expect(() => resolveBrain("nope", p)).toThrow(/unknown brain: nope \(configured: a\)/);
    expect(() => resolveBrain("x", platformWith({}))).toThrow(/no brains configured/);
  });
});

describe("read-only policy (ops layer, fail-closed)", () => {
  const ctx = (readonly: boolean): OpContext => ({
    bundle: work,
    trusted: true,
    readonly,
    engine: () => {
      throw new Error("not needed");
    },
    hasIndex: () => false,
    vectors: () => {
      throw new Error("not needed");
    },
    hasVectors: () => false,
    config: () => ({}),
  });

  test("write and admin ops are refused before the handler runs", async () => {
    for (const [name, params] of [
      ["write_concept", { id: "x", type: "note", title: "t", description: "d" }],
      ["index", {}],
    ] as const) {
      const e = await runOp(getOp(name)!, ctx(true), params).then(
        () => null,
        (err) => err,
      );
      expect(e).toBeInstanceOf(OpError);
      expect((e as OpError).code).toBe("refused");
      expect((e as OpError).message).toContain("read-only");
    }
  });

  test("read ops still run", async () => {
    expect(await runOp(getOp("list_concepts")!, ctx(true), {})).toEqual(["alpha"]);
  });
});

describe("CLI --brain flow", () => {
  test("no brains configured → okb brains explains how to add them", async () => {
    saveConfig({ ...loadConfig(), brains: undefined });
    const r = await okb(["brains"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("no brains configured");
  });

  test("brains lists mounts; --brain selects; readonly blocks writes", async () => {
    saveConfig({ ...loadConfig(), brains: { work, ref: { path: ref, readonly: true } } });

    const ls = await okb(["brains", "--bundle", work]);
    expect(ls.code).toBe(0);
    expect(ls.stdout).toContain("work");
    expect(ls.stdout).toContain("[readonly]");
    expect(ls.stdout.split("\n").find((l) => l.includes("work"))).toStartWith("*"); // active

    expect((await okb(["--brain", "work", "list"])).stdout).toBe("alpha\n");

    const w = await okb(["--brain", "ref", "write", "notes/x", "--type", "note", "--title", "T", "--description", "D"]);
    expect(w.code).toBe(1);
    expect(w.stderr).toContain("read-only");

    const unknown = await okb(["--brain", "nope", "list"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("unknown brain: nope");
  });

  test("$OKB_BRAIN works like --brain; --bundle overrides it", async () => {
    process.env.OKB_BRAIN = "ref";
    try {
      expect((await okb(["list"])).stdout).toBe("beta\n");
      expect((await okb(["list", "--bundle", work])).stdout).toBe("alpha\n");
    } finally {
      delete process.env.OKB_BRAIN;
    }
  });

  test("--brain with --bundle is a usage error", async () => {
    expect((await okb(["--brain", "work", "--bundle", work, "list"])).code).toBe(2);
  });
});
