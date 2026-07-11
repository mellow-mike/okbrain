# Feature framework: Clip — web clipper & reading inbox

Status: proposed. Destination: `docs/features/FEATURE-CLIP.md`. The kickoff
prompt at the bottom has the agent merge this into `CONTEXT.md` / `ROADMAP.md`
(per doc duties) before building. Binding rules: `CLAUDE.md`.

## Why

A brain is only as good as what gets into it. Today capture is `okb capture`
(manual note) or bulk import; there is no path from "I'm reading this page" to
"conformant concept in my bundle" in under five seconds. Clip is that path —
and it feeds every downstream feature (search, graph, ask, review).

## Design

### Pipeline (the `clip` op, scope: `write`)

Input: URL + optional `note`, `quote`, `tags`.

1. **Fetch** via a shared guarded fetcher (`core/ingest/fetch-guard.ts`):
   http/https only, SSRF guard (block private/link-local ranges), size cap,
   timeout, single redirect chain limit. This module is *extracted early* and
   later reused by the Stage-4 web pass — one guard, two callers.
2. **Extract** readable article + metadata (title, author, published date,
   canonical URL): `linkedom` + `@mozilla/readability`, HTML→md via `turndown`.
   Agent verifies this trio runs clean on Bun; if not, pick the lightest
   working equivalent and record the swap in CONTEXT's Decisions Log.
3. **Dedupe** by normalized canonical URL (strip fragment + tracking params,
   lowercase host) against the `resource` frontmatter field (engine query).
   Existing concept → append quote/note under `# Highlights`, refresh
   `timestamp`; no duplicate file.
4. **Write** through the conformance writer: `references/<slug>.md`,
   `type: Reference`, `resource: <canonical url>`, auto `description` (meta
   description or first paragraph), tags = user tags + `inbox`, body = extracted
   markdown capped at `clip.maxBodyBytes` (default 100KB, truncation noted),
   `# Citations` with the source link. `index.md` / `log.md` update as usual.
5. **Hooks** (each skipped gracefully if its stage isn't built): link-suggest,
   embed. Optional AI auto-tagging is off in the `lean` profile.

Offline: fail fast with a clear message. No offline queue in v1 (lightweight).

### Reading inbox

Read-state is user knowledge → must survive `okb rebuild` → lives in the
bundle, not the DB. Representation: the `inbox` **tag** (already OKF-optional
frontmatter; no format extension). Marking read = remove the tag. The inbox is
just the query `tag:inbox`:
- CLI: `okb inbox` (list), `okb inbox read <id>` (clear tag).
- GUI (Stage 3): Inbox view — list with open / mark-read / suggest-links.
- Resurface synergy: `inbox` is a scoring signal in the review queue.

### Surfaces

- `okb clip <url> [--note …] [--quote …] [--tags a,b] [--read]` (`--read` skips
  the inbox tag).
- `clip` exposed through the ops contract → GUI paste-box + MCP (write-gated
  for untrusted callers, as all write ops).
- **Bookmarklet**: `okb bookmarklet` prints a JS bookmarklet that sends the
  current page URL to the local API. Desktop browsers only in v1.

### Security — the bookmarklet hole (fail-closed)

Any web page can fire requests at `localhost`; without a check, a malicious
page could write into the brain (CSRF). Requirement: the clip endpoint demands
a **per-install secret token**, generated at `okb init`/first `serve`, embedded
in the bookmarklet by `okb bookmarklet`, validated server-side; requests
without it are rejected. Transport (GET-with-confirmation-page vs no-cors
POST) is the agent's call — record it in CONTEXT. CORS stays locked; token is
required regardless.

### Config (`clip.*`)

`maxBodyBytes` (100KB), `stripParams` (default utm_* etc.), `autoTag`
(off in `lean`), `defaultTags`.

### Dependencies & timing

Needs the Stage-1 conformance writer. Lands after Stage 1; independent of
Stage 2 (embedding hook no-ops until then). Extracting `fetch-guard.ts` now is
deliberate pre-work for Stage 4.2.

## Roadmap insert (paste as a feature block after Stage 1)

```
## Feature: Clip — web clipper & reading inbox (after Stage 1)
- [ ] F-A.1 `core/ingest/fetch-guard.ts` — http/https only, SSRF guard, size cap, timeout (shared with Stage 4.2)
- [ ] F-A.2 Extraction: linkedom + @mozilla/readability + turndown on Bun (verify; record swaps)
- [ ] F-A.3 Canonical-URL normalize + dedupe against `resource` (append `# Highlights` on re-clip)
- [ ] F-A.4 `clip` op + writer path: references/<slug>, type Reference, citations, `inbox` tag, body cap
- [ ] F-A.5 CLI: `okb clip`, `okb inbox`, `okb inbox read <id>`; `--json`
- [ ] F-A.6 Bookmarklet + per-install token; endpoint validates; `okb bookmarklet`
- [ ] F-A.7 Hooks: link-suggest + embed (graceful no-op pre-Stage-2); autoTag off in lean
- [ ] F-A.8 GUI Inbox view (fold into Stage 3.2)
- [ ] F-A.9 Tests: extraction on local HTML fixtures (no live network in CI); guard against stub server; dedupe; token rejection; clipped doc passes doctor
```

## Acceptance criteria

1. `okb clip <url>` on a real article → concept passes `okb doctor`; visible in
   search and graph; tagged `inbox`.
2. Re-clipping the same URL (any tracking-param variant) creates no new file.
3. Requests to the clip endpoint without the token are rejected.
4. CI green on macOS/Linux/Windows with zero live-network tests.
5. `rg -n "clip"` shows all fetches routed through `fetch-guard.ts`.

## Open questions (small; agent decides + records)

- Slug collisions for different URLs with identical titles (suffix strategy).
- Whether `--quote` also copies into the clipboard-note flow of `okb capture`.

## Kickoff prompt

```
Add the Clip feature to okbrain. First read CLAUDE.md, CONTEXT.md, ROADMAP.md,
docs/context/REFERENCES.md, and docs/features/FEATURE-CLIP.md (this framework).

MERGE DOCS FIRST (same-change rule):
- CONTEXT.md: add a "Clip — web clipper & reading inbox" section under AI
  integration/Ingest summarizing pipeline, inbox-as-tag, and the bookmarklet
  token requirement; log decisions (extraction libs, token transport) in the
  Decisions Log as you make them.
- ROADMAP.md: insert the F-A block from the framework after Stage 1; add a
  Progress Log line.

THEN BUILD in F-A order. Gate: if Stage 1 conformance writer isn't done,
finish the blocking Stage-1 items first. Hold the iron rules: efficient code
(minimum correct, delete dead lines), bugs fix-or-log to the ROADMAP Bug Log
with regression tests, cross-platform (node:path, portable spawn, UTF-8/LF),
tests/typecheck output captured to a file with real exit codes.

Security is non-negotiable: every fetch goes through fetch-guard.ts; the clip
endpoint rejects tokenless requests; write ops stay gated for untrusted MCP
callers. No live network in CI — use local HTML fixtures and a stub server.

End with the updated ROADMAP and a one-line summary of what shipped and what's
next.
```
