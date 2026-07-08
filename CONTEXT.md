# CONTEXT.md

The living design reference for okbrain — the detail that doesn't fit in
`CLAUDE.md`. This file describes the **current design**, not history. When a
decision changes, update the relevant section and add a line to the Decisions
Log (bottom). `ROADMAP.md` tracks what's built; this file explains how it's
meant to work and why.

Originating document: `okbrain-design.md` (the initial research/synthesis).
This file supersedes it as the source of truth for design.

---

## Glossary

- **Bundle** — a user's brain: a directory tree of OKF markdown files in git.
  The canonical store.
- **Concept** — one unit of knowledge = one markdown file with YAML frontmatter.
- **Concept id** — the file path within the bundle minus `.md`
  (`notes/foo.md` → `notes/foo`).
- **Frontmatter** — the YAML block delimited by `---` at the top of a concept.
- **Body** — everything after the frontmatter (standard markdown).
- **Link / edge** — a markdown link from one concept to another; a directed,
  (on-disk) untyped graph edge.
- **Backlink** — the reverse of an edge ("Cited by").
- **Typed edge** — a relationship label (`joins-with`, `cites`, …) derived in
  the DB from link context; never written into the markdown.
- **Engine** — the derived store (SQLite + sqlite-vec + FTS5 by default) behind
  a swappable interface.
- **Op** — an entry in the operations contract (`core/operations.ts`) with a
  scope (`read|write|admin`) and trust flag; the unit every surface calls.
- **Skill** — a fat markdown procedure under `skills/` encoding judgment/process.
- **Gateway / recipe** — the provider-agnostic AI interface and its per-provider
  implementations (local or API).
- **Brain-first** — consult the brain (search op) before answering.
- **System of record** — the bundle; the DB is a derived, rebuildable cache.

---

## Architecture

Five layers, each with one responsibility:

```
 Surfaces (thin):   CLI        GUI (local web)        MCP server
                      └──────────────┴──────────────────┘
 Ops contract:        core/operations.ts  (read/write/admin + trust)
                      ┌──────────┬──────────────┬──────────────┐
 Store (canonical):   OKF bundle (md+frontmatter, git)         │
 Engine (derived):    SQLite + sqlite-vec + FTS5 + graph  ◄────┘ rebuildable
 AI gateway:          embed | chat | rerank   (local | API)
 Skills + jobs:       fat markdown + thin resolver + cron worker
```

Rules of flow: surfaces only call ops; ops read/write the store and update the
engine; the engine is always rebuildable from the store (`okb rebuild`).

---

## Storage & OKF conformance

### Format (OKF v0.1)
A bundle is a directory of UTF-8 markdown files. Reserved filenames at any level:
`index.md` (directory listing / progressive disclosure) and `log.md` (update
history). All other `.md` files are concepts. Relationships beyond the directory
tree are plain markdown links; bundle-absolute links (`/dir/x.md`) are preferred
for stability. Citations go under a `# Citations` heading; external sources may
be mirrored as first-class concepts under `references/`.

### Frontmatter contract
- **On write:** always emit `type`, `title`, `description`, `timestamp`; include
  `resource` (canonical URI) and `tags` when applicable. This satisfies both the
  OKF spec (which requires only `type`) and the OKF reference implementation
  (which also requires `title`/`description`/`timestamp`), and makes index/search
  output good.
- **On read/consume:** require only `type` + parseable YAML. Tolerate unknown
  `type` values, unknown extra keys, and broken links. Preserve unknown keys on
  round-trip. This is the permissive consumer OKF mandates, so bundles authored
  by other tools open cleanly.

### Writer guarantees (`core/okf/write.ts` over `document.ts`)
Every write produces a conformant bundle (`writeConcept`, exposed as the
`write_concept` op / `okb write`):
- Valid delimited YAML; body preserved where possible; unknown frontmatter keys
  preserved verbatim on edit (canonical scaffold keys first, unknowns after).
