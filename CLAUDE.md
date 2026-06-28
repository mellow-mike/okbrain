# CLAUDE.md

okbrain is a self-hosted, cross-platform personal knowledge manager. Its on-disk
storage is a conformant **Open Knowledge Format (OKF)** bundle (markdown + YAML
frontmatter in git); its runtime borrows gbrain's "thin harness, fat skills"
patterns. Stack: **TypeScript on Bun**, single compiled binary, SQLite-class
embedded engine, AI that runs against a local model or a hosted API.

This file is **always-loaded orientation**: North Star, invariants, iron rules,
and a map to where the detail lives. It is not the design spec — that's
`CONTEXT.md`. Current progress, granular tasks, and the bug log are in
`ROADMAP.md`. Keep this file small enough to load every session.

---

## North Star

The most well-tested, lightest-weight OKF-native personal brain that one person
can run on a laptop, fully offline, and grow for years. Lightweight and correct
beat feature-rich. If a change makes the binary heavier, the startup slower, or
the bundle non-portable, it must earn it.

## Prime directive (never violate)

**The OKF bundle (markdown + git) is the only source of truth. The database is a
derived cache that must be fully rebuildable from the bundle via `okb rebuild`.**
Never store canonical user knowledge only in the DB. Never make the bundle
depend on the DB to be readable by a plain OKF consumer.

---

## Cross-cutting invariants (must hold regardless of which file you touch)

1. **OKF conformance on write.** Every concept write goes through
   `core/okf/document.ts`. Emit `type`, `title`, `description`, `timestamp` (and
   `resource`/`tags` when applicable); normalize links to bundle-absolute
   (`/dir/x.md`); maintain `index.md` + `log.md`. **On read, be permissive:**
   require only `type` + parseable YAML; tolerate unknown types/keys and broken
   links; preserve unknown frontmatter keys on round-trip.
2. **Contract-first surfaces.** `core/operations.ts` is the single registry of
   operations (each with `scope: read|write|admin` and a trust flag). The CLI,
   the GUI's local API, and the MCP server are thin adapters generated over it.
   Never add a capability to one surface that bypasses the ops layer.
3. **Trust is fail-closed.** Local CLI/GUI calls are trusted; MCP/remote calls
   are untrusted unless explicitly marked local. Anything not strictly trusted
   is treated as untrusted. `write`/`admin` ops are gated for untrusted callers.
4. **Engine is swappable.** All DB access goes through the engine interface
   (`core/engine/`). SQLite + `sqlite-vec` + FTS5 is the default; Postgres is a
   later drop-in. Canonical state never lives only behind this interface.
5. **Thin harness, fat skills.** Judgment/adaptive work → markdown skills under
   `skills/`. Deterministic lookups/lists/status → code (a CLI op). If the agent
   has to think, it's a skill; if it's a lookup table, it's code.
6. **Provider-agnostic AI.** All model calls go through `core/ai/gateway.ts`.
   Never couple core logic to one provider. Fully-offline (local model, no keys)
   is a supported, tested configuration.
7. **Lightweight core.** No Docker, no message queue, no mandatory network in
   the core. Background work is one worker + a lock until proven insufficient.
8. **Cross-platform always** — macOS, Linux, Windows. See rules below.

---

## Iron rules (working discipline)

### Efficient code — no unnecessary lines
Write the minimum correct, clear code. Every line earns its place. No dead code,
no duplicated logic, no speculative abstraction, no comments that restate the
code. Prefer deleting over adding. Small focused modules. Terse but readable —
not golfed. When you finish a unit, look for lines to remove.

### Bugs: fix-or-log, never silent
When you hit a bug: if it's small and in-scope, fix it now and add a regression
test. Otherwise **log it to the Bug Log in `ROADMAP.md`** (id, date, severity,
area, repro, suspected cause, status) and reference that id where relevant. Do
not leave silent `TODO`/`FIXME` in code — surface it in `ROADMAP.md`. Every bug
fix lands with a test that fails before and passes after.

