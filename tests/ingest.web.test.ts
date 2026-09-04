// Web pass (4.2): guardrails enforced inside the tools (page cap, depth cap,
// host allowlist, path filters, --no-web, frontier-only fetches, references/
// confinement for new ids), the JSON-action loop against a scripted chat, and
// CLI wiring. No live network, no real model.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FetchGuardError } from "../src/core/ingest/fetch-guard.ts";
import {
  defaultLimits,
  parseAction,
  runEnrich,
  type EnrichDeps,
  type WebPassLimits,
} from "../src/core/ingest/web.ts";
import { runDoctor } from "../src/core/okf/doctor.ts";
import { parse } from "../src/core/okf/document.ts";
import { writeConcept } from "../src/core/okf/write.ts";
import { okb } from "./helpers.ts";

const SEED = "https://ex.org/seed";
const PAGE_B = "https://ex.org/b";
const PAGE_C = "https://ex.org/c";
const OTHER_HOST = "https://evil.example/x";

const html = (title: string, links: string[]): string =>
  `<html><head><title>${title}</title></head><body><article><h1>${title}</h1><p>${title} body text.</p>${links.map((l) => `<a href="${l}">${l}</a>`).join("")}</article></body></html>`;

const PAGES: Record<string, string> = {
  [SEED]: html("Seed", ["/b", OTHER_HOST]),
  [PAGE_B]: html("Page B", ["/c"]),
  [PAGE_C]: html("Page C", []),
};

function fakeFetcher() {
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(url);
    const body = PAGES[url];
    if (body === undefined) throw new FetchGuardError(`HTTP 404 from ${url}`);
    return { url, contentType: "text/html", body };
  };
  return { calls, fetch };
}

/** Scripted model: pops one reply per turn, records each observation it saw. */
function scripted(replies: string[]) {
  const observations: string[] = [];
  const chat = async (messages: { content: string }[]): Promise<string> => {
    observations.push(messages[messages.length - 1]!.content);
    const next = replies.shift();
    if (next === undefined) throw new Error("script exhausted");
    return next;
  };
  return { observations, chat };
}

const deps = (
  chat: EnrichDeps["chat"],
  fetch: EnrichDeps["fetcher"],
): EnrichDeps => ({ chat, fetcher: fetch, listConcepts: async () => [] });

const act = (o: Record<string, unknown>): string => JSON.stringify(o);

function tempBundle(): string {
  return mkdtempSync(join(tmpdir(), "okb-web-"));
}

describe("parseAction", () => {
  test("plain object, object embedded in prose, garbage", () => {
    expect(parseAction('{"action":"done"}')).toEqual({ action: "done" });
    expect(parseAction('Sure! Here you go:\n{"action":"fetch_url","url":"x"} hope that helps')).toEqual({
      action: "fetch_url",
      url: "x",
    });
    expect(parseAction('{"a":"b {nested} \\" quote"}')).toEqual({ a: 'b {nested} " quote' });
    expect(parseAction("no json here")).toBeNull();
    expect(parseAction('{"broken": ')).toBeNull();
  });
});