- Full scaffold present: create requires `type`/`title`/`description`;
  `timestamp` (ISO-8601 UTC, second precision) is refreshed on every write;
  `resource`/`tags` included when applicable (`tags: []` clears).
- Links normalized to bundle-absolute form (`#anchors` and `"title"` suffixes
  survive; destinations with spaces/parens get `<…>` wrapped).
- Reserved ids (`index`, `log` basenames) are refused — those files belong to
  the Stage-1.2 generators; a concept whose frontmatter won't parse is never
  overwritten (fix by hand, per doctor).
- `index.md` regenerated for the touched directory and every ancestor
  (`core/okf/indexmd.ts`): each index keeps a human-editable head (H1 +
  intro paragraphs before the first `##`, preserved on regeneration) above
  regenerated sections — `## Directories` (immediate subdirs that have an
  `index.md`, described by the first intro line) and one `## <type>` section
  per concept type (rows `- [Title](/id.md) — Description`, title-sorted).
  Missing intros get a deterministic placeholder. `okf_version: "0.1"` is
  maintained in the root `index.md` frontmatter (the only `index.md` where
  frontmatter is allowed; unknown root keys are preserved).
- Root `log.md` appended per write (`core/okf/logmd.ts`): `## YYYY-MM-DD`
  headings (UTC, matching `timestamp`), newest first; entries are
  `**Creation**`/`**Update**`/`**Deprecation**`: `[Title](/id.md) — summary`,
  same-day entries sharing one section.

### Authoring ops (`okb new` / `okb capture` / `okb import`)
All three are thin front-ends over `writeConcept`:
- **`new <type> <title> <description>`** — creates at `<type>s/<slugify(title)>`
  (naive plural matches OKF reference layouts: `notes/`, `references/`,
  `tables/`; `--id` overrides for irregular cases). Create-only: an existing id
  is refused (`okb write` is the update path).
- **`capture [text]`** — zero-metadata capture; reads piped stdin when no
  argument (declared via `stdinFallback` on the param spec, filled generically
  by the CLI adapter). Type `note`, id `inbox/<YYYY-MM-DD>-<slug(title)>` with
  a numeric suffix on collision; title/description derived from the first line
  (leading `#` stripped, clipped at 80/120 chars).
- **`import <path>`** (`core/ingest/import.ts`) — maps a markdown file or tree
  onto concepts: ids mirror the source's relative layout with each segment
  slugified (optionally under `--dest`); `type`/`title`/`description`/
  `resource`/`tags` come from source frontmatter when present, else are
  derived (first H1 → title, first prose line → description, `--type` default
  `note`); unknown source frontmatter keys are carried via the writer's
  `extra` input (overrides existing unknown keys, never scaffold keys);
  reserved files are skipped, unparseable frontmatter becomes body. Dedupe is
  by id: existing concepts are skipped unless `--overwrite`, and when two
  sources slugify to one id the first (sorted) wins.

### Conformance checklist (`okb doctor` asserts)
`core/okf/doctor.ts` walks every `.md` file and reports findings at two
severities. **Errors** (conformance violations; CLI exits 1): unparseable YAML
frontmatter; missing/empty `type` on a concept; frontmatter in a non-root
`index.md`; a `log.md` heading that isn't `## YYYY-MM-DD`. **Warnings** (what a
permissive consumer must tolerate anyway — flagged, never fatal): missing
recommended keys (`title`/`description`/`timestamp`); broken internal links;
root `index.md` without `okf_version`; `log.md` dates not newest-first; a
directory with concepts (or the root) lacking `index.md`. Links to reserved
files (`/index.md`, `/notes/log.md`) are valid targets. The consumer itself
never rejects on any warning class — doctor is the only strict surface.

### System of record, sync, rebuild
- The bundle is a git repo. `okb sync` = git init/commit/push/pull/status.
  Multi-device "sync" is git; the other machine rebuilds its index on open.
