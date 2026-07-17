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
- The bundle is a git repo; multi-device "sync" IS git (the other machine
  rebuilds its index on open). `okb sync` = ensure repo (init + `main` via
  `symbolic-ref`; a bundle nested inside another repository is refused —
  nested `git init` would corrupt the outer repo's view), ensure seed lines,
  commit everything (`--message` or a timestamped default), then, when an
  `origin` remote is configured, `pull --rebase` + `push` (upstream set on
  first push). `okb sync --status` reports repo/branch/dirty/remote/
  ahead/behind without side effects. Git is spawned by argv only, with
  `GIT_TERMINAL_PROMPT=0` (a missing credential fails fast, never hangs);
  missing identity fails with the exact `git config` commands to run.
- Seeding is append-only "ensure these lines exist" (user lines are never
  rewritten): `.gitignore` gets `.okb/`, `/viz.html`, `db_only/`;
  `.gitattributes` gets `* text=auto eol=lf` — Windows `autocrlf` must never
  rewrite bundle bytes, or diffs churn and Stage-2 embedding content-hashes
  silently invalidate.
- The DB is never the backup. `okb rebuild --confirm-destructive` wipes the
  index and regenerates it from the bundle.
- Privacy: any directory named `db_only/` keeps its concepts on disk + in the
  index but out of git — gitignored by sync **and** invisible to the committed
  surfaces: root `log.md` entries are skipped and parent `index.md` listings
  omit the directory (its own `index.md`, inside the ignored dir, still lists
  its concepts for local browsing). Scope is "under a `db_only/` directory"
  (`inDbOnlyDir`), matching git's directory-pattern semantics. Per-page
  `db_only` is Backlog.

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
SQLite tables: `nodes(id, type, title, description, resource, timestamp,
last_reviewed, body_len, content_hash)`, `edges(src, dst)` (plus
`rel`/`evidence` when typed edges land, Stage 4), `tags(node_id, tag)`,
`review_state(node_id, snooze_until)` (Resurface's DB-only snooze), and an
FTS5 table sharing `nodes.rowid`. The index lives at `<bundle>/.okb/index.db`
— inside the bundle so it travels with context but gitignored and always
disposable (`okb rebuild`). Schema migrations ARE rebuilds: on a version
mismatch every data method fails with "run `okb rebuild`", and `wipe()` —
what rebuild calls — drops and recreates the current schema, so rebuild works
against any old index file and no read can half-answer from a stale shape. **Edges are
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

## Resurface — review queue

The default fate of a PKM is write-only memory. Resurface makes stored
knowledge come back on its own: a small daily queue of concepts worth another
look, each with a stated human-readable reason — the reasons are the UX.
Deterministic, zero new dependencies, works with zero AI providers configured.

### Scoring (deterministic)
Computed on demand from data the engine already holds (nodes + resolved
edges + tags):

| Signal | Trigger | Default weight |
|---|---|---|
| staleness | `min(days_since_timestamp, 365)/365` | 1.0 |
| orphan | degree == 0 | 2.0 |
| stale hub | in-degree ≥ 3 and stale > 90d | 1.5 |
| neighbor activity | a neighbor changed ≤ 7d, self stale > 30d | 1.0 |
| inbox | has `inbox` tag (Clip synergy) | 1.5 |
| anniversary | `timestamp` ≈ n·365d ago (±1d) | 0.5 |

Exclusions: `last_reviewed` within the cooldown (default 30d) or an active
snooze. Queue size defaults to 5. Ordering is fully deterministic: score
desc, then older `timestamp`, then id. Anniversary uses `timestamp` (last
content change) — creation dates aren't tracked in frontmatter. Weights,
cooldown, and queue size are code defaults until the 2.1 config file wires
`review.*` keys. A signal only adds its reason string when it contributes.

### State — what survives a rebuild
- **`last_reviewed`** (ISO 8601 UTC) is user knowledge → frontmatter, via the
  conformance writer in **metadata-only mode**: `timestamp` is *not* refreshed
  (it means content change) and no `log.md` entry is appended (less churn).
  It's an okbrain extension key — OKF-safe because consumers tolerate and
  preserve unknown keys.
- **Snooze** is an ephemeral scheduling preference → DB-only (`review_state`
  table), lost on `okb rebuild` by design.
- The queue itself is recomputed on every call; no cache table at CLI scale.

### Ops & surfaces
`review_queue` (read) → top-N with scores + reasons; `review_done` /
`review_snooze` (write). CLI: `okb review`, `okb review done <id|n>`,
`okb review snooze <id|n> [--days 7]` — `n` is a 1-based queue position;
a pure-integer argument within queue range is read as a position, otherwise
as an id. GUI card stack lands with 3.2, cron recompute with 4.5, the
daily-note section with 4.6.

**Garnish (opt-in AI extra):** `okb review --garnish` makes one chat call
annotating queue items with a ≤25-word line connecting each to notes changed
in the last 7 days (newest 10, queue members excluded) — when a genuine
connection exists. The model only annotates: unknown ids and "no connection"
lines are dropped. Gated by the retrieval profile's `extras` switch (off in
`lean`); any failure (no provider, chat error) warns and returns the plain
deterministic queue.

Non-goals (v1): no spaced repetition (SM-2), no flashcards, no archive action
(moving files rewrites inbound links — future Gardener territory).

---

## Clip — web clipper & reading inbox

The fastest path from "I'm reading this page" into the bundle: one command →
fetch, extract the readable article, dedupe, write a conformant
`references/<slug>` concept tagged `inbox`. Works with zero AI providers and
with or without an index; offline it fails fast (no queue in v1).

### Pipeline (`clip` op, scope `write`)
1. **Fetch** through `core/ingest/fetch-guard.ts` — the one guarded fetcher,
   extracted early on purpose: Stage 4.2's web pass reuses it (one guard, two
   callers). Guards: http/https only; private/link-local/loopback IPs
   rejected (every redirect hop re-resolved and re-checked); response size
   cap; timeout. Residual DNS-rebinding TOCTOU risk is accepted for v1 (a
   personal clipping tool fetches a URL the user chose); revisit for the
   Stage-4 crawler.
