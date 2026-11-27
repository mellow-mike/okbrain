import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir } from "../config.ts";
import { ensureExtensionCapableSqlite } from "../engine/custom-sqlite.ts";
import type { AskExchange, AskResult } from "./ask.ts";

const idPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const maxResultBytes = 512 * 1024;
const maxTurns = 100;
const maxConversations = 250;
const maxTitle = 100;

export interface AskTurn {
  id: string;
  at: string;
  question: string;
  result: AskResult;
}

interface TurnRow { ordinal: number; id: string; at: string; question: string; result: string }
interface ConversationRow { id: string; title: string; updated: string }

export interface AskConversationRequest { id: string; turn: string; previous: string | null; includePrevious: boolean }

export class AskConversationError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

const notFound = () => new AskConversationError("This conversation is unavailable in the selected brain.", 404);
const changed = () => new AskConversationError("This conversation changed. Reopen it before sending another question.", 409);

export function askConversationId(value: unknown): string {
  if (typeof value !== "string" || !idPattern.test(value)) throw new AskConversationError("Choose a valid conversation.", 400);
  return value;
}

export function askConversationRequest(value: unknown): AskConversationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AskConversationError("Choose a conversation and question ID.", 400);
  const { id, turn, previous, includePrevious } = value as Record<string, unknown>;
  if (typeof includePrevious !== "boolean" || (includePrevious && previous === null))
    throw new AskConversationError("Choose whether to include the previous exchange.", 400);
  return { id: askConversationId(id), turn: askConversationId(turn), previous: previous === null ? null : askConversationId(previous), includePrevious };
}

export function askConversationBinding(bundle: string, dev: bigint, ino: bigint): string {
  return createHash("sha256").update(JSON.stringify([bundle, String(dev), String(ino)])).digest("hex");
}

const storePath = () => join(dataDir(), "knowledge", "conversations.sqlite");

function database(write: boolean): Database | undefined {
  const path = storePath();
  if (!write && !existsSync(path)) return;
  if (write && !existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    closeSync(openSync(path, "a", 0o600));
  }
  ensureExtensionCapableSqlite();
  const db = new Database(path, { create: false, strict: true });
  try {
    db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000; PRAGMA secure_delete = ON");
    // Readers can arrive just after the file was created by another app window.
    db.exec(`CREATE TABLE IF NOT EXISTS ask_conversations (
      brain TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, updated TEXT NOT NULL,
      PRIMARY KEY (brain, id)
    );
    CREATE TABLE IF NOT EXISTS ask_turns (
      brain TEXT NOT NULL, conversation TEXT NOT NULL, id TEXT NOT NULL, ordinal INTEGER NOT NULL,
      at TEXT NOT NULL, question TEXT NOT NULL, result TEXT NOT NULL,
      PRIMARY KEY (brain, conversation, id), UNIQUE (brain, id), UNIQUE (brain, conversation, ordinal),
      FOREIGN KEY (brain, conversation) REFERENCES ask_conversations (brain, id) ON DELETE CASCADE
    )`);
    return db;
  } catch (error) { db.close(); throw error; }
}

function turn(row: TurnRow): AskTurn { return { id: row.id, at: row.at, question: row.question, result: JSON.parse(row.result) as AskResult }; }

function last(db: Database, brain: string, id: string) {
  return db.query<TurnRow, [string, string]>(`SELECT id, ordinal, at, question, result FROM ask_turns
    WHERE brain = ? AND conversation = ? ORDER BY ordinal DESC LIMIT 1`).get(brain, id);
}

function previousExchange({ question, result }: AskTurn): AskExchange {
  return { question: question.slice(0, 2000).toWellFormed(), answer: result.answer.slice(0, 6000).toWellFormed() };
}

function titleOf(value: string): string {
  return Array.from(value.replace(/[\s\p{Cc}]+/gu, " ").trim()).slice(0, maxTitle).join("");
}

export function listAskConversations(brain: string) {
  using db = database(false);
  return db?.query<ConversationRow & { turns: number }, [string]>(`SELECT id, title, updated,
    (SELECT count(*) FROM ask_turns AS t WHERE t.brain = c.brain AND t.conversation = c.id) AS turns
    FROM ask_conversations AS c WHERE brain = ? ORDER BY updated DESC, id`).all(brain) ?? [];
}

