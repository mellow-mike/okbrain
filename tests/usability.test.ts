// Opt-in, local-only usability sessions (docs/USABILITY.md): nothing is stored
// until a session starts, the local app and the CLI record event kinds and
// timings while it runs, MCP never does, and no note content can reach the
// store. Driven through the real API server, CLI, and MCP server.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createApiServer, type ApiServer } from "../src/api.ts";
import { openLocalContext } from "../src/core/context.ts";
import { getOp, OpError, operations, runOp } from "../src/core/operations.ts";
import {
  summarizeUsability, USABILITY_OPERATIONS, USABILITY_SCHEMA, usabilityStorePath,
  type UsabilityEvent, type UsabilityExport, type UsabilityStatus,
} from "../src/core/usability.ts";
import { createMcpServer, mcpOps } from "../src/mcp/server.ts";
import { okb } from "./helpers.ts";

const TOKEN = "usability-session-token";
const day = 86_400_000;

/** A brain, a private application-data folder, and a local app serving the brain. */
async function sandbox(brainName = "brain") {
  const root = await mkdtemp(join(tmpdir(), "okb-usability-"));
  const overrides = { XDG_DATA_HOME: join(root, "data"), LOCALAPPDATA: join(root, "data"),
    XDG_CONFIG_HOME: join(root, "config"), APPDATA: join(root, "config") };
  const prior = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  const bundle = join(root, brainName);
  await mkdir(bundle);
  const servers: ApiServer[] = [];
  const serve = (path = bundle, readonly = false) => {
    const server = createApiServer({ bundle: path, token: TOKEN, port: 0, readonly });
    servers.push(server);
    return server;
  };
  const app = serve();
  const request = (server: ApiServer, name: string, params: object = {}, headers: Record<string, string> = {}) =>
    fetch(`${server.url}api/op/${name}`, { method: "POST", body: JSON.stringify(params),
      headers: { "x-okb-token": TOKEN, "content-type": "application/json", ...headers } });
  async function op<T = unknown>(name: string, params: object = {}, server = app): Promise<T> {
    const response = await request(server, name, params);
    const body = await response.json() as { result: T; error?: string };
    if (!response.ok) throw new Error(`${name} → ${response.status}: ${body.error}`);
    return body.result;
  }
  return {
    root, bundle, app, serve, request, op,
    store: usabilityStorePath(),
    exported: (server = app) => op<UsabilityExport>("usability_export", {}, server),
    cli: (...args: string[]) => okb(["--bundle", bundle, ...args]),
    async close() {
      await Promise.allSettled(servers.map((server) => server.stop()));
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

const shape = ({ kind, surface, via, rank, outcome, count, label }: UsabilityEvent) =>
  ({ kind, surface, ...(via ? { via } : {}), ...(rank ? { rank } : {}), ...(outcome ? { outcome } : {}),
    ...(count === undefined ? {} : { count }), ...(label ? { label } : {}) });

describe("usability sessions", () => {
  test("ordinary use never creates the store", async () => {
    const box = await sandbox();
    try {
      await box.op("capture", { text: "A first thought about tide pools" });
      await box.op("index");
      await box.op("search", { query: "tide", "keyword-only": true });
      const [id] = await box.op<string[]>("list_concepts");
      await box.op("read_concept", { id, via: "search", rank: 1 });
      await box.op("list_concepts", { detail: true });
      expect((await box.cli("capture", "A second thought")).code).toBe(0);
      expect((await box.cli("search", "thought", "--keyword-only")).code).toBe(0);

      // Looking for a session, from any surface, is not a reason to create one.
      expect(await box.op<UsabilityStatus>("usability_session")).toEqual(
        { recording: false, startedAt: null, events: 0, task: null, sessions: 0, retentionDays: 30 });
      expect((await box.cli("usability")).stdout).toBe("Not recording. 0 sessions stored for this brain (kept 30 days).\n");
      expect(await box.exported()).toMatchObject({ schema: USABILITY_SCHEMA, retentionDays: 30, sessions: [] });
      expect((await box.op<UsabilityStatus>("usability_session", { action: "stop" })).recording).toBe(false);
      expect((await box.op<UsabilityStatus>("usability_session", { action: "clear" })).sessions).toBe(0);
      const status = await (await fetch(`${box.app.url}api/status`, { headers: { "x-okb-token": TOKEN } })).json() as { usabilityRecording: boolean };
      expect(status.usabilityRecording).toBe(false);
      expect((await box.request(box.app, "usability_task", { action: "start", label: "T1" })).status).toBe(403);

      expect(existsSync(box.store)).toBe(false);
      expect(existsSync(dirname(box.store))).toBe(false);
    } finally { await box.close(); }
  });

  test("a session starts, stops, and clears, and a brain records one session at a time", async () => {
    const box = await sandbox();
    try {
      const started = await box.op<UsabilityStatus>("usability_session", { action: "start" });
      expect(started).toMatchObject({ recording: true, events: 0, task: null, sessions: 1 });
      expect(Date.parse(started.startedAt!)).toBeLessThanOrEqual(Date.now());
      if (process.platform !== "win32") {
        const { statSync } = await import("node:fs");
        expect(statSync(dirname(box.store)).mode & 0o777).toBe(0o700);
        expect(statSync(box.store).mode & 0o777).toBe(0o600);
      }

      const again = await box.request(box.app, "usability_session", { action: "start" });
      expect(again.status).toBe(403);
      expect((await again.json() as { error: string }).error).toContain("already recording");
      expect((await box.cli("usability", "start")).code).toBe(1);
      expect((await box.cli("usability")).stdout).toStartWith(`Recording since ${started.startedAt}: 0 events.`);

      // One task at a time, ended under its own label.
      expect(await box.op<UsabilityStatus>("usability_task", { action: "start", label: "T1" })).toMatchObject({ task: "T1", events: 1 });
      expect((await box.request(box.app, "usability_task", { action: "start", label: "T2" })).status).toBe(403);
      expect((await box.request(box.app, "usability_task", { action: "end", label: "T2", outcome: "found" })).status).toBe(403);
      expect((await box.request(box.app, "usability_task", { action: "end", label: "T1" })).status).toBe(400);
      expect((await box.request(box.app, "usability_task", { action: "start", label: "T1", outcome: "found" })).status).toBe(400);
      expect((await box.cli("usability", "task", "end", "T1", "--outcome", "not_found")).stdout).toContain("2 events.");
      expect((await box.request(box.app, "usability_task", { action: "end", label: "T1", outcome: "found" })).status).toBe(403);
      expect((await box.cli("usability", "task", "start", "T2")).code).toBe(0);

      // Stopping closes a task that was left open, so every task has a result.
      expect(await box.op<UsabilityStatus>("usability_session", { action: "stop" })).toEqual(
        { recording: false, startedAt: null, events: 0, task: null, sessions: 1, retentionDays: 30 });
      const [first] = (await box.exported()).sessions;
      expect(first!.endedAt).not.toBeNull();
      expect(first!.events.map(shape)).toEqual([
        { kind: "task_start", surface: "gui", label: "T1" },
        { kind: "task_end", surface: "cli", label: "T1", outcome: "not_found" },
        { kind: "task_start", surface: "cli", label: "T2" },
        { kind: "task_end", surface: "gui", label: "T2", outcome: "abandoned" },
      ]);
      expect(first!.summary.refind).toMatchObject({ tasks: 2, found: 0, notFound: 1, abandoned: 1, successRate: 0 });

      // A stopped session records nothing more, and the next one is separate.
      await box.op("capture", { text: "Written between sessions" });
      expect((await box.op<UsabilityStatus>("usability_session", { action: "start" })).sessions).toBe(2);
      await box.op("capture", { text: "Written while recording" });
      const both = (await box.exported()).sessions;
      expect(both.map((session) => session.events.length)).toEqual([4, 1]);
      expect(new Set(both.map((session) => session.id)).size).toBe(2);
      expect(both[1]!.endedAt).toBeNull();

      // Clear removes every session for the brain at once, a recording one included.
      expect(await box.op<UsabilityStatus>("usability_session", { action: "clear" })).toMatchObject({ recording: false, sessions: 0 });
      expect((await box.exported()).sessions).toEqual([]);
      await box.op("capture", { text: "Written after clearing" });
      expect((await box.exported()).sessions).toEqual([]);
    } finally { await box.close(); }
  });

  test("the local app and the CLI record what happened, and MCP callers never do", async () => {
    const box = await sandbox();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const agent = new Client({ name: "study-agent", version: "1.0.0" });
    try {
      await box.op("capture", { text: "Estuary notes before the study" });
      await box.op("index");
      await box.op("usability_session", { action: "start" });

      const saved = await box.op<{ id: string }>("capture", { text: "Heron sightings along the estuary" });
      await box.op("search", { query: "estuary", "keyword-only": true });
      await box.op("read_concept", { id: saved.id, via: "search", rank: 2 });
      expect((await box.cli("capture", "Kingfisher by the weir")).code).toBe(0);
      expect((await box.cli("search", "kingfisher", "--keyword-only")).code).toBe(0);
      expect((await box.cli("read", saved.id)).code).toBe(0);

      // A trusted agent can write and read, and still leaves no trace in the session.
      await createMcpServer({ bundle: box.bundle, trusted: true }).connect(serverTransport);
      await agent.connect(clientTransport);
      const tools = (await agent.listTools()).tools.map((tool) => tool.name);
      expect(tools).toContain("write_concept");
      expect(tools.filter((name) => name.startsWith("usability_"))).toEqual([]);
      for (const [name, args] of [
        ["write_concept", { id: "notes/from-agent", type: "note", title: "From an agent", description: "Agent note" }],
        ["search", { query: "estuary" }],
        ["read_concept", { id: saved.id, via: "search", rank: 1 }],
      ] as const)
        expect((await agent.callTool({ name, arguments: args })).isError).toBeFalsy();
      for (const name of ["usability_session", "usability_task", "usability_export"])
        expect(await agent.callTool({ name, arguments: {} })).toMatchObject({ isError: true });

      // The remaining kinds, plus the lookups and no-ops that are not events.
      await box.op("list_concepts");
      const rows = await box.op<unknown[]>("list_concepts", { detail: true });
      await box.op("review_done", { id: saved.id });
      await box.op("focused_map", { id: saved.id });
      expect((await box.request(box.app, "read_concept", { id: "notes/absent" })).status).toBe(404);
      expect((await box.request(box.app, "read_concept", { id: saved.id, via: "telepathy" })).status).toBe(400);
      expect((await box.request(box.app, "read_concept", { id: saved.id, rank: 0 })).status).toBe(400);
      await box.op("write_concept", { id: saved.id, status: "draft" });
      // Saving the same thing again changes nothing, so it is not a save.
      expect(await box.op("write_concept", { id: saved.id, status: "draft" })).toMatchObject({ noop: true });

      const [session] = (await box.exported()).sessions;
      expect(session!.events.map(shape)).toEqual([
        { kind: "save", surface: "gui", via: "capture", count: 1 },
        { kind: "search", surface: "gui", count: 2 },
        { kind: "open", surface: "gui", via: "search", rank: 2 },
        { kind: "save", surface: "cli", via: "capture", count: 1 },
        { kind: "search", surface: "cli", count: 1 },
        { kind: "open", surface: "cli", via: "direct" },
        { kind: "browse", surface: "gui", count: rows.length },
        { kind: "review", surface: "gui" },
        { kind: "map", surface: "gui", count: 1 },
        { kind: "error", surface: "gui", via: "open", outcome: "not_found" },
        { kind: "error", surface: "gui", via: "open", outcome: "bad_params" },
        { kind: "error", surface: "gui", via: "open", outcome: "bad_params" },
        { kind: "save", surface: "gui", via: "note", count: 1 },
      ]);
      expect(session!.events.map((event) => event.seq)).toEqual(session!.events.map((_, index) => index + 1));
      for (const event of session!.events) {
        expect(event.offsetMs).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(event.durationMs)).toBe(true);
      }
      expect(session!.summary).toMatchObject({ events: 13, errors: 3, firstSaveKind: "capture",
        timeToFirstSaveMs: session!.events[0]!.offsetMs, search: { count: 2 } });
      expect(session).toMatchObject({ appVersion: expect.stringMatching(/^\d+\.\d+\.\d+/), platform: expect.any(String), endedAt: null });
      // The key that ties a session to its brain folder stays in the store.
      expect(Object.keys(session!)).toEqual(["id", "startedAt", "endedAt", "appVersion", "platform", "events", "summary"]);
      expect(JSON.stringify(await box.exported())).not.toMatch(/[0-9a-f]{64}/);
    } finally {
      await agent.close().catch(() => {});
      await box.close();
    }
  });

  test("only the local app and the CLI on a writable brain can run a session", async () => {
    const box = await sandbox();
    const refused = async (run: Promise<unknown>) => {
      const error = await run.then(() => null, (thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(OpError);
      expect((error as OpError).code).toBe("refused");
    };
    try {
      await box.op("usability_session", { action: "start" });
      const owner = await box.op<{ id: string }>("capture", { text: "Recorded while the owner works" });

      // A caller that holds trust but is an agent, or names no owner surface, is refused.
      const asAgent = openLocalContext(box.bundle, true, false, "study-agent/1.0.0");
      asAgent.ctx.surface = "mcp";
      const unnamed = openLocalContext(box.bundle);
      const posing = openLocalContext(box.bundle, true, false, "study-agent/1.0.0");
      posing.ctx.surface = "gui";
      try {
        for (const { ctx } of [asAgent, unnamed, posing]) {
          await refused(runOp(getOp("usability_session")!, ctx, {}));
          await refused(runOp(getOp("usability_task")!, ctx, { action: "start", label: "T1" }));
          await refused(runOp(getOp("usability_export")!, ctx, {}));
          await runOp(getOp("read_concept")!, ctx, { id: owner.id });
          await runOp(getOp("capture")!, ctx, { text: "Written by another caller" });
        }
      } finally { await Promise.all([asAgent.close(), unnamed.close(), posing.close()]); }

      // A read-only mount behaves like local note usage: refused, and silent.
      const readonly = box.serve(box.bundle, true);
      for (const name of ["usability_session", "usability_export"])
        expect((await box.request(readonly, name)).status).toBe(403);
      expect((await box.request(readonly, "read_concept", { id: owner.id })).status).toBe(200);
      const status = async (server: ApiServer) =>
        (await (await fetch(`${server.url}api/status`, { headers: { "x-okb-token": TOKEN } })).json() as { usabilityRecording: boolean }).usabilityRecording;
      expect(await status(readonly)).toBe(false);
      expect(await status(box.app)).toBe(true);

      // The controls take the app's own header, origin, and JSON, like other owner actions.
      const route = `${box.app.url}api/op/usability_session`;
      expect((await fetch(`${route}?token=${TOKEN}`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status).toBe(401);
      expect((await box.request(box.app, "usability_session", {}, { origin: "https://study.example" })).status).toBe(403);
      expect((await box.request(box.app, "usability_session", {}, { "content-type": "text/plain" })).status).toBe(415);

      expect((await box.exported()).sessions[0]!.events.map(shape)).toEqual([{ kind: "save", surface: "gui", via: "capture", count: 1 }]);
    } finally { await box.close(); }
  });

  test("answers and reviewed imports are events too", async () => {
    const box = await sandbox();
    const model = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () =>
      Response.json({ choices: [{ message: { content: "Tide pools are covered in [notes/pools]." } }] }) });
    const provider = { OKB_CHAT_PROVIDER: "ollama", OKB_CHAT_BASE_URL: `http://127.0.0.1:${model.port}/v1` };
    Object.assign(process.env, provider);
    try {
      await box.op("write_concept", { id: "notes/pools", type: "note", title: "Tide pools", description: "Shore notes", body: "Tide pools at low water." });
      await box.op("index");
      await box.op("usability_session", { action: "start" });

      const headers = { "x-okb-token": TOKEN, "content-type": "application/json" };
      const stream = await fetch(`${box.app.url}api/ask/stream`, { method: "POST", headers, body: JSON.stringify({ question: "tide pools", profile: "lean" }) });
      expect(await stream.text()).toContain("event: done");
      await box.op("ask", { question: "tide pools", profile: "lean" });

      const upload = `${box.app.url}api/conversations/upload?provider=chatgpt`;
      const archive = await Bun.file(join(import.meta.dir, "fixtures", "chatgpt-conversations.json")).text();
      const preview = await (await fetch(upload, { method: "POST", headers, body: archive })).json() as { result: { preview: string } };
      const imported = await fetch(upload, { method: "POST", headers: { ...headers, "x-okb-preview": preview.result.preview }, body: archive });
      expect(imported.status).toBe(200);
      expect((await fetch(upload, { method: "POST", headers: { ...headers, "x-okb-preview": "0".repeat(64) }, body: archive })).status).toBe(400);

      expect((await box.exported()).sessions[0]!.events.map(shape)).toEqual([
        { kind: "ask", surface: "gui", count: 1 },
        { kind: "ask", surface: "gui", count: 1 },
        // The preview saved nothing, so only the confirmed import is a save.
        { kind: "save", surface: "gui", via: "import", count: 1 },
        { kind: "error", surface: "gui", via: "save", outcome: "bad_params" },
      ]);
    } finally {
      for (const key of Object.keys(provider)) delete process.env[key];
      await model.stop(true);
      await box.close();
    }
  });

  test("the protocol's invented export imports as five drafts that its re-find tasks can reach", async () => {
    const box = await sandbox();
    try {
      const archive = await Bun.file(join(import.meta.dir, "..", "docs", "usability", "chatgpt-export", "conversations.json")).text();
      const upload = (preview?: string) => fetch(`${box.app.url}api/conversations/upload?provider=chatgpt`, { method: "POST", body: archive,
        headers: { "x-okb-token": TOKEN, "content-type": "application/json", ...(preview ? { "x-okb-preview": preview } : {}) } });
      const { result: planned } = await (await upload()).json() as { result: { preview: string; planned: string[]; skipped: unknown[] } };
      expect(planned).toMatchObject({ planned: { length: 5 }, skipped: [] });
      const { result } = await (await upload(planned.preview)).json() as { result: { imported: string[] } };
      expect(result.imported).toHaveLength(5);
      await box.op("index");
      // T3 and T5 in docs/USABILITY.md describe these two notes without quoting their titles.
      for (const [words, title] of [["feed starter counter", "Sourdough starter schedule"], ["river path main road", "Two ways to cycle to the station"]] as const) {
        const hits = await box.op<{ title: string }[]>("search", { query: words, "keyword-only": true });
        expect(hits[0]?.title).toBe(title);
      }
    } finally { await box.close(); }
  });

  test("no note content, ID, path, tag, query, or error text reaches the store or the export", async () => {
    const sentinels = ["ZQXPATH7731", "ZQXTITLE7731", "ZQXDESC7731", "ZQXBODY7731", "zqxtag7731", "zqx-id-7731",
      "ZQXQUERY7731", "zqx-missing-7731", "ZQXCAPTURE7731", "ZQXLABEL7731"];
    const box = await sandbox("brain-ZQXPATH7731");
    try {
      await box.op("index");
      await box.op("usability_session", { action: "start" });
      const id = "notes/zqx-id-7731";
      await box.op("write_concept", { id, type: "note", title: "ZQXTITLE7731", description: "ZQXDESC7731", body: "ZQXBODY7731 body", tags: "zqxtag7731" });
      await box.op("capture", { text: "ZQXCAPTURE7731 captured", title: "ZQXTITLE7731 again", tags: "zqxtag7731" });
      await box.op("search", { query: "ZQXQUERY7731", "keyword-only": true });
      await box.op("search", { query: "ZQXBODY7731", "keyword-only": true });
      await box.op("read_concept", { id, via: "search", rank: 1 });
      await box.op("list_concepts", { tag: "zqxtag7731" });
      await box.op("focused_map", { query: "ZQXBODY7731" });
      const missing = await box.request(box.app, "read_concept", { id: "notes/zqx-missing-7731" });
      expect((await missing.json() as { error: string }).error).toContain("zqx-missing-7731");
      expect((await box.cli("search", "ZQXQUERY7731", "--keyword-only")).code).toBe(0);
      expect((await box.cli("read", "notes/zqx-missing-7731")).code).toBe(1);
      // A label is the one free value, and it is too short and too plain to carry content.
      for (const label of ["ZQXLABEL7731 with words", "ZQXLABEL7731-and-more-than-sixteen", "", "naïve", "a/b", "T 1"])
        expect((await box.request(box.app, "usability_task", { action: "start", label })).status).toBe(400);
      await box.op("usability_task", { action: "start", label: "T3" });
      await box.op("usability_task", { action: "end", label: "T3", outcome: "found" });
      await box.op("usability_session", { action: "stop" });

      const exported = JSON.stringify(await box.exported()).toLowerCase();
      expect((await box.exported()).sessions[0]!.events.length).toBeGreaterThanOrEqual(12);
      const files = (await readdir(dirname(box.store))).map((name) => join(dirname(box.store), name));
      expect(files).toContain(box.store);
      const stored = (await Promise.all(files.map((file) => readFile(file)))).map((bytes) => bytes.toString("latin1").toLowerCase()).join("\n");
      for (const sentinel of sentinels.map((value) => value.toLowerCase())) {
        expect(exported).not.toContain(sentinel);
        expect(stored).not.toContain(sentinel);
      }
      for (const identity of [box.bundle, box.root, "notes/", "inbox/"].map((value) => value.toLowerCase())) {
        expect(exported).not.toContain(identity);
        expect(stored).not.toContain(identity);
      }
    } finally { await box.close(); }
  });

  test("the store's own schema refuses free text", async () => {
    const box = await sandbox();
    try {
      await box.op("usability_session", { action: "start" });
      const db = new Database(box.store);
      try {
        db.exec("PRAGMA foreign_keys = ON");
        const { id } = db.query<{ id: string }, []>("SELECT id FROM sessions").get()!;
        const insert = (column: string, value: string | number) => () => db.query(
          `INSERT INTO events (session_id, seq, offset_ms, kind, surface, ${column}) VALUES (?, 99, 0, 'open', 'gui', ?)`).run(id, value);
        expect(insert("via", "search")).not.toThrow();
        db.query("DELETE FROM events").run();
        for (const [column, value] of [
          ["label", "a note title"], ["label", "seventeen-letters"], ["label", "notes/path"], ["via", "notes/secret"],
          ["outcome", "ENOENT: /home/someone/brain"], ["duration_ms", "soon"], ["duration_ms", -1], ['"count"', 1.5], ['"rank"', 0],
        ] as const)
          expect(insert(column, value)).toThrow();
        const event = (kind: string, surface: string) => () => db.query(
          "INSERT INTO events (session_id, seq, offset_ms, kind, surface) VALUES (?, 99, 0, ?, ?)").run(id, kind, surface);
        expect(event("opened a note", "gui")).toThrow();
        expect(event("open", "mcp")).toThrow();
        const session = (brain: string, version: string, platform: string) => () => db.query(
          "INSERT INTO sessions (id, brain, started_at, app_version, platform) VALUES (?, ?, 0, ?, ?)").run(crypto.randomUUID(), brain, version, platform);
        expect(session("/home/someone/brain", "0.1.0", "linux")).toThrow();
        expect(session("0".repeat(64), "my build", "linux")).toThrow();
        expect(session("0".repeat(64), "0.1.0", "someone's laptop")).toThrow();
        // A second recording session for one brain is refused by the index itself.
        const { brain } = db.query<{ brain: string }, []>("SELECT brain FROM sessions").get()!;
        expect(session(brain, "0.1.0", "linux")).toThrow();
      } finally { db.close(); }
    } finally { await box.close(); }
  });

  test("brains stay separate and sessions expire after 30 days", async () => {
    const box = await sandbox();
    try {
      const other = join(box.root, "other");
      await mkdir(other);
      const elsewhere = box.serve(other);
      await box.op("usability_session", { action: "start" });
      await box.op("capture", { text: "In the recorded brain" });
      await box.op("capture", { text: "In the other brain" }, elsewhere);
      expect(await box.op<UsabilityStatus>("usability_session", {}, elsewhere)).toMatchObject({ recording: false, sessions: 0 });
      expect((await box.exported(elsewhere)).sessions).toEqual([]);
      expect((await box.exported()).sessions[0]!.events).toHaveLength(1);

      // The other brain can record at the same time, and clearing one leaves the other.
      await box.op("usability_session", { action: "start" }, elsewhere);
      await box.op("capture", { text: "Recorded in the other brain" }, elsewhere);
      await box.op("usability_session", { action: "clear" });
      expect((await box.exported()).sessions).toEqual([]);
      expect((await box.exported(elsewhere)).sessions[0]!.events).toHaveLength(1);

      // Thirty days on, a session that was never stopped no longer records and is dropped.
      const db = new Database(box.store);
      try { db.query("UPDATE sessions SET started_at = started_at - ?").run(30 * day + 1000); }
      finally { db.close(); }
      await box.op("capture", { text: "Written after the session expired" }, elsewhere);
      const status = await (await fetch(`${elsewhere.url}api/status`, { headers: { "x-okb-token": TOKEN } })).json() as { usabilityRecording: boolean };
      expect(status.usabilityRecording).toBe(false);
      expect(await box.op<UsabilityStatus>("usability_session", {}, elsewhere)).toMatchObject({ recording: false, sessions: 0 });
      expect((await box.exported(elsewhere)).sessions).toEqual([]);
      const emptied = new Database(box.store, { readonly: true });
      try { expect(emptied.query("SELECT count(*) AS left FROM events").get()).toEqual({ left: 0 }); }
      finally { emptied.close(); }
    } finally { await box.close(); }
  });

  test("ordinary use deletes an expired session, with no visit to the session controls", async () => {
    const box = await sandbox();
    try {
      // What the store holds, read straight from the file so that no session command runs.
      const held = () => {
        const db = new Database(box.store, { readonly: true });
        try {
          return { sessions: db.query<{ total: number }, []>("SELECT count(*) AS total FROM sessions").get()!.total,
            events: db.query<{ total: number }, []>("SELECT count(*) AS total FROM events").get()!.total };
        } finally { db.close(); }
      };
      const age = (ms: number) => {
        const db = new Database(box.store);
        try { db.query("UPDATE sessions SET started_at = started_at - ?, ended_at = ended_at - ?").run(ms, ms); }
        finally { db.close(); }
      };
      const study = async () => {
        await box.op("usability_session", { action: "start" });
        await box.op("capture", { text: "Saved during the study" });
        await box.op("usability_session", { action: "stop" });
        expect(held()).toEqual({ sessions: 1, events: 1 });
      };

      // Inside the window, later work leaves a finished study alone.
      await box.op("capture", { text: "Written before the study" });
      await box.op("index");
      await study();
      age(29 * day);
      await box.op("search", { query: "study", "keyword-only": true });
      expect(held()).toEqual({ sessions: 1, events: 1 });

      // Past it, the next search in the app deletes the study.
      age(day + 1000);
      await box.op("search", { query: "study", "keyword-only": true });
      expect(held()).toEqual({ sessions: 0, events: 0 });

      // So does the next command in a terminal.
      await study();
      age(30 * day + 1000);
      expect((await box.cli("search", "study", "--keyword-only")).code).toBe(0);
      expect(held()).toEqual({ sessions: 0, events: 0 });

      // And the app's status check, which a read-only brain makes too.
      await study();
      age(30 * day + 1000);
      const readonly = box.serve(box.bundle, true);
      const status = await (await fetch(`${readonly.url}api/status`, { headers: { "x-okb-token": TOKEN } })).json() as { usabilityRecording: boolean };
      expect(status.usabilityRecording).toBe(false);
      expect(held()).toEqual({ sessions: 0, events: 0 });

      // A client over MCP is not the owner's own use, so it deletes nothing and reads nothing.
      await study();
      age(30 * day + 1000);
      const agent = openLocalContext(box.bundle, true, false, "study-agent/1.0.0");
      agent.ctx.surface = "mcp";
      try { await runOp(getOp("search")!, agent.ctx, { query: "study", "keyword-only": true }); }
      finally { await agent.close(); }
      expect(held()).toEqual({ sessions: 1, events: 1 });
    } finally { await box.close(); }
  });
});

describe("usability summary", () => {
  const at = (seq: number, offsetMs: number, kind: UsabilityEvent["kind"], more: Partial<UsabilityEvent> = {}): UsabilityEvent =>
    ({ seq, offsetMs, kind, surface: "gui", ...more });

  test("first save, task results, the re-find rate and median, and search latency", () => {
    const events = [
      at(1, 400, "browse", { count: 0 }),
      at(2, 900, "error", { via: "save", outcome: "bad_params" }),
      at(3, 1200, "save", { via: "clip", count: 1, durationMs: 80 }),
      at(4, 1500, "save", { via: "capture", count: 1 }),
      at(5, 2000, "search", { count: 3, durationMs: 40 }),          // before any task
      at(6, 3000, "task_start", { label: "T3" }),
      at(7, 3500, "search", { count: 5, durationMs: 10 }),
      at(8, 4000, "open", { via: "search", rank: 2 }),
      at(9, 5000, "search", { count: 1, durationMs: 30 }),
      at(10, 6000, "open", { via: "browse" }),
      at(11, 7000, "task_end", { label: "T3", outcome: "found" }),
      at(12, 8000, "open", { via: "link" }),                        // between tasks
      at(13, 10_000, "task_start", { label: "T4" }),
      at(14, 19_000, "task_end", { label: "T4", outcome: "not_found" }),
      at(15, 20_000, "task_start", { label: "T5" }),
      at(16, 21_000, "open", { via: "review", rank: 1 }),
      at(17, 26_000, "task_end", { label: "T5", outcome: "found" }),
      at(18, 27_000, "task_start", { label: "T6" }),
      at(19, 28_000, "search", { count: 0, durationMs: 20 }),
      at(20, 29_000, "task_end", { label: "T6", outcome: "abandoned" }),
      at(21, 30_000, "task_start", { label: "T7" }),                // still open
      at(22, 31_000, "open", { via: "direct" }),
    ];
    expect(summarizeUsability(events, 45_000)).toEqual({
      durationMs: 45_000,
      events: 22,
      timeToFirstSaveMs: 1200,
      firstSaveKind: "clip",
      errors: 1,
      tasks: [
        { label: "T3", outcome: "found", durationMs: 4000, searches: 2, opens: 2, firstOpenRank: 2, firstOpenVia: "search" },
        { label: "T4", outcome: "not_found", durationMs: 9000, searches: 0, opens: 0, firstOpenRank: null, firstOpenVia: null },
        { label: "T5", outcome: "found", durationMs: 6000, searches: 0, opens: 1, firstOpenRank: 1, firstOpenVia: "review" },
        { label: "T6", outcome: "abandoned", durationMs: 2000, searches: 1, opens: 0, firstOpenRank: null, firstOpenVia: null },
        { label: "T7", outcome: null, durationMs: null, searches: 0, opens: 1, firstOpenRank: null, firstOpenVia: "direct" },
      ],
      // Four tasks ended, two as found: 4000 and 6000 ms.
      refind: { tasks: 4, found: 2, notFound: 1, abandoned: 1, successRate: 0.5, medianFoundMs: 5000 },
      // 10, 20, 30, 40 ms: the median is 25, and 95% of the way from 30 to 40 rounds to 39.
      search: { count: 4, p50Ms: 25, p95Ms: 39 },
    });
  });

  test("an empty or still-recording session has no measures to report", () => {
    expect(summarizeUsability([], null)).toEqual({
      durationMs: null, events: 0, timeToFirstSaveMs: null, firstSaveKind: null, errors: 0, tasks: [],
      refind: { tasks: 0, found: 0, notFound: 0, abandoned: 0, successRate: null, medianFoundMs: null },
      search: { count: 0, p50Ms: null, p95Ms: null },
    });
    expect(summarizeUsability([at(1, 10, "search", { durationMs: 7 })], null).search).toEqual({ count: 1, p50Ms: 7, p95Ms: 7 });
    expect(summarizeUsability([at(1, 10, "task_start", { label: "T1" }), at(2, 50, "task_end", { label: "T1", outcome: "found" })], 60).refind)
      .toEqual({ tasks: 1, found: 1, notFound: 0, abandoned: 0, successRate: 1, medianFoundMs: 40 });
  });
});

describe("usability registry", () => {
  test("every observed operation exists, so a rename cannot silently stop recording", () => {
    const names = operations.map((operation) => operation.name);
    for (const name of Object.keys(USABILITY_OPERATIONS)) expect(names).toContain(name);
    // The measures the product plan asks for depend on these four.
    for (const name of ["capture", "write_concept", "search", "read_concept"]) expect(Object.keys(USABILITY_OPERATIONS)).toContain(name);
  });

  test("the session controls are owner settings: reachable from the app, never from MCP", () => {
    for (const name of ["usability_session", "usability_task", "usability_export"]) {
      expect(getOp(name)).toMatchObject({ scope: "admin" });
      expect(getOp(name)!.localOnly).toBeUndefined();
      expect(mcpOps(true).map((operation) => operation.name)).not.toContain(name);
      expect(Object.keys(USABILITY_OPERATIONS)).not.toContain(name);
    }
    expect(getOp("usability_session")!.cliName).toBe("usability");
    expect(getOp("usability_task")!.cliName).toBe("usability task");
    expect(getOp("usability_export")!.cliName).toBe("usability export");
  });
});
