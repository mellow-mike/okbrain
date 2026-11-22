import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { isIsoInstant } from "../okf/document.ts";
import { regenerateIndexes } from "../okf/indexmd.ts";
import { idToAbsPath } from "../okf/paths.ts";
import { OkfWriteError, writeConcept } from "../okf/write.ts";
import { TOOL_ACTOR } from "../version.ts";
import { clip } from "./capture.ts";

const PROVIDERS = { chatgpt: "ChatGPT", claude: "Claude" } as const;
const MAX_EXPORT_BYTES = 128 * 1024 * 1024;
export type ConversationProvider = keyof typeof PROVIDERS;

export function isConversationProvider(value: unknown): value is ConversationProvider {
  return typeof value === "string" && Object.hasOwn(PROVIDERS, value);
}

export interface ConversationImportInput {
  provider: ConversationProvider;
  path: string;
  actor?: string;
  dryRun?: boolean;
}

export interface ConversationImportResult {
  imported: string[];
  planned: string[];
  skipped: { row: number; id?: string; reason: string }[];
}

interface Message {
  role: "user" | "assistant";
  text: string;
}

interface Conversation {
  sourceId: string;
  title: string;
  createdAt?: string;
  updatedAt?: string;
  messages: Message[];
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const string = (value: unknown): string => typeof value === "string" ? value : "";

function timestamp(value: unknown): string | undefined {
  if (isIsoInstant(value)) return value;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  const date = new Date(value * 1000);
  if (!Number.isFinite(date.getTime())) return undefined;
  const iso = date.toISOString();
  return isIsoInstant(iso) ? iso : undefined;
}

function message(role: unknown, parts: string[]): Message | undefined {
  if (role !== "user" && role !== "assistant") return undefined;
  const text = parts.filter((part) => part.trim() !== "").join("\n\n").replace(/\r\n?/g, "\n");
  return text === "" ? undefined : { role, text };
}

function chatgptMessages(row: Record<string, unknown>): Message[] | string {
  const mapping = record(row.mapping);
  if (!mapping) return "missing ChatGPT message mapping";
  let current = string(row.current_node);
  if (!current) {
    // Older exports can omit the selected node. Only infer it for a single branch.
    const entries = Object.entries(mapping);
    const parents = new Set(entries.map(([, node]) => string(record(node)?.parent)));
    const leaves = entries.filter(([key]) => !parents.has(key));
    if (leaves.length !== 1) return "ChatGPT export has no unambiguous active branch";
    current = leaves[0]![0];
  }

  const messages: Message[] = [];
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current) || !Object.hasOwn(mapping, current)) return "invalid ChatGPT active branch";
    const node = record(mapping[current]);
    if (!node) return "invalid ChatGPT active branch";
    seen.add(current);
    const raw = record(node.message);
    const content = record(raw?.content);
    const recipient = string(raw?.recipient);
    if (
      (!recipient || recipient === "all") &&
      record(raw?.metadata)?.is_visually_hidden_from_conversation !== true &&
      Array.isArray(content?.parts)
    ) {
      const parsed = message(record(raw?.author)?.role, content.parts.map(string));
      if (parsed) messages.push(parsed);
    }
    current = string(node.parent);
  }
  return messages.reverse();
}

function claudeMessages(row: Record<string, unknown>): Message[] | string {
  if (!Array.isArray(row.chat_messages)) return "missing Claude chat messages";
  const messages: Message[] = [];
  for (const entry of row.chat_messages) {
    const raw = record(entry);
    if (!raw) continue;
    const parts = Array.isArray(raw.content)
      ? raw.content.flatMap((block) => {
          const content = record(block);
          return content?.type === "text" ? [string(content.text)] : [];
        })
      : [];
    const role = raw.sender === "human" ? "user" : raw.sender;
    const parsed = message(role, parts.some((part) => part.trim() !== "") ? parts : [string(raw.text)]);
    if (parsed) messages.push(parsed);
  }
  return messages;
}

function parseRow(provider: ConversationProvider, value: unknown): Conversation | string {
  const row = record(value);
  if (!row) return "invalid conversation record";
  const isChatGPT = provider === "chatgpt";
  const sourceId = (isChatGPT ? string(row.conversation_id) || string(row.id) : string(row.uuid)).trim();
  if (!sourceId || sourceId.length > 512) return "missing or invalid conversation id";
  const messages = isChatGPT ? chatgptMessages(row) : claudeMessages(row);
  if (typeof messages === "string") return messages;
  if (messages.length === 0) return "conversation has no visible text messages";
  const title = string(isChatGPT ? row.title : row.name).replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();
  return {
    sourceId,
    title: clip(title || `Untitled ${PROVIDERS[provider]} conversation`, 120),
    createdAt: timestamp(isChatGPT ? row.create_time : row.created_at),
    updatedAt: timestamp(isChatGPT ? row.update_time : row.updated_at),
    messages,
  };
}