export function getAskConversation(brain: string, id: string) {
  using db = database(false);
  if (!db) throw notFound();
  return db.transaction(() => {
    const conversation = db.query<ConversationRow, [string, string]>(`SELECT id, title, updated FROM ask_conversations WHERE brain = ? AND id = ?`).get(brain, id);
    if (!conversation) throw notFound();
    const turns = db.query<TurnRow, [string, string]>(`SELECT id, ordinal, at, question, result FROM ask_turns
      WHERE brain = ? AND conversation = ? ORDER BY ordinal`).all(brain, id).map(turn);
    return { ...conversation, turns, previous: turns.length ? previousExchange(turns.at(-1)!) : null };
  })();
}

/** Return the exact bounded exchange shown by the app and reject stale follow-ups. */
export function prepareAskConversation(brain: string, request: AskConversationRequest, question: string): { history?: AskExchange; saved?: AskTurn } {
  using db = database(false);
  const saved = db?.query<TurnRow, [string, string, string]>(`SELECT id, ordinal, at, question, result FROM ask_turns
    WHERE brain = ? AND conversation = ? AND id = ?`).get(brain, request.id, request.turn);
  if (saved) {
    if (saved.question !== question) throw changed();
    return { saved: turn(saved) };
  }
  const previous = db && last(db, brain, request.id);
  if ((previous?.id ?? null) !== request.previous || (previous?.ordinal ?? 0) >= maxTurns) throw changed();
  return request.includePrevious && previous ? { history: previousExchange(turn(previous)) } : {};
}

/** The previewed tail must still be current when a completed turn is written. */
export function appendAskTurn(brain: string, request: AskConversationRequest, question: string, result: AskResult) {
  const resultJson = JSON.stringify(result);
  if (Buffer.byteLength(resultJson) > maxResultBytes) throw new AskConversationError("The answer is too large to keep in the conversation.", 400);
  using db = database(true)!;
  return db.transaction(() => {
    const saved = db.query<TurnRow, [string, string, string]>(`SELECT id, ordinal, at, question, result FROM ask_turns
      WHERE brain = ? AND conversation = ? AND id = ?`).get(brain, request.id, request.turn);
    if (saved) {
      if (saved.question !== question) throw changed();
      return turn(saved);
    }
    const previous = last(db, brain, request.id);
    const ordinal = (previous?.ordinal ?? 0) + 1;
    if ((previous?.id ?? null) !== request.previous || ordinal > maxTurns) throw changed();
    const at = new Date().toISOString();
    if (!previous) {
      const count = db.query<{ total: number }, [string]>(`SELECT count(*) AS total FROM ask_conversations WHERE brain = ?`).get(brain)!.total;
      if (count >= maxConversations) throw new AskConversationError("Delete a conversation before saving another one.", 409);
      db.run("INSERT INTO ask_conversations VALUES (?, ?, ?, ?)", [brain, request.id, titleOf(question) || "New conversation", at]);
    } else db.run("UPDATE ask_conversations SET updated = ? WHERE brain = ? AND id = ?", [at, brain, request.id]);
    db.run("INSERT INTO ask_turns VALUES (?, ?, ?, ?, ?, ?, ?)", [brain, request.id, request.turn, ordinal, at, question, resultJson]);
    return { id: request.turn, at, question, result };
  }).immediate();
}

export function changeAskConversation(brain: string, input: Record<string, unknown>) {
  const id = askConversationId(input.id);
  using db = database(false);
  if (!db) throw notFound();
  if (input.action === "delete") {
    if (input.confirm !== true) throw new AskConversationError("Confirm deletion of this conversation.", 400);
    if (!db.run("DELETE FROM ask_conversations WHERE brain = ? AND id = ?", [brain, id]).changes) throw notFound();
    return { id, deleted: true };
  }
  if (input.action !== "rename" || typeof input.title !== "string" || !titleOf(input.title))
    throw new AskConversationError("Enter a conversation title.", 400);
  const title = titleOf(input.title);
  if (!db.run("UPDATE ask_conversations SET title = ? WHERE brain = ? AND id = ?", [title, brain, id]).changes) throw notFound();
  return { id, title };
}
