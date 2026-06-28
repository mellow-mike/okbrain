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

### Writer guarantees (`core/okf/document.ts` + helpers)
Every write produces a conformant bundle:
- Valid delimited YAML; body preserved where possible.
- Required keys present; `timestamp` refreshed on meaningful change.
- Links normalized to bundle-absolute form.
- `index.md` regenerated for touched directories (grouped by `type`, entries
  carry each concept's `description`; directory descriptions synthesized).
- `log.md` appended (`## YYYY-MM-DD` headings, newest first; leading bold marker
  `**Creation**`/`**Update**`/`**Deprecation**`).
- `okf_version: "0.1"` maintained in the root `index.md` frontmatter (the only
  place frontmatter is allowed inside an `index.md`).

### Conformance checklist (`okb doctor` asserts)
1. Every non-reserved `.md` has parseable YAML frontmatter.
2. Every frontmatter has a non-empty `type`.
3. `index.md` / `log.md` follow OKF structure when present.
4. The consumer never rejects on missing optional fields, unknown types/keys,
   broken links, or missing `index.md`.

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
SQLite tables: `nodes(id, type, title, description, resource, body_len, …)`,
`edges(src, dst, rel, evidence)`, `tags(node_id, tag)`. Neighborhoods, paths,
and orphan detection use depth-bounded recursive CTEs. Enough for 1–2 hop
retrieval expansion and the viewer's adjacency.

### Viewer (live + static)
Adapted from OKF's self-contained `viz.html` (Cytoscape.js graph + marked.js
body rendering): type-colored nodes, directed edges, detail panel with rendered
body and rewired internal links, "Cited by" backlinks, search over
title/id/tags, type filter, switchable layouts (cose / concentric /
breadth-first / circle / grid).
- **Live (GUI):** same component fed by the engine over the local API; reflects
  current DB, click-through to the editor.
- **Static export:** `okb export viz` writes the exact OKF-style single HTML
  file — no backend, shareable, committable next to the bundle.

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
Every operation is declared once as data: name, params, handler,
`scope: read|write|admin`, optional `localOnly`. Three adapters are generated:
the CLI, the GUI's local HTTP API, and the MCP server. Add a capability once →
it appears in all three. CLI/GUI can't drift.

### CLI surface (illustrative)
| Command | Scope | Purpose |
|---|---|---|
| `okb init` | admin | Create/attach a bundle; pick engine + AI provider; write config |
| `okb new <type> <title>` | write | Create a conformant concept |
| `okb capture` | write | Quick-capture a note/clip → concept (+ link suggestions) |
| `okb import <path>` | write | Ingest existing markdown/notes |
| `okb enrich [--web-seed …]` | write | Run the enrichment agent (guardrailed) |
| `okb search <query>` | read | Hybrid + graph retrieval (`--json` for agents) |
| `okb ask <question>` | read | Retrieval-augmented answer with citations |
| `okb graph <id> [--depth N]` | read | Neighborhood / paths around a concept |
| `okb links suggest` | write | Propose cross-links for review |
| `okb index` / `okb embed` | admin | (Re)build FTS / vectors incrementally |
| `okb rebuild --confirm-destructive` | admin | Wipe + regenerate index from bundle |
| `okb doctor` / `okb lint` | read | OKF conformance + health report |
| `okb sync` | write | git commit/push/pull |
| `okb serve` | admin | Start local GUI + API |
| `okb mcp` | admin | Start MCP server |
| `okb export viz` | read | Self-contained OKF-style graph HTML |

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