2. **Extract** readable article + metadata (title, byline, published,
   canonical URL, description) with `linkedom` + `@mozilla/readability`,
   HTML→markdown via `turndown`.
3. **Dedupe** by normalized canonical URL — strip fragment + tracking params
   (`utm_*`, `fbclid`, `gclid`, …), lowercase scheme/host, drop default
   ports, sort remaining params — compared (both sides normalized) against
   every concept's `resource`. Existing concept → append the new
   quote/note under `# Highlights` and refresh `timestamp`; no new file. An
   input URL that is already stored short-circuits *before* any fetch, so
   re-clipping known pages also works offline.
4. **Write** via the conformance writer: `references/<slug(title)>` (numeric
   suffix when a different URL collides on slug), `type: reference`,
   `resource:` canonical URL, description from page metadata, tags = user
   tags + `inbox` (`--read` skips it), body = extracted markdown capped at
   100KB (truncation noted in the body), `# Citations` with the source link.
5. Hooks that ride along without changing clip: embedding (2.2, on write),
   **autoTag** (F-B.8, `--auto-tag` flag or `clip.autoTag` config): one chat
   call suggests ≤5 kebab-case topic tags for a *new* clip, offered the
   bundle's existing tag vocabulary (`Engine.listTags()`) so the tag space
   doesn't fragment; the reserved `inbox` tag is filtered. Off in `lean`
   (`extras`); failures warn and tag nothing — AI never blocks a clip.
   Link-suggest lands with 4.4.

