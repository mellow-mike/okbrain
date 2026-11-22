import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { join, posix } from "node:path";
import { rebaseBodyLinks, resolvePathField } from "../graph/links.ts";
import { protectUnsharedNote } from "../sync.ts";
import { listConcepts } from "./bundle.ts";
import { fmString, fmTags, OkfParseError, parse, serialize, type OkfDocument } from "./document.ts";
import { regenerateIndexBranches } from "./indexmd.ts";
import { assertConceptPathSpelling, inDbOnlyDir, isReservedName, validateId } from "./paths.ts";
import { nowTimestamp, writeFilingDocument } from "./write.ts";

export class InboxFilingError extends Error {}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const absent = (error: NodeJS.ErrnoException): undefined => {
  if (error.code !== "ENOENT") throw error;
  return undefined;
};

function portableId(id: string): void {
  validateId(id);
  const parts = id.split("/");
  if (id.length > 400 || id.endsWith(".md") || isReservedName(`${parts.at(-1)}.md`) || parts.some((part) =>
    !/^[a-z0-9][a-z0-9._-]{0,119}$/.test(part) || part.endsWith(".") || part === "node_modules" ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/.test(part)))
    throw new InboxFilingError("Use lowercase portable concept IDs such as projects/garden-note, without .md.");
}

