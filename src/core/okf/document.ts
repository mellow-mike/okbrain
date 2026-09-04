// The OKF document model: parse (frontmatter + body), serialize, validate,
// and the OKF v0.2 frontmatter families (provenance/trust/lifecycle) as pure
// readers. Reads are permissive (require only parseable YAML; tolerate
// unknown keys); writes emit conventional block-style YAML. Every concept
// write routes through serialize() here so the bundle stays conformant.

import { parse as yamlParse, stringify as yamlStringify } from "yaml";

export interface OkfDocument {
  /** Parsed YAML frontmatter; unknown keys preserved verbatim on round-trip. */
  frontmatter: Record<string, unknown>;
  /** Everything after the closing `---`, preserved as-is. */
  body: string;
}

export class OkfParseError extends Error {}

// Opening `---` line, lazily-captured YAML, then a closing `---` line. Tolerant
// of empty frontmatter (`---\n---`) and a missing trailing newline at EOF.
const FRONTMATTER = /^---\n([\s\S]*?)\n?---[ \t]*(?:\n|$)/;

/** Normalize line endings (accept CRLF) and strip a leading BOM. */
function normalize(raw: string): string {
  const noBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return noBom.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function parse(raw: string): OkfDocument {
  const text = normalize(raw);
  const m = FRONTMATTER.exec(text);
  if (!m) return { frontmatter: {}, body: text };

  let data: unknown;
  try {
    data = yamlParse(m[1]!);
  } catch (e) {
    throw new OkfParseError(
      `unparseable YAML frontmatter: ${(e as Error).message}`,
    );
  }

  const body = text.slice(m[0].length);
  if (data == null) return { frontmatter: {}, body };
  if (typeof data !== "object" || Array.isArray(data))
    throw new OkfParseError("frontmatter must be a YAML mapping");
  return { frontmatter: data as Record<string, unknown>, body };
}

export function serialize(doc: OkfDocument): string {
  if (Object.keys(doc.frontmatter).length === 0) return doc.body;
  // lineWidth: 0 disables folding so long descriptions/URLs stay on one line
  // (stable diffs); yamlStringify emits block style and a trailing newline.
  const yaml = yamlStringify(doc.frontmatter, { lineWidth: 0 });
  return `---\n${yaml}---\n${doc.body}`;
}

/** Coerce a frontmatter value to a string (`""` when absent or non-string). */
export const fmString = (v: unknown): string => (typeof v === "string" ? v : "");

/** Coerce frontmatter `tags` to a string array (a bare string is one tag). */
export function fmTags(v: unknown): string[] {
  if (typeof v === "string" && v.trim() !== "") return [v];
  if (Array.isArray(v)) return v.filter((t): t is string => typeof t === "string");
  return [];
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * The permissive read-side requirement (OKF v0.2 §11): a conformant concept
 * needs a non-empty string `type`; everything else is optional.
 */
export function validate(doc: OkfDocument): ValidationResult {
  const errors: string[] = [];
  const type = doc.frontmatter.type;
  if (type === undefined) errors.push("missing required key: type");
  else if (typeof type !== "string" || type.trim() === "")
    errors.push("type must be a non-empty string");
  return { ok: errors.length === 0, errors };
}

// ---- OKF v0.2 families (§5, §7) ---------------------------------------------

/** `generated` / `verified[]` entries: an actor (§7) and an ISO 8601 instant. */
export interface ActorEvent {
  by: string;
  at?: string;
}

/** One `sources` entry (§5.1); `resource` is the only required member. */
export interface SourceEntry {
  resource: string;
  id?: string;
  title?: string;
  author?: string;
  usage_count?: number;
  last_modified?: string;
  [key: string]: unknown;
}

export const STATUSES = ["draft", "stable", "deprecated"] as const;
export type Status = (typeof STATUSES)[number];

export type TrustTier = "unverified" | "machine-confirmed" | "human-reviewed";

/** ISO 8601 datetime with an explicit UTC offset (`Z` or ±hh:mm), as §5 requires. */
export const isIsoInstant = (v: unknown): v is string =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(v) &&
  !Number.isNaN(Date.parse(v));

/** Any parseable date/time as an ISO 8601 UTC instant (second precision); null when it won't parse. */
export function asInstant(v: unknown): string | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  if (isIsoInstant(v)) return v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The actor convention (§7): `<producer>/<version>`, `human:<id>`, `process:<id>`. */
export const isActor = (v: unknown): v is string =>
  typeof v === "string" && /^(?:human:\S+|process:\S+|[^\s/:]+\/\S+)$/.test(v);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const asEvent = (v: unknown): ActorEvent | null => {
  if (!isRecord(v) || typeof v.by !== "string" || v.by === "") return null;
  return typeof v.at === "string" ? { by: v.by, at: v.at } : { by: v.by };
};

/** `generated` as an event, or null when absent/malformed. */
export const fmGenerated = (fm: Record<string, unknown>): ActorEvent | null =>
  asEvent(fm.generated);

/**
 * `verified` events as a list (§5.2): a bare `{ by, at }` mapping MUST be
 * treated as a one-element list; malformed entries are dropped.
 */
export function normalizeVerified(fm: Record<string, unknown>): ActorEvent[] {
  const v = fm.verified;
  const raw = Array.isArray(v) ? v : v === undefined ? [] : [v];
  return raw.map(asEvent).filter((e): e is ActorEvent => e !== null);
}

/** Trust tier derived from `verified` (§5.3). */
export function trustTier(fm: Record<string, unknown>): TrustTier {
  const events = normalizeVerified(fm);
  if (events.length === 0) return "unverified";
  return events.some((e) => e.by.startsWith("human:")) ? "human-reviewed" : "machine-confirmed";
}

/** Latest `verified[].at` (optionally human actors only); null when none. */
export function lastVerifiedAt(fm: Record<string, unknown>, humanOnly = false): string | null {
  let latest: string | null = null;
  for (const e of normalizeVerified(fm)) {
    if (humanOnly && !e.by.startsWith("human:")) continue;
    if (e.at !== undefined && (latest === null || e.at > latest)) latest = e.at;
  }
  return latest;
}

/** Lifecycle status (§5.4); absent ⇒ `stable`, unknown values fall back to stable. */
export function fmStatus(fm: Record<string, unknown>): Status {
  const s = fm.status;
  return (STATUSES as readonly unknown[]).includes(s) ? (s as Status) : "stable";
}

/**
 * Stale per `stale_after` (§5.5): `now >= stale_after`. A value that is not
 * an ISO instant with an explicit offset (e.g. a bare date) is ignored rather
 * than guessed at — it names a different instant in every timezone.
 */
export function isStale(fm: Record<string, unknown>, now: Date = new Date()): boolean {
  const v = fm.stale_after;
  return isIsoInstant(v) && now.getTime() >= Date.parse(v);
}

/**
 * When the content last changed: `generated.at` (§5.2), falling back to the
 * v0.1 `timestamp` key (§13.1). Null when neither is present.
 */
export function generatedAt(fm: Record<string, unknown>): string | null {
  return fmGenerated(fm)?.at ?? (fmString(fm.timestamp) || null);
}

/**
 * `sources` entries (§5.1) as a list: a bare mapping is one entry; entries
 * without a string `resource` are dropped.
 */
export function fmSources(fm: Record<string, unknown>): SourceEntry[] {
  const v = fm.sources;
  const raw = Array.isArray(v) ? v : v === undefined ? [] : [v];
  return raw.filter(
    (s): s is SourceEntry => isRecord(s) && typeof s.resource === "string" && s.resource !== "",
  );
}
