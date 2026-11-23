import { expect, test } from "bun:test";
import {
  measurePinnedViteRetrieval, requirePinnedViteRetrievalScope, type PinnedViteRetrievalOptions,
} from "../src/core/coding/retrieval-benchmark.ts";

test("pinned retrieval requires every study root with segment-bounded scope checks", () => {
  expect(() => requirePinnedViteRetrievalScope("package", ["."])).not.toThrow();
  expect(() => requirePinnedViteRetrievalScope("package", ["packages", "docs", "playground/css-codesplit"])).not.toThrow();
  expect(() => requirePinnedViteRetrievalScope("subsystem", ["packages", "docs", "playground/css-codesplit/__tests__"])).not.toThrow();
  expect(() => requirePinnedViteRetrievalScope("package", ["packages", "docs", "playground/css-codesplit/__tests__"]))
    .toThrow("source scope");
  expect(() => requirePinnedViteRetrievalScope("package", ["packages", "docs/guid", "playground"]))
    .toThrow("source scope");
});

test("benchmark rejects invalid limits and out-of-scope or cancelled work before reading a checkout", async () => {
  const options: PinnedViteRetrievalOptions = {
    workspace: "\0", study: "package", repetitions: 1, tokenBudget: 4096, progress: () => { throw new Error("Unexpected preview"); },
  };
  await expect(measurePinnedViteRetrieval({ ...options, repetitions: 51 })).rejects.toMatchObject({ status: 400 });
  await expect(measurePinnedViteRetrieval({ ...options, tokenBudget: 0 })).rejects.toMatchObject({ status: 400 });
  await expect(measurePinnedViteRetrieval({ ...options, allowedScopes: ["packages/vite"] })).rejects.toMatchObject({ status: 403 });
  const stopped = new Error("Stopped by benchmark owner");
  await expect(measurePinnedViteRetrieval({ ...options, allowedScopes: ["."], signal: AbortSignal.abort(stopped) })).rejects.toBe(stopped);
});
