// 2.3: hybrid retrieval — RRF fusion math, per-arm sources, graph expansion,
// vector-arm degradation (never breaks recall), profile resolution, and the
// opt-in rerank arm.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Gateway } from "../src/core/ai/gateway.ts";
import type { Engine, VectorStore } from "../src/core/engine/interface.ts";
import { openSqliteEngine } from "../src/core/engine/sqlite.ts";
import { openVectorStore } from "../src/core/engine/vectors.ts";
import {
  hybridRetrieve,
  rrfFuse,
  type HybridArms,
  type HybridHit,
} from "../src/core/retrieval/hybrid.ts";
import { PROFILES, ProfileError, resolveProfile } from "../src/core/retrieval/profiles.ts";
import { rerankConfigured, rerankHits } from "../src/core/retrieval/rerank.ts";

let eng: Engine;
let store: VectorStore;

const put = (id: string, title: string, body: string) =>
  eng.upsertNode({
    id,
    type: "note",
    title,
    description: `${title} described`,
    resource: null,
    timestamp: null,
    lastReviewed: null,
    bodyLen: body.length,
    contentHash: id,
    body,
    tags: [],
  });

const arms = (): HybridArms => ({
  engine: eng,
  vectors: store,
  embed: async (texts) => texts.map(() => [1, 0, 0, 0]),
});

beforeAll(() => {
  eng = openSqliteEngine(":memory:");
  put("notes/dbs", "Databases", "relational databases store rows");
  put("notes/kw-only", "Keyword", "databases appear here too");
  put("notes/vec-only", "Vector", "storage engines and tables");
  put("notes/nb", "Neighbor", "unrelated gardening");
  eng.replaceEdges([{ src: "notes/dbs", dst: "notes/nb" }]);

  store = openVectorStore(":memory:");
  store.reset({ provider: "fake", model: "m", dim: 4 });
  store.replace("notes/dbs", "h1", [
    { seq: 0, text: "relational databases store rows", vector: [1, 0, 0, 0] },
  ]);
  store.replace("notes/vec-only", "h2", [
    { seq: 0, text: "storage engines and tables", vector: [0.9, 0.1, 0, 0] },
  ]);
  store.replace("notes/ghost", "h3", [{ seq: 0, text: "ghost", vector: [1, 0, 0, 0] }]);
});

afterAll(() => {
  eng.close();
  store.close();
});

describe("rrfFuse", () => {
  test("sums 1/(60+rank) per ranking; more arms outrank one", () => {
    const scores = rrfFuse([["a", "b", "c"], ["b"]]);
    expect(scores.get("b")).toBeCloseTo(1 / 62 + 1 / 61);
    expect(scores.get("a")).toBeCloseTo(1 / 61);
    expect(scores.get("c")).toBeCloseTo(1 / 63);
    expect(scores.get("b")!).toBeGreaterThan(scores.get("a")!);
  });
});

describe("hybridRetrieve", () => {
  test("both-arm hit ranks first; sources tag each arm; snippet from best chunk", async () => {
    const { hits, vectorSkipped } = await hybridRetrieve(
      ["databases"],
      arms(),
      PROFILES.balanced!,
      10,
    );
    expect(vectorSkipped).toBeNull();
    expect(hits[0]!.id).toBe("notes/dbs");
    expect([...hits[0]!.sources].sort()).toEqual(["keyword", "vector"]);
    expect(hits[0]!.snippet).toBe("relational databases store rows");
    const byId = new Map(hits.map((h) => [h.id, h]));
    expect(byId.get("notes/kw-only")!.sources).toEqual(["keyword"]);
    expect(byId.get("notes/vec-only")!.sources).toEqual(["vector"]);
  });

  test("graph expansion pulls a linked neighbor with a damped score; lean keeps it off", async () => {
    const balanced = await hybridRetrieve(["databases"], arms(), PROFILES.balanced!, 10);
    const nb = balanced.hits.find((h) => h.id === "notes/nb");
    expect(nb).toBeDefined();
    expect(nb!.sources).toEqual(["graph"]);
    expect(nb!.score).toBeLessThan(balanced.hits[0]!.score);

    const lean = await hybridRetrieve(["databases"], arms(), PROFILES.lean!, 10);
    expect(lean.hits.some((h) => h.id === "notes/nb")).toBe(false);
  });

  test("a stale vector row (node not in the index) never surfaces", async () => {
    const { hits } = await hybridRetrieve(["databases"], arms(), PROFILES.balanced!, 10);
    expect(hits.some((h) => h.id === "notes/ghost")).toBe(false);
  });

  test("vector-arm failure degrades to keyword-only with the reason, not an error", async () => {
    const broken: HybridArms = {
      engine: eng,
      vectors: store,
      embed: async () => {
        throw new Error("embed exploded");
      },
    };
    const { hits, vectorSkipped } = await hybridRetrieve(
      ["databases"],
      broken,
      PROFILES.balanced!,
      10,
    );
    expect(vectorSkipped).toBe("embed exploded");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => !h.sources.includes("vector"))).toBe(true);
  });

  test("without a store the skip note points at okb embed", async () => {
    const { vectorSkipped } = await hybridRetrieve(
      ["databases"],
      { engine: eng },
      PROFILES.balanced!,
      10,
    );
    expect(vectorSkipped).toContain("okb embed");
  });

  test("limit caps the merged pool", async () => {
    const { hits } = await hybridRetrieve(["databases"], arms(), PROFILES.balanced!, 1);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toBe("notes/dbs");
  });
});

describe("profiles", () => {
  test("explicit → config → balanced; unknown fails loudly", () => {
    expect(resolveProfile(undefined, {}).name).toBe("balanced");
    expect(resolveProfile(undefined, { retrieval: { profile: "lean" } }).name).toBe("lean");
    expect(resolveProfile("max", { retrieval: { profile: "lean" } }).name).toBe("max");
    expect(() => resolveProfile("turbo", {})).toThrow(ProfileError);
  });
});

describe("rerank arm", () => {
  const hit = (id: string, score: number): HybridHit => ({
    id,
    title: id,
    description: `${id} described`,
    score,
    sources: ["keyword"],
  });

  test("only an explicit provider configures rerank (a stray key must not)", () => {
    expect(rerankConfigured({}, {})).toBe(false);
    expect(rerankConfigured({}, { VOYAGE_API_KEY: "k" })).toBe(false);
    expect(rerankConfigured({ rerankProvider: "voyage" }, {})).toBe(true);
    expect(rerankConfigured({}, { OKB_RERANK_PROVIDER: "voyage" })).toBe(true);
  });

  test("reorders the head by relevance, keeps the tail, records rerankScore", async () => {
    const gw = {
      rerank: async (_q: string, docs: string[]) => ({
        ranked: docs.map((_, i) => ({ index: docs.length - 1 - i, score: 10 - i })),
        provider: "fake",
        model: "r",
      }),
    } as unknown as Gateway;
    const out = await rerankHits("q", [hit("a", 3), hit("b", 2), hit("c", 1)], gw, 2);
    expect(out.map((h) => h.id)).toEqual(["b", "a", "c"]);
    expect(out[0]!.rerankScore).toBe(10);
    expect(out[2]!.rerankScore).toBeUndefined();
  });

  test("fewer than two candidates skips the provider call", async () => {
    const gw = {
      rerank: async () => {
        throw new Error("must not be called");
      },
    } as unknown as Gateway;
    const one = [hit("a", 1)];
    expect(await rerankHits("q", one, gw)).toEqual(one);
  });
});
