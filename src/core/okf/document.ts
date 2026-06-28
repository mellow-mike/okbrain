// The OKF document model: parse (frontmatter + body), serialize, validate.
// Reads are permissive (require only parseable YAML; tolerate unknown keys);
// writes emit conventional block-style YAML. Every concept write in later
// stages routes through serialize() here so the bundle stays conformant.

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

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * The permissive read-side requirement (CONTEXT §Frontmatter contract): a
 * conformant concept needs a non-empty string `type`. Stricter write-side
 * scaffolding (title/description/timestamp) lands with the writer in Stage 1.
 */
export function validate(doc: OkfDocument): ValidationResult {
  const errors: string[] = [];
  const type = doc.frontmatter.type;
  if (type === undefined) errors.push("missing required key: type");
  else if (typeof type !== "string" || type.trim() === "")
    errors.push("type must be a non-empty string");
  return { ok: errors.length === 0, errors };
}
