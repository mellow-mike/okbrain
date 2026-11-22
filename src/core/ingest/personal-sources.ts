import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, readdir } from "node:fs/promises";
import { basename, join, posix } from "node:path";
import { parseHTML } from "linkedom";
import { resolveLinkTarget, rewriteBodyLinks } from "../graph/links.ts";
import { readConceptPermissive } from "../okf/bundle.ts";
import { fmGenerated, fmSources, fmString, fmTags, isIsoInstant, OkfParseError, parse } from "../okf/document.ts";
import { regenerateIndexes } from "../okf/indexmd.ts";
import { OkfWriteError, writeConcept, type WriteConceptInput } from "../okf/write.ts";
import { TOOL_ACTOR } from "../version.ts";
import { clip } from "./capture.ts";
import { readCalendar, readMail, type OfflineItem } from "./mail-calendar.ts";

const IMPORT_ROOT = "db_only/imports";
const OFFLINE_KINDS = ["email", "calendar"] as const;
const KINDS = ["bookmarks", "markdown", "notion", "notion-live", ...OFFLINE_KINDS] as const;
export const MAX_SOURCE_UPLOAD_BYTES = 24 * 1024 * 1024;
export const MAX_SOURCE_FILES = 500;
export const MAX_SOURCE_ROWS = 2000;
export const MAX_OFFLINE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_OFFLINE_DRAFT_BYTES = 128 * 1024;

export type SourceKind = typeof KINDS[number];
type OfflineSourceKind = typeof OFFLINE_KINDS[number];
type HistoryKind = SourceKind | "chatgpt" | "claude";

export interface SourceUploadFile {
  path: string;
  text: string;
  bytes?: Uint8Array;
  origin?: { resource: string; id: string };
}

interface SourceRow {
  row: number;
  path: string;
  title?: string;
  id?: string;
  previous?: string;
  excerpt?: string;
  status: "new" | "changed" | "unchanged" | "skipped" | "imported";
  reason?: string;
}

interface Entry {
  row: number;
  path: string;
  key: string;
  identity: string;
  excerpt: string;
  note: Omit<WriteConceptInput, "id"> & { title: string };
}

interface Candidate {
  row: SourceRow;
  entry?: Entry;
}

interface ImportStamp {
  kind: SourceKind;
  source: string;
  run: string;
  at: string;
}

interface SourceHistoryItem {
  kind: HistoryKind;
  source: string;
  run: string;
  at: string | null;
  count: number;
  notes: { id: string; title: string }[];
}

export interface SourceUploadResult {
  rows: SourceRow[];
  preview: string;
  imported: string[];
}

export function isSourceKind(value: unknown): value is SourceKind {
  return typeof value === "string" && (KINDS as readonly string[]).includes(value);
}

export function isOfflineSourceKind(value: unknown): value is OfflineSourceKind {
  return value === "email" || value === "calendar";
}

const digest = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const display = (value: string, limit = 140): string => clip(value.replace(/[\s\p{Cc}]+/gu, " ").trim(), limit);
const markdownFile = /\.(?:md|markdown)$/i;
const offlineFile = { email: /\.eml$/i, calendar: /\.ics$/i };

function sourceLabel(value: string): string {
  const label = value.normalize("NFC").trim();
  if (!label || label.length > 80 || /\p{Cc}/u.test(label))
    throw new OkfWriteError("Enter a source name up to 80 characters.");
  return label;
}

function relativePath(value: string): string {
  const path = value.normalize("NFC");
  if (!path || path.length > 1024 || /[\\\p{Cc}]/u.test(path) ||
      path.split("/").some((part) => part === "" || part === "." || part === ".."))
    throw new OkfWriteError("Choose files with valid relative paths.");
  return path;
}

