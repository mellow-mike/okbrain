---
name: verify
description: Build/launch/drive recipe for verifying okbrain changes end-to-end (CLI, the served GUI, and the generated viz.html in headless Chromium)
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
bun run src/cli.ts doctor --bundle "$D"        # v0.2 conformance + signals; `okb upgrade --dry-run` for v0.1 leftovers
```

Exit codes: 0 ok · 1 op failure/unhealthy · 2 usage. Check them. Point
`XDG_CONFIG_HOME` at a temp dir when a run must not touch the real config
(`okb init`, the serve token).

`bundles/acme_retail` is the upstream OKF v0.2 sample — drive reads against a
copy of it to check permissive parsing; never modify it in place.

## Browser surface (`okb serve` GUI and `export-viz`)

Chromium is **not** preinstalled on this machine. A cached Playwright build
lives at `~/.cache/ms-playwright/chromium-<rev>/chrome-linux64/chrome`
(`ls ~/.cache/ms-playwright`); if it is missing, `bun add playwright` in the
scratchpad and `bunx playwright install chromium` (needs Node ≥ 20 for the
installer; Bun runs the tests fine). Pass `executablePath` explicitly — the
package's expected revision rarely matches the cached one.

Drive the **compiled binary** (`bun run build` → `bin/okb`) so embedded assets
are what's tested. Pattern (the full driver from the 2026-09-03 session is
`drive-gui.ts` in that session's scratchpad):

```ts
import { chromium } from "playwright";
// spawn: okb serve --port 6591 --bundle <tmp copy of bundles/example> with
// env XDG_CONFIG_HOME=<tmp>; poll GET /api/status?token=<serve-token> until
// its `bundle` equals yours — a stale server on the port answers too.
const browser = await chromium.launch({ executablePath: "<chrome path>" });
const page = await browser.newPage();
page.on("pageerror", (e) => fail("JS " + e.message + "\n" + e.stack));
page.on("request", (r) => { if (!r.url().startsWith("http://127.0.0.1:6591/")) fail("EXTERNAL " + r.url()); });
page.on("response", (r) => { if (r.status() >= 500) fail("HTTP " + r.status() + " " + r.url()); });
await page.goto("http://127.0.0.1:6591/#home");   // hash routes: home, browse, concept/<enc id>,
                                                   // edit[/<enc id>], graph[/<enc id>], search[/<q>],
                                                   // ask, add, review, inbox, claims, stats, settings
```

Worth driving: Home tiles + quick capture + doctor; Browse filter; a Concept
view (badges, footnotes, links panel, Reviewed ✓ → trust badge flips to
human-reviewed); Edit (status / stale_after / sources) then save; New (no
id → derived); Graph (`window.cy` is a page global: `cy.nodes().length`,
legend toggles hide nodes); Search; Ask (no provider → a clean error box);
Add (clip a private URL → guard error boxed, bookmarklet chip present);
Review snooze; Inbox mark read; Claims stake + resolve; Stats path; Settings
doctor / upgrade preview / jobs / actor; the brain switcher against a
read-only mount (write → 403 rendered, never a page error); theme toggle.
Assert zero `pageerror`s, zero non-127.0.0.1 requests, zero 5xx. Expected
4xx: guard refusals (403), read-only refusals (403), 404 after switching a
brain while on a concept the other bundle lacks.

For `viz.html` (`okb export-viz`), `page.goto("file://<bundle>/viz.html")`,
wait ~1.5 s for the cose layout, then the same `cy` checks; the detail panel
must show status/trust badges and the `sources` list.

## Gotchas

- Capture command output to a file and check the real exit code (CLAUDE.md
  iron rule) — piping eats `$?`.
- Never `pkill -f "okb serve …"` from a Bash tool call: the pattern matches
  the tool's own shell and kills it. `pkill -x okb` is safe.
- A crashed driver leaves its `okb serve` running; the next run then talks to
  the stale server (and its stale binary) — kill it and remove
  `/tmp/okb-gui-e2e-*` first.
- Motion (design system, `window.Okb`): every route is a view-transition
  page turn (~380 ms, input swallowed meanwhile) and the theme toggle an ink
  flood (`html.flooding` until done). Wait for the new view's selector, and
  for `flooding` to clear, before the next action; computed `font-weight` /
  outline settle ~150 ms after a state change. Assert fonts with
  `document.fonts.check('14px "Recursive Sans"')` after `document.fonts.ready`.
- `bun run src/cli.ts` needs no build; the binary path is
  `bun build --compile --outfile bin/okb src/cli.ts` (plus vec0 beside it)
  when embedding (GUI assets, vendored libs) is what's under test.
