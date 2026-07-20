// 2.2: sqlite-vec vector store — cache key, atomic replace, cosine search,
// persistence across reopen, and the auto-recreate on a foreign schema.

import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VectorStore } from "../src/core/engine/interface.ts";
import {
  defaultVectorsPath,
  extensionPath,
  openVectorStore,
  vec0Filename,
  VecError,
} from "../src/core/engine/vectors.ts";

let dir: string;
let store: VectorStore;
const path = () => defaultVectorsPath(dir);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "okb-vec-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
afterEach(() => store?.close());

const META = { provider: "fake", model: "m1", dim: 4 };
const chunk = (seq: number, text: string, vector: number[]) => ({ seq, text, vector });

test("fresh store: no key, empty search, zero count", async () => {
  const d = await mkdtemp(join(tmpdir(), "okb-vec-fresh-"));
  store = openVectorStore(defaultVectorsPath(d));
  expect(store.meta()).toBeNull();
  expect(store.search([1, 0, 0, 0])).toEqual([]);
  expect(store.count()).toBe(0);
  expect(store.embeddedHashes().size).toBe(0);
  store.close(); // Windows locks open DB files; close before deleting (B6)
  await rm(d, { recursive: true, force: true });
});

test("storing chunks before any reset is refused", () => {
  store = openVectorStore(":memory:");
  expect(() => store.replace("a", "h", [chunk(0, "x", [1, 0, 0, 0])])).toThrow(VecError);
  // but an empty (nothing-to-embed) concept can be tracked
  store.replace("a", "h", []);
  expect(store.embeddedHashes().get("a")).toBe("h");
});

describe("with a pinned cache key", () => {
  test("replace + cosine search + count + persistence across reopen", () => {
    store = openVectorStore(path());
    store.reset(META);
    expect(store.meta()).toEqual(META);
    store.replace("notes/a", "ha", [
      chunk(0, "alpha", [1, 0, 0, 0]),
      chunk(1, "alpha two", [0.9, 0.1, 0, 0]),
    ]);
    store.replace("notes/b", "hb", [chunk(0, "beta", [0, 1, 0, 0])]);
    expect(store.count()).toBe(3);

    const hits = store.search([1, 0, 0, 0], 2);
    expect(hits.map((h) => [h.nodeId, h.seq, h.text])).toEqual([
      ["notes/a", 0, "alpha"],
      ["notes/a", 1, "alpha two"],
    ]);
    expect(hits[0]!.distance).toBeLessThan(hits[1]!.distance);
    // cosine: magnitude doesn't matter, direction does
    expect(store.search([5, 0, 0, 0], 1)[0]!.nodeId).toBe("notes/a");
    store.close();

    store = openVectorStore(path());
    expect(store.meta()).toEqual(META);
    expect(store.count()).toBe(3);
    expect(store.embeddedHashes()).toEqual(new Map([["notes/a", "ha"], ["notes/b", "hb"]]));
  });

  test("replace swaps a concept's chunks atomically", () => {
    store = openVectorStore(path());
    store.replace("notes/a", "ha2", [chunk(0, "rewritten", [0, 0, 1, 0])]);
    expect(store.count()).toBe(2);
    expect(store.search([0.9, 0.1, 0, 0], 3).filter((h) => h.nodeId === "notes/a")).toHaveLength(1);
    expect(store.embeddedHashes().get("notes/a")).toBe("ha2");
  });

  test("replace with no chunks keeps the concept tracked, drops its vectors", () => {
    store = openVectorStore(path());
    store.replace("notes/a", "ha3", []);
    expect(store.count()).toBe(1);
    expect(store.embeddedHashes().get("notes/a")).toBe("ha3");
  });

  test("remove drops chunks and tracking", () => {
    store = openVectorStore(path());
    store.remove("notes/b");
    expect(store.count()).toBe(0);
    expect(store.embeddedHashes().has("notes/b")).toBe(false);
  });

  test("reset with a new key wipes everything; clear() returns to never-embedded", () => {
    store = openVectorStore(path());
    store.reset({ provider: "other", model: "m2", dim: 2 });
    expect(store.meta()).toEqual({ provider: "other", model: "m2", dim: 2 });
    expect(store.count()).toBe(0);
    expect(store.embeddedHashes().size).toBe(0);
    store.replace("x", "hx", [chunk(0, "x", [1, 1])]);
    store.clear();
    expect(store.meta()).toBeNull();
    expect(store.count()).toBe(0);
  });

  test("reset validates the dimension", () => {
    store = openVectorStore(":memory:");
    expect(() => store.reset({ provider: "p", model: "m", dim: 0 })).toThrow(VecError);
    expect(() => store.reset({ provider: "p", model: "m", dim: 1.5 })).toThrow(VecError);
  });
});

test("a foreign schema version is discarded, not half-read", async () => {
  const d = await mkdtemp(join(tmpdir(), "okb-vec-schema-"));
  const p = defaultVectorsPath(d);
  store = openVectorStore(p);
  store.reset(META);
  store.replace("a", "h", [chunk(0, "x", [1, 0, 0, 0])]);
  store.close();

  const raw = new Database(p);
  raw.exec("PRAGMA user_version = 99");
  raw.close();

  store = openVectorStore(p);
  expect(store.meta()).toBeNull();
  expect(store.count()).toBe(0);
  store.close(); // Windows locks open DB files; close before deleting (B6)
  await rm(d, { recursive: true, force: true });
});

describe("extension lookup (Stage 5 packaging)", () => {
  test("vec0Filename matches the platform convention", () => {
    expect(vec0Filename("linux")).toBe("vec0.so");
    expect(vec0Filename("darwin")).toBe("vec0.dylib");
    expect(vec0Filename("win32")).toBe("vec0.dll");
  });

  test("a vec0 next to the executable wins over the npm package", async () => {
    const d = await mkdtemp(join(tmpdir(), "okb-vec-exec-"));
    const shipped = join(d, vec0Filename());
    await copyFile(extensionPath(d), shipped); // npm-path fallback seeds the copy
    expect(extensionPath(d)).toBe(shipped);
    await rm(d, { recursive: true, force: true });
  });

  test("no shipped copy → the npm package path; $OKB_SQLITE_VEC overrides all", async () => {
    const d = await mkdtemp(join(tmpdir(), "okb-vec-empty-"));
    expect(extensionPath(d)).toContain("sqlite-vec"); // node_modules dev path
    process.env.OKB_SQLITE_VEC = join(d, "custom-vec0.so");
    try {
      expect(extensionPath(d)).toBe(join(d, "custom-vec0.so"));
    } finally {
      delete process.env.OKB_SQLITE_VEC;
    }
    await rm(d, { recursive: true, force: true });
  });
});
