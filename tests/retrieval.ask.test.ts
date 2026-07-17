// 2.3: okb ask — context packing under the profile budget, citation
// verification (a model-invented id never becomes a source), multi-query
// expansion (max), and search + ask end-to-end through the CLI against a stub
// embed/chat server (no network in CI).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage } from "../src/core/ai/gateway.ts";
import type { Engine } from "../src/core/engine/interface.ts";
import { openSqliteEngine } from "../src/core/engine/sqlite.ts";
import {
  askBrain,
  extractCitations,
  packContext,
  type AskDeps,
} from "../src/core/retrieval/ask.ts";
import type { HybridHit } from "../src/core/retrieval/hybrid.ts";
import { PROFILES } from "../src/core/retrieval/profiles.ts";
import { okb } from "./helpers.ts";

let root: string;
let eng: Engine;

const hit = (id: string, title: string, snippet?: string): HybridHit => ({
  id,
  title,
  description: `${title} described`,
  score: 1,
  sources: ["keyword"],
  ...(snippet === undefined ? {} : { snippet }),
});

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

function chatStub(fn: (messages: ChatMessage[]) => string) {
  const calls: ChatMessage[][] = [];
  const chat: AskDeps["chat"] = async (messages) => {
    calls.push(messages);
    return { text: fn(messages), provider: "fake", model: "chat-1" };
  };
  return { calls, chat };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "okb-ask-"));
  await writeFile(join(root, "index.md"), "# bundle\n");
  await mkdir(join(root, "notes"), { recursive: true });
  await writeFile(
    join(root, "notes", "alpha.md"),
    "---\ntype: note\ntitle: Alpha\ndescription: about databases\n---\nAlpha body about relational databases.\n",
  );
  await writeFile(
    join(root, "notes", "beta.md"),
    "---\ntype: note\ntitle: Beta\ndescription: about gardens\n---\nBeta body about gardens.\n",
  );
  eng = openSqliteEngine(":memory:");
  put("notes/alpha", "Alpha", "Alpha body about relational databases.");
  put("notes/beta", "Beta", "Beta body about gardens.");
});

afterAll(async () => {
  eng.close();
  await rm(root, { recursive: true, force: true });
});

describe("packContext", () => {
  test("snippet wins over the file body; a missing snippet reads the bundle", async () => {
    const { blocks } = await packContext(
      root,
      [hit("notes/alpha", "Alpha", "SNIPPET TEXT"), hit("notes/beta", "Beta")],
      10_000,
    );
    expect(blocks[0]).toBe("[notes/alpha] Alpha\nSNIPPET TEXT");
    expect(blocks[1]).toContain("Beta body about gardens.");
  });

  test("budget cuts the tail but the first block always packs", async () => {
    const { packed } = await packContext(
      root,
      [hit("notes/alpha", "Alpha"), hit("notes/beta", "Beta")],
      10,
    );
    expect(packed.map((h) => h.id)).toEqual(["notes/alpha"]);
  });

  test("an id the bundle no longer has falls back to the description", async () => {
    const { blocks } = await packContext(root, [hit("notes/gone", "Gone")], 10_000);
    expect(blocks[0]).toBe("[notes/gone] Gone\nGone described");
  });
});

describe("extractCitations", () => {
  test("keeps known ids once, in order; drops invented ids and markdown links", () => {
    const packed = [hit("notes/alpha", "Alpha"), hit("notes/beta", "Beta")];
    const got = extractCitations(
      "Fact [notes/beta]. Junk [notes/void]. Again [notes/beta], then [notes/alpha]. See [link](https://x).",
      packed,
    );
    expect(got).toEqual([
      { id: "notes/beta", title: "Beta" },
      { id: "notes/alpha", title: "Alpha" },
    ]);
  });
});

describe("askBrain", () => {
  test("an empty retrieval pool never reaches the model", async () => {
    const { calls, chat } = chatStub(() => "unused");
    const r = await askBrain(
      "zzz-unfindable",
      { bundle: root, arms: { engine: eng }, chat },
      PROFILES.balanced!,
    );
    expect(r.answer).toContain("No relevant concepts");
    expect(r.citations).toEqual([]);
    expect(r.provider).toBeNull();
    expect(calls).toEqual([]);
  });

  test("citations are verified against the packed context", async () => {
    const { chat } = chatStub(
      () => "Databases matter [notes/alpha]; trust me [notes/made-up].",
    );
    const r = await askBrain(
      "databases",
      { bundle: root, arms: { engine: eng }, chat },
      PROFILES.balanced!,
    );
    expect(r.citations).toEqual([{ id: "notes/alpha", title: "Alpha" }]);
    expect(r.context.some((c) => c.id === "notes/alpha")).toBe(true);
    expect(r.provider).toBe("fake");
    expect(r.model).toBe("chat-1");
  });

  test("max profile expands the query via chat and widens recall", async () => {
    const { calls, chat } = chatStub((messages) =>
      messages[0]!.content.startsWith("Give 2 alternative")
        ? "1. gardens\n2. horticulture"
        : "Both matter [notes/alpha] [notes/beta].",
    );
    const r = await askBrain(
      "databases",
      { bundle: root, arms: { engine: eng }, chat },
      PROFILES.max!,
    );
    expect(calls).toHaveLength(2);
    // notes/beta only matches the chat-generated "gardens" phrasing
    expect(r.context.map((c) => c.id).sort()).toEqual(["notes/alpha", "notes/beta"]);
    expect(r.citations).toHaveLength(2);
  });
});

