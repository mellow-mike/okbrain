# ROADMAP.md

Living, granular roadmap for okbrain. **It grows organically** — add subtasks as
you discover them, log bugs in the Bug Log, drop unscheduled ideas in Backlog,
and append a dated line to the Progress Log each session. Maintaining this file
is required by `CLAUDE.md`. Design rationale lives in `CONTEXT.md`.

## Legend
`[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked · `(Rn)` see Bug Log

## Current focus
> Stage 1 — authoring + graph + sync (Stage 0 complete). Done: 1.1 conformance
> writer (`okb write`). Next: 1.2 index.md / log.md generation.

---

## Stage 0 — Format core + read-only viewer (the spine)
Goal: open any OKF bundle, index it, search (keyword), see its graph, check
conformance. Reuses OKF reference shapes directly.

### 0.1 Repo & tooling
- [x] `package.json` (name `okbrain`, bin `okb`), `tsconfig.json` (strict), Bun config
- [x] `.gitignore`, `LICENSE`, minimal `README.md`
- [x] `bunx tsc --noEmit` clean; `bun test` runs
- [x] CI matrix: macOS + Linux + Windows (install, typecheck, test)
- [x] `core/log.ts` — structured logger (levels, JSON option, stderr for progress)
- [x] `core/config.ts` — resolve bundle path + cross-platform config/data dirs
- [x] `src/cli.ts` — minimal entry stub so `bin` resolves (real CLI in 0.5)

### 0.2 OKF document model
- [x] `core/okf/document.ts` — parse (frontmatter + body), serialize, validate
- [x] `core/okf/paths.ts` — concept-id ⇄ path, segment validation
- [x] `core/okf/bundle.ts` — walk tree, list concepts, read concept, reserved-file handling
- [x] Tests: parse/serialize round-trip; missing/!malformed frontmatter; unknown-key preservation; permissive read

### 0.3 Graph extraction (read-only)
- [x] `core/graph/links.ts` — extract md links → edges (resolve rel/abs, drop external/unresolved, dedupe)
- [x] `core/graph/backlinks.ts` — reverse edges
- [x] Tests: relative vs bundle-absolute resolution; broken-link tolerance; dedupe

### 0.4 Engine (SQLite) + index build
- [x] `core/engine/interface.ts` — engine contract (open, migrate, upsert, query, wipe)
- [x] `core/engine/sqlite.ts` — schema (`nodes`, `edges`, `tags`, FTS5), open/migrate
- [x] `core/engine/index-build.ts` — walk bundle → upsert nodes/edges/tags + FTS (idempotent)
- [x] Keyword search query (FTS5/BM25) over title/body/tags
- [x] Graph queries: neighbors + depth-bounded CTE
- [x] Tests: build is idempotent; re-index after edit; search hits; neighbor query

### 0.5 Operations contract + CLI (read side)
- [x] `core/operations.ts` — registry shape (name, cliName, params, handler, scope, render) + fail-closed trust check in `runOp`; ops: `search`, `read_concept`, `list_concepts`, `graph_neighbors`, `index`, `rebuild` (`doctor`/`export_viz` register with 0.6/0.7 when their handlers exist)
- [x] `cli.ts` — commands/arg parsing/help all generated from ops; `--json`; `--bundle`; exit codes 0/1/2
- [x] Wire: `okb index`, `okb rebuild --confirm-destructive`, `okb search`, `okb read`, `okb list`, `okb graph` (`okb doctor` → 0.6)
- [x] Tests: registry uniqueness; trust gating; param validation/coercion; permissive read; rebuild confirmation; CLI help/exit codes/`--json`/persisted index

### 0.6 Conformance (`okb doctor`)
- [x] `core/okf/doctor.ts` — checklist (frontmatter parseable; non-empty `type`; index/log structure; permissive-consumer assertions) + report (error/warning severities; see CONTEXT §Conformance checklist)
- [x] Register `doctor` op (scope read) → `okb doctor` appears in the generated CLI; optional `exitCode(result)` on ops maps a non-conformant report to exit 1
- [x] Tests: passing bundle; each failure class detected; severity mapping; CLI exit codes

### 0.7 Static graph viewer
- [x] `core/viz/export.ts` — walk bundle → graph JSON → self-contained HTML (Cytoscape + marked, type-colored nodes, directed edges, detail panel, backlinks, search, type filter, layouts)
- [x] Register `export_viz` op (scope read); `okb export-viz` writes `<bundle>/viz.html`
- [x] Tests: graph JSON node/edge counts; internal-link rewiring
- [x] Vendor `cytoscape.min.js` + `marked.umd.js` under `core/viz/vendor/` (their `exports` maps hide the browser builds; Bun text imports embed them in the binary)
- [x] Shared permissive read: `readConceptPermissive` in `bundle.ts`, `fmString`/`fmTags` in `document.ts` (index build + viz both use them)

### 0.8 Stage-0 acceptance
- [x] `bundles/example/` — tiny conformant bundle (4 cross-linked concepts in 3 dirs; doctor-clean incl. warnings)
- [x] End-to-end: index example → search → graph → doctor → export viz (`tests/e2e.stage0.test.ts` drives the real CLI on a temp copy)
- [ ] (Optional) round-trip an OKF sample bundle (GA4 / Stack Overflow / Bitcoin)

---

## Stage 1 — Authoring + graph + sync
Goal: a real PKM you can write to, conformant on every save, versioned in git.

### 1.1 Conformance writer
- [x] `write_concept` op → through `document.ts`; frontmatter scaffold (`type/title/description/timestamp`); refresh `timestamp`
- [x] Link normalization to bundle-absolute on write (`normalizeLinks`; anchors + `"title"` suffixes preserved, `<...>`-wrap when needed)
- [x] Tests: written docs pass `doctor`; unknown keys preserved on edit
- [x] Guardrails: reserved ids refused; unparseable existing frontmatter refused (no clobber); `tags: []` clears; write op untrusted-gated

### 1.2 index.md / log.md generation
- [ ] `core/okf/indexmd.ts` — regenerate `index.md` per touched dir (group by `type`, entries carry `description`, synthesize dir descriptions)
- [ ] `core/okf/logmd.ts` — append `## YYYY-MM-DD` + `**Creation**/**Update**`
- [ ] `okf_version` maintained in root `index.md` frontmatter
- [ ] Tests: index regen grouping; log append ordering