- The DB is never the backup. `okb rebuild --confirm-destructive` wipes the
  index and regenerates it from the bundle.
- Privacy: per-directory/per-page `db_only` (gitignored) keeps sensitive
  concepts on disk + in the index but out of git history.

---

## Knowledge graph

### Node / edge model
- **Nodes** = concepts. Attributes: `id`, `type`, `title`, `description`,
  `tags`, `resource`, body size (for node sizing in the viewer).
- **Edges (primary)** = markdown links between concepts. Extraction: match
  `](….md)` links, resolve relative/absolute against the bundle root, drop
  external (`://`) and unresolved targets, dedupe. Directed and (on disk)
  untyped, per OKF — relationship meaning lives in the prose.
- **Backlinks** = reverse edges → "Cited by".
- **Tags** = facets for filtering and a synthesized tag-browse view.

### Derived typed edges (OKF-safe)
OKF keeps links untyped on disk on purpose. We type edges **only in the DB** so
relational retrieval works without breaking the format: a cached pass classifies
each link's relationship from its nearest heading/sentence (a link under
`# Joins` → `joins-with`, under `# Citations` → `cites`, etc.). The markdown file
stays a plain OKF link; okbrain just knows more.

### Storage & queries
SQLite tables: `nodes(id, type, title, description, resource, body_len,
content_hash)`, `edges(src, dst)` (plus `rel`/`evidence` when typed edges land,
Stage 4), `tags(node_id, tag)`, and an FTS5 table sharing `nodes.rowid`. The
index lives at `<bundle>/.okb/index.db` — inside the bundle so it travels with
context but gitignored and always disposable (`okb rebuild`). **Edges are
stored as extracted, dangling targets included**; every edge-reading query
resolves against `nodes`, so a link to a not-yet-written concept is invisible
until that concept exists — at which point its backlinks appear with no
rebuild. That is what makes the **incremental update on write** sound: every
write op refreshes just the written concept (node + its outgoing edges) via
`updateIndexFor` when an index already exists (a write never *creates* the
index — a fresh partial index would silently truncate search). Neighborhoods
use a depth-bounded recursive CTE (undirected: links + backlinks, never
stepping through dangling targets); `okb graph` tags depth-1 rows `→` links-to
/ `←` cited-by / `↔` both from the materialized edge set. Shortest paths
(`okb path`, per-hop direction arrows) and orphan detection (`okb orphans`)
are pure BFS in `core/graph/queries.ts` over `listEdges()` — engine-agnostic,
and path reconstruction wants parent tracking anyway. Keyword search is BM25
with column weights title 10 / tags 5 / body 1; query terms are quoted so FTS5
operators in user input are inert. Index builds hash file content to skip
unchanged concepts, and still index a concept whose frontmatter won't parse
(empty metadata, raw text as body) — search never loses it; `okb doctor`
flags it.

### Viewer (live + static)
Adapted from OKF's self-contained `viz.html` (Cytoscape.js graph + marked.js
body rendering): type-colored nodes, directed edges, node hover tooltips
(title/type/description), detail panel with rendered body and rewired internal
links, "Links to" + "Cited by" lists, search over title/id/tags (dims
non-matches), type filter with per-type counts, switchable layouts (cose /
concentric / breadth-first / circle / grid), fit-to-view. Theming: **dark mode
default**, light via a persisted toggle (`localStorage`); chrome colors live
once as CSS custom properties on `:root[data-theme=…]` and the Cytoscape
styles read them back via `getComputedStyle`, so both surfaces render from one
token set. Node colors are per-mode categorical palettes in a fixed CVD-safe
slot order (validated for lightness/chroma/CVD-separation/contrast against
each surface); a bundle with more than 8 types folds the overflow into a muted
gray, and every node keeps a visible text label so identity is never
color-alone.
- **Live (GUI):** same component fed by the engine over the local API; reflects
  current DB, click-through to the editor.
