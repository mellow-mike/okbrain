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
- **No-op writes are skipped.** An update whose serialized output would match
  the on-disk bytes but for the refreshed `timestamp` is a no-op: the file is
  not rewritten, `timestamp` is not bumped, no `log.md` entry is appended, and
  the index is not regenerated. `writeConcept` detects this by reserializing
  the candidate with the *existing* timestamp and comparing byte-for-byte;
  `WriteResult.noop` marks it (`okb write` renders `unchanged`). This keeps
  re-imports and repeated agent passes over unchanged content out of git
  history and preserves `timestamp`'s meaning ("last content change").
  Non-canonical existing files (CRLF endings, a missing timestamp) never
  match, so they are still normalized on the next write.
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

### Derived typed edges (OKF-safe, 4.3)
OKF keeps links untyped on disk on purpose. We type edges **only in the DB**
(`core/graph/typed-edges.ts`) so relational retrieval works without breaking
the format: classification is deterministic and local — the clause directly
before the link wins ("depends on [X]" → `depends-on`), else the nearest
preceding heading (`# Citations` → `cites`, `# Joins` → `joins-with`; an
unknown heading means untyped, it does not inherit an earlier one), else
null. One shared `REL_VOCAB` phrase table drives both the classifier and
the relational query detector. The markdown file stays a plain OKF link;
okbrain just knows more. The "cache" is the index itself: rels are
recomputed by every index build and per-concept write refresh.

### Storage & queries
SQLite tables: `nodes(id, type, title, description, resource, timestamp,
last_reviewed, body_len, content_hash)`, `edges(src, dst, rel)` (schema v3;
`rel` nullable, derived — see typed edges above), `tags(node_id, tag)`,
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