/** Require ordinary files and directories, including the derived indexes refreshed for this filing. */
async function checkPaths(root: string, id: string, create: boolean): Promise<string | undefined> {
  const parts = id.split("/");
  const leaf = parts.pop()!;
  let folder = root;
  for (const part of [null, ...parts]) {
    if (part !== null) {
      folder = join(folder, part);
      const info = await lstat(folder).catch(absent);
      if (info && !info.isDirectory()) throw new InboxFilingError("Choose an ordinary folder inside this brain.");
      if (!info && !create) return undefined;
      if (!info) await mkdir(folder, { mode: inDbOnlyDir(id) ? 0o700 : undefined }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      if (!(await lstat(folder)).isDirectory()) throw new InboxFilingError("The filing folder changed. Preview again.");
    }
    const index = await lstat(join(folder, "index.md")).catch(absent);
    if (index && !index.isFile()) throw new InboxFilingError("The brain has a conflicting index path.");
  }
  const path = join(folder, `${leaf}.md`);
  const info = await lstat(path).catch(absent);
  if (info && (!info.isFile() || info.size > 16 * 1024 * 1024))
    throw new InboxFilingError("Filing supports regular Markdown files up to 16 MiB.");
  return info ? readFile(path, "utf8") : undefined;
}

function pathLink(id: string): string {
  return `/${id.split("/").map(encodeURIComponent).join("/")}.md`;
}

/** Keep source entries and their unknown fields, changing only a local path that needs rebasing. */
function relocateSources(doc: OkfDocument, id: string, known: Set<string>): void {
  const update = (source: unknown) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) return source;
    const entry = source as Record<string, unknown>;
    if (typeof entry.resource !== "string" || entry.resource.startsWith("/")) return source;
    const target = resolvePathField(id, entry.resource, known);
    if (!target || !known.has(target)) return source;
    const tail = entry.resource.search(/[?#]/);
    return { ...entry, resource: pathLink(target) + (tail < 0 ? "" : entry.resource.slice(tail)) };
  };
  const { sources } = doc.frontmatter;
  if (sources !== undefined) doc.frontmatter.sources = Array.isArray(sources) ? sources.map(update) : update(sources);
}

export interface InboxFiling {
  id: string;
  destination: string;
  preview: string;
  title: string;
  status: "ready" | "resume" | "filed";
}

/** Preview first. Publish the full note exclusively, then replace the original with a portable link. */
export async function fileInboxNote(bundle: string, id: string, destination: string, actor: string, approval?: string): Promise<InboxFiling> {
  portableId(id);
  portableId(destination);
  if (posix.dirname(id).split("/").at(-1) !== "inbox" || destination.split("/").includes("inbox"))
    throw new InboxFilingError("Select a captured inbox note and a destination outside the inbox.");
  if (inDbOnlyDir(id) !== inDbOnlyDir(destination))
    throw new InboxFilingError("File the note within its current privacy scope.");
  const root = await realpath(bundle);
  await assertConceptPathSpelling(root, id);
  await assertConceptPathSpelling(root, destination);
  const raw = await checkPaths(root, id, false);
  if (raw === undefined) throw new InboxFilingError("This capture is missing. Open the inbox and choose an existing note.");
  let doc: OkfDocument;
  try { doc = parse(raw); }
  catch (error) {
    if (error instanceof OkfParseError) throw new InboxFilingError("Repair the capture's YAML frontmatter before filing.");
    throw error;
  }
  const title = fmString(doc.frontmatter.title) || id;
  const result: InboxFiling = { id, destination, title, preview: digest([root, id, destination, actor, raw]), status: "ready" };
  const current = await checkPaths(root, destination, false);
  if (doc.frontmatter.type === "forwarding" && doc.frontmatter.filed_to === destination &&
      typeof doc.frontmatter.filing_preview === "string" && current !== undefined) {
    result.preview = doc.frontmatter.filing_preview;
    result.status = "filed";
  } else {
    const tags = fmTags(doc.frontmatter.tags);
    if (!tags.includes("inbox") || !fmString(doc.frontmatter.type) || !fmString(doc.frontmatter.description) || !fmString(doc.frontmatter.title))
      throw new InboxFilingError("Choose an unread capture with a type, title, and description.");
    if (Object.hasOwn(doc.frontmatter, "inbox_filing")) throw new InboxFilingError("The capture already contains filing metadata.");
    if (Array.isArray(doc.frontmatter.tags)) doc.frontmatter.tags = doc.frontmatter.tags.filter((tag) => tag !== "inbox");
    else delete doc.frontmatter.tags;
    doc.frontmatter.inbox_filing = { from: id, by: actor, preview: result.preview };
    doc.body = rebaseBodyLinks(id, destination, doc.body);
    if (doc.frontmatter.sources !== undefined) relocateSources(doc, id, new Set(await listConcepts(root)));
    if (current !== undefined) {
      if (current !== serialize(doc)) throw new InboxFilingError("A note already exists at that destination.");
      result.status = "resume";
    }
  }
  if (approval === undefined) return result;
  if (approval !== result.preview) throw new InboxFilingError("The capture, actor, brain, or destination changed. Preview the filing again.");
  if (result.status !== "filed") {
    if (doc.frontmatter.db_only === true && !inDbOnlyDir(id)) {
      await protectUnsharedNote(root, id);
      await protectUnsharedNote(root, destination);
    }
    const present = await checkPaths(root, destination, true);
    if (present !== undefined && present !== serialize(doc)) throw new InboxFilingError("A note already exists at that destination.");
    if (present === undefined && !await writeFilingDocument(root, destination, doc))
      throw new InboxFilingError("The destination changed. Preview the filing again.");
    if (await checkPaths(root, destination, false) !== serialize(doc))
      throw new InboxFilingError("The copy changed. The capture remains in the inbox.");
    const forward = {
      frontmatter: {
        type: "forwarding", title, description: "This captured note was filed.", status: "deprecated",
        generated: { by: actor, at: nowTimestamp() }, filed_to: destination, filing_preview: result.preview,
        ...(doc.frontmatter.db_only === true ? { db_only: true } : {}),
      },
      body: `Filed at [${destination}](${pathLink(destination)}).\n`,
    };
    await checkPaths(root, id, false);
    if (!await writeFilingDocument(root, id, forward, raw))
      throw new InboxFilingError("The capture changed after its copy was saved. Review both notes before continuing.");
    result.status = "filed";
  }
  await regenerateIndexBranches(root, [posix.dirname(id), posix.dirname(destination) === "." ? "" : posix.dirname(destination)]);
  return result;
}
