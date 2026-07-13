// 2.2: the ~400-token chunker — deterministic packing, oversize splitting.

import { describe, expect, test } from "bun:test";
import { chunkText, MAX_CHUNK_CHARS } from "../src/core/retrieval/chunk.ts";

describe("chunkText", () => {
  test("empty and whitespace-only input produce no chunks", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("  \n\n \n ")).toEqual([]);
  });

  test("short text is one trimmed chunk", () => {
    expect(chunkText("  hello world \n")).toEqual([{ seq: 0, text: "hello world" }]);
  });

  test("CRLF is normalized before splitting", () => {
    expect(chunkText("a\r\n\r\nb", 3)).toEqual([
      { seq: 0, text: "a" },
      { seq: 1, text: "b" },
    ]);
  });

  test("paragraphs pack greedily up to the cap, joined by blank lines", () => {
    // cap 12: "aaaa\n\nbbbb" is 10 chars (fits), adding "\n\ncccc" would be 16
    expect(chunkText("aaaa\n\nbbbb\n\ncccc", 12)).toEqual([
      { seq: 0, text: "aaaa\n\nbbbb" },
      { seq: 1, text: "cccc" },
    ]);
  });

  test("an oversize paragraph splits at line boundaries", () => {
    expect(chunkText("one\ntwo\nthree", 8)).toEqual([
      { seq: 0, text: "one\ntwo" },
      { seq: 1, text: "three" },
    ]);
  });

  test("an oversize single line hard-splits at the cap", () => {
    expect(chunkText("abcdefghij", 4)).toEqual([
      { seq: 0, text: "abcd" },
      { seq: 1, text: "efgh" },
      { seq: 2, text: "ij" },
    ]);
  });

  test("no chunk ever exceeds the cap; seqs are consecutive", () => {
    const text = Array.from({ length: 50 }, (_, i) => `para ${i} ${"x".repeat(i * 17)}`).join("\n\n");
    const chunks = chunkText(text);
    chunks.forEach((c, i) => {
      expect(c.seq).toBe(i);
      expect(c.text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
      expect(c.text.length).toBeGreaterThan(0);
    });
    // nothing lost: every paragraph's start survives somewhere
    const joined = chunks.map((c) => c.text).join("\n\n");
    for (let i = 0; i < 50; i++) expect(joined).toContain(`para ${i}`);
  });
});