- **Static export:** `okb export-viz` writes the single HTML file to the fixed
  path `<bundle>/viz.html` — no backend, shareable, committable next to the
  bundle. Built straight from a bundle walk (works without an index). Cytoscape
  and marked are vendored minified builds (`core/viz/vendor/`), inlined into
  the page and embedded in the compiled binary via Bun text imports. Internal
  `.md` links in bodies are rewired to `#concept:<encoded-id>` anchors the
  viewer intercepts to focus the target node; external/broken links pass
  through untouched (external ones open in a new tab). The op is scope `read`
  despite writing a file: the output is derived, and the fixed path leaves no
  caller-chosen destination to abuse.

---

## AI integration

### Gateway (`core/ai/gateway.ts`)
One interface, three capabilities: `embed(texts)`, `chat(messages, tools?)`,
`rerank(query, docs)`. Implemented by pluggable recipes:
- **Local:** Ollama, llama.cpp / `llama-server`, LM Studio (OpenAI-compatible).
  Embeddings via `nomic-embed-text` / `mxbai-embed-large`; chat via any local
  instruct model.
- **API:** Anthropic / OpenAI / Gemini / OpenRouter for chat; OpenAI / Voyage /
  Gemini for embeddings.
- **Resolution:** per-call override → env → config → `init` default. The `init`
  default is **API-first** when a key is present; switching to a local model
  (Ollama / llama.cpp / LM Studio) is a one-setting change (config key or
  `okb init --provider local`). Fully-offline (local, no keys) remains
  first-class and tested.

### Retrieval profiles (cost knobs)
`lean` (small payload, no query expansion), `balanced` (default; relational arm
on), `max` (multi-query expansion, larger payload). A profile sets the context
budget and which recall arms run; `lean` keeps a local model comfortable.

### Embeddings & vector index
Chunk concept bodies (~400 tokens), embed, store vectors in `sqlite-vec`.
Re-embed on content-hash change. Fold provider + dimension into the vector
cache key so switching providers can't serve stale vectors. Backfill is
incremental and paceable.

### Retrieval pipeline (brain-first)
1. Vector recall (sqlite-vec) + keyword recall (FTS5/BM25), fused with
   Reciprocal Rank Fusion.
2. Graph expansion: pull 1-hop neighbors/backlinks of top hits; a relational arm
   answers relational questions over typed edges (deterministic; no-op for
   non-relational queries).
3. Optional rerank (local or API) to tighten top-k.
4. Synthesis with citations to concept ids and external sources — never
   fabricated. Skills/agents call this (the `search`/`ask` ops) before answering.

### Enrichment agent (generalized from OKF's two passes)
- **Source pass (pluralized):** filesystem import, quick capture, RSS/feeds, a
  browser grab (later email/calendar) — each produces/updates OKF concepts.
- **Web pass:** the LLM acts as a guarded crawler — fetch seeds, decide which
  outbound links are authoritative, then enrich an existing concept, mint a
  `references/<slug>` doc, or skip. Guardrails enforced inside the tool:
  `--web-max-pages`, `--web-max-depth`, same-domain allowed-hosts, path
  prefix/deny filters, `--no-web`. Citations written under `# Citations`.
- **Tools (minimal, trust-aware):** `list_concepts`, `read_concept_raw`,
  `read_existing_doc`, `write_concept_doc`, `fetch_url`, `link_suggest`,
  `embed_doc`.

### MCP server
Exposes read/write ops (search, read, write, list, graph-neighbors, enrich) so
external agents (Claude, etc.) use the brain as a tool. Untrusted by default;
write/admin gated; stdio + HTTP transports.

---

## Surfaces

### Contract-first ops (`core/operations.ts`)
Every operation is declared once as data: name, typed param specs, handler,
`scope: read|write|admin` (plus, for the CLI surface, `cliName` and a human
`render`; `localOnly` arrives with MCP). `runOp` validates trust (fail-closed:
untrusted ⇒ read-scope only) and params before any handler runs. Three adapters
are generated: the CLI, the GUI's local HTTP API, and the MCP server. Add a
capability once → it appears in all three. CLI/GUI can't drift.

