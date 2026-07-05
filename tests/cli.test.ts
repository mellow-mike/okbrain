import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli } from "../src/cli.ts";
import { capture, okb as okbAt } from "./helpers.ts";

let root: string;

const okb = (...args: string[]) => okbAt([...args, "--bundle", root]);

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "okb-cli-"));
  await mkdir(join(root, "notes"), { recursive: true });
  await writeFile(
    join(root, "alpha.md"),
    "---\ntype: note\ntitle: Alpha\n---\nSee [beta](/notes/beta.md).\n",
  );
  await writeFile(
    join(root, "notes", "beta.md"),
    "---\ntype: note\ntitle: Beta\n---\nBody beta.\n",
  );
});

afterAll(() => rm(root, { recursive: true, force: true }));

describe("okb CLI", () => {
  test("no args prints generated help listing every command", async () => {
    const io = capture();
    expect(await runCli([], io)).toBe(0);
    expect(io.stdout).toContain("usage: okb <command>");
    for (const cmd of ["search", "read", "list", "graph", "doctor", "export-viz", "index", "rebuild"])
      expect(io.stdout).toContain(`\n  ${cmd} `);
  });

  test("help <command> shows the command's options", async () => {
    const r = await okb("help", "search");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("usage: okb search <query> [--limit <int>]");
    expect(r.stdout).toContain("maximum hits");
  });

  test("unknown command and unknown option are usage errors (exit 2)", async () => {
    expect((await okb("frobnicate")).code).toBe(2);
    expect((await okb("search", "x", "--frob")).code).toBe(2);
    expect((await okb("read")).code).toBe(2); // missing required positional
  });

  test("index builds the on-disk index and reports stats", async () => {
    const r = await okb("index");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("indexed 2, skipped 0, removed 0, edges 1\n");
  });

  test("search renders hits; --json emits machine-readable output", async () => {
    const human = await okb("search", "beta");
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("notes/beta — Beta");

    const machine = await okb("search", "beta", "--json", "--limit", "1");
    expect(machine.code).toBe(0);
    expect(JSON.parse(machine.stdout)).toMatchObject([{ id: "notes/beta", title: "Beta" }]);
  });

  test("read prints the raw concept; graph walks the persisted index", async () => {
    const read = await okb("read", "alpha");
    expect(read.code).toBe(0);
    expect(read.stdout).toContain("title: Alpha");

    const graph = await okb("graph", "alpha");
    expect(graph.code).toBe(0);
    expect(graph.stdout).toBe("1  notes/beta — Beta\n");
  });

  test("rebuild without --confirm-destructive fails with guidance (exit 1)", async () => {
    const r = await okb("rebuild");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--confirm-destructive");
    expect((await okb("rebuild", "--confirm-destructive")).code).toBe(0);
  });

  test("doctor exits 0 on a warnings-only bundle, 1 on conformance errors", async () => {
    const ok = await okb("doctor");
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain("[missing-index]");
    expect(ok.stdout).toContain("0 errors");

    const bad = await mkdtemp(join(tmpdir(), "okb-cli-doctor-"));
    try {
      await writeFile(join(bad, "x.md"), "---\ntitle: no type\n---\nbody\n");
      const io = capture();
      expect(await runCli(["doctor", "--bundle", bad], io)).toBe(1);
      expect(io.stdout).toContain("not conformant");
    } finally {
      await rm(bad, { recursive: true, force: true });
    }
  });

  test("nonexistent bundle is a clear failure (exit 1)", async () => {
    const io = capture();
    expect(await runCli(["list", "--bundle", join(root, "nope")], io)).toBe(1);
    expect(io.stderr).toContain("bundle directory not found");
  });
});
