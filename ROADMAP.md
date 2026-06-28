# ROADMAP.md

Living, granular roadmap for okbrain. **It grows organically** — add subtasks as
you discover them, log bugs in the Bug Log, drop unscheduled ideas in Backlog,
and append a dated line to the Progress Log each session. Maintaining this file
is required by `CLAUDE.md`. Design rationale lives in `CONTEXT.md`.

## Legend
`[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked · `(Rn)` see Bug Log

## Current focus
> Stage 0 — Format core + read-only viewer. Done: 0.1 repo/tooling, 0.2 OKF
> document model, 0.3 read-only graph extraction. Next: 0.4 engine (SQLite) +
> index build.

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
- [ ] `core/engine/interface.ts` — engine contract (open, migrate, upsert, query, wipe)
- [ ] `core/engine/sqlite.ts` — schema (`nodes`, `edges`, `tags`, FTS5), open/migrate
- [ ] `core/engine/index-build.ts` — walk bundle → upsert nodes/edges/tags + FTS (idempotent)
- [ ] Keyword search query (FTS5/BM25) over title/body/tags
- [ ] Graph queries: neighbors + depth-bounded CTE
- [ ] Tests: build is idempotent; re-index after edit; search hits; neighbor query

### 0.5 Operations contract + CLI (read side)
- [ ] `core/operations.ts` — registry shape (name, params, handler, scope, trust); read ops: `search`, `read_concept`, `list_concepts`, `graph_neighbors`, `doctor`, `index`, `rebuild`, `export_viz`
- [ ] `cli.ts` — generate commands from ops; arg parsing; help; `--json`
- [ ] Wire: `okb index`, `okb rebuild --confirm-destructive`, `okb search`, `okb read`, `okb graph`, `okb doctor`

### 0.6 Conformance (`okb doctor`)
- [ ] `core/okf/doctor.ts` — checklist (frontmatter parseable; non-empty `type`; index/log structure; permissive-consumer assertions) + report
- [ ] Tests: passing bundle; each failure class detected

### 0.7 Static graph viewer
- [ ] `core/viz/export.ts` — walk bundle → graph JSON → self-contained HTML (Cytoscape + marked, type-colored nodes, directed edges, detail panel, backlinks, search, type filter, layouts)
- [ ] `okb export viz` writes `<bundle>/viz.html`
- [ ] Tests: graph JSON node/edge counts; internal-link rewiring

### 0.8 Stage-0 acceptance
- [ ] `bundles/example/` — tiny conformant bundle (a few linked concepts)
- [ ] End-to-end: index example → search → graph → doctor → export viz
- [ ] (Optional) round-trip an OKF sample bundle (GA4 / Stack Overflow / Bitcoin)

---

## Stage 1 — Authoring + graph + sync
Goal: a real PKM you can write to, conformant on every save, versioned in git.

### 1.1 Conformance writer
- [ ] `write_concept` op → through `document.ts`; frontmatter scaffold (`type/title/description/timestamp`); refresh `timestamp`
- [ ] Link normalization to bundle-absolute on write
- [ ] Tests: written docs pass `doctor`; unknown keys preserved on edit

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
- [ ] `okb sync`; `db_only`/gitignore handling for private concepts
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
- [ ] `sqlite-vec` integration (cross-platform extension load + clear error)
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
- [ ] Link extraction is regex-based and code-fence-unaware — a `](x.md)` inside
      a fenced code block is currently treated as an edge. Revisit if it bites.
- [ ] Concept-id case sensitivity differs across filesystems (macOS/Windows
      case-insensitive); decide on a canonical-casing policy before it matters.

---

## Progress Log
Newest first. One line per session: what changed + what's next.
- 2026-06-28 — Stage 0.1–0.3: repo/tooling + CI matrix, log/config, OKF document
  model (parse/serialize/validate, paths, bundle walk), read-only graph
  extraction (links/backlinks). 44 tests green, tsc clean. Next: 0.4 engine.
- 2026-06-28 — Closed AI-posture question: API-first default, easy local switch. Next: Stage 0.1.
- 2026-06-28 — Repo docs authored (CLAUDE/CONTEXT/ROADMAP/PROMPT). Next: Stage 0.1.
