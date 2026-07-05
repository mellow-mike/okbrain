---
name: verify
description: Build/launch/drive recipe for verifying okbrain changes end-to-end (CLI + generated viz.html in Chromium)
---

# Verifying okbrain

## CLI surface (most ops)

Make a throwaway bundle and drive the real CLI — never import from `src/` in a
verify script:

```bash
D=$(mktemp -d)
printf -- '---\ntype: note\ntitle: A\n---\nSee [b](/b.md).\n' > "$D/a.md"
printf -- '---\ntype: note\ntitle: B\n---\n' > "$D/b.md"
bun run src/cli.ts index --bundle "$D"
bun run src/cli.ts search b --bundle "$D"      # every op takes --bundle; --json for machine output
```

Exit codes: 0 ok · 1 op failure/unhealthy · 2 usage. Check them.

## Browser surface (`export-viz`, later `serve`)

Chromium is preinstalled; drive the generated page with `playwright-core`
(install it in the scratchpad, not the repo):

```ts
import { chromium } from "playwright-core";
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", // or $PLAYWRIGHT_BROWSERS_PATH
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("JS ERROR", e.message));
page.on("request", (r) => { if (!r.url().startsWith("file://")) console.log("EXTERNAL", r.url()); });
await page.goto("file://<bundle>/viz.html");
await page.waitForTimeout(1500); // cose layout settles
// cy (Cytoscape) and marked are page globals: page.evaluate("cy.nodes().length")
```

Worth driving in viz.html: node/edge counts vs bundle; tap a node → detail
panel; click a rewired `#concept:` link → focuses target node; "Cited by"
list; search dims non-matches; type checkbox hides nodes+edges; layout
select; a frontmatter-less concept still gets a node. Assert zero pageerrors
and zero non-`file://` requests (self-containment).

## Gotchas

- Capture command output to a file and check the real exit code (CLAUDE.md
  iron rule) — piping eats `$?`.
- `bun run src/cli.ts` needs no build; the compiled-binary path is
  `bun build --compile --outfile bin/okb src/cli.ts` if binary embedding
  (e.g. vendored viz libs) is what's under test.
