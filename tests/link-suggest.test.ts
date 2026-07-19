// Link suggestion (4.4): deterministic ranking with reasons, exclusion of
// already-connected concepts, and the accept path writing a conformant
// normalized link under # Related (backlink appears via incremental reindex).

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine, NodeUpsert } from "../src/core/engine/interface.ts";
import { openSqliteEngine } from "../src/core/engine/sqlite.ts";
import { suggestLinks } from "../src/core/graph/link-suggest.ts";
import { runDoctor } from "../src/core/okf/doctor.ts";
import { okb } from "./helpers.ts";

const node = (id: string, title: string, opts: Partial<NodeUpsert> = {}): NodeUpsert => ({
  id,
  type: "note",
  title,
  description: "",
  resource: null,
  timestamp: null,
  lastReviewed: null,
  bodyLen: 0,
  contentHash: id,
  body: "",
  tags: [],
  ...opts,
});

function fixture(): Engine {
  const e = openSqliteEngine(":memory:");
  e.upsertNode(node("notes/graphs", "Graph Theory", { body: "graphs and edges", tags: ["math"] }));
  e.upsertNode(node("notes/logs", "Log", { body: "logging" }));
  e.upsertNode(node("notes/catalog", "Catalog", { body: "a catalog" }));
  e.upsertNode(node("notes/tagged", "Tagged Note", { tags: ["math", "todo"] }));
  e.upsertNode(node("notes/linked", "Linked Already", {}));
  e.upsertNode(node("notes/backlinker", "Backlinker", {}));
  e.upsertNode(node("notes/me", "My Note", { tags: ["math"] }));
  e.replaceEdges([
    { src: "notes/me", dst: "notes/linked", rel: null },
    { src: "notes/backlinker", dst: "notes/me", rel: null },
  ]);
  return e;
}

const me = {
  id: "notes/me",
  title: "My Note",
  description: "about graphs",
  body: "Studying Graph Theory in depth. See [linked](/notes/linked.md). A catalog entry.\n",
  tags: ["math"],
};

describe("suggestLinks", () => {
  test("title mention ranks first with its reason; word boundaries respected", () => {
    const e = fixture();
    const ss = suggestLinks(me, e);
    expect(ss[0]!.id).toBe("notes/graphs"); // mention + shared tag + similarity
    expect(ss[0]!.reasons).toContain('mentions "Graph Theory"');
    // "Log" must not match inside "catalog"; "Catalog" itself does match.
    const ids = ss.map((s) => s.id);
    expect(ids).not.toContain("notes/logs");
    expect(ids).toContain("notes/catalog");
    e.close();
  });

  test("already-connected concepts (both directions) and self are excluded", () => {
    const e = fixture();
    const ids = suggestLinks(me, e).map((s) => s.id);
    expect(ids).not.toContain("notes/me");
    expect(ids).not.toContain("notes/linked"); // out-link in body
    expect(ids).not.toContain("notes/backlinker"); // inbound edge
    e.close();
  });

  test("shared tags contribute with a reason; limit respected", () => {
    const e = fixture();
    const ss = suggestLinks(me, e, 10);
    const tagged = ss.find((s) => s.id === "notes/tagged");
    expect(tagged).toBeDefined();
    expect(tagged!.reasons).toContain("shares tags: math");
    expect(suggestLinks(me, e, 1).length).toBe(1);
    e.close();
  });
});

describe("okb links suggest / accept (CLI e2e)", () => {
  test("suggest ranks a mentioned concept; accept writes # Related and the backlink appears", async () => {
    const root = mkdtempSync(join(tmpdir(), "okb-links-"));
    try {
      const w = async (args: string[]) => {
        const r = await okb(args.concat("--bundle", root));
        expect(r.code).toBe(0);
        return r;
      };
      await w(["write", "notes/alpha", "--type", "note", "--title", "Alpha", "--description", "d", "--body", "Talks about Beta Process a lot."]);
      await w(["write", "notes/beta", "--type", "note", "--title", "Beta Process", "--description", "d"]);
      await w(["index"]);

      const sug = await w(["links", "suggest", "notes/alpha", "--json"]);
      const ss = JSON.parse(sug.stdout) as { id: string }[];
      expect(ss[0]!.id).toBe("notes/beta");

      const acc = await w(["links", "accept", "notes/alpha", "notes/beta"]);
      expect(acc.stdout).toContain("linked notes/alpha → notes/beta");
      const raw = await readFile(join(root, "notes", "alpha.md"), "utf8");
      expect(raw).toContain("# Related");
      expect(raw).toContain("[Beta Process](/notes/beta.md)");
      expect((await runDoctor(root)).errors).toBe(0);

      // Incremental reindex made the backlink visible without okb index.
      const g = await w(["graph", "notes/beta"]);
      expect(g.stdout).toContain("← notes/alpha");

      // Accepting again is a visible no-op.
      const again = await w(["links", "accept", "notes/alpha", "notes/beta"]);
      expect(again.stdout).toContain("already links");

      // Accepted target no longer suggested.
      const sug2 = await w(["links", "suggest", "notes/alpha", "--json"]);
      expect((JSON.parse(sug2.stdout) as { id: string }[]).map((s) => s.id)).not.toContain("notes/beta");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("accept with a missing target is not_found", async () => {
    const root = mkdtempSync(join(tmpdir(), "okb-links-"));
    try {
      await okb(["write", "notes/a", "--type", "note", "--title", "A", "--description", "d", "--bundle", root]);
      const r = await okb(["links", "accept", "notes/a", "notes/ghost", "--bundle", root]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("no such concept");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
