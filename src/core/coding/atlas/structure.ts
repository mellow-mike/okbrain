// Deterministic source structure for the repository atlas: declarations,
// imports, and line-ranged units. Everything here is line-based pattern
// matching with fixed caps, so a hostile or generated file costs bounded time
// and a wrong guess only makes one unit boundary less tidy.

import { posix } from "node:path";
import { addTerms } from "./text.ts";

export const roles = ["impl", "test", "doc", "config", "types", "entry", "build", "schema"] as const;
export type Role = typeof roles[number];

export interface SourceSymbol {
  name: string;
  kind: string;
  /** Zero-based line of the declaration. */
  line: number;
  nested: boolean;
  exported: boolean;
}

export interface SourceUnit {
  kind: "symbol" | "section" | "block" | "header";
  name: string;
  /** One-based inclusive line range. */
  startLine: number;
  endLine: number;
  gist: string;
  role: Role;
  symbols: string[];
  /** Terms of the declared names, and of the unit's text. The importer adds the path. */
  names: Map<string, number>;
  body: Map<string, number>;
}

export interface SourceFile {
  language: string;
  role: Role;
  gist: string;
  lines: number;
  imports: string[];
  symbols: SourceSymbol[];
  units: SourceUnit[];
}

const maxAnalyzedLines = 6000;
const maxLineLength = 600;
const maxUnitsPerFile = 256;
const maxUnitLines = 120;
const splitUnitLines = 80;
const minUnitLines = 8;
const mergeUnitLines = 40;
const blockLines = 60;
const maxUnitTextBytes = 8 * 1024;
const maxImports = 64;

const extensions: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", pyi: "python", go: "go", rs: "rust", java: "java", kt: "kotlin", kts: "kotlin", cs: "csharp",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp", m: "objc", mm: "objc",
  rb: "ruby", php: "php", swift: "swift", scala: "scala", sc: "scala", dart: "dart", ex: "elixir", exs: "elixir", lua: "lua",
  sh: "shell", bash: "shell", zsh: "shell", fish: "shell", ps1: "shell",
  md: "doc", mdx: "doc", markdown: "doc", rst: "doc", txt: "doc", adoc: "doc",
  json: "config", jsonc: "config", json5: "config", yaml: "config", yml: "config", toml: "config", ini: "config", cfg: "config",
  conf: "config", properties: "config", xml: "config", plist: "config", editorconfig: "config",
  sql: "sql", proto: "proto", graphql: "graphql", gql: "graphql", prisma: "schema", thrift: "proto", avsc: "schema",
  html: "markup", htm: "markup", vue: "markup", svelte: "markup", astro: "markup", css: "style", scss: "style", less: "style",
  tf: "terraform", hcl: "terraform", gradle: "build", bzl: "build", mk: "build", cmake: "build", nix: "build", r: "r", jl: "julia",
  zig: "zig", nim: "nim", clj: "clojure", erl: "erlang", hs: "haskell", ml: "ocaml", fs: "fsharp", vb: "vb", pl: "perl", pm: "perl",
};
const fileNames: Record<string, string> = {
  makefile: "build", gnumakefile: "build", dockerfile: "build", containerfile: "build", jenkinsfile: "build", "cmakelists.txt": "build",
  build: "build", "build.bazel": "build", workspace: "build", "workspace.bazel": "build", justfile: "build", procfile: "build",
  rakefile: "ruby", gemfile: "ruby", codeowners: "config", readme: "doc", license: "doc", changelog: "doc", contributing: "doc",
};
// Tracked text that carries no navigable structure and would only dilute the index.
const skippedExtensions = new Set(["svg", "csv", "tsv", "snap", "ipynb", "po", "pot", "pbxproj", "lock", "sum", "resx", "xlf", "geojson"]);

export function languageOf(path: string): string | undefined {
  const base = posix.basename(path).toLowerCase();
  const named = fileNames[base] ?? fileNames[base.replace(/\.[^.]+$/u, "")];
  const dot = base.lastIndexOf(".");
  const extension = dot > 0 ? base.slice(dot + 1) : "";
  if (skippedExtensions.has(extension)) return undefined;
  if (base.startsWith("dockerfile.") || base.endsWith(".dockerfile")) return "build";
  return extensions[extension] ?? named ?? (dot <= 0 ? undefined : "text");
}