### 1.3 Authoring ops/CLI
- [ ] `okb new <type> <title>`, `okb capture`, `okb import <path>`
- [ ] Import: map existing md/dirs → OKF; dedupe
- [ ] Tests: new/capture/import produce conformant concepts

### 1.4 Graph (write-aware)
- [ ] Materialized backlinks in DB; `okb graph` shows "cited by"
- [ ] `core/graph/queries.ts` — paths between concepts; orphan detection
- [ ] Incremental index update on single-concept write

### 1.5 Sync (git)
- [ ] `core/sync.ts` — git init/commit/push/pull/status (portable spawn, no shell strings)
- [ ] `okb sync`; `db_only`/gitignore handling for private concepts; ensure the
      bundle's `.okb/` (derived index) is gitignored
- [ ] Tests: commit/status flow on a temp repo (skip push/pull in CI)

### 1.6 Optional
- [ ] `okb watch` — re-index on file change (cross-platform watcher)

---

## Stage 2 — AI gateway + semantic retrieval
Goal: ask questions of your brain, offline or via API.

### 2.1 Gateway + recipes
- [ ] `core/ai/gateway.ts` — `embed` / `chat` / `rerank`; resolution (per-call → env → config → default)
- [ ] Local recipes: Ollama, llama.cpp/`llama-server`, LM Studio (OpenAI-compatible)
- [ ] API recipes: OpenAI, Anthropic, Gemini, OpenRouter (chat); OpenAI, Voyage, Gemini (embed)
- [ ] `okb init` provider/model picker — API-first default (when a key is present); one-setting switch to local (`--provider local`)
- [ ] Tests: gateway resolution; offline path with a stub local server

### 2.2 Embeddings + vector index
- [ ] `core/retrieval/chunk.ts` — ~400-token chunker
- [ ] `sqlite-vec` integration (cross-platform extension load + clear error).
      Note: on macOS `bun:sqlite` links Apple's SQLite, which blocks extension
      loading — needs `Database.setCustomSQLite()` with a real libsqlite3
- [ ] Embed pipeline → store vectors; content-hash skip; provider+dim cache key
- [ ] `okb embed` (incremental, paceable)
- [ ] Tests: re-embed only on change; provider switch invalidates correctly

### 2.3 Retrieval pipeline
- [ ] `core/retrieval/hybrid.ts` — vector + FTS recall fused via RRF
- [ ] Graph expansion: pull neighbors/backlinks of top hits
- [ ] `core/retrieval/rerank.ts` — optional rerank (local/API)
- [ ] `core/retrieval/profiles.ts` — `lean` / `balanced` / `max` (budget + arms)
- [ ] `okb search` upgraded to hybrid; `okb ask` (RAG synthesis with citations, no fabrication)
- [ ] Tests: RRF fusion; citation integrity; profile budget enforced

---

## Stage 3 — GUI + MCP
Goal: a real GUI, and "my agent can use my brain."

