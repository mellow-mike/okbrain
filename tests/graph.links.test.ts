import { describe, expect, test } from "bun:test";
import { backlinks } from "../src/core/graph/backlinks.ts";
import {
  buildEdges,
  extractTargets,
  resolveLinkTarget,
} from "../src/core/graph/links.ts";

describe("resolveLinkTarget", () => {
  test("bundle-absolute link", () => {
    expect(resolveLinkTarget("notes/a", "/refs/x.md")).toBe("refs/x");
  });

  test("relative links resolve against the source dir", () => {
    expect(resolveLinkTarget("notes/a", "b.md")).toBe("notes/b");
    expect(resolveLinkTarget("notes/a", "./b.md")).toBe("notes/b");
    expect(resolveLinkTarget("notes/sub/a", "../b.md")).toBe("notes/b");
  });

  test("strips fragments, queries, titles, and angle brackets", () => {
    expect(resolveLinkTarget("a", "b.md#section")).toBe("b");
    expect(resolveLinkTarget("a", "b.md?v=1")).toBe("b");
    expect(resolveLinkTarget("a", 'b.md "a title"')).toBe("b");
    expect(resolveLinkTarget("a", "<b.md>")).toBe("b");
  });

  test("decodes percent-encoding", () => {
    expect(resolveLinkTarget("a", "my%20note.md")).toBe("my note");
  });

  test("drops external, anchor, non-md, and escaping links", () => {
    expect(resolveLinkTarget("a", "https://x.com/y.md")).toBeNull();
    expect(resolveLinkTarget("a", "mailto:x@y.com")).toBeNull();
    expect(resolveLinkTarget("a", "#heading")).toBeNull();
    expect(resolveLinkTarget("a", "image.png")).toBeNull();
    expect(resolveLinkTarget("notes/a", "../../escape.md")).toBeNull();
  });
});

describe("extractTargets", () => {
  test("collects and dedupes internal targets", () => {
    const body = "See [x](/a.md) and [y](b.md) and again [z](/a.md). Skip [w](http://x).";
    expect(extractTargets("notes/n", body)).toEqual(["a", "notes/b"]);
  });
});

describe("buildEdges", () => {
  test("drops broken links, self-links, and dupes", () => {
    const docs = [
      { id: "a", body: "[->b](/b.md) [->b again](/b.md) [self](/a.md) [missing](/q.md)" },
      { id: "b", body: "[->a](/a.md)" },
    ];
    expect(buildEdges(docs)).toEqual([
      { src: "a", dst: "b" },
      { src: "b", dst: "a" },
    ]);
  });

  test("honors an explicit known set", () => {
    const docs = [{ id: "a", body: "[->b](/b.md)" }];
    expect(buildEdges(docs, new Set(["a"]))).toEqual([]);
  });

  // Regression (B1): ids may contain spaces, so the dedupe key must not be a
  // space-joined string — "a b"->"c" and "a"->"b c" must stay distinct edges.
  test("ids with spaces do not collide in dedupe", () => {
    const docs = [
      { id: "a b", body: "[x](</c.md>)" },
      { id: "a", body: "[x](<b c.md>)" },
    ];
    const known = new Set(["a b", "a", "c", "b c"]);
    expect(buildEdges(docs, known)).toEqual([
      { src: "a b", dst: "c" },
      { src: "a", dst: "b c" },
    ]);
  });
});

describe("backlinks", () => {
  test("reverses edges and sorts sources", () => {
    const map = backlinks([
      { src: "c", dst: "b" },
      { src: "a", dst: "b" },
      { src: "a", dst: "c" },
    ]);
    expect(map.get("b")).toEqual(["a", "c"]);
    expect(map.get("c")).toEqual(["a"]);
    expect(map.has("a")).toBe(false);
  });
});