### RSS ingest (`okb rss`, Stage 4.1)
Feeds are the second ingest source (after import/capture/clip): `okb rss
[url]` pulls one feed, or — with no URL — every entry in config `rss.feeds`
(what the jobs worker runs). `core/ingest/rss.ts` parses RSS 2.0 / RSS 1.0
(RDF) / Atom with linkedom's XML parser (no new deps) and writes each new
item as a conformant `references/<slug>` concept: type `reference`, tags
`inbox` + `rss`, entry content/summary converted to markdown, `# Citations`
naming the feed, `author`/`published`/`feed` as extension keys. Dedupe is
clip's exact rule — normalized item URL against every concept's normalized
`resource` (plus in-run) — so a feed entry and a hand-clipped article of the
same page can never duplicate, and re-pulls are idempotent. Entries keep the
feed's own content; fetching the full page stays clip's (or the enrich
pass's) job. A per-pull `limit` (default 10, config `rss.maxItems`) paces
first pulls of deep feeds; the rest arrive on later runs. Multi-feed pulls
record per-feed errors instead of failing (one dead feed must not block a
cron pull); a single explicit URL fails loudly. Zero AI, works with or
without an index.

### Config (`clip.*`)
`maxBodyBytes` 100KB, `stripParams` (utm_* etc.), `defaultTags` [],
`autoTag` false (true = suggest tags on every clip; still off in `lean`).

---

## Calibration — takes vs facts

Opinions and predictions ("takes") are knowledge too, but they must not
masquerade as settled facts. The separation is a concept type: `type: claim`
(`core/claims.ts`), living under `claims/` per the `<type>s/` scheme, with
okbrain extension keys — `confidence` (0–100), optional `resolve_by`
(YYYY-MM-DD), and on settlement `outcome` + `resolved`. All OKF-safe:
consumers tolerate and preserve unknown keys, and claims are ordinary
concepts to search/graph/review.

- **`okb take <statement> --confidence 70 [--resolve-by …]`** — stakes a
  claim at `claims/<slug>` through the conformance writer (numeric suffix on
  collision, statement = title, optional `--body` for the reasoning).
- **`okb resolve <id> correct|incorrect|void`** — settles exactly once
  (re-judging means editing frontmatter by hand — deliberate friction);
  `true`/`false` accepted as aliases but the stored value is a word, never a
  YAML boolean (a bare `outcome: true` would round-trip as a boolean and
  complicate every consumer). A resolution is a content change: `timestamp`
  refreshes and `log.md` gets an entry.
- **`okb calibrate`** — deterministic, zero-AI report from a bundle scan (no
  index required): open claims with overdue flags (`resolve_by` past), the
  Brier score (mean `(confidence/100 − outcome)²` over correct/incorrect;
  void counts but never scores), and per-decade calibration buckets (stated
  confidence vs actual hit rate).

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
   The relational arm (`relational.ts`, 4.3) adds one more ranking when the
   query names a known relation ("what cites X"): anchor found via FTS with
   question stop-words stripped, then in+out neighbors over that relation,
   tagged `relational` — direction is recall, fusion ranks. Always on; a
   strict no-op for every other query.
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
- **Source pass (pluralized):** filesystem import, quick capture, clip,
  RSS/feeds (4.1), a browser grab (later email/calendar) — each
  produces/updates OKF concepts.
- **Web pass (`okb enrich`, `core/ingest/web.ts`):** the LLM acts as a
  guarded crawler driving a JSON-action loop over the plain-text chat
  gateway (`list_concepts` / `read_concept` / `fetch_url` / `write_concept`
  / `done` — one JSON object per model turn). It may enrich an existing
  concept, mint a `references/<slug>` doc (new ids are confined there by the
  tool), or skip; citations go under `# Citations`. Every guardrail lives
  inside the tools, never the prompt: `--no-web`, the **frontier rule**
  (only seeds and links discovered on fetched pages are fetchable — an
  invented URL is refused with zero packets sent), `--web-max-depth`,
  host allowlist (defaults to the seeds' hosts, subdomains included), path
  allow/deny prefixes, `--web-max-pages` (checked last so a policy refusal
  reports its real reason), and a step cap so a chatty run always ends.
  Guard refusals and bad writes come back as error observations the model
  can correct; two unparseable replies abort. `guardedFetch` (clip's SSRF
  guard) sits underneath. Writes flow through the conformance writer and
  the standard reindex hook (index + vectors), which is why the sketched
  `embed_doc` tool doesn't exist; `link_suggest` joins the toolset with 4.4.

### MCP server (`okb mcp`, `src/mcp/server.ts`)
External agents (Claude, etc.) use the brain as a tool. Tools and their JSON
schemas are generated from the ops registry — the same param specs as the
CLI and local API, so surfaces can't drift. Trust is fail-closed in three
layers: connections are **untrusted by default** (read ops only — write
tools are hidden from `tools/list`, refused by name if called anyway, and
`runOp` re-gates scope underneath); `okb mcp --trusted` deliberately exposes
write ops for clients the user fully trusts; admin and `localOnly` ops never
appear on this surface at all. Transports: stdio (default — stdout carries
only protocol JSON, logs go to stderr) and Streamable HTTP via `--http`
(stateless server-per-request, binds 127.0.0.1, Host-checked like the local
API). Filesystem confinement is the ops' own: concept ids reject traversal
segments before any path is built.

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
| `okb stats` | read | Counts by type/tag, links, orphans, freshness snapshot |
| `okb links suggest <id>` | read | Propose cross-links (deterministic, with reasons) |
| `okb links accept <id> <target>` | write | Accept one: normalized link under `# Related` |
| `okb index` / `okb embed` | admin | (Re)build FTS / vectors incrementally |
| `okb rebuild --confirm-destructive` | admin | Wipe + regenerate index from bundle |
| `okb doctor` / `okb lint` | read | OKF conformance + health report |
| `okb sync` | write | git commit/push/pull |
| `okb take <statement> --confidence N` | write | Stake a claim (opinion/prediction) |
| `okb resolve <id> <outcome>` | write | Settle a claim: correct/incorrect/void |
| `okb calibrate` | read | Brier score + calibration over resolved claims |
| `okb brains` | read | List configured brain mounts (CLI-only) |
| `okb serve` | admin | Start local GUI + API |
| `okb mcp` | admin | Start MCP server |
| `okb export-viz` | read | Self-contained OKF-style graph HTML |

Global flags: `--json` everywhere, `--bundle <path>`, `--brain <name>`
(named mount; also `$OKB_BRAIN`).

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
palettes. Every non-`localOnly` op has a home on one of the views below — the
GUI is a full surface over the ops contract, not a subset. Views:
- **Graph** — live Cytoscape fed by the `graph_data` op (whole graph as
  JSON; also `okb graph-data --json` for agents/scripts); search filter,
  type-colored nodes, detail panel with rendered body (internal links
  rewired to focus their node), click-through to the editor.
- **Search** — hybrid `search` op (keyword + vector recall, graph
  expansion, optional profile) with per-hit recall-source chips; distinct
  from the Graph view's client-side title filter. Each hit links to
  editor + graph.
- **Ask** — SSE streaming: retrieved context appears as chips before the
  answer arrives; verified citations link to graph and editor.
- **Add** — the quick-ingest hub for the ops that don't need the full
  editor: quick `capture` (note → `inbox/`), `clip` a URL, pull configured
  feeds (`rss`), and bulk `import` of a server-side path.
- **Review** — card stack with scores + reasons, optional garnish toggle;
  done / snooze / suggest-links (accepts write) / open / graph per card.
- **Inbox** — unread clips/notes; open / mark-read / suggest-links.
- **Claims** — calibration dashboard (`calibrate`: correct/incorrect/void
  tallies, Brier score, per-decade buckets); a stake form (`take`) and
  per-open-claim resolve controls (`resolve`), overdue claims flagged.
- **Stats** — brain-at-a-glance tiles (`stats`), a two-concept path finder
  (`graph_path`), and an orphan list (`orphans`).
- **Editor** — scaffold fields (type/title/description/tags/resource) + a
  markdown body textarea; concept-id link picker inserting normalized
  links; citation-section helper; live backlinks; suggest-links panel
  (insert-only — a suggestion lands in the textarea and becomes real on
  save); saves via `write_concept`, so every save is conformant.
  Deliberately not a rich editor: the bundle is plain markdown and external
  editors remain first-class.
- **Settings** — AI providers + retrieval profile (backed by `init`, which
  persists them), git sync (status / run), enrichment guardrails + run
  (`enrich`), and maintenance (re-index, embed, doctor, export viz.html,
  and a confirm-gated rebuild).
Cross-platform free (it's a web app); an optional Tauri wrapper later gives
a native desktop app over the same local API.

### Trust boundary
Each op call carries a trust flag. CLI + local GUI are trusted; MCP/remote is
untrusted unless explicitly local. Not-strictly-trusted ⇒ untrusted
(fail-closed). Untrusted callers get read ops; write/admin are gated and
filesystem confinement tightens.

### Multi-brain mounts (Stage 5)
The gbrain "brains" axis: config `brains` maps a name to a bundle path
(string form) or `{ path, readonly }` (policy form) — `~` expands, paths
must otherwise be absolute (a config file resolving against cwd would be a
footgun). Selection is `okb --brain <name>` / `$OKB_BRAIN` (mutually
exclusive with `--bundle`); `okb brains` lists mounts and is `localOnly` —
mount paths are host filesystem topology and never belong on a network
surface. The **read-only policy is a third gate in the ops layer**, distinct
from trust: `checkOpCall` refuses write/admin on a readonly context before
any handler runs, and the flag is threaded through every adapter (CLI, each
local-API request, MCP even with `--trusted`), so serving a read-only brain
cannot re-open it. Each mount is its own repo + its own `.okb/` index —
nothing is shared between brains.

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

### Packaging & distribution (Stage 5)
`okb` and the sqlite-vec `vec0` extension always travel **side by side**:
the extension lookup is `$OKB_SQLITE_VEC` → next to the okb executable → the
npm package (dev path). Embedding vec0 *inside* the compiled binary was
rejected — SQLite loads extensions via dlopen, which can't read Bun's
compiled-in virtual files, so extraction would be needed anyway; shipping
the pair beats hidden temp-file extraction. `bun run build` copies the
platform vec0 into `bin/`; `scripts/package-release.ts` (driven by
`.github/workflows/release.yml` on `v*` tags) cross-compiles all five
targets from one Linux runner and pairs each with its platform vec0 from
the npm registry (tar.gz/zip + SHA256SUMS.txt). Homebrew/Scoop manifest
templates live in `packaging/`; artifacts stay unsigned until org
certificates exist (hook points documented in `packaging/README.md`).

### Scale path (opt-in, behind the same interfaces)
More files / faster search → swap engine to **Postgres + pgvector** (ops
unchanged; verify with a rebuild-parity test) — **deliberately deferred**:
without Postgres in the 3-OS CI matrix it cannot meet the "most well-tested"
bar, and no bundle has outgrown SQLite (decision 2026-07-20). Heavier
background work → promote the single worker to a real queue. Multiple/team
brains → **shipped** as multi-brain mounts (see §Surfaces). Single-user
stays the default. Switching engines = point at the new engine +
`okb rebuild`.

---

## Repo layout

```
okbrain/
├── src/
│   ├── core/
│   │   ├── operations.ts        # the ONE contract (scope + trust + readonly)
│   │   ├── config.ts            # bundle path, config/data dirs, brain mounts
│   │   ├── claims.ts            # calibration: takes vs facts (Brier, buckets)
│   │   ├── stats.ts             # okb stats: brain-wide counts/orphans/freshness
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
├── scripts/                     # build/release helpers (copy-vec0, package-release)
├── packaging/                   # Homebrew/Scoop templates + release/signing docs
├── docs/
│   └── context/                 # user-dropped reference material
│       └── REFERENCES.md        # registry of that material (see below)
└── tests/                       # conformance, graph, retrieval, surfaces
```

---

## Skills & jobs

"Thin harness, fat skills": capabilities needing judgment are markdown
procedures the agent reads, parameterized like method calls. The first set
shipped with 4.6 under `skills/`: `RESOLVER.md` routes intent to one of
capture, ingest, enrich, query (brain-first retrieval recipe), daily-note
(embeds the review queue's "worth revisiting" section, reasons verbatim),
and link-suggest. Every skill has an explicit Parameters block and grounds
its deterministic steps in `okb` CLI calls (`--json`) — the skill carries
only the judgment. Decision rule: lookup/list/status → CLI command
(deterministic); needs to think/adapt → skill. Operating discipline worth
keeping: do a task manually 3–10×, codify it into a skill, then put it on
cron.

Jobs/cron (`core/jobs/worker.ts`, `okb jobs`): one sequential maintenance
run under `.okb/jobs.lock` — exclusive create, stale locks (dead pid,
unreadable, >24 h) reclaimed once, SIGINT/SIGTERM finish the current job
then stop, per-job failures captured so later jobs still run. The job list:
index refresh (regenerates edges/backlinks), embed backfill (only when a
vector store already exists), rss pull (`rss.feeds`), review-queue
recompute (surfaced in the run report — the queue itself is on-demand),
doctor. Nothing in the list spends AI implicitly; enrich-stale is
deliberately not a job — `okb enrich` is always an explicit decision.
Scheduling belongs to the OS (cron / launchd / Task Scheduler invoking
`okb jobs`); no daemon, no queue infra in v1.

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

- 2026-07-22 — **The GUI is a full surface over the ops contract, not a
  curated subset.** Stage 3.2 shipped the GUI with the everyday views, but
  a dozen non-`localOnly` ops (`search`, `graph_path`, `orphans`, `stats`,
  `capture`, `import`, `export_viz`, `rebuild`, `clip`, `rss`, `take`,
  `resolve`, `calibrate`) had no GUI home and were reachable only from the
  CLI/MCP — a drift the ops-contract invariant (2) exists to prevent. Wired
  them all in with three new views (Search, Add, Claims, Stats) plus two
  maintenance buttons, so every capability the local API exposes now has a
  GUI affordance. A regression test asserts each op literal is present in
  the served `app.js` (and `ask` via its SSE endpoint), so a new
  network-facing op can't be added without a GUI wiring or a deliberate
  choice to leave it out. `new_concept` is the one intentional omission:
  the Editor already creates via `write_concept` with an explicit id, so a
  second create path would be redundant chrome. Forms that need typed
  inputs (claim confidence/date) use plain inputs rather than the generic
  `field()` helper, whose ids are `ed`-prefixed for the Editor/Settings
  forms.
- 2026-07-22 — **Writer no-op detection compares bytes, not fields.** The
  guard reserializes the candidate concept with the *existing* timestamp and
  compares to the on-disk bytes; only an exact match is a no-op. Comparing
  bytes rather than a field-by-field semantic diff is deliberately
  conservative: it can only ever *skip* a write that would have produced an
  identical file (minus the timestamp bump), so it never risks dropping a real
  change, and it correctly treats a canonicalization (CRLF→LF, adding a missing
  timestamp, reordering keys) as the real write it is. The alternative — a
  semantic equality check — would have to re-encode the notion of "conformant
  bytes" a second time and could disagree with the serializer. The no-op path
  also skips `index.md`/`log.md` regeneration: an unchanged concept's index row
  is already correct, and a spurious `**Update**` log line for a byte-identical
  file is exactly the git churn this removes.
- 2026-07-22 — **`okb stats` is code, not a skill, and needs an index.** A
  brain-wide snapshot (counts, orphans, freshness) is a deterministic
  aggregate, so by the thin-harness rule it is a read op (`core/stats.ts`
  pure `computeStats` over engine rows/edges/`tagCounts()`), not agent
  judgment. It reads through the engine like `search`/`graph`/`orphans`, so it
  fails loudly on a never-indexed bundle (B3) rather than silently creating an
  empty index. Freshness takes an injected `now` and a `staleDays` window so
  the aggregation is testable and the "stale" line is meaningful without a
  magic constant buried in a query.
- 2026-07-20 — **Packaging (5.1): vec0 ships beside the binary, never
  embedded in it.** SQLite loads extensions with dlopen, which cannot read
  the virtual files Bun compiles into an executable — an embedded vec0
  would need extraction to a real path on every start, trading a visible
  file for hidden temp-dir state. So the contract is "okb and vec0 sit in
  the same directory": the lookup is `$OKB_SQLITE_VEC` → executable's dir →
  npm package (dev), `bun run build` copies the pair, and every release
  archive, the Homebrew formula (libexec + symlink), and the Scoop manifest
  preserve it. Releases cross-compile all five bun targets from one Linux
  runner (`scripts/package-release.ts`, verified end-to-end) with the
  matching sqlite-vec platform tarball pulled from the npm registry at the
  repo's pinned version. Signing/notarization stays a documented hook, not
  a workflow step, until certificates exist — a release process that lies
  about signing is worse than one that says "unsigned".
- 2026-07-20 — **Multi-brain (5.2): read-only is a third ops-layer gate,
  not a trust level.** A readonly mount is a *policy* on a trusted caller —
  reusing `trusted=false` would have conflated it with the MCP boundary and
  produced misleading errors, so `OpContext.readonly` is its own fail-closed
  check in `checkOpCall` (write/admin refused before any handler) and every
  adapter threads it: the CLI at resolution, the local API into each
  per-request context, MCP even under `--trusted`. Brain paths must be
  absolute (after `~` expansion) because a config file resolving relative
  paths against whatever cwd happens to be would silently target the wrong
  directory; `okb brains` is `localOnly` because mount paths are host
  topology no network surface needs. Per-brain provider/profile settings
  are Backlog until wanted.
- 2026-07-20 — **Calibration (5.3): claims are a concept type, outcomes are
  words, resolution settles once.** "Takes vs facts" needs no new storage:
  `type: claim` + extension keys (`confidence`, `resolve_by`, `outcome`,
  `resolved`) keep claims ordinary OKF concepts that search/graph/review
  already handle. Outcomes are `correct|incorrect|void` — storing `true`
  would round-trip as a YAML boolean and force every consumer to handle
  both shapes (CLI still accepts true/false as aliases). `okb resolve`
  refuses a second judgment (re-judging = hand-editing frontmatter,
  deliberate friction against score-polishing), and a resolution is a
  content change (timestamp + log). Scoring is a bundle scan, not an engine
  query: claim keys aren't indexed columns, scans are laptop-cheap, and
  `okb calibrate` stays index-free like clip. Brier + per-decade buckets
  because both are deterministic, explainable, and need zero AI.
- 2026-07-20 — **Postgres engine and desktop wrapper deferred (5.4).** The
  North Star says most-well-tested, and the 3-OS CI matrix has no Postgres
  service — an engine that ships without CI-green tests on every platform
  would violate the bar it exists to meet; SQLite has no observed scale
  problem to justify the infrastructure. The engine interface remains the
  seam (rebuild-parity test lands with the engine when it earns its way
  in). Tauri/Electron likewise: `okb serve` already gives a cross-platform
  GUI, and a wrapper would be the repo's heaviest dependency for window
  chrome. Both stay on the roadmap as `[!]` with this rationale.
- 2026-07-19 — **Jobs (4.5): the OS schedules, okb runs once under a lock,
  and no job spends AI implicitly.** A daemon would violate the lightweight
  core for zero gain — every platform already ships a scheduler, so
  `okb jobs` is a single idempotent pass (cron/launchd/Task Scheduler owns
  the cadence) guarded by an exclusively-created `.okb/jobs.lock`; stale
  locks (dead pid / unreadable / >24 h) are reclaimed exactly once so a
  crash can't wedge the nightly run, while a live lock always wins. The
  roadmap's "enrich stale" job was dropped from the list on the
  no-silent-spend rule (rerank/garnish precedent): embed only backfills a
  store the user explicitly created, rss/index/doctor/review are zero-AI,
  and enrichment stays a deliberate `okb enrich`. Job failures are data
  (captured per job, run continues, exit 1 at the end) — a broken feed must
  not cancel doctor.
- 2026-07-19 — **Link suggestion (4.4): always through review, never
  auto-insert.** Resolves the open question: a suggested link that writes
  itself would put derived guesses into canonical markdown, so `link_suggest`
  is a read op (deterministic scoring with stated reasons — title mention
  with word boundaries strongest, per-word FTS similarity because
  engine.search is AND-semantics, shared tags) and `link_accept` is the only
  writer: it appends a normalized `[Title](/id.md)` under `# Related` via
  the conformance writer, so accepts are content changes (timestamp + log,
  correctly). Already-connected concepts in either direction are never
  suggested — the queue self-cleans as you accept. The GUI keeps the same
  split: Review/Inbox buttons accept (write ops), while the Editor's button
  only inserts into the textarea — nothing becomes real until Save. The
  enrich agent gets the same engine via a `link_suggest` action rather than
  a separate implementation.
- 2026-07-19 — **Typed edges (4.3): sentence beats heading, unknown headings
  don't inherit, and the DB is the cache.** Classification must be
  deterministic (it reruns on every index build), so it's a fixed phrase
  vocabulary, not a model call: the clause ending at the link is the most
  local signal and wins; otherwise the nearest preceding heading — and an
  *unknown* nearest heading yields untyped rather than letting an earlier
  `# Citations` bleed across sections. Rels live in the edges table (schema
  v3, nullable `rel`), never in markdown — OKF stays untyped on disk. No
  separate cache table: rels recompute with the content-hash-skipped index
  build and the per-write refresh, exactly as cheap as link extraction.
  The relational arm is always on (no profile knob): detection over the
  same vocabulary makes it a strict no-op for non-relational queries, and
  it returns in+out neighbors (grammar-blind) because the arm's job is
  recall — RRF fusion does the ranking. Consumers that ignore rel
  (path/orphans/review scorer) now type against `LinkEdge`.
- 2026-07-19 — **Web pass (4.2): guardrails live in the tools; the frontier
  rule replaces URL trust.** The crawler's chat protocol is one JSON action
  per turn over the existing plain-text gateway (no SDK tool-calling — the
  gateway stays three dialects of plain fetch). Prompts are advice; the
  tools are law: fetch_url refuses anything not in the frontier map (seeds
  at depth 0, links discovered on fetched pages at parent+1), so a
  hallucinated URL never costs a packet, and depth/host/path/page caps are
  re-checked on every call with the SSRF guard underneath. New concept ids
  are confined to references/ by write_concept (existing concepts may be
  enriched in place) — the same enrich/mint/skip triad OKF's pass used.
  Failures the model can fix (guard refusal, missing scaffold field, 404)
  return as error observations; only provider/system errors abort. The
  sketched read_existing_doc/embed_doc tools were dropped: one raw read
  suffices, and the standard write-reindex hook already refreshes vectors.
- 2026-07-19 — **RSS ingest (4.1) stores the feed's own content and shares
  clip's dedupe.** A feed pull does not fetch item pages: the entry's
  content/summary is the body (converted to markdown), and getting the full
  article is clip's or the enrich pass's job — pulls stay cheap, cron-safe,
  and zero-AI. Dedupe reuses clip's normalized-resource rule on both sides,
  so `okb rss` and `okb clip` can never create duplicates of the same page
  and re-pulls are idempotent. Configured multi-feed pulls capture per-feed
  errors in the result instead of throwing (a dead feed must not block the
  nightly pull); an explicitly given single URL still fails loudly. Feed
  parsing uses linkedom's XML DOMParser (already a dep) over direct-child
  lookups — querySelector would cross item boundaries.
- 2026-07-17 — **MCP (3.3): read-only by default, write is an explicit local
  opt-in, admin never.** The MCP surface is the trust boundary made
  concrete: a default connection gets read tools only, and the gate is
  triple-layered (hidden from `tools/list` + refused by name on call +
  `runOp`'s own fail-closed scope check), so no single bug re-opens it.
  Write access is `--trusted` — a flag the user passes when wiring their own
  agent, never negotiated by the client. Admin ops (index/rebuild/embed/
  init) are excluded outright: an agent that can wipe the derived index or
  rewrite provider config is a footgun with no agent-shaped use case; and
  localOnly ops (serve/bookmarklet/mcp) can't start servers from a server.
  Tool schemas are generated from the registry's param specs, keeping the
  contract single-sourced. HTTP mode is stateless (fresh server+transport
  per request — no session table to manage or leak) on 127.0.0.1 with the
  same Host check as the local API; no token, because the default surface
  is read-only and write requires the local `--trusted` decision. The MCP
  TS SDK is Stage 3's one new dependency (pure JS, compiles into the
  binary — verified end-to-end through the compiled binary).
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
- Concept `type` vocabulary: ship a small non-binding default set (Note, Person,
  Project, Reference, Idea, Meeting…) vs fully free-form?
- Acceptance test: round-trip the three OKF sample bundles (GA4, Stack Overflow,
  Bitcoin) as a conformance gate?
