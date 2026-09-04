// OKF v0.2 conformance checks (CONTEXT §Conformance checklist). Reads stay
// permissive everywhere else; doctor is the one strict surface. Errors are
// conformance violations (§11); warnings flag what a permissive consumer
// must tolerate anyway (broken links, missing recommended keys, malformed
// optional families, v0.1 leftovers) — and a signal summary (trust tiers,
// lifecycle, staleness) turns the walk into a health report.

import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { extractTargets, resolvePathField } from "../graph/links.ts";
import { listMdFiles } from "./bundle.ts";
import {
  fmSources,
  fmStatus,
  isActor,
  isIsoInstant,
  isStale,
  normalizeVerified,
  OkfParseError,
  parse,
  STATUSES,
  trustTier,
  validate,
  type Status,
  type TrustTier,
} from "./document.ts";
import { OKF_VERSION } from "./indexmd.ts";
import { isReservedName, relPathToId } from "./paths.ts";

export interface Finding {
  severity: "error" | "warning";
  /**
   * Stable check id: frontmatter · type · recommended-keys · broken-link ·
   * broken-source · legacy-timestamp · legacy-citations · generated-shape ·
   * verified-shape · status-value · stale-after-format · sources-shape ·
   * computation-runtime · index-frontmatter · okf-version · log-heading ·
   * log-order · missing-index
   */
  check: string;
  /** Bundle-relative forward-slash path the finding is about. */
  path: string;
  message: string;
}

export interface DoctorSignals {
  trust: Record<TrustTier, number>;
  status: Record<Status, number>;
  /** Concepts past their `stale_after`. */
  stale: number;
  /** Concepts still carrying v0.1 conventions (`timestamp` / `# Citations`). */
  legacy: number;
}

export interface DoctorReport {
  /** No errors (warnings allowed). */
  ok: boolean;
  files: number;
  concepts: number;
  errors: number;
  warnings: number;
  /** `okf_version` declared by the root index.md, if any. */
  okfVersion: string | null;
  signals: DoctorSignals;
  findings: Finding[];
}

const RECOMMENDED = ["title", "description"] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const H2 = /^##[ \t]+(.+?)[ \t]*$/gm;
const CITATIONS = /^#[ \t]+citations[ \t]*$/im;
const COMPUTATION_TYPE = "attested computation";

// log.md structure: `## YYYY-MM-DD` headings, newest first.
function checkLog(path: string, body: string, findings: Finding[]): void {
  let prev: string | undefined;
  let misordered = false;
  for (const m of body.matchAll(H2)) {
    const h = m[1]!;
    if (!DATE.test(h)) {
      findings.push({
        severity: "error",
        check: "log-heading",
        path,
        message: `log headings must be \`## YYYY-MM-DD\`, found "## ${h}"`,
      });
    } else {
      if (prev !== undefined && h > prev) misordered = true;
      prev = h;
    }
  }
  if (misordered)
    findings.push({
      severity: "warning",
      check: "log-order",
      path,
      message: "date headings are not newest-first",
    });
}

/** The v0.2 optional families (§5, §10): malformed shapes are warnings, never fatal. */
function checkFamilies(
  path: string,
  fm: Record<string, unknown>,
  body: string,
  findings: Finding[],
): void {
  const warn = (check: string, message: string): void =>
    void findings.push({ severity: "warning", check, path, message });

  if (fm.timestamp !== undefined && fm.generated === undefined)
    warn("legacy-timestamp", "v0.1 `timestamp` is superseded by `generated.at` in OKF v0.2 (okb upgrade converts it)");
  if (CITATIONS.test(body))
    warn("legacy-citations", "v0.1 `# Citations` section — provenance belongs in `sources` frontmatter (okb upgrade converts it)");

  if (fm.generated !== undefined) {
    const g = fm.generated as Record<string, unknown> | null;
    if (typeof g !== "object" || g === null || Array.isArray(g) || typeof g.by !== "string" || g.by === "")
      warn("generated-shape", "`generated` must be a mapping with a `by` actor");
    else {
      if (!isActor(g.by)) warn("generated-shape", `generated.by is not an actor (human:<id>, process:<id>, <producer>/<version>): ${g.by}`);
      if (g.at !== undefined && !isIsoInstant(g.at)) warn("generated-shape", `generated.at must be an ISO 8601 instant with offset: ${String(g.at)}`);
    }
  }
  if (fm.verified !== undefined) {
    const events = normalizeVerified(fm);
    const raw = Array.isArray(fm.verified) ? fm.verified : [fm.verified];
    if (events.length < raw.length) warn("verified-shape", "every `verified` entry needs a `by` actor");
    for (const e of events) {
      if (!isActor(e.by)) warn("verified-shape", `verified.by is not an actor: ${e.by}`);
      if (e.at !== undefined && !isIsoInstant(e.at)) warn("verified-shape", `verified.at must be an ISO 8601 instant with offset: ${e.at}`);
    }
  }
  if (fm.status !== undefined && !(STATUSES as readonly unknown[]).includes(fm.status))
    warn("status-value", `status must be one of ${STATUSES.join(" | ")}: ${String(fm.status)}`);
  if (fm.stale_after !== undefined && !isIsoInstant(fm.stale_after))
    warn("stale-after-format", `stale_after must be an ISO 8601 instant with offset (a bare date is ignored): ${String(fm.stale_after)}`);
  if (fm.sources !== undefined) {
    const entries = fmSources(fm);
    const raw = Array.isArray(fm.sources) ? fm.sources : [fm.sources];
    if (entries.length < raw.length) warn("sources-shape", "every `sources` entry needs a `resource`");
    for (const s of entries)
      if (s.last_modified !== undefined && !isIsoInstant(s.last_modified))
        warn("sources-shape", `sources[${s.id ?? "?"}].last_modified must be an ISO 8601 instant with offset`);
  }
  if (String(fm.type ?? "").toLowerCase() === COMPUTATION_TYPE && (typeof fm.runtime !== "string" || fm.runtime === ""))
    warn("computation-runtime", "an Attested Computation requires `runtime` (§10.2)");
}