const testPath = /(?:^|\/)(?:tests?|__tests__|spec|specs|e2e|testing|testdata|fixtures?|__mocks__|mocks)\//iu;
const testFile = /(?:[._-](?:test|spec|tests|e2e)\.[^./]+$|_test\.(?:go|py|rs|rb|exs?)$|^test_[^/]*\.py$|(?:Test|Tests|Spec|IT)\.(?:java|kt|cs|scala|swift)$|_spec\.rb$)/u;
const entryStem = /^(?:index|main|mod|lib|__init__|__main__|app|server|cli|program|application|root|setup)$/iu;

export function roleOf(path: string, language: string): Role {
  const base = posix.basename(path);
  const lower = path.toLowerCase();
  if (testPath.test(`/${path}`) || testFile.test(base)) return "test";
  if (language === "doc") return "doc";
  if (language === "sql" || language === "proto" || language === "graphql" || language === "schema" || /(?:^|\/)(?:migrations?|schemas?)\//u.test(lower)) return "schema";
  if (language === "build" || language === "terraform" || /(?:^|\/)(?:\.github|\.circleci|\.gitlab|ci|scripts|tools|build|deploy|infra)\//u.test(lower)
    || /(?:^|\/)(?:webpack|vite|rollup|esbuild|babel|jest|vitest|playwright|eslint|prettier|tsup|turbo|nx)\.config\.[^/]+$/u.test(lower)) return "build";
  if (language === "config") return "config";
  if (/\.d\.[cm]?ts$/u.test(lower) || /(?:^|\/)(?:types?|typings|interfaces?|models?|dto|entities)(?:\.[^/]+|\/[^/]+)$/u.test(lower)) return "types";
  if (entryStem.test(base.replace(/\.[^.]+$/u, ""))) return "entry";
  return "impl";
}

interface Pattern {
  re: RegExp;
  /** Capture group holding the name. */
  name: number;
  /** A fixed kind, or the capture group that names it. */
  kind: string | number;
  /** Only meaningful at this indentation: "top" is column zero, "nested" is indented. */
  at?: "top" | "nested";
  /** A fixed export flag, or derived from the matched line by the language rule. */
  exported?: boolean;
}

const control = new Set(["if", "for", "while", "switch", "catch", "return", "else", "do", "try", "function", "with", "foreach", "elif", "match", "when", "using", "lock", "new", "throw", "typeof", "await", "yield", "super", "this", "delete", "sizeof", "assert"]);
const identifier = "[\\p{L}_$][\\p{L}\\p{N}_$]*";

const scriptPatterns: Pattern[] = [
  // The lookahead keeps `type A, type B` inside a wrapped import list from reading as a declaration.
  { re: new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?(function\\*?|class|interface|type|enum|namespace|module)\\s+(${identifier})(?=\\s*(?:[<({=:]|extends\\b|implements\\b|$))`, "u"), name: 2, kind: 1 },
  { re: new RegExp(`^(?:export\\s+)?(?:declare\\s+)?(const|let|var)\\s+(${identifier})\\s*(?::[^=]{1,200})?=`, "u"), name: 2, kind: 1, at: "top" },
  { re: new RegExp(`^\\s+(?:(?:public|private|protected|static|readonly|abstract|override|async|get|set)\\s+)*(#?${identifier})\\s*(?:<[^>()]{0,120}>)?\\s*\\([^)]{0,300}\\)?[^;=]*\\{\\s*$`, "u"), name: 1, kind: "method", at: "nested" },
];
const pythonPatterns: Pattern[] = [
  { re: /^\s*(?:async\s+)?(def)\s+([A-Za-z_][A-Za-z0-9_]*)/u, name: 2, kind: "function" },
  { re: /^\s*(class)\s+([A-Za-z_][A-Za-z0-9_]*)/u, name: 2, kind: "class" },
  { re: /^([A-Z][A-Z0-9_]{2,})\s*(?::[^=]{1,120})?=(?!=)/u, name: 1, kind: "const", at: "top" },
];
const goPatterns: Pattern[] = [
  { re: /^func\s+(?:\([^)]{0,200}\)\s+)?([A-Za-z_][A-Za-z0-9_]*)/u, name: 1, kind: "function", at: "top" },
  { re: /^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(struct|interface)?/u, name: 1, kind: "type", at: "top" },
  { re: /^(var|const)\s+([A-Za-z_][A-Za-z0-9_]*)/u, name: 2, kind: 1, at: "top" },
];
const rustPatterns: Pattern[] = [
  { re: /^\s*(?:pub(?:\([^)]{0,40}\))?\s+)?(?:default\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?(fn|struct|enum|trait|type|const|static|mod|union)\s+([A-Za-z_][A-Za-z0-9_]*)/u, name: 2, kind: 1 },
  { re: /^\s*impl(?:<[^>]{0,200}>)?\s+(?:[\w:<>,'\s]{1,200}\s+for\s+)?([A-Za-z_][A-Za-z0-9_]*)/u, name: 1, kind: "impl" },
  { re: /^\s*macro_rules!\s+([A-Za-z_][A-Za-z0-9_]*)/u, name: 1, kind: "macro" },
];
const modifiers = "public|private|protected|internal|abstract|final|sealed|static|open|data|partial|inline|value|case|actor|indirect|fileprivate|override|suspend|virtual|async|synchronized|native|unsafe|extern|mutating|required|convenience|export|external|lateinit|readonly|strictfp|transient|volatile|default|new|operator|infix|tailrec";
const objectPatterns: Pattern[] = [
  { re: new RegExp(`^\\s*(?:@[\\w.]+(?:\\([^)]{0,200}\\))?\\s+)*(?:(?:${modifiers})\\s+)*(class|interface|enum|record|struct|object|trait|protocol|extension|namespace|mixin|typealias)\\s+(${identifier})`, "u"), name: 2, kind: 1 },
  { re: new RegExp(`^\\s*(?:(?:${modifiers})\\s+)*(fun|func|def)\\s+(?:<[^>]{0,120}>\\s*)?(?:[\\w.<>?,\\s]{1,80}\\.)?(${identifier})\\s*[(<\\[]`, "u"), name: 2, kind: "function" },
  { re: new RegExp(`^\\s+(?:(?:${modifiers})\\s+)+(?:<[^>]{0,120}>\\s*)?[\\w.<>\\[\\],?\\s]{1,120}?\\s+(${identifier})\\s*\\([^;]*$`, "u"), name: 1, kind: "method", at: "nested" },
];
const cPatterns: Pattern[] = [
  { re: /^\s*(?:template\s*<[^>]{0,200}>\s*)?(class|struct|union|namespace|enum(?:\s+class)?)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:[:{]|$)/u, name: 2, kind: 1 },
  { re: /^#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)/u, name: 1, kind: "macro", at: "top" },
  { re: /^(?!(?:typedef|using|return|static_assert|extern\s+"C")\b)[A-Za-z_][\w\s*&:<>,~]{0,200}?[\s*&]([A-Za-z_~][A-Za-z0-9_:~]*)\s*\([^;]*$/u, name: 1, kind: "function", at: "top" },
  { re: /^[-+]\s*\([^)]{1,80}\)\s*([A-Za-z_][A-Za-z0-9_]*)/u, name: 1, kind: "method", at: "top" },
];
const rubyPatterns: Pattern[] = [
  { re: /^\s*def\s+(?:self\.)?([A-Za-z_][A-Za-z0-9_]*[?!=]?)/u, name: 1, kind: "function" },
  { re: /^\s*(class|module)\s+([A-Z][A-Za-z0-9_:]*)/u, name: 2, kind: 1 },
];
const phpPatterns: Pattern[] = [
  { re: /^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+&?([A-Za-z_][A-Za-z0-9_]*)/u, name: 1, kind: "function" },
  { re: /^\s*(?:abstract\s+|final\s+|readonly\s+)*(class|interface|trait|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/u, name: 2, kind: 1 },
];
const shellPatterns: Pattern[] = [
  { re: /^(?:function\s+)?([A-Za-z_][A-Za-z0-9_-]*)\s*\(\)\s*\{?\s*$/u, name: 1, kind: "function", at: "top" },
  { re: /^function\s+([A-Za-z_][A-Za-z0-9_-]*)/u, name: 1, kind: "function", at: "top" },
];
const families: Record<string, Pattern[]> = {
  typescript: scriptPatterns, javascript: scriptPatterns, markup: scriptPatterns, python: pythonPatterns, go: goPatterns, rust: rustPatterns,
  java: objectPatterns, kotlin: objectPatterns, csharp: objectPatterns, scala: objectPatterns, swift: objectPatterns, dart: objectPatterns,
  c: cPatterns, cpp: cPatterns, objc: cPatterns, ruby: rubyPatterns, php: phpPatterns, shell: shellPatterns,
  sql: [{ re: /^\s*create\s+(?:or\s+replace\s+)?(?:unique\s+)?(?:materialized\s+)?(?:temp(?:orary)?\s+)?(table|view|function|procedure|index|trigger|type|schema)\s+(?:if\s+not\s+exists\s+)?["`[]?([\w.]+)/iu, name: 2, kind: 1 }],
  proto: [{ re: /^\s*(message|service|enum|rpc|struct|exception)\s+([A-Za-z_][A-Za-z0-9_]*)/u, name: 2, kind: 1 }],
  graphql: [{ re: /^(?:extend\s+)?(type|input|interface|enum|union|scalar|query|mutation|subscription|fragment|directive)\s+@?([A-Za-z_][A-Za-z0-9_]*)/u, name: 2, kind: 1, at: "top" }],
  schema: [{ re: /^(model|enum|type|datasource|generator|view)\s+([A-Za-z_][A-Za-z0-9_]*)/u, name: 2, kind: 1, at: "top" }],
  elixir: [{ re: /^\s*(defmodule|defmacro|defprotocol|defp?)\s+([A-Za-z_][A-Za-z0-9_.?!]*)/u, name: 2, kind: 1 }],
  lua: [{ re: /^(?:local\s+)?function\s+([A-Za-z_][A-Za-z0-9_.:]*)/u, name: 1, kind: "function", at: "top" }],
  terraform: [{ re: /^(resource|data|module|variable|output|provider|locals)\s+"([^"]{1,120})"(?:\s+"([^"]{1,120})")?/u, name: 2, kind: 1, at: "top" }],
  build: [{ re: /^([A-Za-z0-9][A-Za-z0-9_.-]{0,60})\s*:(?!=)(?:\s|$)/u, name: 1, kind: "target", at: "top" }],
};
const typeKinds = new Set(["interface", "type", "enum", "struct", "trait", "protocol", "union", "typealias", "record", "message", "input", "scalar", "model"]);

function indentation(line: string): number {
  let width = 0;
  for (const char of line) {
    if (char === " ") width++;
    else if (char === "\t") width += 4;
    else break;
  }
  return width;
}

function exportedSymbol(language: string, line: string, name: string, nested: boolean): boolean {
  switch (language) {
    case "typescript": case "javascript": case "markup": return /^\s*export\b/u.test(line) || (nested && !/^\s*(?:private|protected|#)/u.test(line) && !name.startsWith("#"));
    case "python": return !name.startsWith("_");
    case "go": return /^\p{Lu}/u.test(name);
    case "rust": return /^\s*pub\b/u.test(line);
    case "java": case "csharp": case "php": return /\bpublic\b/u.test(line) || !/\b(?:private|protected|internal)\b/u.test(line);
    case "kotlin": case "swift": case "scala": case "dart": return !/\b(?:private|fileprivate|internal|protected)\b/u.test(line) && !name.startsWith("_");
    default: return !nested;
  }
}

function findSymbols(language: string, lines: string[]): SourceSymbol[] {
  const patterns = families[language];
  if (!patterns) return [];
  const symbols: SourceSymbol[] = [];
  const limit = Math.min(lines.length, maxAnalyzedLines);
  for (let index = 0; index < limit; index++) {
    const line = lines[index]!;
    if (line.length > maxLineLength || line.length < 3) continue;
    const indent = indentation(line);
    // Declarations nested more than two levels deep are local helpers or closures.
    if (indent > 8) continue;
    for (const pattern of patterns) {
      if (pattern.at === "top" && indent !== 0) continue;
      if (pattern.at === "nested" && indent === 0) continue;
      const match = pattern.re.exec(line);
      if (!match) continue;
      let name = match[pattern.name];
      if (!name || control.has(name)) continue;
      // Terraform blocks are identified by both labels: `aws_s3_bucket.logs`.
      if (language === "terraform" && match[3]) name = `${name}.${match[3]}`;
      const kind = typeof pattern.kind === "number" ? (match[pattern.kind] ?? "symbol").replace(/\s+/gu, " ").replace(/\*$/u, "") : pattern.kind;
      const nested = indent > 0;
      symbols.push({ name: name.slice(0, 96), kind, line: index, nested, exported: pattern.exported ?? exportedSymbol(language, line, name, nested) });
      break;
    }
  }
  return symbols;
}

const scriptImport = /\b(?:from\s+|import\s*(?:\(\s*)?|require\s*\(\s*)["']([\w@./-]{1,256})["']/gu;

/** Import specifiers, tagged by how they resolve: plain module names, `mod:x` for Rust, `inc:x` for C includes. */
function findImports(language: string, lines: string[]): string[] {
  const found = new Set<string>();
  const limit = Math.min(lines.length, maxAnalyzedLines);
  let goBlock = false;
  for (let index = 0; index < limit && found.size < maxImports; index++) {
    const line = lines[index]!;
    if (line.length > maxLineLength) continue;
    switch (language) {
      case "typescript": case "javascript": case "markup":
        for (const match of line.matchAll(scriptImport)) found.add(match[1]!);
        break;
      case "python": {
        const from = /^\s*from\s+(\.*[\w.]*)\s+import\s+([\w*, ]{1,200})/u.exec(line);
        if (from) {
          const module = from[1]!;
          found.add(module);
          // `from . import a, b` and `from pkg import mod` may name submodules.
          for (const part of from[2]!.split(",")) {
            const name = part.trim().split(/\s+/u)[0];
            if (name && name !== "*") found.add(module.endsWith(".") ? `${module}${name}` : `${module}.${name}`);
          }
        } else {
          const plain = /^\s*import\s+([\w., ]{1,200})/u.exec(line);
          if (plain) for (const part of plain[1]!.split(",")) {
            const name = part.trim().split(/\s+/u)[0];
            if (name) found.add(name);
          }
        }
        break;
      }
      case "go": {
        if (/^import\s*\(/u.test(line)) goBlock = true;
        else if (goBlock && line.startsWith(")")) goBlock = false;
        if (goBlock || /^import\s+/u.test(line)) {
          const match = /"([\w./~-]{1,256})"/u.exec(line);
          if (match) found.add(match[1]!);
        }
        break;
      }
      case "rust": {
        const module = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/u.exec(line);
        if (module) found.add(`mod:${module[1]}`);
        const use = /^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+((?:crate|super|self)(?:::[A-Za-z_][A-Za-z0-9_]*)+)/u.exec(line);
        if (use) found.add(use[1]!);
        const external = /^\s*(?:pub\s+)?use\s+([a-z_][a-z0-9_]*)::/u.exec(line);
        if (external && !["crate", "super", "self", "std", "core", "alloc"].includes(external[1]!)) found.add(`crate:${external[1]}`);
        break;
      }
      case "java": case "kotlin": case "scala": {
        const match = /^\s*import\s+(?:static\s+)?([\w.]{1,256})/u.exec(line);
        if (match) found.add(match[1]!);
        break;
      }
      case "c": case "cpp": case "objc": {
        const match = /^\s*#\s*(?:include|import)\s+"([\w./+-]{1,256})"/u.exec(line);
        if (match) found.add(`inc:${match[1]}`);
        break;
      }
      case "ruby": {
        const match = /^\s*require(_relative)?\s+["']([\w./-]{1,256})["']/u.exec(line);
        if (match) found.add(match[1] ? `./${match[2]}` : match[2]!);
        break;
      }
      case "php": {
        const match = /^\s*(?:require|include)(?:_once)?\s*\(?\s*(?:__DIR__\s*\.\s*)?["']\/?([\w./-]{1,256})["']/u.exec(line);
        if (match) found.add(`./${match[1]}`);
        break;
      }
      case "dart": {
        const match = /^\s*import\s+["']([\w:./-]{1,256})["']/u.exec(line);
        if (match && !match[1]!.startsWith("dart:")) found.add(match[1]!);
        break;
      }
      default: break;
    }
  }
  return [...found];
}

const commentLine = /^\s*(?:\/\/[/!]?|#(?!\s*(?:include|define|if|ifdef|ifndef|endif|pragma|import)\b|\[|!)|\*(?!\/)|\/\*\*?|--|;;)\s?(.*)$/u;

function plainComment(line: string): string | undefined {
  const match = commentLine.exec(line);
  if (!match) return undefined;
  return match[1]!.replace(/\*\/\s*$/u, "").replace(/^@\w+\s*/u, "").trim();
}

function clip(text: string, length: number): string {
  const compact = text.replace(/\s+/gu, " ").trim();
  return compact.length > length ? `${compact.slice(0, length - 1).trimEnd()}…` : compact;
}

function firstSentence(text: string): string {
  const end = text.search(/[.!?](?:\s|$)/u);
  return end > 0 ? text.slice(0, end + 1) : text;
}

/** The comment block directly above a declaration, and the line it starts on. */
function leadingComment(lines: string[], declaration: number, floor: number): { start: number; text: string } {
  let start = declaration;
  const parts: string[] = [];
  for (let index = declaration - 1; index >= floor && declaration - index <= 40; index--) {
    const line = lines[index]!;
    // Decorators and attributes travel with their declaration but say little about it.
    if (/^\s*(?:@[\w.]+|#\[|\[[\w.]+)/u.test(line)) { start = index; continue; }
    const text = plainComment(line);
    if (text === undefined) break;
    start = index;
    if (text) parts.unshift(text);
  }
  return { start, text: parts.join(" ") };
}

function docstringBelow(lines: string[], declaration: number): string {
  for (let index = declaration + 1; index < Math.min(lines.length, declaration + 4); index++) {
    const match = /^\s*(?:[rubf]{0,2})("""|''')\s*(.*)$/iu.exec(lines[index]!);
    if (match) return (match[2]!.replace(/("""|''')\s*$/u, "").trim() || (lines[index + 1] ?? "").trim());
    if (lines[index]!.trim() && !/[:(,]\s*$/u.test(lines[index]!)) break;
  }
  return "";
}

interface Segment { start: number; end: number; symbols: SourceSymbol[]; comment: string; header?: true }

function segmentCode(lines: string[], symbols: SourceSymbol[]): Segment[] {
  const segments: Segment[] = [];
  let floor = 0;
  for (const symbol of symbols) {
    const { start, text } = leadingComment(lines, symbol.line, floor);
    const previous = segments.at(-1);
    if (previous && start <= previous.start) {
      // Two declarations on adjacent lines share one unit.
      previous.symbols.push(symbol);
      continue;
    }
    if (previous) previous.end = start - 1;
    else if (start > 0) segments.push({ start: 0, end: start - 1, symbols: [], comment: "", header: true });
    segments.push({ start, end: lines.length - 1, symbols: [symbol], comment: text });
    floor = symbol.line + 1;
  }
  return segments;
}

function nonBlank(lines: string[], start: number, end: number): number {
  let count = 0;
  for (let index = start; index <= end; index++) if (lines[index]!.trim()) count++;
  return count;
}

function trimSegment(lines: string[], segment: Segment): void {
  while (segment.end > segment.start && !lines[segment.end]!.trim()) segment.end--;
  while (segment.start < segment.end && !lines[segment.start]!.trim()) segment.start++;
}

/** Join neighbours until units are large enough to read, then cut anything too long to send whole. */
function shapeSegments(lines: string[], input: Segment[]): Segment[] {
  const merged: Segment[] = [];
  for (const segment of input) {
    trimSegment(lines, segment);
    if (segment.header && nonBlank(lines, segment.start, segment.end) < 3) continue;
    const previous = merged.at(-1);
    const size = segment.end - segment.start + 1;
    // A top-level declaration always starts its own unit; small nested members join their neighbour.
    const joinable = previous && !previous.header && !segment.header && segment.symbols.every((symbol) => symbol.nested)
      && (previous.end - previous.start + 1 < minUnitLines || size < minUnitLines)
      && segment.end - previous.start + 1 <= mergeUnitLines;
    // A run of one-line constants or type aliases reads better as one unit than as many.
    // A line that opens a block is the head of something larger, not part of a run.
    const opens = (candidate: Segment) => candidate.symbols.some((symbol) => /[{([:]\s*$/u.test(lines[symbol.line] ?? ""));
    const smallRun = previous && !previous.header && !segment.header && size < 4 && previous.end - previous.start + 1 < 4
      && segment.end - previous.start + 1 <= 16 && !opens(segment) && !opens(previous);
    if (joinable || smallRun) {
      previous.end = segment.end;
      previous.symbols.push(...segment.symbols);
    } else merged.push({ ...segment, symbols: [...segment.symbols] });
  }
  const shaped: Segment[] = [];
  for (const segment of merged) {
    const size = segment.end - segment.start + 1;
    if (size <= maxUnitLines) { shaped.push(segment); continue; }
    for (let start = segment.start; start <= segment.end; start += splitUnitLines) {
      const end = Math.min(segment.end, start + splitUnitLines - 1);
      shaped.push({
        start, end, comment: start === segment.start ? segment.comment : "", ...(segment.header ? { header: true as const } : {}),
        symbols: segment.symbols.filter((symbol) => symbol.line >= start && symbol.line <= end || (start === segment.start && symbol.line < start)),
      });
    }
  }
  // A pathological file still yields a bounded number of units.
  while (shaped.length > maxUnitsPerFile) {
    const halved: Segment[] = [];
    for (let index = 0; index < shaped.length; index += 2) {
      const first = shaped[index]!;
      const second = shaped[index + 1];
      halved.push(second ? { start: first.start, end: second.end, symbols: [...first.symbols, ...second.symbols], comment: first.comment } : first);
    }
    shaped.length = 0;
    shaped.push(...halved);
  }
  return shaped;
}

function unitText(lines: string[], start: number, end: number): string {
  let bytes = 0;
  const parts: string[] = [];
  for (let index = start; index <= end && bytes < maxUnitTextBytes; index++) {
    const line = lines[index]!.length > maxLineLength ? lines[index]!.slice(0, maxLineLength) : lines[index]!;
    parts.push(line);
    bytes += line.length + 1;
  }
  return parts.join("\n");
}

function buildUnit(path: string, lines: string[], language: string, fileRole: Role, segment: Segment, part: number): SourceUnit {
  const base = posix.basename(path);
  const first = segment.symbols[0];
  const declaration = first ? lines[first.line] ?? "" : "";
  const comment = segment.comment
    || (first && language === "python" && (first.kind === "function" || first.kind === "class") ? docstringBelow(lines, first.line) : "");
  const names = new Map<string, number>();
  const body = new Map<string, number>();
  for (const symbol of segment.symbols) addTerms(names, symbol.name, 1);
  // The declaration line counts twice: a signature says more than a body line.
  if (declaration) addTerms(body, declaration.slice(0, maxLineLength), 1);
  addTerms(body, unitText(lines, segment.start, segment.end), 1, 2048);
  const role: Role = first && fileRole !== "test" && segment.symbols.every((symbol) => typeKinds.has(symbol.kind)) ? "types" : fileRole;
  let name: string;
  let gist: string;
  if (first) {
    name = first.name;
    const sentence = comment ? firstSentence(comment) : "";
    gist = clip(declaration, 110) + (sentence ? ` — ${clip(sentence, 90)}` : "");
  } else if (segment.header) {
    name = base;
    gist = clip(segment.comment || `Imports and setup of ${base}`, 140);
  } else {
    name = `${base}:${segment.start + 1}`;
    let preview = "";
    for (let index = segment.start; index <= segment.end && !preview; index++) preview = lines[index]!.trim();
    gist = clip(preview, 140);
  }
  if (part > 0) name = `${name} (${part + 1})`;
  return {
    kind: first ? "symbol" : segment.header ? "header" : "block", name, startLine: segment.start + 1, endLine: segment.end + 1,
    gist, role, symbols: segment.symbols.map((symbol) => symbol.name), names, body,
  };
}

function docUnits(path: string, lines: string[], role: Role): { units: SourceUnit[]; symbols: SourceSymbol[]; gist: string } {
  const headings: { line: number; title: string }[] = [];
  const limit = Math.min(lines.length, maxAnalyzedLines);
  let fenced = false;
  for (let index = 0; index < limit; index++) {
    const line = lines[index]!;
    if (/^\s*(?:```|~~~)/u.test(line)) { fenced = !fenced; continue; }
    if (fenced || line.length > maxLineLength) continue;
    const match = /^ {0,3}#{1,6}\s+(.+?)\s*#*$/u.exec(line);
    if (match) headings.push({ line: index, title: match[1]!.replace(/[`*_]/gu, "") });
    // Setext and reStructuredText underlines mark the line above as a heading.
    else if (index > 0 && /^(?:={3,}|-{3,}|~{3,}|\^{3,})\s*$/u.test(line) && lines[index - 1]!.trim() && !/^[-=~^\s]+$/u.test(lines[index - 1]!))
      headings.push({ line: index - 1, title: lines[index - 1]!.trim() });
  }
  const segments: Segment[] = [];
  const symbols: SourceSymbol[] = [];
  if (!headings.length) {
    for (let start = 0; start < limit; start += blockLines) segments.push({ start, end: Math.min(limit, start + blockLines) - 1, symbols: [], comment: "" });
  } else {
    if (headings[0]!.line > 0) segments.push({ start: 0, end: headings[0]!.line - 1, symbols: [], comment: "", header: true });
    for (const [index, heading] of headings.entries()) {
      const symbol: SourceSymbol = { name: heading.title.slice(0, 96), kind: "heading", line: heading.line, nested: index > 0, exported: true };
      symbols.push(symbol);
      segments.push({ start: heading.line, end: (headings[index + 1]?.line ?? limit) - 1, symbols: [symbol], comment: "" });
    }
  }
  const units = shapeSegments(lines, segments).map((segment) => {
    const first = segment.symbols[0];
    const names = new Map<string, number>();
    const terms = new Map<string, number>();
    for (const symbol of segment.symbols) addTerms(names, symbol.name, 1);
    addTerms(terms, unitText(lines, segment.start, segment.end), 1, 2048);
    let body = "";
    for (let index = (first?.line ?? segment.start - 1) + 1; index <= segment.end && !body; index++) {
      const text = lines[index]!.trim();
      if (text && !/^(?:[-=~^#>|]+|```.*)$/u.test(text)) body = text;
    }
    const unit: SourceUnit = {
      kind: first ? "section" : segment.header ? "header" : "block", name: first?.name ?? `${posix.basename(path)}:${segment.start + 1}`,
      startLine: segment.start + 1, endLine: segment.end + 1, role,
      gist: clip(first ? `${first.name}${body ? ` — ${firstSentence(body)}` : ""}` : body, 160),
      symbols: segment.symbols.map((symbol) => symbol.name), names, body: terms,
    };
    return unit;
  });
  const title = headings[0]?.title ?? lines.find((line) => line.trim())?.trim() ?? "";
  return { units, symbols, gist: clip(title, 140) };
}

/** Describe one tracked text file as symbols, imports, and bounded line-ranged units. */
export function analyzeSource(path: string, lines: string[]): SourceFile | undefined {
  const language = languageOf(path);
  if (!language) return undefined;
  const role = roleOf(path, language);
  if (language === "doc") {
    const { units, symbols, gist } = docUnits(path, lines, role);
    return { language, role, gist, lines: lines.length, imports: [], symbols, units };
  }
  const symbols = findSymbols(language, lines);
  const analyzed = lines.length > maxAnalyzedLines ? lines.slice(0, maxAnalyzedLines) : lines;
  let segments: Segment[];
  if (symbols.length) segments = shapeSegments(analyzed, segmentCode(analyzed, symbols));
  else {
    segments = [];
    for (let start = 0; start < analyzed.length; start += blockLines) {
      const segment: Segment = { start, end: Math.min(analyzed.length, start + blockLines) - 1, symbols: [], comment: "" };
      trimSegment(analyzed, segment);
      if (nonBlank(analyzed, segment.start, segment.end)) segments.push(segment);
    }
    segments = segments.slice(0, maxUnitsPerFile);
  }
  const parts = new Map<string, number>();
  const units = segments.map((segment) => {
    const key = segment.symbols[0]?.name ?? "";
    const part = key ? parts.get(key) ?? 0 : 0;
    if (key) parts.set(key, part + 1);
    return buildUnit(path, analyzed, language, role, segment, part);
  });
  const exported = symbols.filter((symbol) => symbol.exported && !symbol.nested).map((symbol) => symbol.name);
  const header = leadingFileComment(analyzed);
  const gist = header ? clip(firstSentence(header), 140)
    : exported.length ? clip(`Declares ${exported.slice(0, 6).join(", ")}${exported.length > 6 ? ` and ${exported.length - 6} more` : ""}`, 140)
      : units[0]?.gist ?? "";
  return { language, role, gist, lines: lines.length, imports: findImports(language, analyzed), symbols, units };
}

function leadingFileComment(lines: string[]): string {
  const parts: string[] = [];
  for (let index = 0; index < Math.min(lines.length, 30); index++) {
    const line = lines[index]!;
    if (!line.trim() || /^#!/u.test(line)) { if (parts.length) break; continue; }
    const docstring = /^\s*("""|''')\s*(.*)$/u.exec(line);
    if (docstring && !parts.length) return docstring[2]!.replace(/("""|''')\s*$/u, "").trim() || (lines[index + 1] ?? "").trim();
    const text = plainComment(line);
    if (text === undefined) break;
    // Licence banners describe the file's terms, not what it does.
    if (/copyright|licen[cs]e|spdx|all rights reserved/iu.test(text)) return "";
    if (text) parts.push(text);
  }
  return parts.join(" ");
}