### 3.1 Local API
- [ ] `api.ts` — local HTTP over ops (trusted); bind localhost only; CORS locked to localhost
- [ ] Streaming endpoint for `ask`

### 3.2 GUI app (`okb serve`)
- [ ] GUI build setup (minimal bundler) + static asset embedding into the binary
- [ ] Graph view — live Cytoscape via API; click-through to editor
- [ ] Editor — md + frontmatter; concept-id link autocomplete; live backlinks; citation helper; suggested-link inbox; save via conformance writer
- [ ] Ask view — chat; streamed cited answers; "open in graph"
- [ ] Settings — engine, provider/model, retrieval profile, sync, enrichment guardrails
- [ ] `okb serve` starts API + GUI

### 3.3 MCP server (`okb mcp`)
- [ ] `mcp/server.ts` — expose read/write ops via MCP TS SDK; stdio + HTTP transports
- [ ] Trust = untrusted; gate `write`/`admin`; tighten filesystem confinement
- [ ] Tests: untrusted write is gated; read ops work; scope enforced before handler

---

## Stage 4 — Enrichment agent + jobs + typed edges
Goal: the brain improves itself on a schedule.

### 4.1 Ingest sources
- [ ] `core/ingest/import.ts` (bulk md), `capture.ts` (note/clip), `rss.ts` (feeds)
- [ ] (Later) browser grab; email/calendar

### 4.2 Web pass (LLM-as-crawler)
- [ ] `core/ingest/web.ts` — `fetch_url` tool with guardrails (`--web-max-pages`, `--web-max-depth`, allowed-hosts, path prefix/deny, `--no-web`)
- [ ] Crawler loop: enrich existing concept | mint `references/<slug>` | skip; write `# Citations`
- [ ] Tool set: `list_concepts`, `read_concept_raw`, `read_existing_doc`, `write_concept_doc`, `fetch_url`, `link_suggest`, `embed_doc` (all trust-aware)
- [ ] `okb enrich [--web-seed …]`
- [ ] Tests: caps enforced inside the tool; host allowlist; no-web path

### 4.3 Typed edges + relational retrieval
- [ ] `core/graph/typed-edges.ts` — classify link relation from heading/sentence; store `rel`; cache
- [ ] `core/retrieval/relational.ts` — relational arm over typed edges (deterministic; no-op for non-relational)
- [ ] Tests: relation classification; relational query results; non-relational no-op

### 4.4 Link suggestion + review
- [ ] `link_suggest` → propose cross-links; GUI review inbox; accept writes a normalized link
- [ ] Tests: suggestions ranked; accept produces conformant link

### 4.5 Jobs / cron
- [ ] `core/jobs/worker.ts` — single background worker + file/SQLite lock
- [ ] Scheduled: embed backfill, enrich stale, regenerate index/backlinks, `doctor`
- [ ] Progress to stderr; clean shutdown
- [ ] Tests: lock prevents double-run; jobs idempotent

### 4.6 Skills
- [ ] `skills/RESOLVER.md` (thin router) + `capture/enrich/ingest/query/daily-note/link-suggest` SKILL.md
- [ ] Each parameterized; brain-first where applicable

---

## Stage 5+ — Scale & advanced (optional)
- [ ] `core/engine/postgres.ts` (pgvector) behind the engine interface
- [ ] Rebuild-parity test: SQLite vs Postgres identical derived state
- [ ] Multi-brain mounts (brains axis): per-bundle repo + index + access policy
- [ ] Calibration / "takes vs facts": separate opinions from facts; prediction scoring
- [ ] Tauri/Electron desktop wrapper over the local API
- [ ] Packaging: signed per-OS binaries; Homebrew tap + Scoop manifest; release workflow

---

## Cross-cutting (ongoing, never "done")
- [ ] Cross-platform: every feature green on macOS/Linux/Windows CI
- [ ] Logging + actionable error messages on every failure path
- [ ] Performance: cold start, index build, search latency tracked as they grow
- [ ] Security: trust boundary honored on every new op; SSRF guard on `fetch_url`
- [ ] Docs upkeep: `ROADMAP.md` + `CONTEXT.md` + `docs/context/REFERENCES.md` current

---

## Bug Log
Log bugs here as they're found (per `CLAUDE.md`: fix-or-log). Fix lands with a
regression test; then mark `fixed` with the commit/PR ref.

