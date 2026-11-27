import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { dataDir } from "../config.ts";
import { importPersonalSource, sourceTextMarkdown, type ConnectedSourceProvider, type SourceUploadFile, type SourceUploadResult } from "./personal-sources.ts";

export interface LiveSourcesOptions {
  directory?: string;
  fetch?: (url: URL, init: RequestInit) => Promise<Response>;
}

export class LiveSourceError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

type Preview = {
  provider: ConnectedSourceProvider;
  bundle: string;
  tokenHash: string;
  file: SourceUploadFile;
  name: string;
  preview: string;
  expires: number;
  commit?: Promise<SourceUploadResult>;
};

const labels = { drive: "Google Drive", slack: "Slack", linear: "Linear" };
const tokenPatterns = { drive: /^[\w.~-]{20,2048}$/u, slack: /^xox[bp]-[\w-]{15,512}$/u, linear: /^lin_api_[\w-]{20,512}$/u };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const maxReplyBytes = 1024 * 1024;
const maxTextBytes = 512 * 1024;

type Transport = NonNullable<LiveSourcesOptions["fetch"]>;
type Request = (url: URL, init?: RequestInit) => Promise<Response>;
type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}

function plainText(value: string): string {
  const text = value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/gu, "").replace(/\r\n?/gu, "\n").trim();
  if (Buffer.byteLength(text) > maxTextBytes) throw new LiveSourceError("The selected text exceeds 512 KiB. Choose a smaller item.", 413);
  return text;
}

function secureUrl(value: string): URL | undefined {
  const url = URL.parse(value);
  return url?.protocol === "https:" && !url.username && !url.password && !url.port ? url : undefined;
}

async function readBounded(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw new LiveSourceError("The selected item exceeds the response limit. Choose a smaller item.", 413);
      }
      chunks.push(value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total));
  } catch (error) {
    if (error instanceof LiveSourceError) throw error;
    throw new LiveSourceError("The provider returned unreadable text. Try previewing again.", 502);
  } finally { reader.releaseLock(); }
}

async function jsonRecord(response: Response): Promise<RecordValue> {
  const raw = await readBounded(response, maxReplyBytes);
  try {
    const parsed = record(JSON.parse(raw));
    if (parsed) return parsed;
  } catch { /* Provider response bodies stay out of error output. */ }
  throw new LiveSourceError("The provider returned unexpected data. Try previewing again.", 502);
}

function requester(provider: ConnectedSourceProvider, token: string, transport: Transport): Request {
  return async (url, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", provider === "linear" ? token : `Bearer ${token}`);
    let response;
    try { response = await transport(url, { ...init, headers, redirect: "error", signal: AbortSignal.timeout(10_000) }); }
    catch { throw new LiveSourceError(`${labels[provider]} could not be reached. Try previewing again.`, 502); }
    if (response.ok) return response;
    await response.body?.cancel().catch(() => {});
    if (response.status === 429) throw new LiveSourceError(`${labels[provider]} reached its rate limit. Try again later.`, 429);
    if (response.status === 401) throw new LiveSourceError(`${labels[provider]} rejected the credential. Save a valid credential and try again.`, 409);
    if (response.status === 403 || response.status === 404) throw new LiveSourceError(`${labels[provider]} could not read this item. Check the link and credential access.`, 409);
    throw new LiveSourceError(`${labels[provider]} could not return this item. Try previewing again.`, 502);
  };
}

function downloadFile(provider: ConnectedSourceProvider, id: string, resource: string, title: string, text: string): SourceUploadFile {
  return { path: `${labels[provider]} item.md`, text: plainText(text), origin: { id, resource, title } };
}

async function driveFile(selection: string, request: Request): Promise<SourceUploadFile> {
  const input = secureUrl(selection);
  const fileId = /^[\w-]{8,160}$/u;
  let id = selection;
  if (input?.hostname === "docs.google.com") id = /^\/document\/(?:u\/\d+\/)?d\/([\w-]+)(?:\/|$)/u.exec(input.pathname)?.[1] ?? "";
  if (input?.hostname === "drive.google.com") id = /^\/file\/d\/([\w-]+)(?:\/|$)/u.exec(input.pathname)?.[1] ?? input.searchParams.get("id") ?? "";
  if (!fileId.test(id)) throw new LiveSourceError("Enter a Google Drive file link or ID.");
  const resourceKey = input?.searchParams.get("resourcekey");
  if (resourceKey && !/^[\w-]{1,160}$/u.test(resourceKey)) throw new LiveSourceError("Enter a valid Google Drive sharing link.");
  const access = resourceKey ? { headers: { "x-goog-drive-resource-keys": `${id}/${resourceKey}` } } : undefined;
  const base = `https://www.googleapis.com/drive/v3/files/${id}`;
  const metadata = new URL(base);
  metadata.search = new URLSearchParams({ fields: "id,name,mimeType,trashed,capabilities(canDownload)", supportsAllDrives: "true" }).toString();
  const info = await jsonRecord(await request(metadata, access));
  if (info.id !== id || typeof info.name !== "string" || !info.name.trim() || info.trashed === true || record(info.capabilities)?.canDownload !== true)
    throw new LiveSourceError("Google Drive does not allow downloading this file with the current access.", 409);
  const document = info.mimeType === "application/vnd.google-apps.document";
  const textFile = info.mimeType === "text/plain" || info.mimeType === "text/markdown";
  if (!document && !textFile) throw new LiveSourceError("Choose a Google Doc, plain-text file, or Markdown file.");
  const download = new URL(document ? `${base}/export?mimeType=text%2Fplain` : `${base}?alt=media&supportsAllDrives=true`);
  const text = await readBounded(await request(download, access), maxTextBytes);
  const resource = document ? `https://docs.google.com/document/d/${id}/edit` : `https://drive.google.com/file/d/${id}/view`;
  return downloadFile("drive", id, resource, info.name, text);
}