### Reading inbox
Read-state is user knowledge → it lives in the bundle as the `inbox` **tag**
(OKF-optional frontmatter; no format extension), so it survives `okb rebuild`.
The inbox is just the tag query: `okb inbox` lists, `okb inbox read <id>`
clears the tag through the writer. Resurface scores `inbox` as a signal.

### Bookmarklet (built with 3.1)
Any web page can fire requests at localhost, so a naive clip endpoint is a
CSRF hole into the brain. The `/clip` endpoint demands the per-install secret
token (`core/serve-token.ts` — minted at first use, mode 0600 beside
config.json, embedded by `okb bookmarklet`, constant-time validated);
tokenless requests are rejected, and the same token gates the whole `/api`
surface. The bookmarklet itself is a top-level `window.open` GET navigation
to `/clip?token=…&url=…` (+ the current selection as `quote`) — navigations
bypass CORS, mixed-content, and private-network-access rules that would
break a cross-origin `fetch` from an HTTPS page, so it works from any site
with zero server relaxations. The confirmation page auto-closes on success.

### Config (`clip.*`)
`maxBodyBytes` 100KB, `stripParams` (utm_* etc.), `defaultTags` [],
`autoTag` false (true = suggest tags on every clip; still off in `lean`).

---

## AI integration

### Gateway (`core/ai/gateway.ts` + `recipes.ts`)
One interface, three capabilities: `chat(messages)`, `embed(texts)`,
`rerank(query, docs)` — plain `fetch`, no provider SDKs. Three HTTP dialects
cover every recipe (openai-compatible / anthropic / gemini):
- **Local (no keys):** Ollama, llama.cpp / `llama-server`, LM Studio — all one
  OpenAI-compatible dialect; `local` is an alias for ollama. Defaults:
  `llama3.2` chat, `nomic-embed-text` embed.
- **API:** Anthropic / OpenAI / Gemini / OpenRouter for chat; OpenAI / Voyage /
  Gemini for embeddings; Voyage for rerank (the only rerank recipe in v1).
  Keys come only from env vars (`ANTHROPIC_API_KEY`, …) — never stored in
  config; a missing key fails naming the exact var.
- **Resolution (per capability, per call):** per-call override →
  `OKB_CHAT_/EMBED_/RERANK_PROVIDER|MODEL|BASE_URL` (generic
  `OKB_AI_PROVIDER` only wins capabilities it has) → `config.json` → key
  detection. Detection is **API-first** when a key is present, local
  otherwise; a chat-only provider (anthropic) can never hijack the embed
  slot. Fully-offline (local, no keys) is first-class and is the tested path
  (stub local server in CI).

### User config (`config.json`, written by `okb init`)
Lives in the per-user config dir (`core/config.ts`; XDG / %APPDATA%). `okb
init` is non-interactive: it detects providers from present keys (API-first),
persists the choice explicitly, records the current bundle as
`defaultBundle` (bundle resolution: explicit → `$OKB_BUNDLE` → config → cwd;
skip with `--no-default-bundle`), and validates `--provider`/`--embed-provider`
against the recipe table. Unknown config keys are preserved on rewrite.
`review.*` (queueSize, cooldownDays, weights), `clip.*` (maxBodyBytes,
defaultTags, stripParams), and `retrieval.profile` are read from here by their
ops; ops receive config via `OpContext.config()`. Tests are hermetic: a bun-test preload pins the
config dir to a temp directory and strips provider keys from the env.

### Retrieval profiles (cost knobs)
`core/retrieval/profiles.ts` — a profile sets each arm's depth and the budget:
`lean` (vec/fts depth 8, no graph expansion, no rerank, 6 KB ask context),
`balanced` (default; 16/16, 1-hop expansion of the top 4, rerank when
configured, 12 KB), `max` (32/32, top-8 expansion, rerank, 2 chat-generated
extra query phrasings in `okb ask`, 24 KB). A profile also carries `extras`
(false in `lean`): whether opt-in AI garnish features (review garnish, clip
autoTag) may run when asked for. Selection: `--profile` → config
`retrieval.profile` → `balanced`. `lean` keeps a local model comfortable.

