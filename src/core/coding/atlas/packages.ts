// Workspace packages and their commands, read from tracked manifests. Every
// fact carries the manifest path and line that proves it, so a reviewer can
// check a command before running it. Nothing here executes repository code.

import { createHash } from "node:crypto";
import { posix } from "node:path";
import { parse as parseYaml } from "yaml";

export type Ecosystem = "npm" | "deno" | "cargo" | "go" | "python" | "maven" | "gradle" | "bazel" | "dotnet" | "composer" | "ruby"
  | "elixir" | "swift" | "dart" | "make" | "root";
export type ToolKind = "test" | "build" | "lint" | "typecheck" | "format" | "run" | "other";

export interface PackageInfo {
  /** Workspace-relative directory, `.` for the repository root. */
  root: string;
  name: string;
  ecosystem: Ecosystem;
  manifest?: string;
  description?: string;
  /** Names this package declares it depends on, in its ecosystem's naming. */
  dependencies: string[];
}

export interface CommandTool {
  id: string;
  package: string;
  kind: ToolKind;
  name: string;
  /** Workspace-relative directory to run in. */
  cwd: string;
  /** An argument array. okbrain never builds a shell string from it. */
  argv: string[];
  source: { path: string; line: number };
}

export interface PackageMap {
  packages: PackageInfo[];
  tools: CommandTool[];
  limited: boolean;
}

const maxPackages = 4000;
const maxToolsPerPackage = 16;
const maxManifestBytes = 256 * 1024;
const manifestNames = new Set([
  "package.json", "deno.json", "deno.jsonc", "cargo.toml", "go.mod", "pyproject.toml", "setup.py", "setup.cfg", "pom.xml",
  "build.gradle", "build.gradle.kts", "build", "build.bazel", "composer.json", "mix.exs", "package.swift", "pubspec.yaml",
  "makefile", "gnumakefile", "justfile",
]);
const lockManagers: [string, string][] = [
  ["bun.lock", "bun"], ["bun.lockb", "bun"], ["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["package-lock.json", "npm"],
];

type Read = (path: string) => Promise<string | undefined>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lineOf(text: string, needle: string, from = 0): number {
  const index = text.indexOf(needle, from);
  if (index < 0) return 1;
  let line = 1;
  for (let offset = 0; offset < index; offset++) if (text.charCodeAt(offset) === 10) line++;
  return line;
}

function clean(value: unknown, length = 200): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\x00-\x1f\x7f]+/gu, " ").trim();
  return text ? text.slice(0, length) : undefined;
}

const safeName = (value: unknown): string | undefined => {
  const name = clean(value, 160);
  return name && /^[@\w][\w@./:+-]*$/u.test(name) ? name : undefined;
};

export function toolKind(name: string): ToolKind {
  const lower = name.toLowerCase();
  if (/(?:^|[:_-])(?:test|tests|spec|e2e|unit|integration|check-tests)(?:$|[:_-])/u.test(lower) || lower === "check") return "test";
  if (/(?:^|[:_-])(?:typecheck|type-check|tsc|types|check-types|mypy|pyright)(?:$|[:_-])/u.test(lower)) return "typecheck";
  if (/(?:^|[:_-])(?:lint|eslint|clippy|vet|ruff|biome)(?:$|[:_-])/u.test(lower)) return "lint";
  if (/(?:^|[:_-])(?:format|fmt|prettier)(?:$|[:_-])/u.test(lower)) return "format";
  if (/(?:^|[:_-])(?:build|compile|bundle|dist|package)(?:$|[:_-])/u.test(lower) || lower === "all") return "build";
  if (/(?:^|[:_-])(?:dev|start|serve|run|watch)(?:$|[:_-])/u.test(lower)) return "run";
  return "other";
}