function slackSelection(selection: string): { url: URL; channel: string; timestamp: string; thread?: string } {
  const url = secureUrl(selection);
  const match = url && /^[a-z0-9-]+\.slack\.com$/iu.test(url.hostname) && /^\/archives\/([CG][A-Z0-9]{7,20})\/p(\d{9,12})(\d{6})\/?$/u.exec(url.pathname);
  if (!url || !match) throw new LiveSourceError("Paste a channel message link copied from Slack.");
  const thread = url.searchParams.get("thread_ts") ?? undefined;
  if (thread && !/^\d{9,12}\.\d{6}$/u.test(thread)) throw new LiveSourceError("Paste a valid message link copied from Slack.");
  return { url, channel: match[1]!, timestamp: `${match[2]}.${match[3]}`, ...(thread ? { thread } : {}) };
}

async function slackMessage(selection: string, request: Request): Promise<SourceUploadFile> {
  const { url, channel, timestamp, thread } = slackSelection(selection);
  const reply = thread && thread !== timestamp ? thread : undefined;
  const permalink = new URL("https://slack.com/api/chat.getPermalink");
  permalink.search = new URLSearchParams({ channel, message_ts: timestamp }).toString();
  const result = await jsonRecord(await request(permalink));
  const canonical = result.ok === true && typeof result.permalink === "string" ? secureUrl(result.permalink) : undefined;
  const canonicalThread = canonical?.searchParams.get("thread_ts");
  if (!canonical || canonical.hostname !== url.hostname || canonical.pathname.replace(/\/$/u, "") !== url.pathname.replace(/\/$/u, "")
    || (canonicalThread && canonicalThread !== timestamp ? canonicalThread : undefined) !== reply)
    throw new LiveSourceError("The Slack connection did not return a permalink for this workspace and message.", 409);
  const endpoint = new URL(`https://slack.com/api/conversations.${reply ? "replies" : "history"}`);
  endpoint.search = new URLSearchParams({ channel, oldest: timestamp, latest: timestamp, inclusive: "true", limit: "1",
    ...(reply ? { ts: reply } : {}) }).toString();
  const data = await jsonRecord(await request(endpoint));
  const messages = data.ok === true && Array.isArray(data.messages) ? data.messages : [];
  const message = messages.map(record).find((message) => message?.ts === timestamp);
  if (typeof message?.text !== "string") throw new LiveSourceError("Slack could not read this exact message. Check membership and history scopes.", 409);
  canonical.search = "";
  canonical.hash = "";
  if (reply) canonical.search = new URLSearchParams({ thread_ts: reply, cid: channel }).toString();
  return downloadFile("slack", `${canonical.hostname}/${channel}/${timestamp}`, canonical.href, `Slack message · ${channel} · ${timestamp}`, message.text);
}

const linearUuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
const linearIdentifier = /^[a-z][a-z0-9]{0,31}-\d{1,12}$/iu;

function linearLocation(value: string): { url: URL; workspace: string; issue: string } | undefined {
  const url = secureUrl(value);
  const match = url?.hostname === "linear.app" && /^\/([\w-]+)\/issue\/([a-z][a-z0-9]{0,31}-\d{1,12})(?:\/|$)/iu.exec(url.pathname);
  if (url && match) return { url, workspace: match[1]!, issue: match[2]!.toUpperCase() };
}

async function linearIssue(selection: string, request: Request): Promise<SourceUploadFile> {
  const original = linearLocation(selection);
  const id = original?.issue ?? (linearIdentifier.test(selection) ? selection.toUpperCase() : selection.toLowerCase());
  if (!linearIdentifier.test(id) && !linearUuid.test(id)) throw new LiveSourceError("Enter a Linear issue link, key, or UUID.");
  const response = await request(new URL("https://api.linear.app/graphql"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    query: "query SelectedIssue($id: String!) { issue(id: $id) { id identifier title description url } }", variables: { id },
  }) });
  const result = await jsonRecord(response);
  const issue = record(record(result.data)?.issue);
  const location = typeof issue?.url === "string" ? linearLocation(issue.url) : undefined;
  if (result.errors || !issue || !location || typeof issue.id !== "string" || !linearUuid.test(issue.id) || typeof issue.title !== "string" || !issue.title.trim()
    || typeof issue.identifier !== "string" || issue.identifier.toUpperCase() !== location.issue
    || (linearUuid.test(id) ? issue.id.toLowerCase() !== id : location.issue !== id)
    || (original && original.workspace !== location.workspace)) throw new LiveSourceError("Linear could not read this exact issue. Check the link and key access.", 409);
  location.url.search = "";
  location.url.hash = "";
  return downloadFile("linear", issue.id.toLowerCase(), location.url.href, `${location.issue} · ${issue.title}`,
    typeof issue.description === "string" ? issue.description : "");
}