### Embeddings & vector index
Chunk concept bodies (~400 tokens ≈ 1600 chars, no tokenizer dep —
`core/retrieval/chunk.ts`), embed via the gateway, store in a `sqlite-vec`
vec0 table (cosine metric) in **its own DB file** `.okb/vectors.db`
(`core/engine/vectors.ts`, behind the `VectorStore` interface) — separate
from the keyword index so `okb rebuild` never discards paid-for embeddings
and machines without extension support keep a fully working keyword index.
The store's cache key is `(provider, model, dim)`: `okb embed` resets the
whole store when the key changes; otherwise it re-embeds only concepts whose
hash changed and drops vanished ones. The hash covers exactly what feeds the
embedding — title, description, body — so metadata-only stamps
(`last_reviewed`, inbox tag clears) never re-embed. Each chunk embeds as
`title\n\nchunk`; an empty body falls back to description/title. `okb embed
[--limit n]` paces spend; interrupted runs resume (whole concepts commit
atomically). Write ops refresh their own vectors when a store exists
(embed-on-write hook), best-effort — a failure warns and never fails the
write, and the hook never resets the cache key. Extension loading: Linux and
Windows Bun load `vec0` natively; on macOS `bun:sqlite` links Apple's SQLite
(no extensions), so `core/engine/custom-sqlite.ts` swaps in a real
libsqlite3 (`$OKB_SQLITE_LIB` → Homebrew → MacPorts) via
`Database.setCustomSQLite()` before any DB opens. A compiled binary can't
self-locate the extension yet — `$OKB_SQLITE_VEC` points at it (Backlog:
embed it).

### Retrieval pipeline (brain-first)
`core/retrieval/hybrid.ts`, behind the `search` and `ask` ops:
1. Keyword recall (FTS5/BM25) + vector recall (sqlite-vec), fused with
   Reciprocal Rank Fusion (k=60). Queries embed under the vector store's own
   cache key — the documents' space — never the currently configured
   embedder. The vector arm is optional: any failure (no store, unreachable
   provider, dimension drift) degrades to keyword-only with a warning, so
   `okb search` always works; vector rows whose node left the keyword index
   are dropped as stale cache.
2. Graph expansion: 1-hop neighbors/backlinks of the top fused hits join the
   pool with a damped share (×0.25) of their parent's score, tagged `graph`.
   (The relational arm over typed edges arrives with 4.3.)
3. Optional rerank (`core/retrieval/rerank.ts`) reorders the head by
   cross-encoder relevance — only when the profile asks AND a rerank
   provider is explicitly configured (config/env); key detection never
   triggers it, and failures fall back to the fused order.
4. `okb ask` (`core/retrieval/ask.ts`): packs the pool score-first into
   `[id] title\ntext` blocks under the profile budget (vector-arm chunk when
   present, else the body capped at one chunk), synthesizes with a system
   prompt confined to those concepts, and post-verifies citations against
   the packed ids — invented ids never reach `citations` (the answer text is
   verbatim). An empty pool short-circuits before the model. `max` first
   asks chat for alternate query phrasings and fuses all rankings.

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

### Local API (`src/api.ts`, started by `okb serve`)
The GUI's backend and the bookmarklet's target — a thin adapter generated
over the registry, trusted like the CLI but defended like a network surface:
- **Routes:** `GET /api/ops` (public op descriptors, for surface generation),
  `POST /api/op/<name>` (JSON params → `runOp` → `{ result }`),
  `GET /api/ask/stream` (SSE via the generic `Operation.stream` hook: events
  `context` — packed sources before synthesis — then `answer`, then `done`
  with the full result, or `error`; the gateway doesn't stream tokens yet, so
  `answer` arrives whole — Backlog), `GET /clip` (bookmarklet), `GET /`
  (GUI page; placeholder until 3.2). Ops marked `localOnly` (`serve`,
  `bookmarklet`) never appear on network adapters.