### Cross-platform rules
- Use `node:path` for all path work; never hardcode `/` or `\`. Compare/normalize
  paths through path APIs.
- Resolve home/config/data dirs cross-platform (XDG on Linux/mac, `%APPDATA%` on
  Windows — centralize this in `core/config.ts`, don't scatter it).
- Write files as UTF-8 with LF; read tolerantly (accept CRLF).
- Spawn subprocesses portably (e.g. `git`): resolve the executable, no shell
  string interpolation, no `bash`-only constructs in code paths.
- `sqlite-vec` must load on all three OSes; gate/verify extension loading and
  fail with a clear message.
- No platform-only shell commands inside the app. CI runs the test matrix on
  macOS + Linux + Windows; a feature isn't done until it's green on all three.

### Tests — capture output, never pipe through `tail`/`head`
Redirect full output to a file, then read it and check the real exit code. A
pipe makes `$?` the pipe's exit code (often 0) and truncates failures.
```bash
bun test > /tmp/okb-test.txt 2>&1; echo "EXIT=$?"; tail -60 /tmp/okb-test.txt
```
(On Windows/PowerShell use the equivalent redirect + `$LASTEXITCODE`.) Apply the
same pattern to `tsc`, builds, and any command whose exit code matters.

---

## Documentation duties (part of every change)

Treat docs as code; update them in the same change, not "later":

- **`ROADMAP.md`** — check off completed items; add any subtasks/edge cases you
  discovered; add bugs to the Bug Log; add unscheduled ideas to Backlog; add a
  dated one-line entry to the Progress Log. The roadmap grows organically.
- **`CONTEXT.md`** — when you make or change a design decision, or resolve an
  open question, record it in the Decisions Log and update the relevant section.
  `CONTEXT.md` describes **current design only** — no release-history narration.
- **`CLAUDE.md`** (this file) — update only when an invariant, iron rule, or the
  reference map changes. Keep it short.
- **`docs/context/REFERENCES.md`** — when the user adds reference material,
  register and apply it (see below).

A change that alters behavior or design without updating these is incomplete.

## Added reference material (repos, PDFs, markdown)

The user may drop extra context into **`docs/context/`** (PDF/markdown/etc.) or
add links. The registry is **`docs/context/REFERENCES.md`** — a table of each
source, its type, what area it informs, and status (`unread` → `read` →
`applied`). Rules:
- On startup, read `docs/context/REFERENCES.md`. Before working in an area,
  check it for relevant material and read that material first.
- When new material appears, add a registry row, read it, and write a one-line
  summary of how it affects the design (into the row and, if it changes design,
  `CONTEXT.md`). Fetch URLs if you have web access; if not, note it as
  `needs-fetch` so the user can paste the content.

---

## Build & commands (Bun)

```bash
bun install                                   # deps
bun run src/cli.ts <args>                      # run CLI in dev (alias: okb)
bunx tsc --noEmit                              # typecheck
bun test                                       # unit tests (capture per rule above)
bun build --compile --outfile bin/okb src/cli.ts            # local binary
bun build --compile --target bun-darwin-arm64 --outfile dist/okb-macos-arm64 src/cli.ts   # cross-compile example
bun run src/cli.ts serve                       # start local GUI + API (later stage)
bun run src/cli.ts mcp                          # start MCP server (later stage)
```

## Reference map (load on demand)

| Working on… | Read first |
|---|---|
| anything — current tasks, status, bugs | `ROADMAP.md` |
| the design / why a component exists | `CONTEXT.md` (find the section) |
| OKF format, frontmatter, conformance | `CONTEXT.md` §Storage & OKF conformance |
| graph: links/backlinks/typed edges/viewer | `CONTEXT.md` §Knowledge graph |
| AI gateway, retrieval, enrichment, MCP | `CONTEXT.md` §AI integration |
| CLI/GUI/MCP + the ops contract | `CONTEXT.md` §Surfaces |
| stack, libs, repo layout, scale path | `CONTEXT.md` §Tech stack / §Repo layout |
| user-supplied extra context | `docs/context/REFERENCES.md` |

## Architecture in one line

Surfaces (CLI / GUI / MCP) → one ops contract → OKF store (canonical) + derived
engine (SQLite+vec+FTS, graph) + AI gateway (local|API) + skills/jobs. Detail in
`CONTEXT.md`.
