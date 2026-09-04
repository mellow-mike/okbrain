// F-B.8 AI extras: review garnish (recent-note picking, one-call annotation,
// unknown-id rejection) and clip autoTag (normalization, vocabulary, reserved
// tags) — pure with stubbed chat, plus CLI e2e for `okb review --garnish`
// against a stub chat server (no network in CI). Both must degrade to their
// deterministic base behavior on any AI failure.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage } from "../src/core/ai/gateway.ts";
import { openSqliteEngine } from "../src/core/engine/sqlite.ts";
import { suggestTags } from "../src/core/ingest/autotag.ts";
import { clipUrl } from "../src/core/ingest/clip.ts";
import type { FetchedPage } from "../src/core/ingest/fetch-guard.ts";
import { readConceptPermissive } from "../src/core/okf/bundle.ts";
import { fmTags } from "../src/core/okf/document.ts";
import { garnishQueue, pickRecent, type GarnishNote } from "../src/core/review/garnish.ts";
import { okb } from "./helpers.ts";

function chatStub(fn: (messages: ChatMessage[]) => string) {
  const calls: ChatMessage[][] = [];
  return {
    calls,
    chat: async (messages: ChatMessage[]) => {
      calls.push(messages);
      return { text: fn(messages), provider: "fake", model: "chat-1" };
    },
  };
}

const note = (id: string, title = id): GarnishNote => ({
  id,
  title,
  description: `${title} described`,
});

describe("pickRecent", () => {
  const now = new Date("2026-07-17T12:00:00Z"); // injected — pure tests may pin time
  const day = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();

  test("keeps only fresh, non-queued rows, newest first, capped", () => {
    const rows = [
      { id: "a", title: "A", timestamp: day(1) },
      { id: "b", title: "B", timestamp: day(3) },
      { id: "queued", title: "Q", timestamp: day(2) },
      { id: "old", title: "O", timestamp: day(30) },
      { id: "untimed", title: "U", timestamp: null },
    ];
    const got = pickRecent(rows, new Set(["queued"]), now);
    expect(got.map((r) => r.id)).toEqual(["a", "b"]);
  });

  test("caps at 10", () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({
      id: `n${i}`,
      title: `N${i}`,
      timestamp: day(1),
    }));
    expect(pickRecent(rows, new Set(), now)).toHaveLength(10);
  });
});

describe("garnishQueue", () => {
  test("no recent activity → no chat call", async () => {
    const { calls, chat } = chatStub(() => "unused");
    const got = await garnishQueue([note("notes/a")], [], chat);
    expect(got.size).toBe(0);
    expect(calls).toEqual([]);
  });

  test("keeps lines for known ids; drops invented ids, '-', and junk", async () => {
    const { calls, chat } = chatStub(
      () =>
        "notes/a: ties into the new capture\n" +
        "[notes/b]: -\n" +
        "notes/invented: sounds plausible\n" +
        "not a parseable line",
    );
    const got = await garnishQueue([note("notes/a"), note("notes/b")], [note("inbox/x")], chat);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]!.content).toContain("[inbox/x] inbox/x — inbox/x described");
    expect(calls[0]![0]!.content).toContain("[notes/a]");
    expect(got.get("notes/a")).toBe("ties into the new capture");
    expect(got.has("notes/b")).toBe(false);
    expect(got.size).toBe(1);
  });
});

describe("suggestTags", () => {
  test("normalizes to kebab-case, dedupes, drops reserved tags, caps at 5", async () => {
    const { calls, chat } = chatStub(
      () => "Machine Learning, AI\nmachine-learning, inbox, C++ stuff, one, two, three",
    );
    const got = await suggestTags(
      { title: "T", description: "D", markdown: "body" },
      ["ai", "gardening"],
      chat,
    );
    expect(got).toEqual(["machine-learning", "ai", "c-stuff", "one", "two"]);
    expect(calls[0]![0]!.content).toContain("Existing tags: ai, gardening");
  });

  test("empty vocabulary omits the existing-tags line", async () => {
    const { calls, chat } = chatStub(() => "solo");
    await suggestTags({ title: "T", description: "D", markdown: "b" }, [], chat);
    expect(calls[0]![0]!.content).not.toContain("Existing tags");
  });
});