- **Security (fail-closed):** binds 127.0.0.1 only; the Host header must be
  the server's own `127.0.0.1/localhost/[::1]:port` (defeats DNS rebinding);
  every `/api` and `/clip` request must present the per-install token
  (header `x-okb-token`, `Authorization: Bearer`, or `?token=`;
  constant-time compare); CORS reflects only the server's own localhost
  origins — everything else gets no CORS headers and preflights are 403.
  HTTP errors map from `OpError` codes (bad_params 400, not_found 404,
  untrusted/refused 403; anything else 500).
- Each request runs in a fresh `OpContext` (shared `core/context.ts`, also
  the CLI's) — engines open lazily per request and close after, so the
  server never holds the index hostage from a concurrent CLI.

### GUI (local web app, `okb serve`)
A vanilla single-page app (`src/gui/`: index.html + app.js + style.css) —
no framework, no build step; api.ts serves the files and Bun text imports
embed them into the compiled binary (the viz-vendor pattern). Presentation
only: every data access is a `/api/op/*` call. Hash routing; dark default +
persisted light toggle using the viewer's token system and validated
palettes. Views:
- **Graph** — live Cytoscape fed by the `graph_data` op (whole graph as
  JSON; also `okb graph-data --json` for agents/scripts); search filter,
  type-colored nodes, detail panel with rendered body (internal links
  rewired to focus their node), click-through to the editor.
- **Editor** — scaffold fields (type/title/description/tags/resource) + a
  markdown body textarea; concept-id link picker inserting normalized
  links; citation-section helper; live backlinks; saves via
  `write_concept`, so every save is conformant. (Suggested-link inbox
  arrives with 4.4.) Deliberately not a rich editor: the bundle is plain
  markdown and external editors remain first-class.
- **Ask** — SSE streaming: retrieved context appears as chips before the
  answer arrives; verified citations link to graph and editor.
- **Review** — card stack with scores + reasons, optional garnish toggle;
  done / snooze / open / graph per card.
- **Inbox** — unread clips/notes; open / mark-read.
- **Settings** — AI providers + retrieval profile (backed by `init`, which
  persists them), git sync (status / run), maintenance (re-index, embed,
  doctor report). Enrichment guardrails join with Stage 4.
Cross-platform free (it's a web app); an optional Tauri wrapper later gives
a native desktop app over the same local API.

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
- **GUI build:** none — vanilla JS/CSS/HTML served as-is and embedded via Bun
  text imports; Bun's compiler is the only "bundler" (decided at 3.2).

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

- 2026-07-17 — **GUI (3.2): vanilla JS, zero build step; editor is a form,
  not an IDE.** A framework + bundler would add the project's heaviest dev
  dependency for six views of forms and lists — instead the GUI is three
  static files served by api.ts and embedded into the binary with Bun text
  imports (exactly how the viz vendor libs already ship), so `bun build
  --compile` remains the entire build. All data access goes through
  `/api/op/*`; the app holds no logic the ops don't provide. The graph view
  gets its data from a new `graph_data` read op (the viz exporter's
  `buildVizGraph` behind the contract) rather than a bespoke endpoint, so
  the same JSON is available to the CLI (`okb graph-data --json`) and MCP.
  This resolves the "GUI editor scope" open question: a scaffold-field +
  textarea editor that saves through the conformance writer — the bundle is
  plain markdown and Obsidian/VS Code stay first-class editors, so okbrain
  competes on conformance (every save normalized + indexed), not on editing
  chrome. Settings persist through `init` (which gained
  `--retrieval-profile`) instead of a new config op. Verified end-to-end in
  Chromium: every view driven, zero page errors, zero external requests.
- 2026-07-17 — **Local API (3.1): one token gates everything; the
  bookmarklet navigates instead of fetching.** The per-install serve token
  is required on every `/api` and `/clip` request, not just clip: CORS only
  protects response *reads*, so an untokened POST from a hostile page would
  still execute a write op. Defense layers: 127.0.0.1 bind → Host-header
  check (DNS rebinding lets a remote origin become "same-origin" with
  localhost; matching the server's own host:port kills it) → token
  (constant-time compare) → CORS reflection only for the server's own
  localhost origins. `GET /` stays tokenless — it's the GUI bootstrap; local
  processes can read the token file anyway and remote pages can't read the
  response. The bookmarklet is a top-level GET navigation (`window.open`)
  rather than a `fetch`, because HTTPS→http://127.0.0.1 fetches trip
  mixed-content/PNA rules in real browsers; the token in the URL is
  accepted for a localhost-only, per-install secret. Streaming ask is a
  generic `Operation.stream(ctx, params, emit)` hook on the registry —
  adapters stay generated, nothing bypasses the ops layer — emitting phased
  events (`context`/`answer`/`done`); token-level streaming waits for
  gateway SSE support (Backlog). `serve`/`bookmarklet` are `localOnly` ops:
  in the registry (the CLI stays 100% generated) but invisible to network
  adapters — a server must not be able to start servers. operations.ts ⇄
  api.ts is a deliberate lazy ESM cycle (the `serve` op needs the server,
  the server needs the registry); neither dereferences the other at module
  top level.
- 2026-07-17 — **AI extras are opt-in per call, profile-gated, fail-soft
  (F-B.8).** Review garnish and clip autoTag never run implicitly: garnish
  needs `--garnish` on each invocation, autoTag needs the `--auto-tag` flag
  or an explicit `clip.autoTag: true` in config — the same no-silent-spend
  rule as rerank. Both consult the retrieval profile's new `extras` switch
  (false in `lean`, whose whole point is keeping a local model comfortable),
  and both are one chat call that can only *decorate* the deterministic
  result: garnish lines are keyed to known queue ids (invented ids dropped),
  suggested tags are normalized to kebab-case with the reserved `inbox` tag
  filtered, and any AI failure warns and yields the un-garnished queue /
  untagged clip. autoTag runs only for newly created clips (a dedupe append
  never re-tags) and feeds the model the bundle's existing tag vocabulary
  (`Engine.listTags()`) so tagging converges instead of fragmenting.
- 2026-07-17 — **Hybrid retrieval ships fail-soft and spend-safe (2.3).**
  Query vectors must live in the documents' space, so the vector arm embeds
  queries under the store's recorded (provider, model) cache key — not the
  currently configured embedder — and any vector-arm failure degrades to
  keyword-only with a warning: search must never break because an optional
  arm can't run. Rerank runs only when a provider is explicitly configured
  (config `ai.rerankProvider` / `$OKB_RERANK_PROVIDER`), never via key
  detection — a merely-exported `VOYAGE_API_KEY` must not make every search
  spend credits. `okb ask` never presents an unverified source: citations
  are post-checked against the packed context ids, and an empty retrieval
  pool returns a stock "nothing found" without calling the model (asking
  with nothing to cite invites fabrication). Multi-query expansion is
  `max`-only; a chat failure there just narrows recall instead of erroring.
- 2026-07-13 — **Vectors live in their own DB file, keyed by
  (provider, model, dim) (2.2).** Two forcing facts: a vec0 virtual table
  can't even be `DROP`ped without the extension loaded, so putting it in
  `index.db` would break `okb rebuild` on any machine where sqlite-vec can't
  load (notably stock macOS); and embeddings cost real money/time, so the
  rebuild escape hatch must not discard them. Hence `.okb/vectors.db` behind
  a small `VectorStore` interface (Postgres later implements both it and
  `Engine`). Skip logic hashes title+description+body — not the raw file —
  so Resurface's metadata-only stamps don't trigger paid re-embeds. The
  embed-on-write hook only refreshes under a matching cache key and never
  resets it (resets are `okb embed`'s job, visibly reported); hook failures
  warn and never fail the write. A vector-store schema change auto-discards
  (it's a cache of a cache; the next `okb embed` reports the full re-embed),
  unlike `index.db` which refuses and demands a rebuild — the difference is
  that a stale keyword index silently truncates *reads*, while an empty
  vector store just means re-embedding. macOS CI installs Homebrew sqlite;
  `custom-sqlite.ts` must run before *any* Database opens, so both engine
  and vector store call it first.
- 2026-07-11 — **Gateway (2.1): three dialects, per-capability slots, no
  SDKs.** All providers speak one of three HTTP dialects (openai-compatible /
  anthropic / gemini), so recipes are data rows, not classes, and the binary
  gains zero SDK weight. Resolution runs per capability with the rule that a
  provider only wins a slot it can serve — configuring anthropic for chat
  must not break embeddings (they fall through to detection → local). API
  keys are env-only, never persisted, and the missing-key error names the
  var. Rerank ships with a single recipe (Voyage); local/chat-based rerank is
  a 2.3 concern. `okb init` is deliberately non-interactive (flags +
  detection persisted explicitly) — the CLI has no prompt infrastructure and
  scripted setup should behave identically to manual setup. It also persists
  `defaultBundle`, completing the Stage-0 promise ("cwd until okb init");
  test hermeticity comes from a bun-test preload pinning the config dir and
  stripping provider keys, so a developer's real config/keys can't sway CI
  or local runs. Zero-weighted review signals now also drop their reason
  string — a config-disabled signal disappears from the UX entirely.
- 2026-07-11 — **Clip extraction trio verified on Bun — no swaps (F-A.2).**
  linkedom (parse), @mozilla/readability (article isolation), turndown
  (HTML→md, `remove(["script","style","noscript"])`) all run clean on Bun;
  all pure JS, so they compile into the single binary. Readability's content
  HTML is re-parsed once to absolutize `a[href]`/`img[src]` against the page
  URL (serialize via `document.toString()` — linkedom's `document.body` is
  unreliable for wrapped fragments). When Readability returns null (thin
  pages), the whole `<body>` is converted and the description falls back to
  "Clipped from <host>". The fetch guard exposes `allowPrivate` (default
  off, never set by the CLI) so tests can exercise mechanics against a
  127.0.0.1 stub and a future config could permit intranet wikis.
- 2026-07-11 — **Engine schema migrations are rebuilds (v2 for Resurface).**
  The DB is a disposable cache, so v1→v2 doesn't get ALTER-TABLE migrations
  (backfilling new columns would defeat the content-hash skip and reproduce
  the truncation risk). Instead: a version mismatch flips the engine into a
  refuse state where every data method throws "run `okb rebuild`", and
  `wipe()` — the first thing rebuild calls — drops and recreates the current
  schema unconditionally. Rebuild therefore works against any old index file,
  and nothing can half-answer from a stale shape. Review-queue positions
  (`review done 3`) resolve against the unlimited ranking, so numbering from
  any `--limit` listing stays valid; two-word CLI commands (`review done`)
  are a generic adapter feature over `cliName`, keeping the ops contract
  surface-neutral.
- 2026-07-11 — **Feature interlude order + scope guard (decided).** After
  Stage 1: Resurface (F-B) then Clip (F-A), then Stage 2.1. Both features ship
  CLI-first and must run with zero AI providers configured; their GUI pieces
  fold into 3.2, the clip bookmarklet + token endpoint into 3.1 (an endpoint
  without the local API would be dead code), cron into 4.5, AI garnish/autoTag
  into Stage 2. No Stage 3/4 work starts early.
- 2026-07-11 — **Resurface state split: reviewed → bundle, snooze → DB.**
  "I reviewed this" is user knowledge, so `review done` stamps a
  `last_reviewed` frontmatter key (okbrain extension; OKF-safe since consumers
  tolerate + preserve unknown keys) and survives `okb rebuild`. A snooze is a
  scheduling preference, so it lives only in the engine's `review_state` table
  and dies on rebuild — documented, acceptable. The stamp goes through the
  conformance writer in a new **metadata-only mode** that skips the `timestamp`
  refresh and the `log.md` entry: `timestamp` means *content* change, and a
  daily review of 5 items must not churn the log (resolves the framework's
  open question: frontmatter key only). This is the single exception to the
  1.1 "timestamp always refreshed" rule, available only to internal callers —
  the `write` op's surface is unchanged. Queue determinism: score desc → older
  `timestamp` → id; anniversary is computed on `timestamp` because creation
  dates aren't tracked in frontmatter.
- 2026-07-11 — **Clip conventions.** Type is lowercase `reference` (the
  codebase's type convention — capture writes `note`), landing at
  `references/<slug>` per the `<type>s/` scheme. Inbox = the `inbox` tag, not
  a new frontmatter key: read-state is user knowledge and must survive
  rebuild, and a tag is already OKF-optional vocabulary. Dedupe compares
  *normalized* canonical URLs on both sides (stored `resource` values may be
  hand-written), so the engine exposes id+resource pairs and normalization
  stays in TS; without an index clip falls back to a bundle scan — clip never
  requires an index. Slug collisions between different URLs get numeric
  suffixes (capture's pattern). `fetch-guard.ts` is extracted before Stage 4
  on purpose: one SSRF/size/timeout guard, two callers (clip now, crawler
  later); redirects are re-checked per hop; the DNS-rebinding TOCTOU residual
  is accepted for v1 and revisited with the crawler.
- 2026-07-11 — **Sync (1.5): bundle repos are self-contained; seed files are
  append-only.** `okb sync` manages the bundle as its own repo and refuses a
  bundle nested inside another repository (a nested `git init` would leave the
  outer repo seeing a broken gitlink). Initial branch is `main` via
  `symbolic-ref` (portable below git 2.28). Seeding means "ensure these lines
  exist", so user entries in `.gitignore`/`.gitattributes` survive every sync.
  `* text=auto eol=lf` is seeded because a Windows `autocrlf` checkout that
  rewrites LF would churn every diff and silently invalidate Stage-2 embedding
  content-hashes. Git spawns by argv with `GIT_TERMINAL_PROMPT=0`; push/pull
  are CI-tested against a local bare remote, so no network is ever needed.
- 2026-07-11 — **db_only privacy is enforced by the generators, not only by
  gitignore (1.5).** Ignoring `db_only/` alone still leaked private titles and
  descriptions into the *committed* root `log.md` and parent `index.md`.
  Writes under a `db_only/` directory now skip the root log entry, and parent
  indexes omit the directory row; the directory's own (never-committed)
  `index.md` still lists its concepts. A root concept literally named
  `db_only.md` stays public (`inDbOnlyDir` checks directory segments only),
  matching git's `db_only/` pattern semantics.
- 2026-07-11 — **Engine access can't implicitly create an index (B3).**
  `OpContext.engine()` takes `createIfMissing`, passed only by
  `index`/`rebuild`. Any other engine-backed op on a never-indexed bundle now
  fails with "run `okb index` first" instead of opening an empty DB that
  `hasIndex()` would forever after treat as real — the same silent-truncation
  failure mode the 1.4 write-refresh decision guards against.
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
- Concept `type` vocabulary: ship a small non-binding default set (Note, Person,
  Project, Reference, Idea, Meeting…) vs fully free-form?
- Acceptance test: round-trip the three OKF sample bundles (GA4, Stack Overflow,
  Bitcoin) as a conformance gate?