### CLI surface (illustrative)
| Command | Scope | Purpose |
|---|---|---|
| `okb init` | admin | Create/attach a bundle; pick engine + AI provider; write config |
| `okb new <type> <title> <description>` | write | Create a conformant concept at `<type>s/<slug>` |
| `okb capture [text]` | write | Quick-capture text/stdin → `inbox/` concept (link suggestions later) |
| `okb import <path>` | write | Map existing markdown (file/tree) → concepts; dedupe by id |
| `okb enrich [--web-seed …]` | write | Run the enrichment agent (guardrailed) |
| `okb search <query>` | read | Hybrid + graph retrieval (`--json` for agents) |
| `okb ask <question>` | read | Retrieval-augmented answer with citations |
| `okb graph <id> [--depth N]` | read | Neighborhood with `→`/`←`/`↔` direction tags |
| `okb path <from> <to>` | read | Shortest link chain between two concepts |
| `okb orphans` | read | Concepts with no links in or out |
| `okb links suggest` | write | Propose cross-links for review |
| `okb index` / `okb embed` | admin | (Re)build FTS / vectors incrementally |
| `okb rebuild --confirm-destructive` | admin | Wipe + regenerate index from bundle |
| `okb doctor` / `okb lint` | read | OKF conformance + health report |
| `okb sync` | write | git commit/push/pull |
| `okb serve` | admin | Start local GUI + API |
| `okb mcp` | admin | Start MCP server |
| `okb export-viz` | read | Self-contained OKF-style graph HTML |

### GUI (local web app, `okb serve`)
Views: **Graph** (live viewer), **Editor** (markdown + frontmatter, concept-id
link autocomplete, live backlinks, citation helper, suggested-link inbox; saves
route through the conformance writer), **Ask** (chat over the brain with
streamed, cited answers and "open in graph"), **Settings** (engine, provider,
retrieval profile, sync, enrichment guardrails). It's a web app → cross-platform
free; an optional Tauri wrapper later gives a native desktop app over the same
local API.

### Trust boundary
Each op call carries a trust flag. CLI + local GUI are trusted; MCP/remote is
untrusted unless explicitly local. Not-strictly-trusted ⇒ untrusted
(fail-closed). Untrusted callers get read ops; write/admin are gated and
filesystem confinement tightens.

---

## Tech stack

- **Runtime/language:** TypeScript on Bun. One language for CLI + web GUI + MCP;
  `bun build --compile` for per-OS single binaries.
- **Engine (default):** SQLite + `sqlite-vec` (vectors) + FTS5 (keyword) —
  embedded, file-based, zero-config, cross-platform.
