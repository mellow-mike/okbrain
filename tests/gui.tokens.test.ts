// The design tokens (core/viz/tokens.css) are the only source of colour,
// type, spacing and motion for the GUI and the static viewer. An undefined
// custom property fails silently in CSS, and a token missing from one theme
// silently inherits the other's value — so both are checked here.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const read = (p: string): string => readFileSync(join(SRC, p), "utf8");
const tokens = read("core/viz/tokens.css");
const names = (text: string, re: RegExp): Set<string> => new Set([...text.matchAll(re)].map((m) => m[1]!));

/** The custom properties one theme block of tokens.css declares. */
function themeBlock(selector: string): Set<string> {
  const at = tokens.indexOf(selector + " {");
  expect(at).toBeGreaterThanOrEqual(0);
  return names(tokens.slice(at, tokens.indexOf("}", at)), /--([a-z0-9-]+):/g);
}

describe("design tokens", () => {
  test("dark and light declare the same themed tokens, graph slots included", () => {
    const dark = themeBlock(':root, [data-theme="dark"]');
    const light = themeBlock('[data-theme="light"]');
    expect([...light].sort()).toEqual([...dark].sort());
    for (const t of ["ink", "surface", "plane", "ok", "warn", "danger", "graph-other", "shadow", "focus-ring"])
      expect(dark.has(t)).toBe(true);
    for (let i = 1; i <= 8; i++) expect(dark.has(`graph-${i}`)).toBe(true);
  });

  test("every token the GUI, the viewer and Okb read is defined", () => {
    const files = ["gui/style.css", "gui/app.js", "core/viz/export.ts", "core/viz/okb.js"].map(read);
    const defined = new Set([
      ...names(tokens, /--([a-z0-9-]+)\s*:/g),
      ...files.flatMap((f) => [...names(f, /--([a-z0-9-]+)\s*:/g), ...names(f, /setProperty\('--([a-z0-9-]+)'/g)]),
    ]);
    const used = files.flatMap((f) => [...names(f, /var\(--([a-z0-9-]+)/g), ...names(f, /\b(?:token|ms)\('([a-z0-9-]+)'\)/g)]);
    expect(used.length).toBeGreaterThan(50);
    expect(used.filter((n) => !defined.has(n))).toEqual([]);
  });

  test("every font face the stylesheet declares ships in src/gui/fonts", () => {
    const faces = [...read("gui/style.css").matchAll(/url\("\/gui\/fonts\/([^"]+)"\)/g)].map((m) => m[1]!);
    expect(faces).toHaveLength(4);
    for (const f of faces) expect(existsSync(join(SRC, "gui", "fonts", f))).toBe(true);
  });
});