function renderTranscript(messages: Message[]): string {
  return messages.map(({ role, text }) => {
    // A fence longer than any in the original text preserves nested code blocks
    // and prevents remote images and invented local links from becoming active.
    let length = 3;
    for (const run of text.matchAll(/(?:^|\n) {0,3}(~{3,})/g)) length = Math.max(length, run[1]!.length + 1);
    const fence = "~".repeat(length);
    return `## ${role === "user" ? "User" : "Assistant"}\n\n${fence}\n${text}${text.endsWith("\n") ? "" : "\n"}${fence}`;
  }).join("\n\n");
}

async function readExport(path: string): Promise<unknown[]> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  let raw: Buffer;
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new OkfWriteError("conversation export must be an extracted JSON file");
    if (stat.size > MAX_EXPORT_BYTES) throw new OkfWriteError("conversation export exceeds the 128 MiB file limit");
    // Read one extra byte to detect growth after sizing without an unbounded read.
    const buffer = Buffer.allocUnsafe(stat.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size !== stat.size) throw new OkfWriteError("conversation export changed while being read");
    raw = buffer.subarray(0, size);
  } finally {
    await file.close();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8").replace(/^\uFEFF/, ""));
  } catch {
    throw new OkfWriteError("conversation export is invalid JSON; choose the extracted conversations JSON file");
  }
  if (!Array.isArray(parsed)) throw new OkfWriteError("conversation export must contain a JSON array of conversations");
  return parsed;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    return false;
  }
}

async function checkDestination(root: string, dir: string): Promise<void> {
  let path = root;
  for (const segment of dir.split("/")) {
    path = join(path, segment);
    try {
      if (!(await lstat(path)).isDirectory())
        throw new OkfWriteError(`conversation import destination must be a directory inside the bundle: ${dir}`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
  }
}

/** Import local text transcripts and preserve their original provider provenance. */
export async function importConversations(
  root: string,
  { provider, path, actor, dryRun }: ConversationImportInput,
): Promise<ConversationImportResult> {
  if (!isConversationProvider(provider)) throw new OkfWriteError("conversation provider must be chatgpt or claude");
  const dir = `db_only/conversations/${provider}`;
  await checkDestination(root, dir);
  const rows = await readExport(path);
  const result: ConversationImportResult = { imported: [], planned: [], skipped: [] };
  const seen = new Set<string>();
  try {
    for (const [index, row] of rows.entries()) {
      const conversation = parseRow(provider, row);
      if (typeof conversation === "string") {
        result.skipped.push({ row: index + 1, reason: conversation });
        continue;
      }
      const { sourceId, title, createdAt, updatedAt, messages } = conversation;
      const id = `${dir}/${createHash("sha256").update(sourceId).digest("hex")}`;
      if (seen.has(id)) {
        result.skipped.push({ row: index + 1, id, reason: "duplicate conversation in export" });
        continue;
      }
      seen.add(id);
      if (dryRun) {
        if (await exists(idToAbsPath(root, id))) result.skipped.push({ row: index + 1, id, reason: "concept already exists" });
        else result.planned.push(id);
        continue;
      }
      const date = createdAt?.slice(0, 10);
      const written = await writeConcept(root, {
        id,
        type: "conversation",
        title,
        description: `${PROVIDERS[provider]} conversation${date ? ` from ${date}` : ""}.`,
        tags: ["conversation", provider],
        status: "draft",
        body: renderTranscript(messages),
        actor: actor ?? TOOL_ACTOR,
        sources: [{
          id: "export",
          resource: `${provider}-export:conversation`,
          conversation_id: sourceId,
          created_at: createdAt,
          last_modified: updatedAt,
        }],
      }, { createOnly: true, deferIndex: true });
      if (!written.created) {
        result.skipped.push({ row: index + 1, id, reason: "concept already exists" });
        continue;
      }
      result.imported.push(id);
    }
  } finally {
    if (result.imported.length > 0) await regenerateIndexes(root, dir);
  }
  return result;
}