- **Graph:** SQLite tables + recursive CTEs.
- **Viewer:** Cytoscape.js + marked.js (from OKF's viewer), bundled into the
  static export and reused live in the GUI.
- **MCP:** the MCP TypeScript SDK.
- **AI:** HTTP clients per recipe (OpenAI-compatible for most local + several
  API providers).
- **GUI build:** a lightweight bundler (e.g. Vite or Bun's bundler) — decide at
  Stage 3; keep deps minimal.

### Scale path (opt-in, behind the same interfaces)
More files / faster search → swap engine to **Postgres + pgvector** (ops
unchanged; verify with a rebuild-parity test). Heavier background work → promote
the single worker to a real queue. Multiple/team brains → mount additional
bundles (gbrain's "brains" axis), each its own repo + index + policy. Single-user
stays the default. Switching engines = point at the new engine + `okb rebuild`.

---

## Repo layout

```
okbrain/
├── src/
│   ├── core/
│   │   ├── operations.ts        # the ONE contract (scope + trust)
│   │   ├── config.ts            # bundle path + cross-platform config/data dirs
│   │   ├── log.ts               # structured logger
│   │   ├── okf/                 # document, paths, bundle, indexmd, logmd, doctor
│   │   ├── engine/              # interface, sqlite, index-build  (postgres later)
│   │   ├── graph/               # links, typed-edges, backlinks, queries
│   │   ├── ai/                  # gateway, recipes/*
│   │   ├── retrieval/           # chunk, hybrid (rrf), relational, rerank, profiles
│   │   ├── ingest/              # import, capture, rss, web (crawler pass)
│   │   └── sync.ts              # git
│   ├── cli.ts                   # generated from operations.ts (trusted)
│   ├── api.ts                   # local HTTP for the GUI (trusted)
│   ├── mcp/server.ts            # MCP server (untrusted-by-default)
│   └── gui/                     # graph view (adapted viz) + editor + ask + settings
├── skills/                      # fat markdown procedures
│   ├── RESOLVER.md              # thin router: intent → which skill
│   ├── capture/SKILL.md
│   ├── enrich/SKILL.md
│   ├── ingest/SKILL.md
│   ├── query/SKILL.md
│   ├── daily-note/SKILL.md
│   └── link-suggest/SKILL.md
├── bundles/example/             # tiny conformant OKF bundle for tests/demos
├── docs/
│   └── context/                 # user-dropped reference material
│       └── REFERENCES.md        # registry of that material (see below)
└── tests/                       # conformance, graph, retrieval, rebuild-parity
```

---

## Skills & jobs

"Thin harness, fat skills": capabilities needing judgment are markdown
procedures the agent reads, parameterized like method calls. First set: capture,
ingest, enrich, query (brain-first retrieval recipe), link-suggest, daily-note.
Decision rule: lookup/list/status → CLI command (deterministic); needs to
think/adapt → skill. Operating discipline worth keeping: do a task manually
3–10×, codify it into a skill, then put it on cron.

Jobs/cron: a single background worker + file/SQLite lock for nightly embedding
backfill, enrichment of stale concepts, `index.md`/backlink regeneration, and
`okb doctor`. No queue infra in v1.

---

## Reference materials convention (`docs/context/`)

The user adds extra context — links to repos, PDFs, markdown — over time. How
the agent handles it:
- Material is dropped into `docs/context/` (files) and/or registered as links.
- `docs/context/REFERENCES.md` is the registry. Suggested row format:

  | id | source (path or URL) | type | informs | status | notes |
  |----|----------------------|------|---------|--------|-------|
  | R1 | docs/context/foo.pdf | pdf | retrieval | applied | one-line takeaway |

  Status flow: `unread` → `read` → `applied` (or `needs-fetch` if a URL can't be
  retrieved in-agent yet, so the user can paste the content).
- On startup the agent reads `REFERENCES.md`; before working in an area it reads
  any material that `informs` that area; when new material appears it adds a row,
  reads it, and records the takeaway (and updates this file if design changes).

---

## Decisions Log

Append-only record of decisions and resolved questions (newest first). Keep the
sections above as current truth; this log says *why/when*.

- 2026-07-08 — **Write-aware graph (1.4): store dangling edges, resolve at
  query time.** The alternative — only storing resolved edges — makes
  incremental updates wrong: concept A links to not-yet-written X; writing X
  can't recover the A→X edge without rescanning every body. Storing all
  extracted edges and joining `nodes` in every edge query keeps
  `updateIndexFor` a strict single-concept operation (upsert node + replace
  its out-edges) while backlinks to new concepts appear by themselves.
  `IndexStats.edges` and `listEdges()` keep reporting *resolved* edges, so
  nothing user-visible counts phantoms. Write ops refresh an *existing* index
  only — never create one, since a one-concept index would silently truncate
  search until the next `okb index`. Paths/orphans are pure BFS over the
  resolved edge list (`core/graph/queries.ts`) rather than SQL CTEs: engine-
  agnostic for the Postgres drop-in, and BFS needs parent tracking anyway.
- 2026-07-08 — **Authoring conventions (1.3).** `okb new` derives ids as
  `<type>s/<slug>` (naive plural, `--id` escape hatch) rather than asking for a
  directory; `okb capture` always lands in `inbox/` (triage later, by design);
  `okb import` dedupes by id with first-wins + `--overwrite`, and the writer
  gained an `extra` input so imports can round-trip unknown frontmatter keys.
  Stdin support is a generic `stdinFallback` flag on param specs, kept in the
  CLI adapter so the ops contract stays surface-neutral.
- 2026-07-08 — **Canonical OKF reference corrected.** The OKF links previously
  in the repo (openknowledge.foundation, a deepset-ai repo) were hallucinated;
  the real source is `github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf`
  (registered as R1 in `docs/context/REFERENCES.md`). Its SPEC.md confirms the
  existing design: only `type` required, recommended keys as we emit them,
  bundle-absolute links recommended, reserved `index.md`/`log.md` without
  frontmatter, permissive readers. No design change needed.
- 2026-07-07 — **index.md/log.md generation is deterministic, with a preserved
  human head.** No AI in the generators: an `index.md`'s H1 + pre-`##` intro
  is the user's (preserved verbatim and reused as the directory's description
  in its parent's listing); everything from the first `##` down is owned and
  regenerated by okbrain. A missing intro gets a placeholder rather than an
  AI synthesis (revisit post-Stage 2 if wanted). An `index.md` with
  unparseable frontmatter is rebuilt, not refused — unlike concepts, its
  structure is derived. Parent `## Directories` lists only subdirs that have
  an `index.md`, so generated links always resolve; log dates are UTC to
  match `timestamp`.
- 2026-07-05 — **Viewer theming: dark default, CSS-variable token bridge,
  per-mode validated palettes.** The static viewer defaults to dark with a
  persisted light toggle. All chrome colors are defined once as CSS custom
  properties per theme; Cytoscape styles use function values that read the
  vars via `getComputedStyle`, so a theme switch is set-attribute +
  `cy.style().update()` — no duplicated color tables in JS. Node colors come
  from two 8-slot categorical palettes (one per surface, fixed CVD-safe order,
  validated for contrast/CVD separation); types beyond 8 share a muted
  overflow gray rather than cycling hues.
- 2026-07-05 — **Writer semantics (`core/okf/write.ts`).** `timestamp` is
  ISO-8601 UTC at second precision and is always refreshed on write (no
  caller override). Canonical frontmatter key order: type, title,
  description, timestamp, resource?, tags?, then unknown keys verbatim in
  original order. Create requires type/title/description (the full scaffold —
  conformant-on-write is strict even though reads stay permissive); updates
  may set any subset. Reserved ids (`index`, `*/log`) are refused — those
  files belong to the generators (1.2). A concept whose existing frontmatter
  won't parse is never overwritten. Link normalization preserves `#anchors`
  and `"title"` suffixes and `<...>`-wraps destinations containing
  spaces/parens. `tags: []` clears tags; index/log regeneration and
  incremental DB update land with 1.2/1.4.
- 2026-07-05 — **Viz export: vendored libs, fixed output path, `#concept:`
  rewiring.** Cytoscape/marked are vendored files (their npm `exports` maps
  don't expose the browser builds to import), inlined so `viz.html` makes zero
  network requests. `export_viz` stays scope `read` per the surfaces table by
  taking no parameters and always writing `<bundle>/viz.html`. Link rewiring
  happens in the exported graph JSON (never on disk), turning resolvable
  internal links into URI-encoded `#concept:` anchors so in-body navigation
  survives markdown parsing even for ids with spaces.
- 2026-07-03 — **Doctor severities: error = violation, warning = tolerated.**
  `okb doctor` maps the permissive-consumer mandate onto two levels: only what
  the OKF read contract actually requires (parseable YAML, non-empty `type`,
  index/log structure) is an error; everything a consumer must tolerate (broken
  links, missing recommended keys, missing `index.md`) is a warning. Ops can
  now map a successful-but-unhealthy result to a CLI exit status via an
  optional `exitCode(result)` on the registry entry — doctor exits 1 on errors
  so it works as a CI gate; warnings alone exit 0.
- 2026-07-02 — **The op registry carries CLI presentation (`cliName` +
  `render`).** Keeping the human rendering beside each op declaration lets the
  CLI stay 100% generated (zero per-command code, so surfaces can't drift);
  `--json` bypasses `render`, and non-CLI adapters ignore it.
- 2026-07-02 — **`OpContext.engine()` is lazy and adapter-owned.** Ops that only
  read the bundle (`read`, `list`) never open — or create — `.okb/index.db`;
  the adapter opens on first use and owns close. Keeps bundle-only commands
  side-effect-free on foreign bundles.
- 2026-07-02 — **Derived index lives at `<bundle>/.okb/index.db`.** Dot-dirs are
  invisible to the bundle walker, so the DB can't be mistaken for content;
  keeping it in the bundle needs no cross-bundle keying in the data dir and dies
  with the bundle. `okb sync` (Stage 1.5) must gitignore `.okb/`.
- 2026-07-02 — **Search ranking: BM25 with column weights title 10 / tags 5 /
  body 1**, user query terms individually quoted (FTS5 syntax can't error or
  inject). Unweighted BM25 let a tiny tags-only doc outrank a real title match.
- 2026-07-02 — **Index build is tolerant where doctor is strict.** A concept
  with unparseable frontmatter is indexed with empty metadata and its raw text
  as body (warn-logged) instead of failing the build — the index must never be
  the thing that hides a note; conformance complaints belong to `okb doctor`.
- 2026-06-28 — **Frontmatter serialization uses the `yaml` package, not
  `Bun.YAML`.** `Bun.YAML.parse` is fine and used for reads, but
  `Bun.YAML.stringify` emits flow style (`{type: note,…}`), which is unfit for a
  human-editable, git-diffable store. `core/okf/document.ts` uses `yaml` for both
  parse and serialize (block style, `lineWidth: 0` to avoid folding long
  values). One small pure-JS dep; correctness of the canonical format wins.
- 2026-06-28 — **Default bundle path = cwd until `okb init`.** `resolveBundlePath`
  is explicit-arg → `$OKB_BUNDLE` → cwd. Convention: run `okb` inside your brain.
  Stage 1's `okb init` will persist a default into config.
- 2026-06-28 — **AI posture: API-first default, easy switch to local.** `okb
  init` defaults to a hosted API provider when a key is present; switching to a
  local model (Ollama/llama.cpp/LM Studio) is one setting. Offline stays a
  supported, tested config. Resolves the open question previously listed below.
- 2026-06-28 — **Language fixed: TypeScript on Bun.** Best fit for single-binary
  CLI + web GUI + MCP in one language; mirrors gbrain; OKF viewer is already JS.
- 2026-06-28 — **OKF required-keys reconciliation.** Write `type/title/
  description/timestamp`; consume requiring only `type`. Satisfies spec +
  reference implementation; stays a permissive consumer.
- 2026-06-28 — **Default engine: SQLite + sqlite-vec + FTS5.** Lightweight
  embedded analog of gbrain's PGLite; Postgres/pgvector is the documented
  upgrade behind the engine interface.

### Open questions (decide as they come up; record the answer here)
- Suggested links: auto-insert on capture vs always route through a review inbox?
- GUI editor scope for v1: full editor vs read-only + capture (bundle is plain
  markdown, so Obsidian/VS Code already edit it)?
- Concept `type` vocabulary: ship a small non-binding default set (Note, Person,
  Project, Reference, Idea, Meeting…) vs fully free-form?
- Acceptance test: round-trip the three OKF sample bundles (GA4, Stack Overflow,
  Bitcoin) as a conformance gate?
