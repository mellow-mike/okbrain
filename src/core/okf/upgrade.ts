// v0.1 → v0.2 migration (`okb upgrade`, OKF SPEC §13): `timestamp` becomes
// `generated: { by, at }` under a stated actor, a `# Citations` body list
// becomes `sources` entries, okbrain's own `last_reviewed` stamp becomes a
// `verified` event, and clip's `author`/`published` extras move onto the
// page's source entry. Deterministic, idempotent, and a representation
// change only — writes are metadata-only (no new `generated` event, no
// per-concept log lines; one summary log entry instead).

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { listConcepts, readConceptPermissive } from "./bundle.ts";
import {
  asInstant,
  fmGenerated,
  fmSources,
  fmString,
  normalizeVerified,
  parse,
  serialize,
  type SourceEntry,
} from "./document.ts";
import { OKF_VERSION } from "./indexmd.ts";
import { appendLogEntry } from "./logmd.ts";
import { writeConcept, type WriteConceptInput } from "./write.ts";

export interface UpgradePlan {
  changes: string[];
  input: Omit<WriteConceptInput, "id">;
}

// A `# Citations` section: the heading through the next H1 (or EOF).
const CITATIONS_SECTION = /^#[ \t]+citations[ \t]*\n([\s\S]*?)(?=^#[ \t]|(?![\s\S]))/im;
const CITATION_LINE = /^[-*]\s+(?:\[([^\]]*)\]\(([^)\s]+)\)|(\S+))(?:\s+[—–-]\s+(.+))?\s*$/;

/** Parse a v0.1 citations list into source entries (bullets with a link or bare URL). */
export function parseCitations(section: string): SourceEntry[] {
  const out: SourceEntry[] = [];
  for (const line of section.split("\n")) {
    const m = CITATION_LINE.exec(line.trim());
    if (!m) continue;
    const entry: SourceEntry = { resource: (m[2] ?? m[3])! };
    if (m[1]) entry.title = m[1];
    if (m[4]) entry.author = m[4].trim();
    out.push(entry);
  }
  return out;
}

/** What `okb upgrade` would change for one parsed concept; null when nothing. */
export function planUpgrade(
  fm: Record<string, unknown>,
  body: string,
  actor: string,
): UpgradePlan | null {
  const changes: string[] = [];
  const input: Omit<WriteConceptInput, "id"> = { metadataOnly: true };

  if (fmGenerated(fm) === null && typeof fm.timestamp === "string" && fm.timestamp !== "") {
    const at = asInstant(fm.timestamp) ?? fm.timestamp;
    input.generated = { by: actor, at };
    changes.push("timestamp → generated");
  }

  const lr = fmString(fm.last_reviewed);
  if (lr !== "" && !normalizeVerified(fm).some((e) => e.by.startsWith("human:"))) {
    input.verify = { by: actor, at: asInstant(lr) ?? lr };
    changes.push("last_reviewed → verified");
  }

  let sources: SourceEntry[] | undefined;
  const m = CITATIONS_SECTION.exec(body);
  if (m) {
    const cited = parseCitations(m[1]!);
    const have = fmSources(fm);
    const knownRes = new Set(have.map((s) => s.resource));
    sources = [...have, ...cited.filter((c) => !knownRes.has(c.resource))];
    input.body = body.replace(CITATIONS_SECTION, "").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "\n");
    changes.push(`# Citations → sources (${cited.length})`);
  }

  // Clip's v0.1 extras belong on the page's own source entry (credibility signals).
  const extras: Record<string, unknown> = {};
  const page = (sources ?? fmSources(fm)).find((s) => s.resource === fm.resource);
  if (page && (typeof fm.author === "string" || fm.published !== undefined)) {
    sources ??= fmSources(fm);
    const entry = sources.find((s) => s.resource === fm.resource)!;
    if (typeof fm.author === "string" && fm.author !== "" && entry.author === undefined) {
      entry.author = fm.author;
      extras.author = undefined;
    }
    const published = asInstant(fm.published);
    if (published !== null && entry.last_modified === undefined) {
      entry.last_modified = published;
      extras.published = undefined;
    }
    if (Object.keys(extras).length > 0) changes.push("author/published → sources");
  }
  if (sources !== undefined && sources.length > 0) input.sources = sources;

  if (changes.length === 0) return null;
  // `extra` keys set to undefined delete the legacy key from the document.
  if (Object.keys(extras).length > 0) input.extra = extras;
  return { changes, input };
}

export interface UpgradeResult {
  dryRun: boolean;
  okfVersion: string;
  /** Root index.md declaration was (or would be) updated. */
  declared: boolean;
  upgraded: { id: string; changes: string[] }[];
  unchanged: number;
  /** Concepts skipped because their frontmatter does not parse. */
  skipped: string[];
}

/** Upgrade every concept in the bundle (or report what would change). */
export async function upgradeBundle(
  root: string,
  opts: { actor: string; dryRun?: boolean },
): Promise<UpgradeResult> {
  const dryRun = opts.dryRun === true;
  const result: UpgradeResult = { dryRun, okfVersion: OKF_VERSION, declared: false, upgraded: [], unchanged: 0, skipped: [] };

  for (const id of await listConcepts(root)) {
    const c = await readConceptPermissive(root, id);
    if (!c.parsed) {
      result.skipped.push(id);
      continue;
    }
    const plan = planUpgrade(c.doc.frontmatter, c.doc.body, opts.actor);
    if (plan === null) {
      result.unchanged++;
      continue;
    }
    if (!dryRun) await writeConcept(root, { id, ...plan.input });
    result.upgraded.push({ id, changes: plan.changes });
  }

  const indexPath = join(root, "index.md");
  let raw: string | null = null;
  try {
    raw = await readFile(indexPath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (raw !== null) {
    let doc;
    try {
      doc = parse(raw);
    } catch {
      doc = null; // unparseable root index: leave it to the generators / doctor
    }
    if (doc && doc.frontmatter.okf_version !== OKF_VERSION) {
      result.declared = true;
      if (!dryRun)
        await writeFile(
          indexPath,
          serialize({ frontmatter: { okf_version: OKF_VERSION, ...omit(doc.frontmatter, "okf_version") }, body: doc.body }),
          "utf8",
        );
    }
  }

  if (!dryRun && result.upgraded.length > 0)
    await appendLogEntry(
      root,
      `**Update**: upgraded ${result.upgraded.length} concept${result.upgraded.length === 1 ? "" : "s"} to OKF v${OKF_VERSION} (okb upgrade)`,
    );
  return result;
}

const omit = (o: Record<string, unknown>, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));