/** Deliberately scoped live reads and short-lived reviewed receipts. Secret values stay in server-side application data. */
export function createLiveSources(options: LiveSourcesOptions = {}) {
  const directory = options.directory ?? join(dataDir(), "source-connections");
  const transport = options.fetch ?? fetch;
  const previews = new Map<string, Preview>();
  const readers = { drive: driveFile, slack: slackMessage, linear: linearIssue };

  async function readToken(provider: ConnectedSourceProvider): Promise<string | undefined> {
    const path = join(directory, provider);
    try {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.nlink !== 1 || info.size > 2049 || (process.platform !== "win32" && (info.mode & 0o077) !== 0))
          throw new LiveSourceError(`The saved ${labels[provider]} credential is not in a private file. Reconnect this source.`, 409);
        const token = (await file.readFile("utf8")).trim();
        if (tokenPatterns[provider].test(token)) return token;
        throw new LiveSourceError(`The saved ${labels[provider]} credential is invalid. Reconnect this source.`, 409);
      } finally { await file.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new LiveSourceError(`Reconnect ${labels[provider]} to replace its credential file.`, 409);
      throw error;
    }
  }

  function invalidate(provider: ConnectedSourceProvider) {
    for (const [id, preview] of previews) if (preview.provider === provider) previews.delete(id);
  }

  return {
    connector(provider: ConnectedSourceProvider) {
      const path = join(directory, provider);
      return {
        async status() { return { connected: Boolean(await readToken(provider)) }; },
        async connect(input: RecordValue, authorize?: () => void) {
          const token = typeof input.token === "string" ? input.token.trim() : "";
          if (input.allow !== true || !tokenPatterns[provider].test(token)) throw new LiveSourceError(`Enter a ${labels[provider]} credential and confirm read access.`);
          authorize?.();
          await mkdir(dirname(path), { recursive: true, mode: 0o700 });
          const temporary = `${path}.${randomUUID()}.tmp`;
          try {
            await writeFile(temporary, token + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
            authorize?.();
            await rename(temporary, path);
            invalidate(provider);
          } finally { await unlink(temporary).catch(() => {}); }
          return { connected: true };
        },
        async disconnect(authorize?: () => void) {
          authorize?.();
          await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
          invalidate(provider);
          return { connected: false };
        },
        async preview(bundle: string, input: RecordValue) {
          const item = typeof input.item === "string" ? input.item.trim() : "";
          const name = typeof input.name === "string" ? input.name.trim() : "";
          if (!item || item.length > 2048) throw new LiveSourceError("Choose one item by its direct link or ID.");
          if (!name || name.length > 80 || /\p{Cc}/u.test(name)) throw new LiveSourceError("Enter a source name up to 80 characters.");
          const token = await readToken(provider);
          if (!token) throw new LiveSourceError(`Connect ${labels[provider]} before previewing.`, 409);
          const file = await readers[provider](item, requester(provider, token, transport));
          const plan = await importPersonalSource(bundle, provider, name, [file]);
          if (await readToken(provider) !== token) throw new LiveSourceError("The saved credential changed. Preview the item again.", 409);
          const previewId = randomUUID();
          const now = Date.now();
          for (const [id, preview] of previews) if (preview.expires <= now) previews.delete(id);
          if (previews.size >= 12) previews.delete(previews.keys().next().value!);
          previews.set(previewId, { provider, bundle, tokenHash: hash(token), file, name, preview: plan.preview, expires: now + 10 * 60_000 });
          return { previewId, rows: plan.rows, markdown: sourceTextMarkdown(file.text), resource: file.origin!.resource };
        },
        async commit(bundle: string, id: unknown, authorize?: () => void) {
          const preview = typeof id === "string" ? previews.get(id) : undefined;
          const token = await readToken(provider);
          if (!preview || preview.provider !== provider || preview.bundle !== bundle || preview.expires <= Date.now() || !token || preview.tokenHash !== hash(token))
            throw new LiveSourceError("Preview the item again for this brain and connection.", 409);
          authorize?.();
          preview.commit ??= importPersonalSource(bundle, provider, preview.name, [preview.file], { preview: preview.preview, selected: [1] });
          try { return await preview.commit; }
          catch (error) { delete preview.commit; throw error; }
        },
      };
    },
    close() { previews.clear(); },
  };
}

export type LiveSources = ReturnType<typeof createLiveSources>;
export type LiveConnector = ReturnType<LiveSources["connector"]>;
