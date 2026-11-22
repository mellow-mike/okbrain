import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { dataDir } from "../config.ts";
import { importPersonalSource, type SourceUploadFile, type SourceUploadResult } from "./personal-sources.ts";

export interface NotionSourceOptions {
  path?: string;
  fetch?: (url: URL, init: RequestInit) => Promise<Response>;
}

export class NotionSourceError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

interface Preview {
  bundle: string;
  tokenHash: string;
  name: string;
  file: SourceUploadFile;
  preview: string;
  expires: number;
  commit?: Promise<SourceUploadResult>;
}

const MAX_PAGE_BYTES = 1024 * 1024;
const PAGE_ID = /^[a-f0-9]{32}$/i;
const CONVENTIONAL_PAGE_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const TOKEN = /^(?:ntn_|secret_)[a-zA-Z0-9_-]{20,256}$/;
const hash = (token: string): string => createHash("sha256").update(token).digest("hex");

function pageId(value: unknown): string {
  if (typeof value !== "string" || value.length > 512) throw new NotionSourceError("Enter a Notion page URL or ID.");
  const text = value.trim();
  if (PAGE_ID.test(text) || CONVENTIONAL_PAGE_ID.test(text)) return text.replaceAll("-", "").toLowerCase();
  const url = URL.parse(text);
  if (url?.protocol === "https:" && !url.username && !url.password && !url.port &&
      /(?:^|\.)notion\.(?:so|site)$/.test(url.hostname)) {
    const tail = url.pathname.split("/").filter(Boolean).at(-1) ?? "";
    const id = /(?:^|-)([a-f0-9]{32})$/i.exec(tail)?.[1];
    if (id) return id.toLowerCase();
    if (CONVENTIONAL_PAGE_ID.test(tail)) return tail.replaceAll("-", "").toLowerCase();
  }
  throw new NotionSourceError("Enter a Notion page URL or ID.");
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new NotionSourceError("Notion sent an empty response.", 502);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PAGE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new NotionSourceError("This Notion page exceeds the 1 MiB response limit. Choose a smaller page.", 413);
      }
      chunks.push(value);
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    throw new Error();
  } catch (error) {
    if (error instanceof NotionSourceError) throw error;
    throw new NotionSourceError("Notion returned unreadable page data.", 502);
  } finally {
    reader.releaseLock();
  }
}

// The import is text-only. Do not persist expiring media credentials or embed
// externally loaded pixels when someone opens the draft.
function withoutMedia(markdown: string): string {
  return markdown.replace(/!\[([^\]\n]*)\]\[[^\]\n]*\]|!\[([^\]\n]*)\]\([^\n]*?\)/g,
    (_match, referenceLabel: string | undefined, inlineLabel: string | undefined) => referenceLabel || inlineLabel || "[Image omitted]")
    .replace(/<(?:file|image|video|audio|pdf)\b[^>]*>/gi, "[Attachment omitted]")
    .replace(/https?:\/\/[^\s<>")]+[?&](?:X-Amz-Signature|X-Amz-Credential|X-Goog-Signature)=[^\s<>")]+/gi, "omitted:attachment");
}

/** Read-only internal Notion connection. The browser never receives its stored token. */
export function createNotionSource(options: NotionSourceOptions = {}) {
  const path = options.path ?? join(dataDir(), "notion", "internal-token");
  const transport = options.fetch ?? fetch;
  const previews = new Map<string, Preview>();

  async function readToken() {
    try {
      const token = (await readFile(path, "utf8")).trim();
      if (TOKEN.test(token)) return token;
      throw new NotionSourceError("The saved Notion connection is invalid. Connect again.", 409);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  return {
    async status() {
      return { connected: Boolean(await readToken()) };
    },
    async connect(input: Record<string, unknown>) {
      const token = typeof input.token === "string" ? input.token.trim() : "";
      if (input.allow !== true || !TOKEN.test(token))
        throw new NotionSourceError("Enter the token for a read-only internal Notion connection and confirm access.");
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const pending = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(pending, token + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
        await rename(pending, path);
      } finally {
        await unlink(pending).catch(() => {});
      }
      previews.clear();
      return { connected: true };
    },
    async disconnect() {
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      previews.clear();
      return { connected: false };
    },
    async preview(bundle: string, input: Record<string, unknown>) {
      const id = pageId(input.page);
      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (!name || name.length > 80 || /\p{Cc}/u.test(name)) throw new NotionSourceError("Enter a source name up to 80 characters.");
      const token = await readToken();
      if (!token) throw new NotionSourceError("Connect Notion before previewing a page.", 409);
      let response;
      try {
        response = await transport(new URL(`https://api.notion.com/v1/pages/${id}/markdown?include_transcript=false&markdown_version=v2`), {
          method: "GET",
          redirect: "error",
          headers: { authorization: `Bearer ${token}`, "notion-version": "2026-03-11" },
          signal: AbortSignal.timeout(10000),
        });
      } catch {
        throw new NotionSourceError("Notion could not be reached. Try previewing again.", 502);
      }
      if (response.status === 401) throw new NotionSourceError("Notion rejected the connection token. Connect with a valid token.", 502);
      if (response.status === 403 || response.status === 404)
        throw new NotionSourceError("Notion could not read this page. Share it with your internal connection in Notion.", 502);
      if (response.status === 429) throw new NotionSourceError("Notion's rate limit was reached. Try again later.", 502);
      if (!response.ok) throw new NotionSourceError("Notion could not return this page as Markdown.", 502);
      const page = await responseJson(response);
      if (page.object !== "page_markdown" || typeof page.id !== "string" || page.id.replaceAll("-", "").toLowerCase() !== id ||
          typeof page.markdown !== "string" || typeof page.truncated !== "boolean" || !Array.isArray(page.unknown_block_ids))
        throw new NotionSourceError("Notion returned unexpected page data.", 502);
      const file = {
        path: `Notion page ${id.slice(0, 8)}.md`,
        text: withoutMedia(page.markdown),
        origin: { resource: `https://www.notion.so/${id}`, id },
      };
      const plan = await importPersonalSource(bundle, "notion-live", name, [file]);
      if (await readToken() !== token) throw new NotionSourceError("The Notion connection changed. Preview the page again.", 409);
      const previewId = randomUUID();
      for (const [key, preview] of previews) if (preview.expires <= Date.now()) previews.delete(key);
      if (previews.size >= 8) previews.delete(previews.keys().next().value!);
      previews.set(previewId, { bundle, tokenHash: hash(token), name, file, preview: plan.preview, expires: Date.now() + 10 * 60_000 });
      return {
        previewId, rows: plan.rows, markdown: file.text,
        partial: page.truncated || page.unknown_block_ids.length > 0,
      };
    },
    async commit(bundle: string, value: unknown) {
      const preview = typeof value === "string" ? previews.get(value) : undefined;
      const token = await readToken();
      if (!preview || !token || preview.bundle !== bundle || preview.expires <= Date.now() || preview.tokenHash !== hash(token))
        throw new NotionSourceError("Preview the Notion page again for this brain.");
      preview.commit ??= importPersonalSource(bundle, "notion-live", preview.name, [preview.file], { preview: preview.preview, selected: [1] });
      return preview.commit;
    },
    close() { previews.clear(); },
  };
}

export type NotionSource = ReturnType<typeof createNotionSource>;