| id | date | sev | area | description / repro | suspected cause | status | fix |
|----|------|-----|------|---------------------|-----------------|--------|-----|
| B1 | 2026-06-28 | med | graph | `buildEdges` dedupe key was space-joined `${id} ${dst}` (and briefly held a literal NUL, marking the source binary); ids containing spaces could collide/merge distinct edges | non-unique separator for ids that may contain spaces | fixed | `JSON.stringify([id,dst])` key + regression test in `tests/graph.links.test.ts` |
| B2 | 2026-06-28 | low | tests | `config.test.ts` failed on Windows CI: hardcoded POSIX absolute paths (`/abs`, `/work`) — `resolve("/work")` is drive-anchored to `D:\work` on win32. Production code was correct | test baked in POSIX path assumptions | fixed | rebuild expectations via `node:path` `resolve`/`join` so they're OS-correct |
| _(example)_ | _2026-06-28_ | _med_ | _engine_ | _`okb index` doubles edges on re-run_ | _upsert not keyed on (src,dst,rel)_ | _open_ | _—_ |

Severity: `crit` (data loss / corruption / non-conformant write) · `high`
(feature broken) · `med` (wrong but recoverable) · `low` (cosmetic).

---

## Backlog (unscheduled ideas)
Capture anything not yet placed in a stage; promote into a stage when picked up.
- [ ] Full-text snippet highlighting in `okb search` output
- [ ] `okb stats` (concept/edge/tag counts, orphans, freshness)
- [ ] Bundle templates / starter vocabularies
- [ ] Export to other PKM formats (one-way) for portability checks
- [ ] Link extraction and doctor's `log.md` heading scan are regex-based and
      code-fence-unaware — a `](x.md)` or `## heading` inside a fenced code
      block is treated as real. Revisit if it bites.
- [ ] Concept-id case sensitivity differs across filesystems (macOS/Windows
      case-insensitive); decide on a canonical-casing policy before it matters.
- [ ] `viz.html` renders concept bodies with marked, which passes raw HTML
      through — fine for your own notes, but a shared export could carry
      scripted HTML from ingested content. Consider sanitizing (e.g. vendored
      DOMPurify) before Stage 4 ingestion lands.

---

## Progress Log
Newest first. One line per session: what changed + what's next.
- 2026-07-05 — Stage 1.1: conformance writer — `okb write` creates/updates
  concepts with the full scaffold in canonical key order, refreshes
  `timestamp` (ISO-8601 UTC), preserves unknown keys, normalizes links to
  bundle-absolute (anchors/titles preserved), refuses reserved ids and
  unparseable-frontmatter overwrites. 116 tests green, tsc clean. Next: 1.2
  index.md/log.md generation.
- 2026-07-05 — Stage 0.8: `bundles/example/` (tiny fully-conformant bundle,
  0 errors 0 warnings) + end-to-end acceptance test through the real CLI
  (index → search → read → graph → doctor → export-viz → rebuild); gitignored
  the bundle's derived `viz.html`. **Stage 0 complete.** 105 tests green, tsc
  clean. Next: Stage 1.1 conformance writer.
- 2026-07-05 — Stage 0.7: `okb export-viz` — self-contained graph viewer
  (vendored Cytoscape+marked inlined, graph JSON from a bundle walk, internal
  links rewired to `#concept:` anchors, fixed `<bundle>/viz.html` output);
  verified interactively in Chromium (zero JS errors / external requests);
  added project verify skill. 98 tests green, tsc clean. Next: 0.8 acceptance.
- 2026-07-03 — Stage 0.6: `okb doctor` — conformance checker with error/warning
  severities (violations vs permissive-consumer tolerances), registered as a
  read op; ops gained optional `exitCode(result)` so doctor exits 1 on a
  non-conformant bundle. 91 tests green, tsc clean. Next: 0.7 static viewer.
- 2026-07-02 — Stage 0.5: operations registry (scope + fail-closed trust in
  `runOp`, typed param specs with coercion) and a fully generated CLI adapter
  (commands/help/parsing from the registry; `--json`, `--bundle`, exit codes
  0/1/2). 84 tests green, tsc clean. Next: 0.6 `okb doctor`.
- 2026-07-02 — Stage 0.4: engine contract, SQLite engine (bun:sqlite, FTS5/BM25
  weighted search, depth-bounded neighbor CTE), idempotent index build with
  content-hash skip + removal. DB at `<bundle>/.okb/index.db`. 63 tests green,
  tsc clean. Next: 0.5 ops contract + CLI.
- 2026-06-28 — Stage 0.1–0.3: repo/tooling + CI matrix, log/config, OKF document
  model (parse/serialize/validate, paths, bundle walk), read-only graph
  extraction (links/backlinks). 44 tests green, tsc clean. Next: 0.4 engine.
- 2026-06-28 — Closed AI-posture question: API-first default, easy local switch. Next: Stage 0.1.
- 2026-06-28 — Repo docs authored (CLAUDE/CONTEXT/ROADMAP/PROMPT). Next: Stage 0.1.
