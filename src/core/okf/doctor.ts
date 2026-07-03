// OKF conformance checks (CONTEXT §Conformance checklist). Reads stay
// permissive everywhere else; doctor is the one strict surface. Errors are
// conformance violations; warnings flag what a permissive consumer must
// tolerate anyway (broken links, missing recommended keys, missing index.md).

import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { extractTargets } from "../graph/links.ts";
import { listMdFiles } from "./bundle.ts";
import { OkfParseError, parse, validate } from "./document.ts";
import { isReservedName, relPathToId } from "./paths.ts";

export interface Finding {
  severity: "error" | "warning";
  /**
   * Stable check id: frontmatter · type · recommended-keys · broken-link ·
   * index-frontmatter · okf-version · log-heading · log-order · missing-index
   */
  check: string;
  /** Bundle-relative forward-slash path the finding is about. */
  path: string;
  message: string;
}

export interface DoctorReport {
  /** No errors (warnings allowed). */
  ok: boolean;
  files: number;
  concepts: number;
  errors: number;
  warnings: number;
  findings: Finding[];
}

const RECOMMENDED = ["title", "description", "timestamp"] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const H2 = /^##[ \t]+(.+?)[ \t]*$/gm;

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

export async function runDoctor(root: string): Promise<DoctorReport> {
  const files = await listMdFiles(root);
  // Reserved ids included so links to an index.md/log.md aren't "broken".
  const known = new Set(files.map(relPathToId));
  const findings: Finding[] = [];
  const conceptDirs = new Set([""]); // root always expects an index.md
  let concepts = 0;

  for (const path of files) {
    const name = posix.basename(path);
    const reserved = isReservedName(name);
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
    if (!reserved) {
      for (const err of validate(doc).errors)
        findings.push({ severity: "error", check: "type", path, message: err });
      const missing = RECOMMENDED.filter((k) => {
        const v = doc.frontmatter[k];
        return v === undefined || v === "";
      });
      if (missing.length > 0)
        findings.push({
          severity: "warning",
          check: "recommended-keys",
          path,
          message: `missing recommended keys: ${missing.join(", ")}`,
        });
    } else if (name === "index.md") {
      if (path === "index.md") {
        const v = doc.frontmatter["okf_version"];
        if (typeof v !== "string" || v === "")
          findings.push({
            severity: "warning",
            check: "okf-version",
            path,
            message: "root index.md should declare okf_version in frontmatter",
          });
      } else if (Object.keys(doc.frontmatter).length > 0) {
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
    for (const target of extractTargets(relPathToId(path), doc.body))
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
    findings,
  };
}