describe("runEnrich loop", () => {
  test("full pass: fetch seed + discovered link, mint a cited reference", async () => {
    const root = tempBundle();
    const f = fakeFetcher();
    const { observations, chat } = scripted([
      act({ action: "list_concepts" }),
      act({ action: "fetch_url", url: SEED }),
      act({ action: "fetch_url", url: PAGE_B }),
      act({
        action: "write_concept",
        id: "references/seed-topic",
        type: "reference",
        title: "Seed Topic",
        description: "What the seed pages say",
        body: "Summary of the pages.[^seed]\n\n[^seed]: Seed",
        sources: [{ id: "seed", resource: SEED, title: "Seed" }, PAGE_B],
      }),
      act({ action: "done", summary: "minted one reference" }),
    ]);
    try {
      const r = await runEnrich(root, "capture the seeds", [SEED], defaultLimits([SEED]), deps(chat, f.fetch));
      expect(r.fetched).toEqual([SEED, PAGE_B]);
      expect(r.written).toEqual([{ id: "references/seed-topic", created: true }]);
      expect(r.summary).toBe("minted one reference");
      expect(observations[2]).toContain('"links"'); // fetch result fed back
      const raw = await readFile(join(root, "references", "seed-topic.md"), "utf8");
      expect(raw).not.toContain("# Citations");
      expect(raw).toContain("generated:\n  by: okb-enrich/"); // agent actor (producer/model)
      expect(parse(raw).frontmatter.sources).toEqual([
        { id: "seed", resource: SEED, title: "Seed" },
        { id: "ex-org", resource: PAGE_B },
      ]);
      expect((await runDoctor(root)).errors).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("frontier rule: an invented URL is refused without a fetch", async () => {
    const root = tempBundle();
    const f = fakeFetcher();
    const { observations, chat } = scripted([
      act({ action: "fetch_url", url: "https://ex.org/invented" }),
      act({ action: "done", summary: "gave up" }),
    ]);
    try {
      const r = await runEnrich(root, "t", [SEED], defaultLimits([SEED]), deps(chat, f.fetch));
      expect(f.calls).toEqual([]); // refused before any packet
      expect(r.fetched).toEqual([]);
      expect(observations[1]).toContain("seed URLs or links");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("depth cap: links of links are beyond maxDepth 1", async () => {
    const root = tempBundle();
    const f = fakeFetcher();
    const { observations, chat } = scripted([
      act({ action: "fetch_url", url: SEED }),
      act({ action: "fetch_url", url: PAGE_B }),
      act({ action: "fetch_url", url: PAGE_C }), // discovered on B at depth 2
      act({ action: "done", summary: "" }),
    ]);
    try {
      const r = await runEnrich(root, "t", [SEED], defaultLimits([SEED]), deps(chat, f.fetch));
      expect(r.fetched).toEqual([SEED, PAGE_B]);
      expect(observations[3]).toContain("depth cap");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("page cap, host allowlist, deny paths, no-web — all enforced in-tool", async () => {
    const root = tempBundle();
    const f = fakeFetcher();
    const limits: WebPassLimits = {
      ...defaultLimits([SEED]),
      maxPages: 1,
      denyPaths: ["/private"],
    };
    const { observations, chat } = scripted([
      act({ action: "fetch_url", url: SEED }),
      act({ action: "fetch_url", url: OTHER_HOST }), // discovered but foreign host
      act({ action: "fetch_url", url: PAGE_B }), // page cap already hit
      act({ action: "done", summary: "" }),
    ]);
    try {
      await runEnrich(root, "t", [SEED], limits, deps(chat, f.fetch));
      expect(f.calls).toEqual([SEED]);
      expect(observations[2]).toContain("allowlist");
      expect(observations[3]).toContain("page cap");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    const root2 = tempBundle();
    const f2 = fakeFetcher();
    const s2 = scripted([act({ action: "fetch_url", url: SEED }), act({ action: "done", summary: "" })]);
    try {
      await runEnrich(root2, "t", [SEED], { ...defaultLimits([SEED]), noWeb: true }, deps(s2.chat, f2.fetch));
      expect(f2.calls).toEqual([]);
      expect(s2.observations[1]).toContain("--no-web");
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  });

  test("new ids are confined to references/; existing concepts may be enriched", async () => {
    const root = tempBundle();
    await writeConcept(root, {
      id: "notes/topic",
      type: "note",
      title: "Topic",
      description: "d",
      body: "old",
    });
    const { observations, chat } = scripted([
      act({ action: "write_concept", id: "notes/new-note", type: "note", title: "N", description: "d", body: "x" }),
      act({ action: "write_concept", id: "notes/topic", body: "old plus new insight" }),
      act({ action: "done", summary: "" }),
    ]);
    try {
      const r = await runEnrich(root, "t", [], defaultLimits([]), deps(chat, undefined));
      expect(existsSync(join(root, "notes", "new-note.md"))).toBe(false);
      expect(observations[1]).toContain("references/");
      expect(r.written).toEqual([{ id: "notes/topic", created: false }]);
      expect(await readFile(join(root, "notes", "topic.md"), "utf8")).toContain("new insight");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("link_suggest tool: wired dep answers, missing dep explains", async () => {
    const root = tempBundle();
    const s = scripted([
      act({ action: "link_suggest", id: "notes/x" }),
      act({ action: "done", summary: "" }),
    ]);
    try {
      await runEnrich(root, "t", [], defaultLimits([]), {
        ...deps(s.chat, undefined),
        suggestLinks: async (id) => [{ id: "notes/other", forId: id }],
      });
      expect(s.observations[1]).toContain("notes/other");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    const root2 = tempBundle();
    const s2 = scripted([
      act({ action: "link_suggest", id: "notes/x" }),
      act({ action: "done", summary: "" }),
    ]);
    try {
      await runEnrich(root2, "t", [], defaultLimits([]), deps(s2.chat, undefined));
      expect(s2.observations[1]).toContain("okb index");
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  });

  test("a bad write becomes an observation, not a crash", async () => {
    const root = tempBundle();
    const { observations, chat } = scripted([
      act({ action: "write_concept", id: "references/x", body: "no scaffold", sources: [SEED] }), // create needs type/title/description
      act({ action: "write_concept", id: "references/y", type: "reference", title: "Y", description: "d", body: "uncited" }),
      act({ action: "done", summary: "" }),
    ]);
    try {
      const r = await runEnrich(root, "t", [], defaultLimits([]), deps(chat, undefined));
      expect(r.written).toEqual([]);
      expect(observations[1]).toContain("required");
      expect(observations[2]).toContain("sources entry"); // a minted reference must cite something
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("enriching an existing concept merges sources and never shrinks them", async () => {
    const root = tempBundle();
    await writeConcept(root, {
      id: "notes/topic", type: "note", title: "Topic", description: "d", body: "old",
      sources: [{ id: "orig", resource: "https://orig.test/doc" }],
    });
    const { chat } = scripted([
      act({ action: "write_concept", id: "notes/topic", body: "old plus web", sources: ["https://orig.test/doc", SEED] }),
      act({ action: "done", summary: "" }),
    ]);
    try {
      await runEnrich(root, "t", [], defaultLimits([]), { ...deps(chat, undefined), actor: "okb-enrich/test-model" });
      const fm = parse(await readFile(join(root, "notes", "topic.md"), "utf8")).frontmatter;
      expect(fm.sources).toEqual([
        { id: "orig", resource: "https://orig.test/doc" },
        { id: "ex-org", resource: SEED },
      ]);
      expect(fm.generated).toMatchObject({ by: "okb-enrich/test-model" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("unparseable replies strike out; step cap ends a chatty run", async () => {
    const root = tempBundle();
    const s = scripted(["hello", "still prose", "more prose"]);
    try {
      const r = await runEnrich(root, "t", [], defaultLimits([]), deps(s.chat, undefined));
      expect(r.summary).toContain("aborted");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    const root2 = tempBundle();
    const many = Array.from({ length: 50 }, () => act({ action: "list_concepts" }));
    const s2 = scripted(many);
    try {
      const r2 = await runEnrich(root2, "t", [], { ...defaultLimits([]), maxSteps: 4 }, deps(s2.chat, undefined));
      expect(r2.steps).toBe(4);
      expect(r2.summary).toContain("step cap");
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  });
});

describe("okb enrich (CLI)", () => {
  test("no task, seeds, or concept → usage error", async () => {
    const root = tempBundle();
    try {
      const r = await okb(["enrich", "--bundle", root]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("--web-seed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("malformed seed URL → usage error", async () => {
    const root = tempBundle();
    try {
      const r = await okb(["enrich", "--web-seed", "not a url", "--bundle", root]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("http(s)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