/** Browser file paths are descriptive only. Only these generated paths are opened. */
async function directoryEntries(root: string, dir: string): Promise<string[]> {
  let path = root;
  for (const segment of dir.split("/")) {
    path = join(path, segment);
    try {
      if (!(await lstat(path)).isDirectory())
        throw new OkfWriteError(`Source import destination must be a directory inside the brain: ${dir}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
  return (await readdir(path, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^[a-z0-9-]+\.md$/.test(entry.name))
    .map((entry) => entry.name.slice(0, -3))
    .filter((name) => name !== "index" && name !== "log")
    .sort();
}

function markdownEntry(kind: Exclude<SourceKind, "bookmarks">, file: SourceUploadFile, row: number): Candidate | Entry {
  if (!markdownFile.test(file.path))
    return { row: { row, path: file.path, status: "skipped", reason: "Only Markdown text is imported from this selection." } };
  let doc;
  try {
    doc = parse(file.text);
  } catch (error) {
    if (!(error instanceof OkfParseError)) throw error;
    doc = { frontmatter: {}, body: file.text.replace(/\r\n?/g, "\n") };
  }
  if (!doc.body.trim() && !Object.keys(doc.frontmatter).length)
    return { row: { row, path: file.path, status: "skipped", reason: "Empty Markdown file." } };

  const fm = doc.frontmatter;
  const stem = posix.basename(file.path).replace(markdownFile, "");
  const notionId = file.origin?.id ?? (kind === "notion" ? /(?:^| )([a-f0-9]{32})$/i.exec(stem)?.[1]?.toLowerCase() : undefined);
  const heading = /^#\s+(.+)$/m.exec(doc.body)?.[1];
  const title = display(fmString(fm.title) || heading || (kind === "notion" && notionId ? stem.slice(0, -32).trim() : stem)) || "Untitled note";
  const excerpt = display(doc.body, 240);
  const originalActor = fmGenerated(fm);
  return {
    row,
    path: file.path,
    key: notionId ?? file.path,
    identity: digest(JSON.stringify([file.path, file.text.replace(/\r\n?/g, "\n")])),
    excerpt,
    note: {
      title,
      type: display(fmString(fm.type), 80) || "note",
      description: display(fmString(fm.description) || doc.body.split("\n").find((line) => line.trim() && !line.startsWith("#")) || `Imported from ${file.path}.`, 160),
      body: doc.body,
      tags: [...new Set([...fmTags(fm.tags), kind, "imported"])],
      resource: file.origin?.resource ?? (fmString(fm.resource) || undefined),
      sources: [
        { id: file.origin ? "notion" : "export", resource: file.origin?.resource ?? `file-export:${kind}`, path: file.path, notion_page_id: notionId },
        ...fmSources(fm).filter((source) =>
          source.resource.trim() && (source.last_modified === undefined || isIsoInstant(source.last_modified))),
      ],
      extra: { ...fm, ...(originalActor ? { original_generated: originalActor } : {}) },
    },
  };
}

function bookmarkEntries(file: SourceUploadFile): (Candidate | Entry)[] {
  if (!/<!doctype\s+netscape-bookmark-file-1\b/i.test(file.text) && !/<dl[\s>]/i.test(file.text))
    throw new OkfWriteError("Choose a browser bookmarks HTML export.");
  const { document } = parseHTML(file.text);
  const folders = new WeakMap<object, string[]>();
  const nextFolder = new WeakMap<object, string>();
  const entries: (Candidate | Entry)[] = [];
  for (const element of document.querySelectorAll("dl,h3,a")) {
    const { localName } = element;
    const list = element.parentElement?.closest("dl");
    if (localName === "h3" && list) nextFolder.set(list, display(element.textContent ?? ""));
    if (localName === "dl") {
      if (!list) continue;
      const label = nextFolder.get(list);
      folders.set(element, [...(folders.get(list) ?? []), ...(label ? [label] : [])]);
      nextFolder.delete(list);
    }
    if (localName !== "a" || !list) continue;
    if (entries.length >= MAX_SOURCE_ROWS)
      throw new OkfWriteError(`Choose a bookmark export with up to ${MAX_SOURCE_ROWS.toLocaleString("en-US")} bookmarks.`);

    const row = entries.length + 1;
    const attr = (name: string): string | undefined => {
      const match = element.getAttributeNames().find((key: string) => key.toLowerCase() === name);
      return match ? element.getAttribute(match) ?? undefined : undefined;
    };
    const url = URL.parse(attr("href")?.trim() ?? "");
    if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.href.length > 2048) {
      entries.push({ row: { row, path: file.path, status: "skipped", reason: "Only HTTP and HTTPS bookmark addresses without credentials are supported." } });
      continue;
    }
    const title = display(element.textContent ?? "") || url.hostname;
    const folder = (folders.get(list) ?? []).join(" / ");
    const savedAt = attr("add_date");
    entries.push({
      row,
      path: folder ? `${file.path} · ${folder}` : file.path,
      key: url.href,
      identity: digest(JSON.stringify([url.href, title, folder, savedAt ?? null])),
      excerpt: url.href,
      note: {
        title,
        type: "reference",
        description: `Bookmark from ${url.hostname}.`,
        body: `<${url.href}>\n`,
        resource: url.href,
        tags: ["bookmark", "imported"],
        sources: [{ id: "export", resource: url.href, title, path: file.path, folder, saved_at_unix: savedAt }],
      },
    });
  }
  return entries;
}

function offlineEntry(kind: OfflineSourceKind, path: string, row: number, item: OfflineItem): Candidate | Entry {
  const text = [...item.details, ...(item.text ? ["", item.text] : [])].join("\n").trim();
  if (Buffer.byteLength(text) > MAX_OFFLINE_DRAFT_BYTES)
    return { row: { row, path, title: item.title, status: "skipped", reason: "Readable text exceeds 128 KiB." } };
  // Imported mail and calendar descriptions are plain text, even when their
  // source includes Markdown syntax that could render an external image.
  let fenceLength = 3;
  for (const [run] of text.matchAll(/~{3,}/g)) fenceLength = Math.max(fenceLength, run.length + 1);
  const fence = "~".repeat(fenceLength);
  const body = text ? `${fence}text\n${text}\n${fence}\n` : "";
  return {
    row, path, key: item.key, identity: digest(JSON.stringify(item)), excerpt: display(item.text || text, 240),
    note: { title: item.title, type: kind === "email" ? "email" : "event", description: display(item.text || text || item.title, 160), body,
      tags: [kind, "imported"], sources: [{ id: "export", resource: `file-export:${kind}`, path }] },
  };
}

async function offlineEntries(kind: OfflineSourceKind, files: SourceUploadFile[]): Promise<(Candidate | Entry)[]> {
  const entries: (Candidate | Entry)[] = [];
  for (const { path, text, bytes } of files) {
    const skip = (reason: string) => entries.push({ row: { row: entries.length + 1, path, status: "skipped", reason } });
    const file = bytes ?? text;
    if (!offlineFile[kind].test(path)) skip(kind === "email" ? "Choose an .eml message file." : "Choose an .ics calendar file.");
    else if ((bytes?.byteLength ?? Buffer.byteLength(text)) > MAX_OFFLINE_FILE_BYTES) skip("Choose files up to 2 MiB each.");
    else {
      let items: (OfflineItem | undefined)[] = [];
      try {
        items = kind === "email" ? [await readMail(file, path)] : readCalendar(
          typeof file === "string" ? file : new TextDecoder("utf-8", { fatal: true }).decode(file), MAX_SOURCE_ROWS + 1 - entries.length,
        );
      } catch { /* The preview reports invalid files without returning parser input or internal errors. */ }
      if (!items.length) skip(kind === "email" ? "Could not read this message." : "No readable calendar events found.");
      for (const item of items) {
        if (item) entries.push(offlineEntry(kind, path, entries.length + 1, item));
        else skip(kind === "email" ? "No readable message text found." : "This event has no valid identifier.");
      }
    }
    if (entries.length > MAX_SOURCE_ROWS) throw new OkfWriteError("Choose a selection with up to 2,000 items.");
  }
  return entries;
}

/** CLI-selected files stay local and use the same byte and row bounds as uploads. */
export async function readOfflineSourcePath(path: string, kind: OfflineSourceKind): Promise<SourceUploadFile[]> {
  try {
    const info = await lstat(path);
    const selection: string[] = [];
    if (info.isDirectory()) {
      for await (const entry of await opendir(path)) {
        if (!entry.isFile() || !offlineFile[kind].test(entry.name)) continue;
        if (selection.length === MAX_SOURCE_FILES) throw new OkfWriteError(`Choose between 1 and ${MAX_SOURCE_FILES} files.`);
        selection.push(join(path, entry.name));
      }
      selection.sort();
    } else if (info.isFile()) selection.push(path);
    else throw new OkfWriteError("Choose a local file or directory.");

    let total = 0;
    const files: SourceUploadFile[] = [];
    for (const file of selection) {
      const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stats = await handle.stat();
        if (!stats.isFile()) throw new OkfWriteError("Choose a regular local export file.");
        if (stats.size > MAX_OFFLINE_FILE_BYTES) throw new OkfWriteError("Choose files up to 2 MiB each.");
        total += stats.size;
        if (total > MAX_SOURCE_UPLOAD_BYTES) throw new OkfWriteError("Choose a selection up to 24 MiB.");
        const bytes = Buffer.allocUnsafe(stats.size + 1);
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        if (offset !== stats.size) throw new OkfWriteError("An export file changed while reading it. Preview the selection again.");
        files.push({ path: basename(file), text: "", bytes: bytes.subarray(0, offset) });
      } finally { await handle.close(); }
    }
    return files;
  } catch (error) {
    if (error instanceof OkfWriteError) throw error;
    throw new OkfWriteError("Could not read the selected local export files.");
  }
}

function isEntry(value: Candidate | Entry): value is Entry {
  return typeof value.row === "number";
}

function mapCandidates(dir: string, entries: (Candidate | Entry)[], names: string[]): Candidate[] {
  const versions = new Map<string, string[]>();
  const existing = new Set(names);
  for (const name of names) {
    const key = name.slice(0, 24);
    const known = versions.get(key) ?? [];
    known.push(name);
    versions.set(key, known);
  }
  const seen = new Set<string>();
  return entries.map((entry) => {
    if (!isEntry(entry)) return entry;
    const key = digest(entry.key).slice(0, 24);
    const row = { row: entry.row, path: entry.path, title: entry.note.title, excerpt: entry.excerpt };
    if (seen.has(key)) return { row: { ...row, status: "skipped", reason: "Duplicate item in this selection." } };
    seen.add(key);
    const name = `${key}-${entry.identity.slice(0, 24)}`;
    const id = `${dir}/${name}`;
    const prior = versions.get(key);
    if (existing.has(name)) return { entry, row: { ...row, id, status: "unchanged" } };
    return { entry, row: { ...row, id, previous: prior ? `${dir}/${prior[0]}` : undefined, status: prior ? "changed" : "new" } };
  });
}

function sourceMarkdown(body: string, path: string, targets: Map<string, string>): string {
  return rewriteBodyLinks(body, (match, raw) => {
    const target = resolveLinkTarget(path, raw);
    if (target === null) return match;
    const id = targets.get(`${target}.md`);
    if (!id) return match;
    const hash = raw.match(/#[^ ">|]*/)?.[0] ?? "";
    return `](/${id}.md${hash})`;
  });
}

/** Preview a bounded selection and write only explicitly selected private drafts. */
export async function importPersonalSource(
  root: string,
  kind: SourceKind,
  name: string,
  files: SourceUploadFile[],
  confirmation?: { preview: string; selected: number[] },
): Promise<SourceUploadResult> {
  const source = sourceLabel(name);
  if (!files.length || files.length > MAX_SOURCE_FILES)
    throw new OkfWriteError(`Choose between 1 and ${MAX_SOURCE_FILES} files.`);
  files = files.map((file) => ({ ...file, path: relativePath(file.path) }));
  if (kind === "bookmarks" && (files.length !== 1 || !/\.html?$/i.test(files[0]!.path)))
    throw new OkfWriteError("Choose one browser bookmarks HTML file.");
  if (files.reduce((size, file) => size + (file.bytes?.byteLength ?? Buffer.byteLength(file.text)), 0) > MAX_SOURCE_UPLOAD_BYTES)
    throw new OkfWriteError("Choose a selection up to 24 MiB.");
  const dir = `${IMPORT_ROOT}/${kind}-${digest(source).slice(0, 16)}`;
  const names = await directoryEntries(root, dir);
  const entries = kind === "bookmarks" ? bookmarkEntries(files[0]!) : isOfflineSourceKind(kind) ? await offlineEntries(kind, files) :
    files.map((file, index) => markdownEntry(kind, file, index + 1));
  const candidates = mapCandidates(dir, entries, names);
  const rows = candidates.map((candidate) => candidate.row);
  const preview = digest(JSON.stringify([
    root, kind, source, files.map(({ path, text, bytes, origin }) => [path, digest(bytes ?? text), origin]), rows,
  ]));
  const imported: string[] = [];
  if (!confirmation) return { rows, preview, imported };
  if (confirmation.preview !== preview)
    throw new OkfWriteError("The selected files or saved drafts changed. Preview this import again.");

  const selected = new Set(confirmation.selected);
  const planned = candidates.filter(({ row }) => selected.has(row.row) && (row.status === "new" || row.status === "changed"));
  if (!planned.length || planned.length !== selected.size || selected.size !== confirmation.selected.length)
    throw new OkfWriteError("Select the draft rows you want to import from this preview.");
  const targets = new Map<string, string>();
  for (const { row, entry } of candidates) {
    if (entry && row.id && (row.status === "unchanged" || selected.has(row.row))) {
      targets.set(entry.path, row.id);
      targets.set(entry.path.replace(markdownFile, ".md"), row.id);
    }
  }
  const stamp: ImportStamp = { kind, source, at: new Date().toISOString(), run: randomUUID() };
  try {
    for (const { row, entry } of planned) {
      const note = entry!.note;
      const id = row.id!;
      const written = await writeConcept(root, {
        ...note, id, status: "draft", actor: TOOL_ACTOR,
        body: kind === "bookmarks" || isOfflineSourceKind(kind) ? note.body : sourceMarkdown(note.body ?? "", entry!.path, targets),
        extra: { ...note.extra, source_import: { ...stamp, key: entry!.key } },
      }, { createOnly: true, deferIndex: true });
      row.status = written.created ? "imported" : "unchanged";
      if (written.created) imported.push(id);
    }
  } finally {
    if (imported.length) await regenerateIndexes(root, dir);
  }
  return { rows, preview, imported };
}

/** Import history is rebuilt from portable drafts, independently of the search index. */
export async function sourceHistory(root: string): Promise<SourceHistoryItem[]> {
  const groups = new Map<string, SourceHistoryItem>();
  const add = (kind: HistoryKind, source: string, run: string, at: string | null, id: string, title: string) => {
    const key = JSON.stringify([kind, source, run]);
    const item = groups.get(key) ?? { kind, source, run, at, count: 0, notes: [] };
    item.count++;
    if (item.notes.length < 5) item.notes.push({ id, title });
    groups.set(key, item);
  };
  const imports = join(root, "db_only", "imports");
  // Check the path before listing directories or reading user-editable drafts.
  await directoryEntries(root, IMPORT_ROOT);
  const children = await readdir(imports, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const child of children) {
    if (!child.isDirectory() || !/^(bookmarks|markdown|notion|notion-live|email|calendar)-[a-f0-9]{16}$/.test(child.name)) continue;
    const dir = `${IMPORT_ROOT}/${child.name}`;
    for (const name of await directoryEntries(root, dir)) {
      const id = `${dir}/${name}`;
      const { doc } = await readConceptPermissive(root, id);
      const fm = doc.frontmatter;
      const stamp = fm.source_import as Partial<ImportStamp> | null | undefined;
      if (!stamp || !isSourceKind(stamp.kind) || typeof stamp.source !== "string" || typeof stamp.run !== "string" || !isIsoInstant(stamp.at)) continue;
      add(stamp.kind, stamp.source, stamp.run, stamp.at, id, fmString(fm.title) || id);
    }
  }
  for (const provider of ["chatgpt", "claude"] as const) {
    const dir = `db_only/conversations/${provider}`;
    for (const name of await directoryEntries(root, dir)) {
      const id = `${dir}/${name}`;
      const { doc } = await readConceptPermissive(root, id);
      const fm = doc.frontmatter;
      const stamp = fm.source_import as Partial<ImportStamp> | null | undefined;
      const run = typeof stamp?.run === "string" ? stamp.run : "earlier";
      add(provider, provider === "chatgpt" ? "ChatGPT exports" : "Claude exports", run,
        isIsoInstant(stamp?.at) ? stamp.at : null, id, fmString(fm.title) || id);
    }
  }
  return [...groups.values()].sort((a, b) => (b.at ?? "").localeCompare(a.at ?? "") || a.source.localeCompare(b.source)).slice(0, 100);
}