/** Read `[section]` tables and `key = "value"` pairs. Enough for the manifest fields used here. */
function tomlSections(text: string): Map<string, { keys: Map<string, { value: string; line: number }>; line: number }> {
  const sections = new Map<string, { keys: Map<string, { value: string; line: number }>; line: number }>();
  let current = { keys: new Map<string, { value: string; line: number }>(), line: 1 };
  sections.set("", current);
  let pending: { key: string; parts: string[]; line: number } | undefined;
  for (const [index, raw] of text.split(/\r?\n/u).entries()) {
    const line = raw.replace(/(^|\s)#.*$/u, "$1").trim();
    if (pending) {
      pending.parts.push(line);
      if (line.includes("]")) {
        current.keys.set(pending.key, { value: pending.parts.join(" "), line: pending.line });
        pending = undefined;
      }
      continue;
    }
    const section = /^\[\[?\s*([\w."'-]+)\s*\]\]?$/u.exec(line);
    if (section) {
      const name = section[1]!.replace(/["']/gu, "");
      current = sections.get(name) ?? { keys: new Map(), line: index + 1 };
      sections.set(name, current);
      continue;
    }
    const pair = /^([\w."'-]+)\s*=\s*(.*)$/u.exec(line);
    if (!pair) continue;
    const key = pair[1]!.replace(/["']/gu, "");
    const value = pair[2]!;
    if (value.startsWith("[") && !value.includes("]")) pending = { key, parts: [value], line: index + 1 };
    else current.keys.set(key, { value, line: index + 1 });
  }
  return sections;
}

const tomlString = (value: string | undefined): string | undefined => {
  const match = value === undefined ? null : /^\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/u.exec(value);
  return match ? match[1] ?? match[2] : undefined;
};

const tomlStrings = (value: string | undefined): string[] =>
  value === undefined ? [] : [...value.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/gu)].map((match) => match[1] ?? match[2] ?? "");

interface Draft {
  info: PackageInfo;
  tools: Omit<CommandTool, "id" | "package">[];
}

function draft(root: string, ecosystem: Ecosystem, manifest: string, name: string | undefined, description?: string): Draft {
  return {
    info: { root, ecosystem, manifest, name: name ?? (root === "." ? "root" : posix.basename(root)), dependencies: [], ...(description ? { description } : {}) },
    tools: [],
  };
}

function parseNode(root: string, path: string, text: string, manager: string): Draft | undefined {
  let json: unknown;
  try { json = JSON.parse(text); } catch { return undefined; }
  if (!record(json)) return undefined;
  const result = draft(root, "npm", path, safeName(json.name), clean(json.description));
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const group = json[field];
    if (record(group)) result.info.dependencies.push(...Object.keys(group).slice(0, 400));
  }
  if (record(json.scripts)) {
    for (const [name, command] of Object.entries(json.scripts)) {
      if (typeof command !== "string" || !/^[\w:.-]{1,64}$/u.test(name)) continue;
      result.tools.push({ kind: toolKind(name), name, cwd: root, argv: [manager, "run", name], source: { path, line: lineOf(text, `"${name}"`, text.indexOf('"scripts"')) } });
    }
  }
  return result;
}

function parseDeno(root: string, path: string, text: string): Draft | undefined {
  let json: unknown;
  // Deno accepts comments in deno.jsonc; strip whole-line comments before parsing.
  try { json = JSON.parse(text.replace(/^\s*\/\/.*$/gmu, "")); } catch { return undefined; }
  if (!record(json)) return undefined;
  const result = draft(root, "deno", path, safeName(json.name));
  if (record(json.tasks)) for (const name of Object.keys(json.tasks)) {
    if (!/^[\w:.-]{1,64}$/u.test(name)) continue;
    result.tools.push({ kind: toolKind(name), name, cwd: root, argv: ["deno", "task", name], source: { path, line: lineOf(text, `"${name}"`) } });
  }
  return result;
}

function parseCargo(root: string, path: string, text: string): Draft | undefined {
  const sections = tomlSections(text);
  const pkg = sections.get("package");
  const name = safeName(tomlString(pkg?.keys.get("name")?.value));
  if (!pkg || !name) return undefined;
  const result = draft(root, "cargo", path, name, clean(tomlString(pkg.keys.get("description")?.value)));
  for (const [section, { keys }] of sections) {
    if (/^(?:dev-|build-)?dependencies$/u.test(section) || /^target\..+\.dependencies$/u.test(section)) result.info.dependencies.push(...keys.keys());
    const dotted = /^(?:dev-|build-)?dependencies\.(.+)$/u.exec(section);
    if (dotted) result.info.dependencies.push(dotted[1]!);
  }
  const line = pkg.keys.get("name")?.line ?? 1;
  for (const [kind, argv] of [["test", ["cargo", "test"]], ["build", ["cargo", "build"]], ["lint", ["cargo", "clippy"]]] as const)
    result.tools.push({ kind, name: argv[1]!, cwd: root, argv: [...argv], source: { path, line } });
  return result;
}

function parseGo(root: string, path: string, text: string): Draft | undefined {
  const module = /^module\s+(\S+)/mu.exec(text);
  const name = safeName(module?.[1]);
  if (!name) return undefined;
  const result = draft(root, "go", path, name);
  for (const match of text.matchAll(/^\s*([\w.-]+\.[\w.-]+\/[\w./~-]+)\s+v[\w.+-]+/gmu)) result.info.dependencies.push(match[1]!);
  const line = lineOf(text, "module ");
  for (const [kind, argv] of [["test", ["go", "test", "./..."]], ["build", ["go", "build", "./..."]], ["lint", ["go", "vet", "./..."]]] as const)
    result.tools.push({ kind, name: argv[1]!, cwd: root, argv: [...argv], source: { path, line } });
  return result;
}

function parsePython(root: string, path: string, text: string, siblings: ReadonlySet<string>): Draft | undefined {
  const base = posix.basename(path);
  let name: string | undefined;
  let description: string | undefined;
  const result = draft(root, "python", path, undefined);
  if (base === "pyproject.toml") {
    const sections = tomlSections(text);
    const project = sections.get("project") ?? sections.get("tool.poetry");
    name = safeName(tomlString(project?.keys.get("name")?.value));
    description = clean(tomlString(project?.keys.get("description")?.value));
    for (const dependency of tomlStrings(sections.get("project")?.keys.get("dependencies")?.value)) {
      const match = /^[A-Za-z0-9][\w.-]*/u.exec(dependency);
      if (match) result.info.dependencies.push(match[0]);
    }
    for (const key of sections.get("tool.poetry.dependencies")?.keys.keys() ?? []) if (key !== "python") result.info.dependencies.push(key);
    const tool = (prefix: string) => [...sections.entries()].find(([section]) => section === prefix || section.startsWith(`${prefix}.`));
    const add = (kind: ToolKind, label: string, argv: string[], section: string) => {
      const found = tool(section);
      if (found) result.tools.push({ kind, name: label, cwd: root, argv, source: { path, line: found[1].line } });
    };
    add("test", "pytest", ["python", "-m", "pytest"], "tool.pytest");
    add("lint", "ruff", ["ruff", "check", "."], "tool.ruff");
    add("typecheck", "mypy", ["mypy", "."], "tool.mypy");
    add("typecheck", "pyright", ["pyright"], "tool.pyright");
    add("format", "black", ["black", "."], "tool.black");
  } else {
    name = safeName(/\bname\s*=\s*["']([^"']+)["']/u.exec(text)?.[1]);
    description = clean(/\bdescription\s*=\s*["']([^"']+)["']/u.exec(text)?.[1]);
  }
  // A manifest with no project table is tool configuration, not a package.
  if (!name && base !== "setup.py") return undefined;
  if (name) result.info.name = name;
  if (description) result.info.description = description;
  const hasTests = [...siblings].some((file) => /^(?:pytest\.ini|conftest\.py|tox\.ini)$/u.test(file));
  if (hasTests && !result.tools.some((tool) => tool.name === "pytest"))
    result.tools.push({ kind: "test", name: "pytest", cwd: root, argv: ["python", "-m", "pytest"], source: { path, line: 1 } });
  return result;
}

function parseMaven(root: string, path: string, text: string): Draft | undefined {
  const own = text.replace(/<parent>[\s\S]*?<\/parent>/u, "").replace(/<dependencies>[\s\S]*?<\/dependencies>/gu, "");
  const name = safeName(/<artifactId>\s*([^<\s]+)\s*<\/artifactId>/u.exec(own)?.[1]);
  if (!name) return undefined;
  const result = draft(root, "maven", path, name, clean(/<description>\s*([^<]+)<\/description>/u.exec(own)?.[1]));
  for (const match of text.matchAll(/<dependency>[\s\S]*?<artifactId>\s*([^<\s]+)\s*<\/artifactId>/gu)) result.info.dependencies.push(match[1]!);
  const line = lineOf(text, "<artifactId>");
  result.tools.push({ kind: "test", name: "test", cwd: root, argv: ["mvn", "-q", "test"], source: { path, line } },
    { kind: "build", name: "package", cwd: root, argv: ["mvn", "-q", "-DskipTests", "package"], source: { path, line } });
  return result;
}

function parseScripted(root: string, path: string, text: string, ecosystem: Ecosystem): Draft | undefined {
  switch (ecosystem) {
    case "gradle": {
      const result = draft(root, "gradle", path, undefined);
      for (const match of text.matchAll(/project\(\s*["']:([\w:.-]+)["']\s*\)/gu)) result.info.dependencies.push(match[1]!.split(":").at(-1)!);
      result.tools.push({ kind: "test", name: "test", cwd: root, argv: ["gradle", "test"], source: { path, line: 1 } },
        { kind: "build", name: "build", cwd: root, argv: ["gradle", "build"], source: { path, line: 1 } });
      return result;
    }
    case "elixir": {
      const result = draft(root, "elixir", path, safeName(/app:\s*:([a-z_][a-z0-9_]*)/u.exec(text)?.[1]));
      result.tools.push({ kind: "test", name: "test", cwd: root, argv: ["mix", "test"], source: { path, line: lineOf(text, "app:") } });
      return result;
    }
    case "swift": {
      const result = draft(root, "swift", path, safeName(/\bname:\s*"([^"]+)"/u.exec(text)?.[1]));
      result.tools.push({ kind: "test", name: "test", cwd: root, argv: ["swift", "test"], source: { path, line: 1 } },
        { kind: "build", name: "build", cwd: root, argv: ["swift", "build"], source: { path, line: 1 } });
      return result;
    }
    case "dart": {
      let yaml: unknown;
      try { yaml = parseYaml(text); } catch { return undefined; }
      if (!record(yaml)) return undefined;
      const result = draft(root, "dart", path, safeName(yaml.name), clean(yaml.description));
      if (record(yaml.dependencies)) result.info.dependencies.push(...Object.keys(yaml.dependencies));
      const flutter = record(yaml.dependencies) && "flutter" in yaml.dependencies;
      result.tools.push({ kind: "test", name: "test", cwd: root, argv: [flutter ? "flutter" : "dart", "test"], source: { path, line: 1 } });
      return result;
    }
    case "composer": {
      let json: unknown;
      try { json = JSON.parse(text); } catch { return undefined; }
      if (!record(json)) return undefined;
      const result = draft(root, "composer", path, safeName(json.name), clean(json.description));
      if (record(json.require)) result.info.dependencies.push(...Object.keys(json.require));
      if (record(json.scripts)) for (const name of Object.keys(json.scripts)) {
        if (!/^[\w:.-]{1,64}$/u.test(name)) continue;
        result.tools.push({ kind: toolKind(name), name, cwd: root, argv: ["composer", "run-script", name], source: { path, line: lineOf(text, `"${name}"`) } });
      }
      return result;
    }
    default: return undefined;
  }
}

/** Make and just targets become commands of the package that owns the file. */
function taskTargets(root: string, path: string, text: string, runner: "make" | "just"): Draft["tools"] {
  const tools: Draft["tools"] = [];
  const seen = new Set<string>();
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    const match = /^([A-Za-z0-9][A-Za-z0-9_-]{0,48})\s*(?:[A-Za-z0-9_ =$"'{}-]*)?:(?![=:])/u.exec(line);
    if (!match || seen.has(match[1]!) || match[1] === "PHONY") continue;
    seen.add(match[1]!);
    const kind = toolKind(match[1]!);
    if (kind === "other") continue;
    tools.push({ kind, name: match[1]!, cwd: root, argv: [runner, match[1]!], source: { path, line: index + 1 } });
  }
  return tools;
}

/** Single-command `run:` steps in CI, as evidence of what the project treats as its checks. */
function workflowCommands(path: string, text: string): Draft["tools"] {
  const tools: Draft["tools"] = [];
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    const match = /^\s*(?:-\s*)?run:\s*(\S.*)$/u.exec(line);
    const command = match?.[1]?.trim();
    if (!command || /[|&;<>$`\\"'(){}*?]/u.test(command) || command.startsWith("#")) continue;
    const argv = command.split(/\s+/u);
    if (argv.length > 8 || !/^[\w./-]+$/u.test(argv[0]!)) continue;
    const kind = toolKind(argv.slice(1).join("-") || argv[0]!);
    if (kind === "other" || kind === "run") continue;
    tools.push({ kind, name: argv.join(" "), cwd: ".", argv, source: { path, line: index + 1 } });
  }
  return tools;
}

export function packageOf(path: string, roots: ReadonlySet<string>): string {
  let directory = posix.dirname(path);
  while (directory !== "." && directory !== "/") {
    if (roots.has(directory)) return directory;
    directory = posix.dirname(directory);
  }
  return ".";
}

/** Find package roots among tracked paths and read the commands their manifests declare. */
export async function detectPackages(
  paths: readonly string[], read: Read, options: { workspaceName?: string; rootFiles?: Iterable<string> } = {},
): Promise<PackageMap> {
  const workspaceName = options.workspaceName ?? "root";
  const byDirectory = new Map<string, Set<string>>();
  // Lock files are excluded from the index but still say which package manager the root uses.
  const rootFiles = new Set<string>([...options.rootFiles ?? []].map((name) => name.toLowerCase()));
  const manifests: string[] = [];
  const workflows: string[] = [];
  for (const path of paths) {
    const directory = posix.dirname(path);
    const base = posix.basename(path);
    const lower = base.toLowerCase();
    if (directory === ".") rootFiles.add(lower);
    if (manifestNames.has(lower) || /\.(?:csproj|fsproj|vbproj|gemspec)$/u.test(lower)) {
      manifests.push(path);
      let files = byDirectory.get(directory);
      if (!files) byDirectory.set(directory, files = new Set());
      files.add(lower);
    } else if (/^(?:pytest\.ini|conftest\.py|tox\.ini)$/u.test(lower)) {
      let files = byDirectory.get(directory);
      if (!files) byDirectory.set(directory, files = new Set());
      files.add(lower);
    }
    if (/^\.github\/workflows\/[^/]+\.ya?ml$/u.test(path)) workflows.push(path);
  }
  const manager = lockManagers.find(([file]) => rootFiles.has(file))?.[1] ?? "npm";
  const bazel = ["workspace", "workspace.bazel", "module.bazel"].some((file) => rootFiles.has(file));
  // Shallow manifests first, so a cap keeps the packages that structure the repository.
  manifests.sort((a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : a > b ? 1 : 0));

  const drafts = new Map<string, Draft>();
  let limited = false;
  const adopt = (candidate: Draft | undefined) => {
    if (!candidate) return;
    const existing = drafts.get(candidate.info.root);
    if (!existing) {
      if (drafts.size >= maxPackages) { limited = true; return; }
      drafts.set(candidate.info.root, candidate);
      return;
    }
    // A second manifest in the same directory adds commands and keeps the first identity.
    existing.tools.push(...candidate.tools);
    existing.info.dependencies.push(...candidate.info.dependencies);
    if (!existing.info.description && candidate.info.description) existing.info.description = candidate.info.description;
  };
  const extraTools: { root: string; tools: Draft["tools"] }[] = [];

  for (const path of manifests) {
    const root = posix.dirname(path);
    const lower = posix.basename(path).toLowerCase();
    // Bazel build files describe packages without needing their text.
    if (lower === "build" || lower === "build.bazel") {
      if (!bazel) continue;
      const label = root === "." ? "//..." : `//${root}/...`;
      const candidate = draft(root, "bazel", path, root === "." ? undefined : `//${root}`);
      candidate.tools.push({ kind: "test", name: "test", cwd: ".", argv: ["bazel", "test", label], source: { path, line: 1 } },
        { kind: "build", name: "build", cwd: ".", argv: ["bazel", "build", label], source: { path, line: 1 } });
      adopt(candidate);
      continue;
    }
    const text = await read(path);
    if (text === undefined || Buffer.byteLength(text) > maxManifestBytes) continue;
    if (lower === "package.json") adopt(parseNode(root, path, text, manager));
    else if (lower === "deno.json" || lower === "deno.jsonc") adopt(parseDeno(root, path, text));
    else if (lower === "cargo.toml") adopt(parseCargo(root, path, text));
    else if (lower === "go.mod") adopt(parseGo(root, path, text));
    else if (lower === "pyproject.toml" || lower === "setup.py" || lower === "setup.cfg") adopt(parsePython(root, path, text, byDirectory.get(root) ?? new Set()));
    else if (lower === "pom.xml") adopt(parseMaven(root, path, text));
    else if (lower === "build.gradle" || lower === "build.gradle.kts") adopt(parseScripted(root, path, text, "gradle"));
    else if (lower === "mix.exs") adopt(parseScripted(root, path, text, "elixir"));
    else if (lower === "package.swift") adopt(parseScripted(root, path, text, "swift"));
    else if (lower === "pubspec.yaml") adopt(parseScripted(root, path, text, "dart"));
    else if (lower === "composer.json") adopt(parseScripted(root, path, text, "composer"));
    else if (lower === "makefile" || lower === "gnumakefile") extraTools.push({ root, tools: taskTargets(root, path, text, "make") });
    else if (lower === "justfile") extraTools.push({ root, tools: taskTargets(root, path, text, "just") });
    else if (/\.(?:csproj|fsproj|vbproj)$/u.test(lower)) {
      const candidate = draft(root, "dotnet", path, safeName(posix.basename(path).replace(/\.[^.]+$/u, "")));
      for (const match of text.matchAll(/<ProjectReference\s+Include="([^"]+)"/gu)) candidate.info.dependencies.push(posix.basename(match[1]!.replaceAll("\\", "/")).replace(/\.[^.]+$/u, ""));
      for (const match of text.matchAll(/<PackageReference\s+Include="([^"]+)"/gu)) candidate.info.dependencies.push(match[1]!);
      candidate.tools.push({ kind: "test", name: "test", cwd: root, argv: ["dotnet", "test"], source: { path, line: 1 } },
        { kind: "build", name: "build", cwd: root, argv: ["dotnet", "build"], source: { path, line: 1 } });
      adopt(candidate);
    } else if (lower.endsWith(".gemspec")) {
      adopt(draft(root, "ruby", path, safeName(posix.basename(path).replace(/\.gemspec$/u, ""))));
    }
  }
  // Paths that no manifest claims belong to the workspace itself. An import limited to
  // package directories has none, and then there is no root package to report.
  const detected = new Set(drafts.keys());
  if (!drafts.has(".") && (workflows.length > 0 || paths.some((path) => packageOf(path, detected) === ".")))
    drafts.set(".", { info: { root: ".", name: workspaceName, ecosystem: "root", dependencies: [] }, tools: [] });
  const roots = new Set(drafts.keys());
  // A Makefile without a manifest beside it belongs to the nearest enclosing package.
  for (const { root, tools } of extraTools) drafts.get(roots.has(root) ? root : packageOf(`${root}/Makefile`, roots))!.tools.push(...tools);
  for (const path of workflows.slice(0, 32)) {
    const text = await read(path);
    if (text !== undefined && Buffer.byteLength(text) <= maxManifestBytes) drafts.get(".")!.tools.push(...workflowCommands(path, text));
  }

  const packages: PackageInfo[] = [];
  const tools: CommandTool[] = [];
  const ids = new Set<string>();
  for (const { info, tools: drafted } of drafts.values()) {
    info.dependencies = [...new Set(info.dependencies)].slice(0, 400);
    packages.push(info);
    const seen = new Set<string>();
    const order: ToolKind[] = ["test", "typecheck", "lint", "build", "format", "run", "other"];
    const ranked = [...drafted].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.name.length - b.name.length);
    for (const tool of ranked) {
      const key = JSON.stringify([tool.cwd, tool.argv]);
      if (seen.has(key) || seen.size >= maxToolsPerPackage) continue;
      seen.add(key);
      const base = `${info.root}#${tool.kind}:${tool.name}`;
      const id = base.length <= 200 && !ids.has(base)
        ? base : `${base.slice(0, 183)}#${createHash("sha256").update(JSON.stringify([base, key])).digest("hex").slice(0, 16)}`;
      ids.add(id);
      tools.push({ ...tool, id, package: info.root });
    }
  }
  packages.sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
  return { packages, tools, limited };
}

/** Resolve declared dependency names to packages in this workspace. */
export function internalDependencies(packages: readonly PackageInfo[]): { from: string; to: string }[] {
  const byName = new Map<string, string>();
  for (const { name, root, ecosystem } of packages) {
    if (ecosystem === "root") continue;
    const key = ecosystem === "python" ? name.toLowerCase().replace(/[-_.]+/gu, "-") : name;
    // Two packages sharing a name cannot be told apart by a manifest reference.
    byName.set(key, byName.has(key) ? "" : root);
  }
  const edges: { from: string; to: string }[] = [];
  for (const { root, dependencies, ecosystem } of packages) {
    const seen = new Set<string>();
    for (const dependency of dependencies) {
      const key = ecosystem === "python" ? dependency.toLowerCase().replace(/[-_.]+/gu, "-") : dependency;
      let target = byName.get(key);
      // A Go requirement names a module; a nested module in this workspace shares its prefix.
      if (!target && ecosystem === "go") for (const [name, candidate] of byName) if (candidate && (key === name || key.startsWith(`${name}/`))) target = candidate;
      if (target && target !== root && !seen.has(target)) {
        seen.add(target);
        edges.push({ from: root, to: target });
      }
    }
  }
  return edges;
}
