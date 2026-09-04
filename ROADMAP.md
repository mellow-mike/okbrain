# ROADMAP.md

Living, granular roadmap for okbrain. **It grows organically** — add subtasks as
you discover them, log bugs in the Bug Log, drop unscheduled ideas in Backlog,
and append a dated line to the Progress Log each session. Maintaining this file
is required by `CLAUDE.md`. Design rationale lives in `CONTEXT.md`.

## Legend
`[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked · `(Rn)` see Bug Log

## Current focus
> **Stages 0–6 complete.** The brain ingests (import/capture/clip/rss),
> enriches itself behind guardrails (`okb enrich`), retrieves over keyword +
> vector + graph + typed-edge relational arms, proposes links through
> review, runs nightly maintenance (`okb jobs` under OS cron), ships agent
> skills, packages (vec0 beside the binary, five-target release workflow,
> one-command offline local package, Homebrew/Scoop templates), mounts
> multiple brains with per-mount read-only policy (`--brain`, GUI
> switcher), scores opinions (`okb take` / `resolve` / `calibrate`), and —
> as of Stage 6 — writes **OKF v0.2** (provenance / trust / lifecycle
> families, actors, `okb upgrade` for v0.1 bundles) behind a GUI that is a
> full product surface (Home, Browse, a Concept reader, delete, jobs,
> upgrade, sanitized rendering). Postgres and a desktop wrapper stay
> deferred (see 5.4). Next: a tagged `v0.1.0` release, signing when
> certificates exist, and Backlog items as they earn their way in.

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
- [x] Round-trip an OKF sample bundle — unblocked at Stage 6 by vendoring the
      reference project's `acme_retail` v0.2 sample (`bundles/acme_retail/`,
      Apache-2.0): `tests/e2e.acme.test.ts` drives doctor → index → graph →
      search → stats → export-viz over it, read-only

---

## Stage 1 — Authoring + graph + sync
Goal: a real PKM you can write to, conformant on every save, versioned in git.

### 1.1 Conformance writer
- [x] `write_concept` op → through `document.ts`; frontmatter scaffold (`type/title/description/timestamp`); refresh `timestamp`
- [x] Link normalization to bundle-absolute on write (`normalizeLinks`; anchors + `"title"` suffixes preserved, `<...>`-wrap when needed)
- [x] Tests: written docs pass `doctor`; unknown keys preserved on edit
- [x] Guardrails: reserved ids refused; unparseable existing frontmatter refused (no clobber); `tags: []` clears; write op untrusted-gated

### 1.2 index.md / log.md generation
- [x] `core/okf/indexmd.ts` — regenerate `index.md` per touched dir + ancestors (group by `type`, entries carry `description`, H1/intro preserved, placeholder descriptions synthesized)
- [x] `core/okf/logmd.ts` — append `## YYYY-MM-DD` (UTC, newest-first) + `**Creation**/**Update**/**Deprecation**`
- [x] `okf_version` maintained in root `index.md` frontmatter (unknown root keys preserved)
- [x] Wired into `writeConcept`: every write regenerates the index chain + logs
- [x] Tests: index regen grouping; H1/intro preservation; root fm; ancestor chain; log append ordering; writer-built bundle doctor-clean

### 1.3 Authoring ops/CLI
- [x] `okb new <type> <title> <description>` — id derived `<type>s/<slug>` (`--id` override); create-only
- [x] `okb capture [text]` — stdin fallback (generic `stdinFallback` param flag); `inbox/<date>-<slug>` with collision suffix; title/description from first line
- [x] `okb import <path>` — map existing md/dirs → OKF (frontmatter derived or carried, unknown keys preserved via writer `extra`); dedupe by id (`--overwrite`, in-run first-wins); `--dest`/`--type`
- [x] Tests: new/capture/import produce conformant (doctor-clean) concepts; slugify; dedupe; stdin path

### 1.4 Graph (write-aware)
- [x] Materialized backlinks: `Engine.edgesOf` over the edges table; `okb graph` tags depth-1 rows `→` links-to / `←` cited-by / `↔` both
- [x] `core/graph/queries.ts` — `okb path <from> <to>` (BFS shortest, per-hop arrows, exit 1 on no path) + `okb orphans`
- [x] Incremental index update on single-concept write (`updateIndexFor`; all write ops refresh an existing index, never create one)
- [x] Dangling edges stored, resolved against `nodes` at query time — backlinks to a newly written concept appear without a rebuild
- [x] Tests: dangling-edge visibility/walking, incremental update (incl. backlink-appears regression), path/orphans pure + CLI

### 1.5 Sync (git)
- [x] `core/sync.ts` — git init/commit/push/pull/status (argv-only spawn, no
      shell strings; `GIT_TERMINAL_PROMPT=0` so nothing hangs on credentials;
      refuses a bundle nested inside another repo; `main` via `symbolic-ref`)
- [x] `okb sync` (`--message`, `--status`); seeds bundle `.gitignore` (`.okb/`,
      `/viz.html`, `db_only/`) and `.gitattributes` (`* text=auto eol=lf`) by
      appending missing lines only — user lines never touched
- [x] db_only privacy made real, not just gitignored: writes under `db_only/`
      skip the committed root `log.md` entry and parent `index.md` listings
      (`inDbOnlyDir` in `paths.ts`); per-page db_only → Backlog
- [x] Tests: init/seed/commit/no-op; push+pull against a local **bare** remote
      (multi-device flow, zero network in CI); nested-repo refusal; LF pinned
      under `core.autocrlf=true`; db_only end-to-end; CLI `--status`/`--json`

### 1.6 Optional
- [ ] `okb watch` — re-index on file change (cross-platform watcher) —
      **deferred**: recursive watching differs per OS; revisit when it hurts

---

## Feature: Resurface — review queue (F-B, after Stage 1)
Deterministic daily "worth another look" queue with stated reasons; zero AI
providers required. Design: `docs/features/FEATURE-RESURFACE.md` + CONTEXT
§Resurface. Scope guard: GUI card stack → 3.2, cron recompute → 4.5,
daily-note section → 4.6, AI garnish → 2.3 (items live at those stages).
- [x] F-B.1 `core/review/score.ts` — signals + weighted score + reason strings
      (`review.*` config keys wired since 2.1; zero-weighted signals drop
      their reason too)
- [x] F-B.2 Engine schema v2: `timestamp`/`last_reviewed` node columns +
      `review_state` (snooze) table; degrees computed from resolved edges in
      the scorer; queue recomputed on demand (no cache table at CLI scale).
      Stale-schema handling: data methods refuse with guidance, `wipe()`
      (= `okb rebuild`) recreates the current schema
- [x] F-B.3 Ops: `review_queue` (read); `review_done`/`review_snooze` (write) —
      `last_reviewed` stamped via the conformance writer in metadata-only mode
      (no `timestamp` refresh, no log.md entry); done clears any snooze