describe("clipUrl autoTag hook", () => {
  let root: string;
  const PAGE = "https://example.com/tagged";
  const HTML =
    "<html><head><title>Tagged Article</title></head><body><article><h1>Tagged Article</h1>" +
    `<p>${"Long enough for readability to keep the article body around. ".repeat(10)}</p>` +
    "</article></body></html>";
  const fake =
    (url: string) =>
    async (): Promise<FetchedPage> => ({ url, body: HTML, contentType: "text/html" });

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "okb-autotag-"));
    await writeFile(join(root, "index.md"), "# bundle\n");
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  test("suggested tags merge into the written concept and the result", async () => {
    const r = await clipUrl(
      root,
      { url: PAGE, tags: ["mine"] },
      { fetcher: fake(PAGE), suggestTags: async () => ["auto-topic", "mine"] },
    );
    expect(r.autoTags).toEqual(["auto-topic", "mine"]);
    const { doc } = await readConceptPermissive(root, r.id);
    expect(fmTags(doc.frontmatter.tags)).toEqual(["mine", "auto-topic", "inbox"]);
  });

  test("a deduped re-clip never calls the hook", async () => {
    let called = 0;
    const r = await clipUrl(
      root,
      { url: PAGE },
      {
        fetcher: fake(PAGE),
        suggestTags: async () => {
          called++;
          return ["x"];
        },
      },
    );
    expect(r.deduped).toBe(true);
    expect(called).toBe(0);
    expect(r.autoTags).toEqual([]);
  });
});

describe("engine listTags", () => {
  test("distinct tags, sorted", () => {
    const eng = openSqliteEngine(":memory:");
    const put = (id: string, tags: string[]) =>
      eng.upsertNode({
        id,
        type: "note",
        title: id,
        description: "",
        resource: null,
        timestamp: null,
        lastReviewed: null,
        status: "stable", staleAfter: null, trust: "unverified",
        bodyLen: 0,
        contentHash: id,
        body: "",
        tags,
      });
    put("a", ["zed", "alpha"]);
    put("b", ["alpha", "mid"]);
    expect(eng.listTags()).toEqual(["alpha", "mid", "zed"]);
    eng.close();
  });
});

describe("okb review --garnish (CLI, stub chat server)", () => {
  let root: string;
  let server: ReturnType<typeof Bun.serve>;
  let chatCalls = 0;
  let failChat = false;

  const iso = (msAgo: number) =>
    new Date(Date.now() - msAgo).toISOString().replace(/\.\d{3}Z$/, "Z");

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "okb-garnish-cli-"));
    await writeFile(join(root, "index.md"), "# bundle\n");
    await mkdir(join(root, "notes"), { recursive: true });
    // Stale orphan → queues; fresh note is cooled down (reviewed today) so it
    // stays out of the queue and qualifies as "recent activity" instead.
    await writeFile(
      join(root, "notes", "stale.md"),
      `---\ntype: note\ntitle: Stale\ndescription: old thinking\ntimestamp: ${iso(200 * 86_400_000)}\n---\nOld body.\n`,
    );
    await writeFile(
      join(root, "notes", "fresh.md"),
      `---\ntype: note\ntitle: Fresh\ndescription: new capture\ntimestamp: ${iso(0)}\nlast_reviewed: ${iso(0)}\n---\nNew body linking [Stale](/notes/stale.md).\n`,
    );

    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        if (!new URL(req.url).pathname.endsWith("/chat/completions"))
          return new Response("not found", { status: 404 });
        chatCalls++;
        if (failChat) return new Response("boom", { status: 500 });
        return Response.json({
          choices: [
            { message: { content: "notes/stale: Fresh revisits this idea\nnotes/ghost: x" } },
          ],
        });
      },
    });
    process.env.OKB_CHAT_PROVIDER = "ollama";
    process.env.OKB_CHAT_BASE_URL = `http://127.0.0.1:${server.port}`;
    expect((await okb(["index", "--bundle", root])).code).toBe(0);
  });

  afterAll(async () => {
    delete process.env.OKB_CHAT_PROVIDER;
    delete process.env.OKB_CHAT_BASE_URL;
    server.stop();
    await rm(root, { recursive: true, force: true });
  });

  test("plain okb review never calls chat", async () => {
    const before = chatCalls;
    const r = await okb(["review", "--bundle", root]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("notes/stale");
    expect(r.stdout).not.toContain("↳");
    expect(chatCalls).toBe(before);
  });

  test("--garnish annotates queue items from one chat call", async () => {
    const before = chatCalls;
    const r = await okb(["review", "--garnish", "--bundle", root]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("↳ Fresh revisits this idea");
    expect(chatCalls).toBe(before + 1);

    const q = JSON.parse((await okb(["review", "--garnish", "--json", "--bundle", root])).stdout);
    expect(q.find((it: { id: string }) => it.id === "notes/stale").garnish).toBe(
      "Fresh revisits this idea",
    );
  });

  test("lean profile switches the garnish off (no chat call)", async () => {
    const before = chatCalls;
    const r = await okb(["review", "--garnish", "--profile", "lean", "--bundle", root]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("notes/stale");
    expect(r.stdout).not.toContain("↳");
    expect(chatCalls).toBe(before);
  });

  test("a chat failure degrades to the plain queue, exit 0", async () => {
    failChat = true;
    try {
      const r = await okb(["review", "--garnish", "--bundle", root]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("notes/stale");
      expect(r.stdout).not.toContain("↳");
    } finally {
      failChat = false;
    }
  });
});