describe("okb search + ask end-to-end (stub embed/chat server)", () => {
  let bundle: string;
  let server: ReturnType<typeof Bun.serve>;

  // FNV-1a per text: deterministic, distinct directions (as in the embed tests).
  const vecOf = (text: string): number[] => {
    let h = 2166136261;
    for (const ch of text) h = ((h ^ ch.codePointAt(0)!) * 16777619) >>> 0;
    return Array.from({ length: 4 }, (_, i) => 1 + ((h >>> ((i % 8) * 4)) & 15));
  };

  beforeAll(async () => {
    bundle = await mkdtemp(join(tmpdir(), "okb-ask-cli-"));
    await writeFile(join(bundle, "index.md"), "# bundle\n");
    await mkdir(join(bundle, "notes"), { recursive: true });
    await writeFile(
      join(bundle, "notes", "alpha.md"),
      "---\ntype: note\ntitle: Alpha\ndescription: about databases\n---\nAlpha body about relational databases.\n",
    );
    await writeFile(
      join(bundle, "notes", "beta.md"),
      "---\ntype: note\ntitle: Beta\ndescription: about gardens\n---\nBeta body about gardens.\n",
    );

    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        if (path.endsWith("/embeddings")) {
          const { input } = (await req.json()) as { input: string[] };
          return Response.json({ data: input.map((t) => ({ embedding: vecOf(t) })) });
        }
        if (path.endsWith("/chat/completions"))
          return Response.json({
            choices: [
              {
                message: {
                  content: "Databases live in tables [notes/alpha]. Invented [notes/void].",
                },
              },
            ],
          });
        return new Response("not found", { status: 404 });
      },
    });
    const base = `http://127.0.0.1:${server.port}`;
    process.env.OKB_EMBED_PROVIDER = "ollama";
    process.env.OKB_EMBED_BASE_URL = base;
    process.env.OKB_CHAT_PROVIDER = "ollama";
    process.env.OKB_CHAT_BASE_URL = base;

    expect((await okb(["--bundle", bundle, "index"])).code).toBe(0);
    expect((await okb(["--bundle", bundle, "embed"])).code).toBe(0);
  });

  afterAll(async () => {
    for (const k of ["OKB_EMBED_PROVIDER", "OKB_EMBED_BASE_URL", "OKB_CHAT_PROVIDER", "OKB_CHAT_BASE_URL"])
      delete process.env[k];
    server.stop();
    await rm(bundle, { recursive: true, force: true });
  });

  test("okb search fuses keyword and vector arms and shows sources", async () => {
    const r = await okb(["--bundle", bundle, "search", "databases"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("notes/alpha — Alpha");
    expect(r.stdout).toContain("[keyword+vector]");

    const machine = await okb(["--bundle", bundle, "search", "databases", "--json"]);
    const hits = JSON.parse(machine.stdout) as HybridHit[];
    const alpha = hits.find((h) => h.id === "notes/alpha")!;
    expect(alpha.sources).toContain("keyword");
    expect(alpha.sources).toContain("vector");
    expect(alpha.snippet).toContain("relational databases");
  });

  test("an unreachable embed provider degrades search to keyword-only, exit 0", async () => {
    process.env.OKB_EMBED_BASE_URL = "http://127.0.0.1:9"; // discard port; nothing listens
    try {
      const r = await okb(["--bundle", bundle, "search", "databases"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("notes/alpha — Alpha");
      expect(r.stdout).not.toContain("vector]");
    } finally {
      process.env.OKB_EMBED_BASE_URL = `http://127.0.0.1:${server.port}`;
    }
  });

  test("okb ask answers with verified citations only", async () => {
    const r = await okb(["--bundle", bundle, "ask", "what about databases?"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Databases live in tables");
    // the answer text is verbatim, but the invented id never becomes a source
    const sources = r.stdout.split("sources:")[1]!;
    expect(sources).toContain("notes/alpha — Alpha");
    expect(sources).not.toContain("notes/void");

    const machine = await okb(["--bundle", bundle, "ask", "what about databases?", "--json"]);
    const a = JSON.parse(machine.stdout) as {
      citations: { id: string }[];
      context: { id: string }[];
      profile: string;
    };
    expect(a.citations).toEqual([{ id: "notes/alpha", title: "Alpha" }] as never);
    expect(a.context.length).toBeGreaterThan(0);
    expect(a.profile).toBe("balanced");
  });

  test("an unknown profile is a usage error (exit 2)", async () => {
    const r = await okb(["--bundle", bundle, "search", "x", "--profile", "turbo"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown retrieval profile");
  });
});