- [x] F-B.4 CLI: `okb review`, `okb review done <id|n>`,
      `okb review snooze <id|n> [--days 7]`; `--json`; two-word commands are
      a generic CLI-adapter feature (positions resolve against the unlimited
      ranking so any `--limit` listing's numbering stays valid)
- [x] F-B.5 Tests: each signal in isolation; exclusion windows; deterministic
      ordering (score → older timestamp → id) on a fixture bundle; done
      survives rebuild, snooze doesn't; metadata-only writer semantics;
      stale-schema refuse/repair

---

## Feature: Clip — web clipper & reading inbox (F-A, after F-B)
URL → conformant `references/` concept in seconds; feeds search/graph/review.
Design: `docs/features/FEATURE-CLIP.md` + CONTEXT §Clip. Scope guard:
bookmarklet + token endpoint → 3.1, GUI inbox view → 3.2; embed hook → 2.2,
link-suggest hook → 4.4, autoTag → 2.3 (clip runs zero-AI by construction).
- [x] F-A.1 `core/ingest/fetch-guard.ts` — http/https only, SSRF guard (DNS
      lookup; private/link-local/CGNAT/loopback + IPv6/mapped forms; each
      redirect hop re-checked), size cap, timeout; `allowPrivate` opt-in
      exists for tests/future intranet config (never set by the CLI)
- [x] F-A.2 Extraction verified on Bun: linkedom + @mozilla/readability +
      turndown all run clean — **no swaps needed**; relative links/images
      absolutized against the page URL post-extraction
- [x] F-A.3 Canonical-URL normalize (strip fragment/tracking params, sort
      query) + dedupe against `resource`, both sides normalized; a known
      input URL dedupes before any fetch (offline re-clip append); works
      with or without an index (engine rows or bundle scan)
- [x] F-A.4 `clip` op + writer path: `references/<slug>` (numeric suffix on
      collisions), type `reference`, `# Citations`, `# Highlights` for
      quote/note, `inbox` tag, `author`/`published` extras, 100 KB body cap
      noted on truncation
- [x] F-A.5 CLI: `okb clip <url> [--quote] [--note] [--tags] [--read]`,
      `okb inbox`, `okb inbox read <id>` (metadata-only: timestamp/log
      untouched); `--json`
- [x] F-A.9 Tests: extraction on a local fixture; guard policy with zero
      packets + mechanics against a 127.0.0.1 stub (no live network in CI);
      tracking-param dedupe; doctor-clean clips; truncation; inbox flow;
      also verified once against a live article locally (doctor-clean)

---

## Stage 2 — AI gateway + semantic retrieval
Goal: ask questions of your brain, offline or via API.

### 2.1 Gateway + recipes
- [x] `core/ai/gateway.ts` + `recipes.ts` — `embed`/`chat`/`rerank`; resolution
      per capability: per-call → env (`OKB_CHAT_/EMBED_/RERANK_PROVIDER|MODEL|
      BASE_URL`, generic `OKB_AI_PROVIDER`) → config → key detection; a
      chat-only provider can never hijack the embed slot; plain fetch, no SDKs
- [x] Local recipes: Ollama, llama.cpp/`llama-server`, LM Studio (one
      OpenAI-compatible dialect; `local` alias → ollama; no keys needed)
- [x] API recipes: OpenAI, Anthropic, Gemini, OpenRouter (chat); OpenAI,
      Voyage, Gemini (embed); Voyage (rerank — the only rerank recipe in v1)
- [x] `okb init` — non-interactive picker: detects API-first from present
      keys, persists the choice + the default bundle into `config.json`
      (resolution now explicit → `$OKB_BUNDLE` → config → cwd); flags for
      provider/model/embed-*; `--no-default-bundle`
- [x] Config file (`config.json` in the per-user config dir): load/save with
      unknown keys preserved; `review.*` + `clip.*` now wired into their ops;
      tests hermetic via a preload that pins the config dir + strips keys
- [x] Tests: resolution precedence + detection; all three dialects and rerank
      against a stub local server (the offline path); missing-key errors;
      init detect/merge/validate; config wiring for review/clip

### 2.2 Embeddings + vector index
- [x] `core/retrieval/chunk.ts` — ~400-token chunker (chars/4 approximation;
      paragraph packing, line/hard splits; no tokenizer dep)
- [x] `sqlite-vec` integration (`core/engine/vectors.ts`): vec0 + cosine in a
      separate `.okb/vectors.db` (rebuild-safe, extension-optional; see
      CONTEXT decision 2026-07-13); macOS handled via
      `core/engine/custom-sqlite.ts` (`Database.setCustomSQLite`,
      `$OKB_SQLITE_LIB` → Homebrew → MacPorts; CI installs brew sqlite);
      clear actionable errors on load failure
- [x] Embed pipeline (`core/retrieval/embed.ts`) → store vectors; hash skip
      over title+description+body (metadata-only stamps don't re-embed);
      provider+model+dim cache key, mismatch = visible full reset
- [x] `okb embed` (incremental, `--limit` paces, interrupted runs resume,
      stale concepts removed)
- [x] Embed-on-write hook: writes/clips refresh their vectors when a store
      exists (F-A.7); best-effort — failure warns, never fails the write;
      never resets the cache key
- [x] Tests: re-embed only on change; provider switch invalidates correctly;
      store mechanics + persistence; batch-boundary assembly; CLI + hook
      end-to-end vs a stub embed server (no network in CI)
- [x] Compiled binary can't self-locate the vec0 extension (node_modules
      isn't shipped) — resolved at 5.1: okb looks for vec0 next to its own
      executable; `bun run build` and the release archives ship the pair
      together; `$OKB_SQLITE_VEC` stays the universal override

### 2.3 Retrieval pipeline
- [x] `core/retrieval/hybrid.ts` — vector + FTS recall fused via RRF (k=60);
      queries embedded under the store's own cache key; vector-arm failures
      degrade to keyword-only with a warning; stale vector rows dropped
- [x] Graph expansion: 1-hop neighbors/backlinks of top fused hits join at
      ×0.25 of the parent score, tagged `graph` (off in `lean`)
- [x] `core/retrieval/rerank.ts` — optional rerank; runs only with an
      *explicitly* configured provider (never key detection — no silent spend)
- [x] `core/retrieval/profiles.ts` — `lean` / `balanced` / `max` (arm depths,
      rerank/multi-query switches, ask budget); `--profile` flag +
      `retrieval.profile` config key
- [x] `okb search` upgraded to hybrid (sources tagged per hit); `okb ask` —
      RAG synthesis, citations post-verified against the packed context,
      empty pool short-circuits before the model, `max` multi-query expansion
- [x] Review garnish (F-B.8): `okb review --garnish` — one chat call annotates
      queue items with a one-liner tying them to notes changed ≤7d; clip
      autoTag (F-A): `okb clip --auto-tag` / config `clip.autoTag` suggests
      kebab-case topic tags against the bundle's tag vocabulary. Both opt-in
      (no silent spend), off in `lean` (`profile.extras`), and fail-soft —
      any AI failure leaves the deterministic result untouched
- [x] Tests: RRF fusion; arm sources/degradation; citation integrity; profile
      budget enforced; CLI e2e vs stub embed+chat server (no network in CI)

---

## Stage 3 — GUI + MCP
Goal: a real GUI, and "my agent can use my brain."

### 3.1 Local API
- [x] `api.ts` — routes generated over the ops registry (`GET /api/ops`,
      `POST /api/op/<name>`; `localOnly` ops hidden); binds 127.0.0.1 only;
      Host header checked (DNS rebinding); CORS locked to the server's own
      localhost origins; per-request `OpContext` via shared
      `core/context.ts` (CLI refactored onto it)
- [x] Streaming `ask`: `GET /api/ask/stream` (SSE) — phased events
      `context` → `answer` → `done`/`error` via a generic `Operation.stream`
      hook (true token streaming through the gateway → Backlog)
- [x] Clip endpoint + per-install secret token + `okb bookmarklet` (F-A.6):
      token minted at first use (`core/serve-token.ts`, 0600 beside
      config.json), required on **every** `/api` and `/clip` request
      (constant-time compare; CSRF fail-closed); bookmarklet = top-level GET
      navigation to `/clip` (no CORS/mixed-content/PNA hurdles), selection
      rides along as the highlight quote
- [x] `okb serve [--port]` (API now, GUI page lands at 3.2) + `okb
      bookmarklet [--port]`, both `localOnly` admin ops

### 3.2 GUI app (`okb serve`)
- [x] No bundler at all: vanilla single-page app (`src/gui/` — index.html,
      app.js, style.css), served by api.ts and embedded into the compiled
      binary via Bun text imports (verified: binary serves all assets)
- [x] Graph view — live Cytoscape over the new `graph_data` read op (also
      `okb graph-data --json` for agents); search filter, type-colored nodes
      (viz palettes), detail panel with rendered body + rewired `#concept:`
      links, click-through to editor
- [x] Editor — scaffold fields + markdown body textarea; concept-id link
      picker (inserts normalized links); live backlinks; citation-section
      helper; saves via `write_concept` (suggested-link inbox → 4.4)
- [x] Ask view — SSE streamed: context chips appear before the answer,
      verified citations link to graph/editor
- [x] Review view — card stack with reasons + optional garnish toggle;
      done / snooze / open / graph (suggest-links → 4.4)
- [x] Inbox view — open / mark-read / graph (suggest-links → 4.4)
- [x] Settings — provider/model + retrieval profile (via `init`, which
      gained `--retrieval-profile`), sync status/run, maintenance
      (re-index / embed / doctor); enrichment guardrails arrive with 4.2
- [x] `okb serve` starts API + GUI; whole app driven end-to-end in Chromium
      (all views, zero page errors, zero external requests)
- [x] Full-surface wiring pass: every non-`localOnly` op now has a GUI home
      (invariant 2). New views — **Search** (`search`), **Add** (`capture`/
      `clip`/`rss`/`import`), **Claims** (`take`/`resolve`/`calibrate`),
      **Stats** (`stats`/`graph_path`/`orphans`) — plus Settings maintenance
      gained `export_viz` + confirm-gated `rebuild`. `new_concept` stays
      Editor-covered by design. Regression test asserts each op literal is
      present in the served `app.js`; re-driven end-to-end in Chromium (all
      ten views incl. write/admin flows, zero page errors, zero external
      requests)

### 3.3 MCP server (`okb mcp`)
- [x] `src/mcp/server.ts` — tools generated from the ops registry via the MCP
      TS SDK (schemas from the same param specs as CLI/API); stdio transport
      (default) + Streamable HTTP (`--http`/`--port`, stateless
      server-per-request, 127.0.0.1 bind + Host check); verified end-to-end
      through the compiled binary
- [x] Trust fail-closed: untrusted by default (read ops only — hidden from
      the list AND refused by name AND re-gated in `runOp`); `--trusted`
      exposes write ops; admin + localOnly ops never appear on this surface;
      concept-id traversal refused before any path is built
- [x] Tests: gated write (hidden + refused), read ops, generated schemas,
      traversal confinement, trusted write doctor-clean, HTTP transport —
      all through the real SDK client

---

## Stage 4 — Enrichment agent + jobs + typed edges
Goal: the brain improves itself on a schedule.

### 4.1 Ingest sources
- [x] `core/ingest/rss.ts` — RSS 2.0/RDF/Atom parse (linkedom XML, no new deps);
      `pullFeed` → conformant `references/<slug>` (inbox+rss tags, `# Citations`,
      author/published/feed extras), dedupe by normalized URL vs every concept
      `resource` (clip's rule — a feed entry and a clip of the same page can't
      duplicate; in-run dedupe too), per-pull `limit`
- [x] `okb rss [url] [--limit]` — no URL pulls every config `rss.feeds`
      (multi-pull records per-feed errors so one dead feed can't block the
      rest; a single explicit feed fails loudly); `rss.maxItems` config
- [x] `import.ts` (bulk md) and `capture.ts` landed at 1.3, clip at F-A —
      this stage's remaining source was feeds
- [ ] (Later) browser grab; email/calendar
- [x] Tests: RSS+Atom parse (rel=alternate, content:encoded, dc:creator,
      relative links, linkless items), idempotent re-pull, in-run dedupe,
      limit paging, doctor-clean output, CLI no-feeds error + live guard

### 4.2 Web pass (LLM-as-crawler)
- [x] `core/ingest/web.ts` — `fetch_url` tool with guardrails enforced
      in-tool: `--no-web`, frontier rule (only seeds + links discovered on
      fetched pages are fetchable — an invented URL is refused with zero
      packets), depth cap, host allowlist (default: seed hosts, subdomains
      ok), path allow/deny prefixes, page cap (checked last so policy
      refusals report their real reason), step cap; guarded fetch underneath
      (SSRF guard stays live)
- [x] Crawler loop: JSON-action protocol over the plain-text chat gateway
      (list_concepts / read_concept / fetch_url / write_concept / done);
      enrich existing | mint `references/<slug>` (new ids confined there,
      tool-enforced) | skip; citations prompted under `# Citations`;
      guard refusals + bad writes are error observations (model corrects
      course), unparseable replies strike out after 2
- [x] Tool set simplified vs the sketch: one read tool (read_concept, raw);
      `embed_doc` unnecessary — writes go through the standard reindex hook
      (index + vectors refresh automatically); `link_suggest` joins the
      toolset when 4.4 lands
- [x] `okb enrich [task] [--web-seed …] [--concept id] [--web-max-pages]
      [--web-max-depth] [--allow-host] [--allow-path] [--deny-path]
      [--no-web]`; GUI Settings gained the enrichment form (guardrails +
      run), deferred from 3.2
- [x] Tests: every cap/filter enforced in-tool (incl. frontier + depth-2
      refusal + zero-packet invented-URL), scripted-chat full pass
      (doctor-clean cited reference), references/ confinement, bad-write
      observation, strike-out + step cap, CLI usage errors

### 4.3 Typed edges + relational retrieval
- [x] `core/graph/typed-edges.ts` — deterministic classification: the clause
      right before the link ("depends on [X]") wins, else the nearest
      preceding heading ("# Citations" → cites; unknown heading = untyped,
      not inherited), else null; one shared `REL_VOCAB` phrase table drives
      classifier + query detection; `rel` stored on edges (schema v3 —
      DB-only, the markdown stays plain OKF; cache = the index itself,
      recomputed with every index build/write refresh)
- [x] `core/retrieval/relational.ts` — relational arm: query names a known
      relation → anchor via FTS (question stop-words stripped) → in+out
      neighbors over that rel join RRF fusion tagged `relational`; strict
      no-op otherwise; always on (cheap, deterministic — no profile knob)
- [x] Tests: heading/sentence/priority/dedupe classification; rel round-trip
      through the engine; relational queries both directions; four no-op
      cases; hybrid integration (tag present / absent)

### 4.4 Link suggestion + review
- [x] `core/graph/link-suggest.ts` — deterministic proposals with reasons
      (title mention w/ word boundary → strongest; per-word FTS similarity —
      engine.search is AND-semantics so one query per meaty word; shared
      tags); self + already-connected (both directions) excluded
- [x] Ops: `link_suggest` (read) + `link_accept` (write — appends a
      normalized `[Title](/id.md)` under `# Related`, creating the section;
      re-accept is a visible no-op); CLI `okb links suggest|accept`; the
      enrich agent's toolset gained the `link_suggest` action (4.2 note)
- [x] Suggested links always route through review (open question resolved —
      see CONTEXT decision); accept is the only writer
- [x] GUI: suggest-links buttons in Review + Inbox cards (accept = writes) and
      the Editor (insert = textarea-local, real on save) — deferred from 3.2
- [x] Tests: ranking + reasons + word-boundary mention; exclusions; CLI e2e
      (accept → conformant `# Related` link, backlink visible without
      reindex, repeat no-op, accepted target drops out); missing target
      not_found; enrich-tool wiring both with and without an index

### 4.5 Jobs / cron
- [x] `core/jobs/worker.ts` — sequential runner + `.okb/jobs.lock` (exclusive
      create; stale lock — dead pid, unreadable, or >24 h — reclaimed once);
      scheduling belongs to the OS (cron/launchd/Task Scheduler invoking
      `okb jobs`), no daemon in v1
- [x] `okb jobs [--only …]` runs: index refresh (also regenerates edges/
      backlinks wholesale), embed backfill (only when a vector store already
      exists — never creates one), rss pull (config `rss.feeds`), review
      queue recompute (F-B.7 — queue is on-demand, so the job surfaces
      today's queue in the run report), doctor. **enrich-stale deliberately
      excluded**: no job spends AI implicitly (no-silent-spend rule); run
      `okb enrich` when you mean it
- [x] Progress to stderr (structured log); SIGINT/SIGTERM finish the current
      job then stop; per-job failures captured, later jobs still run; exit 1
      when any non-skipped job failed
- [x] Tests: lock exclusivity/stale-reclaim/release; failure capture +
      ordering; CLI e2e (run/skip reasons, idempotent re-run, held-lock
      refusal, `--only` subset + unknown-job usage error)

### 4.6 Skills
- [x] `skills/RESOLVER.md` (thin router: intent table + ground rules —
      brain-first, writes only via okb commands, no silent spend) +
      `capture/enrich/ingest/query/daily-note/link-suggest` SKILL.md
- [x] daily-note embeds a "worth revisiting" section from the review queue
      (F-B.7 — reasons verbatim, done/snooze stays the user's move)
- [x] Each parameterized (explicit Parameters block) and CLI-grounded:
      deterministic steps are `okb` calls, the skill carries only judgment

---

## Stage 5 — Packaging, scale & advanced

### 5.1 Packaging & release
- [x] vec0 ships beside the binary: `extensionPath` looks `$OKB_SQLITE_VEC`
      → next to the okb executable → the sqlite-vec npm package (dev);
      `bun run build` copies the platform vec0 into `bin/`
      (`scripts/copy-vec0.ts`); compiled-binary embed verified end-to-end
      against a stub (dlopen can't read Bun's compiled-in virtual files, so
      side-by-side beats embedding)
- [x] Release workflow (`.github/workflows/release.yml`): tag `v*` →
      `scripts/package-release.ts` cross-compiles all five targets
      (linux/darwin × x64/arm64 + windows-x64) on one Linux runner, pairs
      each with its platform vec0 from the npm registry, emits
      tar.gz/zip + SHA256SUMS.txt, creates the GitHub release; full run
      verified locally
- [x] Homebrew formula + Scoop manifest templates (`packaging/`, both built
      on the okb-and-vec0-side-by-side rule) + `packaging/README.md`
- [!] Signed/notarized binaries — blocked on org certificates; the hook
      points and per-OS steps are documented in `packaging/README.md`

### 5.2 Multi-brain mounts (brains axis)
- [x] Config `brains` map (string path or `{ path, readonly }`; `~`
      expansion, absolute-path rule) + `resolveBrain`/`listBrains` in
      `core/config.ts`
- [x] `okb --brain <name>` / `$OKB_BRAIN` (global CLI flag; mutually
      exclusive with `--bundle`); `okb brains` lists mounts (localOnly —
      mount paths are host topology, never a network surface)
- [x] Read-only policy enforced in the ops layer (`checkOpCall` refuses
      write/admin before any handler) and threaded through CLI, local API
      (per request), and MCP — a served read-only brain stays read-only
- [x] Tests: config resolution, ops-layer gating, CLI e2e incl. env var +
      exclusivity (`tests/brains.test.ts`)

### 5.3 Calibration — takes vs facts
- [x] `core/claims.ts` — `type: claim` concepts carry `confidence` (0–100),
      optional `resolve_by`, and on settlement `outcome`
      (correct/incorrect/void — words, not YAML booleans) + `resolved`; all
      okbrain extension keys, OKF-safe; scan-based (no index required)
- [x] Ops: `take` (stake a claim at `claims/<slug>`), `resolve` (settles
      exactly once; true/false accepted as aliases), `calibrate` (read:
      open claims w/ overdue flags, Brier score, per-decade calibration
      buckets) — zero AI, fully deterministic
- [x] Tests: pure Brier/bucket/overdue math + CLI e2e (doctor-clean claims,
      single settlement, validation) (`tests/claims.test.ts`)

### 5.4 Deliberately deferred
- [!] `core/engine/postgres.ts` (pgvector) + rebuild-parity test — no
      Postgres in the 3-OS CI matrix means it can't meet the "most
      well-tested" bar; the engine interface stays the seam; revisit when a
      bundle actually outgrows SQLite (decision 2026-07-20)
- [!] Tauri/Electron desktop wrapper — the GUI is already cross-platform
      via `okb serve`, and a wrapper adds the repo's heaviest dependency
      for chrome; revisit on real demand (decision 2026-07-20)

---

## Stage 6 — OKF v0.2, GUI refresh, production readiness

### 6.1 Format: OKF v0.2 (spec moved to `open-knowledge-format`, R3)
- [x] `core/okf/document.ts` — v0.2 readers: `generated`/`verified` events
      (bare mapping = one-element list), trust tiers, `status` (default
      stable), `stale_after` (explicit offset or ignored), `sources`
      (bare mapping tolerated), actor convention, `generatedAt` with the
      v0.1 `timestamp` fallback (§13.1), `asInstant`
- [x] Writer emits `generated: { by: <actor>, at }` instead of `timestamp`;
      `verify` events (one per actor, latest wins); validated `status`,
      `stale_after`, `sources` (ids assigned); canonical key order; legacy
      `timestamp`/`last_reviewed` superseded in place; `extra` undefined
      deletes a key; no-op guard keyed on `generated`
- [x] Actor model: config `actor` (`okb init --actor`, default
      `human:<os user>`), `OpContext.actor()`, `okb/<version>` for tool
      content (clip/rss/import), `okb-enrich/<model>` for the agent,
      `<client>/<version>` over MCP (from the initialize handshake)
- [x] Clip + RSS: `sources` (page / feed + article with byline and
      publication instant) replace `# Citations`; enrich tool merges
      `sources` (never shrinks), requires ≥1 on minted references, prompts
      for `[^id]` footnotes
- [x] Provenance edges: `sources[].resource` → typed `cites` edges;
      path-valued fields resolve with the spec's root-relative convention
      (`resolvePathField`); shared by index build, viz export, doctor
- [x] Doctor: `legacy-timestamp`, `legacy-citations`, `generated-shape`,
      `verified-shape`, `status-value`, `stale-after-format`,
      `sources-shape`, `broken-source`, `computation-runtime`,
      `okf-version` mismatch; `signals` block (trust / status / stale /
      legacy counts); `okfVersion` in the report
- [x] `okb upgrade [--dry-run] [--by]` (`core/okf/upgrade.ts`) —
      timestamp → generated, `# Citations` → sources, `last_reviewed` →
      verified, clip extras → source signals, root `okf_version` → 0.2;
      idempotent, metadata-only, one summary log line; example bundle
      migrated with it (dogfood)
- [x] Engine schema v4 (`status`, `stale_after`, `trust`; `timestamp` =
      generated.at, `last_reviewed` = latest human verification);
      `okb stats` byStatus / byTrust / expired; Resurface: `expired` +
      `draft` signals, deprecated never queues, `review done` = verified
      event; `okb list --detail/--type/--tag/--status`; `okb read` signals
- [x] `okb rm` (`delete_concept`): file + emptied-directory pruning + index
      chain + `**Deletion**` log + engine/vector removal
- [x] Tests: `tests/okf.v02.test.ts` (readers, path fields, provenance
      edges, upgrade, ops), `tests/e2e.acme.test.ts` (upstream sample),
      v0.2 rewrites of writer/doctor/clip/rss/web/review/stats tests

### 6.2 GUI refresh (every function reachable from the GUI)
- [x] New views: **Home** (tiles, quick capture, review/inbox previews,
      recently changed, one-click doctor, build-index prompt), **Browse**
      (signals, filter/sort), **Concept** reader (provenance, footnotes,
      links to / cited by, verify / read / suggest / deprecate / delete),
      **Edit/New** (status, `stale_after`, sources editor; `new_concept`
      when no id), Graph legend + stale/deprecated styling, Add gained
      `--auto-tag` + bookmarklet, Stats gained status/trust tiles
- [x] `localOnly` ops surfaced without becoming ops: brain switcher
      (`GET /api/brains` names + `x-okb-brain` scoping), status footer
      (`GET /api/status`), bookmarklet (`GET /api/bookmarklet`), MCP setup
      snippet in Settings; `jobs` (job subset) and `upgrade` (preview + run)
      in Maintenance
- [x] Shared `core/viz/render.js` (markdown via `safe-markdown.js` →
      footnote attribution → link routing) for the GUI and the static
      viewer; static viewer shows v0.2 badges + provenance
- [x] Registry-derived GUI wiring test (no more hand-maintained op list)
- [x] Driven end-to-end in headless Chromium against the compiled binary:
      every view, write flows (capture, verify, edit, new, claim, snooze,
      read), brain switch to a read-only mount, zero page errors, zero
      external requests
- [x] Responsive layout (sidebar → top bar under 860px); `/` focuses
      search; `okb serve --open` (config `serve.open`)

### 6.3 Production packaging
- [x] `package.json` version 0.1.0, `core/version.ts` (embedded in the
      binary; `okb --version`; MCP server version)
- [x] `bun run package` — `scripts/package-release.ts --local`: host-only
      archive with the vec0 from `node_modules`, fully offline
- [x] CI + release pin Bun 1.3.14 (B6 was a `latest` drift)
- [x] Docs: README (v0.2, GUI tour, offline package, upgrade), CONTEXT,
      CLAUDE.md invariant 1, REFERENCES (R1 updated, R3/R4 added), skills
- [ ] Tag `v0.1.0` (runs the release workflow) — the maintainer's call

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
| B3 | 2026-07-11 | high | engine/CLI | engine-backed reads (`okb search`/`graph`/…) on a never-indexed bundle silently created an empty `.okb/index.db`; `hasIndex()` then trusted it, so later writes refreshed a near-empty index — silent search truncation | lazy `ctx.engine()` always opened with create | fixed | `OpContext.engine(createIfMissing)` — only `index`/`rebuild` create; other ops fail with "run `okb index` first"; regression test in `tests/cli.test.ts` |
| B4 | 2026-07-11 | low | tests | sync tests failed on ubuntu/windows CI only: the clone-side `git commit` saw no identity ("empty ident name" / "unable to auto-detect email") though `beforeAll` set `GIT_AUTHOR_*` in `process.env`; local runs masked it via the developer's global gitconfig, macOS via runner ident auto-detect | Bun's `execFileSync` without an `env` option passes the *startup* environment, not mutated `process.env` (production `runGit` already spreads it explicitly) | fixed | test helper passes `env: { ...process.env }`; the clone sets local `user.name`/`user.email` so its commit is env-independent |
| B5 | 2026-07-13 | med | tests | 3 `okb review` CLI tests fail from 2026-07-12 onward (green when written on 07-11): "fresh" notes a/b/c enter the queue. The fixture stamped timestamps relative to a **pinned** `NOW = 2026-07-11`, but the real CLI scores with `new Date()` — one real day later the notes gain staleness > 0 and rank | date-relative fixture pinned to the authoring date; only the pure-scorer tests may pin `now` (they inject it) | fixed | CLI fixture timestamps now derive from `Date.now()` (captured once as `TS.*` so asserts match); pure-scorer tests keep the pinned `NOW` |
| B6 | 2026-07-17 | low | tests | 2 `engine.vectors` tests failed on windows CI only (PR #13): both `rm` their temp dir while the store's `vectors.db` is still open (the shared `afterEach` closes too late). POSIX unlinks open files; Windows refuses (EBUSY/EPERM). Green on 07-13 — CI pins `bun-version: latest`, so a Bun update likely changed the Windows file-share flags and exposed it | test deleted a directory containing an open SQLite DB | fixed | `store.close()` before the in-test `rm` (double close is a no-op); the two tests themselves are the regression proof (fail on Windows before, pass after) |
| B7 | 2026-07-20 | low | mcp | HTTP transport: an exception inside the per-request handler (connect/handleRequest) became an unhandled promise rejection with the client socket left open | async `createServer` callback had no try/catch | fixed | wrapped in try/catch → JSON 500; found by review — no deterministic repro exists through the SDK (it absorbs malformed input), so the guard is verified by inspection |
| B8 | 2026-07-20 | low | api | `okb serve` on an occupied port died with Bun's raw "Failed to start server" instead of telling the user what to do | EADDRINUSE not translated at `createApiServer` | fixed | actionable error naming `--port`; regression test in `tests/api.test.ts` |
| B9 | 2026-07-30 | crit | viz/gui | Stored XSS in both viewers: `marked.parse(body)` → `innerHTML` renders raw HTML from concept bodies. Repro: clip a page that *displays* `&lt;img src=x onerror=…&gt;` as text — turndown un-escapes it into the markdown body — then open the concept. Driven in Chromium pre-fix: the handler fired and POSTed the whole graph `G` to an external host. In the GUI the page also holds `window.OKB_TOKEN`, so a payload reaches every write/admin op | markdown permits inline HTML by spec and marked has had no sanitizer since v5; bodies are untrusted (clip/rss/import/git-synced bundles) | fixed | shared `core/viz/safe-markdown.js` escapes raw HTML and gates link/image URL schemes; `tests/viz.safe-markdown.test.ts` + Chromium re-drive (0 live nodes, 0 external requests) |
| B10 | 2026-07-30 | high | ingest | SSRF guard bypass: `isPrivateIp` matched IPv6 textually, so only the dotted-quad spelling of an IPv4-mapped address was caught. `http://[::ffff:7f00:1]/` reached a loopback server (verified end-to-end); `::ffff:a9fe:a9fe` reaches cloud metadata and `0:0:0:0:0:0:0:1` is loopback. Reachable from `okb clip` / `okb rss` / `okb enrich` | regex matching on the un-expanded literal cannot classify IPv6 — one address has many spellings | fixed | expand to eight groups first, then classify (v4-mapped/compatible → v4 rules; fc00::/7, fe80::/10, ff00::/8); unparseable → refuse. Regression tests in `tests/clip.test.ts` |
| B11 | 2026-07-30 | med | api | `tokenMatches` compared UTF-16 string length but handed byte buffers to `timingSafeEqual`; a multibyte candidate of equal string length threw `RangeError` instead of returning false, so the auth path answered 500 rather than 401 (reachable by any page that can hit the port) | length check in code units, comparison in bytes | fixed | compare byte lengths before `timingSafeEqual`; regression tests at both unit and HTTP level in `tests/api.test.ts` |
| B12 | 2026-07-30 | low | api | GUI responses carried no anti-framing headers, though `/` embeds the serve token — a remote page could frame the GUI and drive authenticated writes with hijacked clicks | no `X-Frame-Options`/`frame-ancestors` on the local API | fixed | `X-Frame-Options: DENY` + `frame-ancestors 'none'` + `nosniff` on every response; regression test in `tests/api.test.ts` |
| B13 | 2026-09-03 | med | gui | `jobs` (admin, not localOnly) had no GUI home although the 3.2 decision promised every network-facing op one; the wiring test listed ops by hand and simply omitted it | hand-maintained expectation list | fixed | Settings → Maintenance runs `jobs` (job subset); the API test now derives the required op set from the registry |
| B14 | 2026-09-03 | low | authoring | `okb new` derived the directory from the raw type (`Attested Computation` → `Attested Computations/x`, with the space) | `${type}s/` without slugifying | fixed | `slugify(type)+"s"`; test in `tests/okf.v02.test.ts` |
| B15 | 2026-09-03 | med | ingest | `okb capture` wrote to the `inbox/` directory but never tagged `inbox`, so captures were invisible to `okb inbox`, the Inbox view, and the review queue's inbox signal (the reading inbox is the tag, not the directory) | capture didn't add the tag | fixed | captures carry the `inbox` tag; regression in `tests/authoring.test.ts` |
| _(example)_ | _2026-06-28_ | _med_ | _engine_ | _`okb index` doubles edges on re-run_ | _upsert not keyed on (src,dst,rel)_ | _open_ | _—_ |

Severity: `crit` (data loss / corruption / non-conformant write) · `high`
(feature broken) · `med` (wrong but recoverable) · `low` (cosmetic).

---

## Backlog (unscheduled ideas)
Capture anything not yet placed in a stage; promote into a stage when picked up.
- [ ] Full-text snippet highlighting in `okb search` output
- [ ] Bulk import performance: each imported file regenerates its whole
      `index.md` ancestor chain + appends `log.md`; batch the regeneration for
      large trees if it gets slow
- [ ] `okb capture` triage flow: promote `inbox/` notes to a proper home
      (`okb move`? skill?) once graph tooling (1.4) exists
- [x] Writer no-op detection: skip the write (and the `timestamp` refresh) when
      the result would be byte-identical, so re-running imports/agent passes
      never churns git history. `writeConcept` reserializes the candidate with
      the existing timestamp and compares to the on-disk bytes; a match returns
      `{ noop: true }` before any rewrite/log/index work. Non-canonical files
      (CRLF, missing timestamp) never match, so they still get normalized.
- [x] `okb stats` (concept/edge/tag counts, orphans, freshness) — read op over
      `core/stats.ts` (pure `computeStats`): by-type + top-tag breakdowns,
      orphan/inbox/never-reviewed counts, oldest/newest + a stale window. Needs
      an index (fails loudly otherwise, per B3); auto-exposed on CLI/API/MCP.
- [ ] Bundle templates / starter vocabularies
- [ ] Export to other PKM formats (one-way) for portability checks
- [ ] Link extraction and doctor's `log.md` heading scan are regex-based and
      code-fence-unaware — a `](x.md)` or `## heading` inside a fenced code
      block is treated as real. Revisit if it bites.
- [ ] Concept-id case sensitivity differs across filesystems (macOS/Windows
      case-insensitive); decide on a canonical-casing policy before it matters.
- [ ] Per-page `db_only` (frontmatter flag → sync appends the path to
      `.gitignore`); v1 privacy is per-directory only.
- [x] `viz.html` and the GUI render concept bodies through
      `core/viz/safe-markdown.js` (raw HTML escaped, URL schemes gated — B9);
      the shared `core/viz/render.js` builds on it.
- [ ] True token streaming for `okb ask` / the SSE endpoint: the gateway
      returns whole chat responses, so the `answer` event arrives in one
      piece; add SSE parsing per dialect when incremental rendering matters.
- [ ] Per-brain settings: a mount could carry its own retrieval profile /
      provider defaults (today `brains` entries are path + readonly only).
- [x] GUI brain switcher: the local API re-scopes per request via
      `x-okb-brain` (read-only policy included); the sidebar has the
      dropdown.
- [ ] Claims in review: surface overdue claims (`resolve_by` past) as a
      Resurface signal so settling them becomes part of the daily queue.
- [ ] Per-directory `log.md` (OKF §9 allows one at any level); okbrain
      maintains only the root log today.
- [ ] Upstream-style `index.md` (H1 sections, relative links) as a
      generator option, for bundles shared with the reference tooling.
- [ ] `usage_count` / `usage_window` credibility signals from local usage
      (reads, ask citations) — the spec's adoption signal, sourced from
      the brain's own telemetry, opt-in.
- [ ] `verified` events for machine checks (`process:okb-doctor` after a
      clean doctor run?) — decide whether a conformance pass counts as
      confirmation; today only humans and agents verify.
- [ ] Attested Computation execution/attestation (§10) — deliberately out of
      scope for a personal brain; the contract is displayed, not run.

---

## Progress Log
Newest first. One line per session: what changed + what's next.
- 2026-09-03 — **Stage 6: OKF v0.2 + GUI refresh + production.** The spec
  moved to `open-knowledge-format` and reached v0.2 (provenance / trust /
  lifecycle, actors, Attested Computations); okbrain now writes it: the
  writer records `generated` by a per-surface actor, `review done` is a
  `verified` event, clip/rss/enrich cite `sources`, `status`/`stale_after`
  flow through doctor, the engine (schema v4), stats, the review queue and
  every viewer; `sources[].resource` paths become `cites` edges; `okb
  upgrade` migrates v0.1 bundles (dogfooded on `bundles/example`);
  `bundles/acme_retail` (upstream sample) is the read-only conformance
  fixture. New ops: `upgrade`, `delete_concept` (`okb rm`), `list --detail`.
  GUI rebuilt as a full surface (Home, Browse, Concept reader, Edit with
  v0.2 fields, brain switcher, jobs/upgrade, MCP setup, bookmarklet) over
  three dedicated status routes; v0.2 footnotes and link routing through a
  `render.js` shared with the static viewer (on top of the security audit's
  `safe-markdown.js`); registry-derived wiring test;
  driven end-to-end in headless Chromium against the compiled binary.
  Production: version 0.1.0, `okb --version`, `bun run package` (offline
  local archive), Bun pinned in CI/release, `okb serve --open`. Fixed
  B13–B15. 430+ tests green, tsc clean. Next: tag `v0.1.0`; Backlog.
- 2026-08-08 — **README rewritten as a landing page.** Reordered from a
  ten-step tutorial into a cognitive funnel (what → why → demo → install →
  quick start → commands → config → architecture), and every command, output
  block and count re-verified against the code rather than carried over.
  Fixed four stale/false claims: the test count (372 → 398), a missing
  `stats` command in the reference table, an install section pointing at
  GitHub Releases when zero releases are tagged (build-from-source is now
  the primary path; the release flow sits in a `<details>` with a TODO), and
  README-only env vars now cross-checked against `gateway.ts`
  (`OKB_AI_PROVIDER` added). Adds a Mermaid architecture diagram, an exit-code
  table (`doctor` → 1 makes it a CI gate), and surfaces the shipped
  `bundles/example` as a zero-commitment trial path. Docs only — no `src/`
  change. Next: Backlog as items earn in.
- 2026-07-30 — **Security audit of `src/`.** Full pass against the CLAUDE.md
  invariants. Four findings, all fixed with regression tests (B9–B12): stored
  XSS in `viz.html` and the GUI via unsanitized `marked.parse` → `innerHTML`
  (confirmed exploitable in Chromium — it exfiltrated the whole graph, and the
  GUI page holds the serve token), an SSRF guard bypass on IPv6 spellings of
  loopback/metadata addresses, an unhandled `RangeError` on the API auth path,
  and missing anti-framing headers. Trust gating (`checkOpCall`), the ops
  contract, the git subprocess layer and FTS/SQL construction all held up.
  Next: unreviewed lower-severity notes are listed in the PR — atomic concept
  writes and `slugify` dropping non-ASCII titles are the two worth scheduling.
- 2026-07-22 — **GUI full-surface wiring.** Closed the gap between the ops
  contract and the GUI: a dozen non-`localOnly` ops were CLI/MCP-only.
  Added four views — **Search** (hybrid `search` with source chips),
  **Add** (quick `capture` / `clip` / `rss` / `import` in one ingest hub),
  **Claims** (`calibrate` dashboard + `take` stake form + per-claim
  `resolve`), **Stats** (`stats` tiles + `graph_path` finder + `orphans`
  list) — and gave Settings maintenance `export_viz` + a confirm-gated
  `rebuild`. `app.js`/`index.html`/`style.css` only (presentation layer;
  no ops touched). New api.test asserts every op the GUI should expose is
  wired in the served `app.js` (`ask` via its SSE endpoint). Driven
  end-to-end in Chromium across all ten views incl. capture/resolve/
  export-viz/rebuild write+admin flows — zero page errors, zero external
  requests. 383 tests green, tsc clean. Next: Backlog as items earn in.
- 2026-07-22 — Two high-impact Backlog items shipped. **Writer no-op
  detection** (`core/okf/write.ts`): an update that would reproduce the
  on-disk bytes but for a timestamp refresh is skipped entirely — no rewrite,
  no `timestamp` bump, no `log.md` entry, no index churn — so re-imports and
  repeated agent passes stop churning git history and `timestamp` keeps
  meaning "last content change"; `WriteResult.noop` surfaces it (`okb write`
  renders `unchanged`). Non-canonical files (CRLF, missing timestamp) never
  false-match, so they still normalize. **`okb stats`** (`core/stats.ts` pure
  `computeStats` + read op + engine `tagCounts()`): concept/link/tag totals,
  by-type and top-tag breakdowns, orphan/inbox/never-reviewed counts, and a
  freshness window (oldest/newest + stale-over-N-days); auto-exposed on
  CLI/API/MCP. 382 tests green, tsc clean. Next: Backlog as items earn their
  way in.
- 2026-07-20 — **Stage 5 shipped** after a full review pass. Review: no
  functional bugs found; hardening B7 (MCP HTTP 500 guard) + B8 (serve
  port-in-use message, with test), six internal-only exports de-exported.
  5.1 packaging: vec0 resolves next to the executable, `bun run build`
  copies it, `scripts/package-release.ts` + `release.yml` build all five
  targets (verified locally end-to-end incl. compiled-binary embed vs a
  stub), Homebrew/Scoop templates under `packaging/`. 5.2 multi-brain:
  config `brains` map, `--brain`/`$OKB_BRAIN`, read-only policy enforced in
  `checkOpCall` and threaded through CLI/API/MCP, `okb brains` (localOnly).
  5.3 calibration: `core/claims.ts`, `okb take`/`resolve`/`calibrate`
  (Brier + decade buckets, zero AI). 5.4: Postgres + desktop wrapper
  deferred with reasons (Decisions Log). README rewritten
  production-ready with a 10-step startup guide. 372 tests green, tsc
  clean. Next: signing when certs exist; Backlog on demand.
- 2026-07-19 — Stage 4.6 shipped, **Stage 4 complete**: skills
  (`skills/RESOLVER.md` router + capture/ingest/enrich/query/daily-note/
  link-suggest SKILL.md — parameterized, CLI-grounded, brain-first;
  daily-note embeds the review queue per F-B.7). 349 tests green, tsc
  clean. Next: Stage 5 packaging (vec0 in the binary, signed per-OS
  builds).
- 2026-07-19 — Stage 4.5 shipped: jobs worker (`core/jobs/worker.ts` —
  sequential run under `.okb/jobs.lock`, stale-reclaim once, signal-clean
  stop, per-job failure capture; `okb jobs [--only]` = index, embed
  backfill (existing store only), rss pull, review recompute (F-B.7),
  doctor; enrich-stale excluded by the no-silent-spend rule; OS cron owns
  scheduling). 349 tests green, tsc clean. Next: 4.6 skills.
- 2026-07-19 — Stage 4.4 shipped: link suggestion (`core/graph/link-suggest.ts`
  — deterministic reasons-first ranking: bounded title mention, per-word FTS
  similarity, shared tags; connected/self excluded), ops `link_suggest`
  (read) + `link_accept` (write → normalized link under `# Related`), CLI
  `okb links suggest|accept`, enrich toolset action, GUI buttons in
  Review/Inbox (accept) + Editor (insert-only). Open question resolved:
  suggestions always route through review. 342 tests green, tsc clean.
  Next: 4.5 jobs/cron.
- 2026-07-19 — Stage 4.3 shipped: typed edges (`core/graph/typed-edges.ts` —
  deterministic sentence-clause → heading → null classification over a
  shared REL_VOCAB; engine schema v3 stores nullable `rel`, DB-only) and
  the relational retrieval arm (`core/retrieval/relational.ts` — rel-naming
  queries anchor via FTS and add in+out rel neighbors to RRF, tagged
  `relational`; strict no-op otherwise, always on). 336 tests green, tsc
  clean. Next: 4.4 link suggestion.
- 2026-07-19 — Stage 4.2 shipped: web pass (`core/ingest/web.ts` — LLM as a
  guarded crawler; JSON-action loop over the plain chat gateway; guardrails
  all enforced in-tool: frontier rule, depth/host/path/page caps, --no-web,
  step cap; SSRF guard underneath; new ids confined to references/).
  `okb enrich` + GUI Settings enrichment form (deferred from 3.2). 10 new
  tests vs scripted chat + fake fetcher (zero network). 326 tests green,
  tsc clean. Next: 4.3 typed edges.
- 2026-07-19 — Stage 4.1 shipped: RSS/Atom ingest (`core/ingest/rss.ts` —
  linkedom XML parse over direct-child lookups, RSS 2.0/RDF/Atom;
  `okb rss [url] [--limit]`, no URL = config `rss.feeds`, per-feed errors
  captured on multi-pulls). New items land as conformant `references/<slug>`
  (inbox+rss tags, citations, author/published/feed extras), deduped by
  clip's normalized-resource rule incl. in-run. 316 tests green, tsc clean.
  Next: 4.2 web pass.
- 2026-07-17 — Stage 3.3 shipped, **Stage 3 complete**: MCP server
  (`src/mcp/server.ts` via `@modelcontextprotocol/sdk` — the stage's one new
  dep). Tools + JSON schemas generated from the ops registry; untrusted by
  default (read ops only: hidden from tools/list, refused by name, re-gated
  in `runOp`), `okb mcp --trusted` exposes write ops, admin/localOnly never
  appear; stdio transport default, `--http` Streamable HTTP (stateless
  server-per-request, 127.0.0.1 + Host check); id traversal refused before
  any path is built. 8 new tests through the real SDK client (in-memory +
  HTTP transports); stdio + tools/call verified through the compiled
  binary. 307 tests green, tsc clean. Next: Stage 4.1/4.2 (ingest + web
  pass).
- 2026-07-17 — Stage 3.2 shipped: GUI (`src/gui/` — vanilla single-page app,
  zero build step; Bun text imports embed all assets into the binary, same
  pattern as the viz vendor libs). Views: Graph (live Cytoscape over the new
  `graph_data` op, viz palettes, detail panel with rewired links,
  click-through to editor), Editor (scaffold fields + body, concept link
  picker, citation helper, live backlinks, saves via `write_concept`), Ask
  (SSE — context chips stream in before the answer; citations link to
  graph/editor), Review (cards + garnish toggle, done/snooze), Inbox
  (open/mark-read), Settings (`init` — which gained `--retrieval-profile` —
  plus sync + index/embed/doctor). Whole app driven in Chromium: all views
  exercised, zero page errors, zero external requests; compiled binary
  serves the embedded assets. 299 tests green, tsc clean. Next: 3.3 MCP.
- 2026-07-17 — Stage 3.1 shipped: local API (`src/api.ts`) — op routes
  generated from the registry (`GET /api/ops`, `POST /api/op/<name>`,
  `localOnly` ops hidden), fail-closed security (127.0.0.1 bind, Host check
  vs DNS rebinding, per-install token on every `/api`+`/clip` request with
  constant-time compare, CORS only for the server's own localhost origins),
  SSE `GET /api/ask/stream` via a new generic `Operation.stream` hook
  (events `context` → `answer` → `done`/`error`; true token streaming →
  Backlog), bookmarklet clip: `GET /clip` top-level navigation endpoint +
  `okb bookmarklet` embedding the token (`core/serve-token.ts`), `okb serve
  [--port]`. Shared `core/context.ts` now builds the trusted OpContext for
  CLI + API. 295 tests green, tsc clean. Next: 3.2 GUI.
- 2026-07-17 — F-B.8 shipped, **Stage 2 complete**: review garnish
  (`core/review/garnish.ts` — `okb review --garnish` makes one chat call
  annotating queue items with a ≤25-word line connecting them to notes
  changed in the last 7 days; unknown ids and "no connection" lines dropped)
  and clip autoTag (`core/ingest/autotag.ts` — `okb clip --auto-tag` /
  config `clip.autoTag` suggests ≤5 kebab-case topic tags, existing bundle
  tags offered as vocabulary via new `Engine.listTags()`; reserved `inbox`
  filtered). Both opt-in, gated by the new `extras` profile switch (off in
  `lean`), and fail-soft — chat failures warn and leave the deterministic
  queue/clip untouched. 278 tests green, tsc clean. Next: Stage 3.1 local
  API.
- 2026-07-17 — Stage 2.3 core shipped: hybrid retrieval
  (`core/retrieval/hybrid.ts` — RRF k=60 over FTS + sqlite-vec arms, queries
  embedded under the store's own cache key, vector-arm failures degrade to
  keyword-only with a warning, stale vector rows dropped; 1-hop graph
  expansion at ×0.25 parent score), profiles (`profiles.ts` —
  lean/balanced/max arm depths + ask budget, `--profile` flag,
  `retrieval.profile` config), opt-in rerank (`rerank.ts` — explicit
  provider only, a stray VOYAGE_API_KEY never spends), and `okb ask`
  (`ask.ts` — RAG with citations post-verified against the packed context,
  empty pool short-circuits before the model, `max` multi-query expansion
  via chat). `okb search` renders per-hit recall sources. 265 tests green
  (incl. CLI e2e vs a stub embed+chat server), tsc clean. Next: F-B.8
  review garnish + clip autoTag (last 2.3 line), then 3.1 local API.
- 2026-07-13 — Stage 2.2 shipped: chunker (`core/retrieval/chunk.ts`),
  sqlite-vec vector store in its own `.okb/vectors.db` (vec0 + cosine;
  rebuild-safe; `VectorStore` interface; macOS custom-SQLite shim +
  Homebrew-sqlite CI step; actionable load errors, `$OKB_SQLITE_VEC`
  override for the compiled binary), embed pipeline with hash skip over
  title+description+body and a (provider, model, dim) cache key,
  `okb embed [--limit]` (incremental, paceable, resumable), embed-on-write
  hook (best-effort, never fails a write, never resets the key). Compiled
  binary verified end-to-end against a stub. Fixed B5 (review CLI fixture
  date rot). Registered R2 (KM textbook preview — background only).
  243 tests green, tsc clean. Next: 2.3 hybrid retrieval + `okb ask`.
- 2026-07-11 — Stage 2.1 shipped: provider-agnostic gateway
  (`core/ai/gateway.ts` + `recipes.ts`; chat/embed/rerank over three HTTP
  dialects, plain fetch, no SDKs), per-capability resolution (per-call → env
  → config → key detection; chat-only providers can't claim embed), local
  recipes (Ollama/llama.cpp/LM Studio) + API recipes (OpenAI/Anthropic/
  Gemini/OpenRouter chat; OpenAI/Voyage/Gemini embed; Voyage rerank),
  `okb init` (detects API-first, persists provider + default bundle to
  `config.json`, validates flags), `review.*`/`clip.*` config wired, tests
  hermetic via preload (temp config dir, provider keys stripped). Compiled
  binary verified. 213 tests green, tsc clean. Next: 2.2 embeddings +
  sqlite-vec.
- 2026-07-11 — F-A Clip shipped: `okb clip <url>` → guarded fetch
  (`fetch-guard.ts`: SSRF checks incl. per-redirect-hop re-resolution, size
  cap, timeout — the module Stage 4.2 will reuse), readable-article
  extraction (linkedom + @mozilla/readability + turndown, verified on Bun,
  no swaps; relative links absolutized), canonical-URL dedupe (append
  `# Highlights` on re-clip, no fetch when the URL is already stored),
  conformant `references/<slug>` writes with citations + `inbox` tag;
  `okb inbox` / `okb inbox read` (metadata-only tag clear). Three pure-JS
  deps added (linkedom, @mozilla/readability, turndown). Live-article smoke
  test doctor-clean. 196 tests green, tsc clean. Next: Stage 2.1.
- 2026-07-11 — F-B Resurface shipped: pure deterministic scorer
  (`core/review/score.ts`, six signals with reason strings), engine schema v2
  (`timestamp`/`last_reviewed` columns, `review_state` snooze table,
  stale-schema refuse + wipe-repairs), `okb review` / `review done <id|n>` /
  `review snooze <id|n> [--days]` over three ops (two-word CLI commands are a
  generic adapter feature), writer metadata-only mode (stamp `last_reviewed`
  without touching `timestamp`/log.md). Zero AI required. 180 tests green,
  tsc clean. Next: F-A Clip.
- 2026-07-11 — Merged the Resurface (F-B) and Clip (F-A) feature frameworks
  into the docs: roadmap blocks inserted after Stage 1 with the scope guard
  applied (GUI → 3.2, bookmarklet endpoint → 3.1, cron → 4.5, AI garnish/
  autoTag/embed hooks → Stage 2 — items added at those stages), CONTEXT
  gained §Resurface + §Clip and Decisions Log entries (state split,
  metadata-only writes, inbox-as-tag, fetch-guard-first). Next: build F-B.
- 2026-07-11 — Stage 1.5 git sync: `core/sync.ts` (argv-only git, credential
  prompts disabled, nested-repo refusal), `okb sync [--status|--message]` —
  init + seed (`.gitignore`: `.okb/` `/viz.html` `db_only/`; `.gitattributes`:
  `* text=auto eol=lf` so Windows autocrlf can't rewrite bundle bytes and
  invalidate Stage-2 content-hashes), commit, `pull --rebase` + push when
  `origin` exists. db_only privacy enforced in the generators (no private
  titles in committed index/log). Fixed B3 (unindexed reads created an empty
  index). 161 tests green (push/pull vs a local bare remote — no network in
  CI), tsc clean. **Stage 1 complete**; 1.6 watch deferred. Next: merge
  Resurface/Clip frameworks into docs, then build F-B.
- 2026-07-08 — Stage 1.4 write-aware graph: edges now stored dangling-inclusive
  and resolved against `nodes` in every query, so `updateIndexFor` (run by all
  write ops when an index exists) keeps the graph exact without rebuilds —
  backlinks to a just-written concept appear on their own. `okb graph` gained
  `→`/`←`/`↔` direction tags; new `okb path` (BFS shortest chain with per-hop
  arrows) and `okb orphans` over pure `core/graph/queries.ts`. 150 tests
  green, tsc clean. Next: 1.5 git sync.
- 2026-07-08 — Corrected the OKF reference (repo links were hallucinated; real
  source registered as R1 in REFERENCES.md — spec confirms current design) and
  shipped Stage 1.3 authoring: `okb new` (derived `<type>s/<slug>` id,
  create-only), `okb capture` (piped-stdin fallback, `inbox/<date>-<slug>`,
  collision suffix), `okb import` (md file/tree → concepts, frontmatter
  derived/carried incl. unknown keys via new writer `extra` input, dedupe by
  id + `--overwrite`). 138 tests green, tsc clean. Next: 1.4 write-aware graph.
- 2026-07-07 — Stage 1.2: index.md/log.md generation — every `okb write`
  regenerates `index.md` for the touched dir + ancestors (type-grouped rows,
  H1/intro preserved as the human-editable head, `## Directories` from child
  intros, root `okf_version` maintained) and appends a `**Creation**/**Update**`
  entry to root `log.md` (UTC `## YYYY-MM-DD`, newest-first). Writer-only
  bundles are doctor-clean (0 errors 0 warnings); regenerating the example
  bundle reproduces it verbatim. 123 tests green, tsc clean. Next: 1.3
  authoring ops/CLI.
- 2026-07-05 — Merged parallel sessions: two branches independently built 0.8
  and 1.1; kept main's example bundle, writer, and e2e test, kept this branch's
  viewer redesign (dark default with persisted toggle, CSS-var token bridge
  into Cytoscape, per-mode CVD-validated palettes, hover tooltips, Links
  to/Cited by, type counts; verified in Chromium both themes — zero JS
  errors/external requests) and `tests/helpers.ts` dedupe. Backlogged the
  dropped writer's no-op detection idea.
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