export async function runDoctor(root: string, now: Date = new Date()): Promise<DoctorReport> {
  const files = await listMdFiles(root);
  // Reserved ids included so links to an index.md/log.md aren't "broken".
  const known = new Set(files.map(relPathToId));
  const findings: Finding[] = [];
  const conceptDirs = new Set([""]); // root always expects an index.md
  const signals: DoctorSignals = {
    trust: { unverified: 0, "machine-confirmed": 0, "human-reviewed": 0 },
    status: { draft: 0, stable: 0, deprecated: 0 },
    stale: 0,
    legacy: 0,
  };
  let okfVersion: string | null = null;
  let concepts = 0;

  for (const path of files) {
    const name = posix.basename(path);
    const reserved = isReservedName(name);
    const id = relPathToId(path);
    if (!reserved) {
      concepts++;
      const dir = posix.dirname(path);
      conceptDirs.add(dir === "." ? "" : dir);
    }
    const raw = await readFile(join(root, ...path.split("/")), "utf8");
    let doc;
    try {
      doc = parse(raw);
    } catch (e) {
      if (!(e instanceof OkfParseError)) throw e;
      findings.push({ severity: "error", check: "frontmatter", path, message: e.message });
      continue;
    }
    const fm = doc.frontmatter;
    if (!reserved) {
      for (const err of validate(doc).errors)
        findings.push({ severity: "error", check: "type", path, message: err });
      const missing = RECOMMENDED.filter((k) => fm[k] === undefined || fm[k] === "");
      if (missing.length > 0)
        findings.push({
          severity: "warning",
          check: "recommended-keys",
          path,
          message: `missing recommended keys: ${missing.join(", ")}`,
        });
      const before = findings.length;
      checkFamilies(path, fm, doc.body, findings);
      if (findings.slice(before).some((f) => f.check.startsWith("legacy-"))) signals.legacy++;
      signals.trust[trustTier(fm)]++;
      signals.status[fmStatus(fm)]++;
      if (isStale(fm, now)) signals.stale++;
      for (const s of fmSources(fm)) {
        const target = resolvePathField(id, s.resource, known);
        if (target !== null && !known.has(target))
          findings.push({
            severity: "warning",
            check: "broken-source",
            path,
            message: `sources[${s.id ?? "?"}] names a concept that does not exist: ${s.resource}`,
          });
      }
    } else if (name === "index.md") {
      if (path === "index.md") {
        const v = fm["okf_version"];
        if (typeof v !== "string" || v === "")
          findings.push({
            severity: "warning",
            check: "okf-version",
            path,
            message: `root index.md should declare okf_version: "${OKF_VERSION}" in frontmatter`,
          });
        else {
          okfVersion = v;
          if (v !== OKF_VERSION)
            findings.push({
              severity: "warning",
              check: "okf-version",
              path,
              message: `bundle declares okf_version ${v}; okb writes OKF ${OKF_VERSION} (okb upgrade updates the declaration)`,
            });
        }
      } else if (Object.keys(fm).length > 0) {
        findings.push({
          severity: "error",
          check: "index-frontmatter",
          path,
          message: "frontmatter is only allowed in the root index.md",
        });
      }
    } else {
      checkLog(path, doc.body, findings);
    }
    for (const target of extractTargets(id, doc.body))
      if (!known.has(target))
        findings.push({
          severity: "warning",
          check: "broken-link",
          path,
          message: `broken internal link: /${target}.md`,
        });
  }

  for (const dir of [...conceptDirs].sort()) {
    const idx = dir === "" ? "index.md" : `${dir}/index.md`;
    if (!known.has(relPathToId(idx)))
      findings.push({
        severity: "warning",
        check: "missing-index",
        path: idx,
        message: "directory with concepts has no index.md",
      });
  }

  const errors = findings.filter((f) => f.severity === "error").length;
  return {
    ok: errors === 0,
    files: files.length,
    concepts,
    errors,
    warnings: findings.length - errors,
    okfVersion,
    signals,
    findings,
  };
}
