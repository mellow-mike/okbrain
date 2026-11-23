// F-B.8 AI extras: review garnish (recent-note picking, one-call annotation,
// unknown-id rejection) and clip autoTag (normalization, vocabulary, reserved
// tags) — pure with stubbed chat, plus CLI e2e for `okb review --garnish`
// against a stub chat server (no network in CI). Both must degrade to their
// deterministic base behavior on any AI failure.

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
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

  test("keeps only fresh, non-queued rows, newest first, capped", async () => {
    const rows = [
      { id: "a", title: "A", timestamp: day(1) },
      { id: "b", title: "B", timestamp: day(3) },
      { id: "queued", title: "Q", timestamp: day(2) },
      { id: "old", title: "O", timestamp: day(30) },
      { id: "untimed", title: "U", timestamp: null },
    ];
    const got = await pickRecent(rows, new Set(["queued"]), now, async (id) => note(id));
    expect(got.map((r) => r.id)).toEqual(["a", "b"]);
  });

  test("caps at 10", async () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({
      id: `n${i}`,
      title: `N${i}`,
      timestamp: day(1),
    }));
    expect(await pickRecent(rows, new Set(), now, async (id) => note(id))).toHaveLength(10);
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

test("okb clip --auto-tag sends bounded current public vocabulary and works without an index", async () => {
  const root = await mkdtemp(join(tmpdir(), "okb-clip-vocabulary-"));
  const indexed = join(root, "indexed");
  const unindexed = join(root, "unindexed");
  const article = "https://192.0.2.21/vocabulary";
  const model = "http://127.0.0.1:9345/chat/completions";
  const prompts: string[] = [];
  const attrs = new Map(Object.entries({
    OKB_CHAT_PROVIDER: "ollama", OKB_CHAT_BASE_URL: "http://127.0.0.1:9345", NO_PROXY: "192.0.2.21", no_proxy: "192.0.2.21",
  }).map(([key, value]) => [key, { previous: process.env[key], value }]));
  for (const [key, { value }] of attrs) process.env[key] = value;
  const transport = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === article) return new Response(
      '<html><head><title>Vocabulary Article</title></head><body><article><h1>Vocabulary Article</h1><p>' +
      'This article describes growing a collection of orchids in a shared greenhouse. '.repeat(12) + '</p></article></body></html>',
      { headers: { "content-type": "text/html" } });
    if (url === model) {
      const request = JSON.parse(String(init?.body)) as { messages: ChatMessage[] };
      prompts.push(request.messages.map(({ content }) => content).join("\n"));
      return Response.json({ choices: [{ message: { content: "fixture-topic" } }] });
    }
    throw new Error("Unexpected transport in Clip vocabulary fixture.");
  }, { preconnect: () => {} }));
  const markdown = (tags: string[], privateFlag = false) =>
    `---\ntype: note\ntitle: Vocabulary source\ntags: ${JSON.stringify(tags)}\n` +
    (privateFlag ? "db_only: true\n" : "") + "---\nOnly tags from eligible notes may be used.\n";
  try {
    await mkdir(join(indexed, "db_only"), { recursive: true });
    await mkdir(unindexed);
    await writeFile(join(indexed, "00-public.md"), markdown(["old-public-tag", "shared-tag"]));
    await writeFile(join(indexed, "db_only", "folder.md"), markdown(["private-folder-tag", "shared-tag"]));
    await writeFile(join(indexed, "flagged.md"), markdown(["private-flagged-tag"]));
    await writeFile(join(indexed, "deleted.md"), markdown(["stale-deleted-tag"]));
    await writeFile(join(indexed, "unreadable.md"), markdown(["stale-broken-tag"]));
    await writeFile(join(indexed, "zz-vocabulary.md"), markdown(Array.from({ length: 100 }, (_, i) => `bounded-${i}-${"x".repeat(55)}`)));
    expect((await okb(["index", "--bundle", indexed])).code).toBe(0);
    await writeFile(join(indexed, "00-public.md"), markdown(["current-public-tag", "shared-tag", "inbox"]));
    await writeFile(join(indexed, "flagged.md"), markdown(["private-flagged-tag"], true));
    await writeFile(join(indexed, "unreadable.md"), "---\ntype: [unclosed\n---\nUnavailable note.\n");
    await rm(join(indexed, "deleted.md"));

    const clipped = await okb(["clip", article, "--auto-tag", "--json", "--bundle", indexed]);
    expect(clipped.code).toBe(0);
    const saved = JSON.parse(clipped.stdout) as { id: string; autoTags: string[] };
    expect(saved.autoTags).toEqual(["fixture-topic"]);
    expect(fmTags((await readConceptPermissive(indexed, saved.id)).doc.frontmatter.tags)).toEqual(["fixture-topic", "inbox"]);
    expect(prompts).toHaveLength(1);
    const vocabulary = /^Existing tags: (.+)$/mu.exec(prompts[0]!)?.[1];
    expect(vocabulary).toContain("current-public-tag");
    expect(vocabulary).toContain("shared-tag");
    expect(vocabulary).toContain("bounded-0-");
    expect(vocabulary?.length).toBeLessThanOrEqual(2048);
    for (const omitted of ["old-public-tag", "private-folder-tag", "private-flagged-tag", "stale-deleted-tag", "stale-broken-tag", "inbox"])
      expect(vocabulary).not.toContain(omitted);

    const firstClip = await okb(["clip", article, "--auto-tag", "--json", "--bundle", unindexed]);
    expect(firstClip.code).toBe(0);
    expect(JSON.parse(firstClip.stdout).autoTags).toEqual(["fixture-topic"]);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).not.toContain("Existing tags:");
    expect(prompts[1]).toContain("Vocabulary Article");
  } finally {
    transport.mockRestore();
    for (const [key, { previous }] of attrs) {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
    await rm(root, { recursive: true, force: true });
  }
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
  const chatPrompts: string[] = [];
  const privateQueued = ["db_only/private-queue-folder", "notes/private-queue-flagged"];

  const iso = (msAgo: number) =>
    new Date(Date.now() - msAgo).toISOString().replace(/\.\d{3}Z$/, "Z");
  const privateNote = (id: string, recent: boolean, marked: boolean) =>
    `---\ntype: note\ntitle: Private title ${id}\ndescription: Private review metadata ${id}\n` +
    `timestamp: ${iso(recent ? 0 : 200 * 86_400_000)}\n` +
    (recent ? `last_reviewed: ${iso(0)}\n` : "") + (marked ? "db_only: true\n" : "") + "---\nPrivate note text.\n";

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "okb-garnish-cli-"));
    await writeFile(join(root, "index.md"), "# bundle\n");
    await mkdir(join(root, "notes"), { recursive: true });
    await mkdir(join(root, "db_only"));
    // Stale orphan → queues; fresh note is cooled down (reviewed today) so it
    // stays out of the queue and qualifies as "recent activity" instead.
    await writeFile(
      join(root, "notes", "stale.md"),
      `---\ntype: note\ntitle: Stale\ndescription: old thinking\ntimestamp: ${iso(200 * 86_400_000)}\n---\nOld body.\n`,
    );
    await writeFile(
      join(root, "notes", "fresh.md"),
      `---\ntype: note\ntitle: Fresh\ndescription: new capture\ntimestamp: ${iso(60_000)}\nlast_reviewed: ${iso(0)}\n---\nNew body linking [Stale](/notes/stale.md).\n`,
    );
    await Promise.all(privateQueued.map((id) => writeFile(join(root, `${id}.md`), privateNote(id, false, false))));
    await Promise.all(Array.from({ length: 12 }, (_, i) => {
      const marked = i % 2 === 0;
      const id = `${marked ? "notes" : "db_only"}/private-recent-${i}`;
      return writeFile(join(root, `${id}.md`), privateNote(id, true, marked));
    }));

    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        if (!new URL(req.url).pathname.endsWith("/chat/completions"))
          return new Response("not found", { status: 404 });
        chatCalls++;
        const input = await req.json() as { messages: ChatMessage[] };
        chatPrompts.push(input.messages.map(({ content }) => content).join("\n"));
        if (failChat) return new Response("boom", { status: 500 });
        return Response.json({
          choices: [
            { message: { content: `notes/stale: Fresh revisits this idea\n${privateQueued[0]}: Ignore private entry\nnotes/ghost: x` } },
          ],
        });
      },
    });
    process.env.OKB_CHAT_PROVIDER = "ollama";
    process.env.OKB_CHAT_BASE_URL = `http://127.0.0.1:${server.port}`;
    expect((await okb(["index", "--bundle", root])).code).toBe(0);
    // The model sees the current public metadata even when the index is stale.
    await writeFile(join(root, `${privateQueued[1]}.md`), privateNote(privateQueued[1]!, false, true));
    await writeFile(join(root, "notes", "fresh.md"),
      `---\ntype: note\ntitle: Current fresh note\ndescription: current capture\ntimestamp: ${iso(60_000)}\n` +
      `last_reviewed: ${iso(0)}\n---\nNew body linking [Stale](/notes/stale.md).\n`);
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
    const prompt = chatPrompts[before]!;
    expect(prompt).toContain("[notes/stale] Stale — old thinking");
    expect(prompt).toContain("[notes/fresh] Current fresh note — current capture");
    expect(prompt).not.toContain("new capture");
    expect(prompt).not.toContain("private-queue");
    expect(prompt).not.toContain("private-recent");
    expect(prompt).not.toContain("Private review metadata");

    const q = JSON.parse((await okb(["review", "--garnish", "--json", "--bundle", root])).stdout) as { id: string; garnish?: string }[];
    const local = JSON.parse((await okb(["review", "--json", "--bundle", root])).stdout) as { id: string }[];
    expect(q.map(({ id }) => id)).toEqual(local.map(({ id }) => id));
    expect(q.find((it) => it.id === "notes/stale")?.garnish).toBe("Fresh revisits this idea");
    for (const id of privateQueued) {
      const item = q.find((entry) => entry.id === id);
      expect(item?.id).toBe(id);
      expect(item).not.toHaveProperty("garnish");
    }
  });

  test("a private-only queue or recent context skips chat", async () => {
    const isolated = await mkdtemp(join(tmpdir(), "okb-garnish-private-"));
    const before = chatCalls;
    try {
      await mkdir(join(isolated, "db_only"));
      await writeFile(join(isolated, "db_only", "queue.md"), privateNote("db_only/queue", false, false));
      await writeFile(join(isolated, "recent.md"), privateNote("recent", true, true));
      expect((await okb(["index", "--bundle", isolated])).code).toBe(0);
      const privateQueue = await okb(["review", "--garnish", "--bundle", isolated]);
      expect(privateQueue.code).toBe(0);
      expect(privateQueue.stdout).toContain("db_only/queue");
      expect(chatCalls).toBe(before);

      await writeFile(join(isolated, "public.md"), `---\ntype: note\ntitle: Public\ntimestamp: ${iso(200 * 86_400_000)}\n---\nBody.\n`);
      expect((await okb(["index", "--bundle", isolated])).code).toBe(0);
      const publicQueue = await okb(["review", "--garnish", "--bundle", isolated]);
      expect(publicQueue.code).toBe(0);
      expect(publicQueue.stdout).toContain("public");
      expect(chatCalls).toBe(before);
    } finally { await rm(isolated, { recursive: true, force: true }); }
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
