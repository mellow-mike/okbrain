# okbrain

A self-hosted, cross-platform personal knowledge manager you can run for years
on a laptop, fully offline. Your knowledge lives as a conformant
**[Open Knowledge Format](https://github.com/GoogleCloudPlatform/open-knowledge-format) (OKF v0.2)**
bundle — plain markdown + YAML frontmatter in git — and everything else
(search index, vectors, graph) is a derived cache that rebuilds from it with
one command. No lock-in: any markdown tool can read and edit your brain.

- **One binary, three surfaces.** A single operations contract drives the CLI
  (`okb`), a local web GUI (`okb serve`), and an MCP server (`okb mcp`) so
  your own agents can use your brain as a tool. Every capability is reachable
  from all three.
- **Provenance, trust, and lifecycle are first-class.** Every write records
  who changed it (`generated`), reviews become `verified` events (trust tiers:
  unverified → machine-confirmed → human-reviewed), concepts carry a `status`
  and a `stale_after` date, and clips, feeds, and the enrichment agent cite
  their `sources` in frontmatter. `okb upgrade` migrates older (v0.1) bundles.
- **Hybrid retrieval.** Keyword (FTS5/BM25) + semantic vectors (sqlite-vec) +
  graph + typed-edge relational recall, fused; `okb ask` answers questions
  with citations verified against your own notes.
- **AI-optional, provider-agnostic.** Runs against a local model (Ollama,
  llama.cpp, LM Studio) with no keys, or a hosted API (Anthropic, OpenAI,
  Gemini, OpenRouter, Voyage). Nothing spends AI silently.
- **Fail-closed trust.** Local CLI/GUI calls are trusted; MCP is read-only
  unless you explicitly opt a server into writes, and its writes are
  attributed to the client. Brains can be mounted read-only.

## Install

**From a release** — download the archive for your OS/arch from
[Releases](https://github.com/mellow-mike/okbrain/releases), unpack, and put
the directory on your `PATH`. The archive is the complete offline package:
the `okb` binary (CLI + local API + embedded GUI + MCP server) and the
`vec0` SQLite extension side by side — that's how semantic search finds it.
Nothing is downloaded at runtime.

```bash
tar -xzf okb-<version>-<os>-<arch>.tar.gz -C ~/.local/okb
export PATH="$HOME/.local/okb:$PATH"
okb --version
```

Homebrew/Scoop: manifest templates live in [`packaging/`](packaging/) for
running your own tap or bucket.

**From source** — requires [Bun](https://bun.sh) ≥ 1.1:

```bash
git clone https://github.com/mellow-mike/okbrain && cd okbrain
bun install
bun run build        # → bin/okb + bin/vec0.* (keep them together)
bun run package      # → dist/okb-<ver>-<os>-<arch>.tar.gz|zip for this machine, fully offline
```

macOS note: `bun:sqlite` links Apple's SQLite, which can't load extensions.
`brew install sqlite` once and okbrain finds it automatically (or point
`$OKB_SQLITE_LIB` at any real `libsqlite3.dylib`). Everything except vector
search works without it.

## Startup guide

### 1. Create your brain

A brain is just a directory. Point okbrain at it once and it becomes the
default for every command:

```bash
mkdir ~/brain && cd ~/brain
okb init --actor human:you      # detects AI providers, persists this bundle as default
```

`okb init` is non-interactive: with an API key exported (e.g.
`ANTHROPIC_API_KEY`) it picks that provider; with none it configures a local
model. It also seeds a root `index.md` declaring `okf_version: "0.2"` and
records your **actor** — the identity stamped on everything you write
(`generated: { by: human:you, at: … }`); the default is `human:<os user>`.
Switch anytime — `okb init --provider local` or
`okb init --provider anthropic --embed-provider openai`. Keys are read from
the environment only, never stored.

### 2. Put knowledge in

```bash
okb new note "Zettelkasten" "How my note system works"    # a concept, properly scaffolded
okb capture "An idea I had on the train"                  # zero-friction note → inbox/
echo "piped text works too" | okb capture
okb import ~/old-notes                                    # map existing markdown into concepts
okb clip https://example.com/article --quote "the key passage"   # web page → cited reference
okb rss https://example.com/feed.xml                      # pull a feed into references/
```

Every write goes through the conformance writer: full frontmatter scaffold
plus `generated`, links normalized to bundle-absolute, `index.md`/`log.md`
maintained. Clips and feed items record the page (with byline and
publication date) under `sources`. Your bundle stays valid OKF that any
other tool can read.

### 3. Index and search

```bash
okb index                          # build the derived index (.okb/index.db)
okb search "note system"           # hybrid keyword search, ranked
okb graph notes/zettelkasten       # neighborhood: → links to, ← cited by (incl. provenance edges)
okb list --detail                  # every concept with status / trust tier / staleness
okb doctor                         # conformance + health report (use it as a CI gate)
```

The index is disposable — `okb rebuild --confirm-destructive` regenerates it
from the markdown at any time.

### 4. Ask your brain (semantic search + RAG)

```bash
okb embed                          # embed concepts into .okb/vectors.db (incremental)
okb search "how do I connect ideas"          # now also semantic
okb ask "what did I conclude about spaced repetition?"
```

`okb ask` retrieves across all arms, packs the best concepts into a prompt,
and answers **with citations post-verified against your notes** — an id the
model invented is never presented as a source. Cost knobs: `--profile
lean|balanced|max` (lean keeps a local model comfortable). Embeddings are
incremental; interrupted runs resume; `--limit` paces API spend.

### 5. The GUI and the bookmarklet

```bash
okb serve --open         # local web app on http://127.0.0.1:6522 (127.0.0.1 only)
okb bookmarklet          # prints a clip-this-page bookmarklet (also shown in the GUI)
```

The GUI is a full surface over the same operations the CLI uses:

| View | What it does |
|---|---|
| **Home** | Brain at a glance (concepts, review due, inbox, orphans, past `stale_after`, human-reviewed %), quick capture, today's review queue, inbox, recently changed, one-click conformance check |
| **Browse** | Every concept with type, status, trust tier, staleness; filter, sort |
| **Concept** | Reader view: rendered body with footnote attribution, provenance (`generated`, `verified`, `sources`), links to / cited by, actions — edit, mark reviewed, mark read, suggest links, deprecate/restore, delete |
| **Edit / New** | Scaffold fields, status, `stale_after`, a sources editor, markdown body with link picker; saves through the conformance writer |
| **Graph** | Live Cytoscape graph: type legend, stale/deprecated styling, detail panel |
| **Search / Ask** | Hybrid search with recall-source chips; streamed answers with verified citations |
| **Review / Inbox** | The Resurface queue with reasons (“Reviewed ✓” records a `verified` event by you); unread clips and notes |
| **Add** | Capture, clip, pull feeds, bulk import, the bookmarklet |
| **Claims / Stats** | Calibration dashboard; counts by type, status, trust; path finder; orphans |
| **Settings** | Server status, your actor, AI providers, git sync, enrichment guardrails, maintenance (re-index, embed, doctor, export viz, rebuild, jobs, **v0.2 upgrade**), MCP setup, brain switcher |

Every request needs the per-install token (minted automatically); the
bookmarklet clips the current page + selection into your brain. Rendered
markdown is sanitized, so a clipped page can never run script in the app.

### 6. Keep it versioned

```bash
okb sync                           # git init + commit (+ pull/push when origin is set)
okb sync --status                  # repo state without side effects
```

Multi-device sync **is** git: add an `origin` remote and `okb sync`
pulls/pushes; the other machine runs `okb index` after cloning. Directories
named `db_only/` stay on disk and in the index but out of git — and out of
the committed `index.md`/`log.md`.

### 7. Let it maintain itself

```bash
okb review                         # today's "worth another look" queue, with reasons
okb review done 1                  # mark reviewed → a verified event by your actor
okb jobs                           # one maintenance pass: index, embed, rss, review, doctor
```

The queue ranks concepts past their `stale_after` first, nudges drafts, and
never queues deprecated concepts. Schedule `okb jobs` with your OS scheduler
(cron / launchd / Task Scheduler) — there is no daemon, and no job ever
spends AI implicitly. Deliberate AI enrichment is `okb enrich` (an LLM
crawls the web inside hard guardrails: frontier rule, depth/host/path/page
caps — every cap enforced in-tool; every write cites its pages in `sources`).

### 8. Wire in your agent (MCP)

```bash
okb mcp                            # stdio MCP server, read-only tools
okb mcp --trusted                  # expose write tools (only for clients you fully trust)
```

Tools and schemas are generated from the same ops contract as the CLI and
GUI; the GUI's Settings page shows the exact config snippet. Writes made
over MCP are attributed to the connected client (`<client>/<version>`), so
an agent's edits never masquerade as human-reviewed. Admin ops (rebuild,
init, serve) never appear on this surface.

### 9. More than one brain

```jsonc
// config.json (see `okb brains` for the path)
"brains": {
  "work":     "/home/me/work-brain",
  "reference": { "path": "/home/me/ref-brain", "readonly": true }
}
```

```bash
okb brains                         # list mounts
okb --brain work search "standup"  # any command, any mount ($OKB_BRAIN works too)
```

A `readonly` mount refuses every write/admin op — on the CLI, the GUI (which
has a brain switcher in its sidebar), and MCP alike.

### 10. Keep score of your opinions

```bash
okb take "Feature X ships this quarter" --confidence 70 --resolve-by 2026-10-01
okb resolve claims/feature-x-ships-this-quarter incorrect
okb calibrate                      # Brier score + calibration by confidence decade
```

Takes are ordinary concepts (`type: claim`) separated from settled
knowledge; `okb calibrate` tells you how well your stated confidence matches
reality.

### 11. Bring an older bundle up to date

```bash
okb doctor                         # flags v0.1 leftovers (timestamp, # Citations, …)
okb upgrade --dry-run              # what would change
okb upgrade                        # timestamp → generated, # Citations → sources, last_reviewed → verified
```

The upgrade is a representation change only: it credits your actor for the
migrated events, never bumps content timestamps, and adds one summary line
to `log.md`.

## Command reference

`okb help` lists everything; `okb help <command>` shows options. Global
flags: `--json` (machine-readable, on every command), `--bundle <path>`,
`--brain <name>`, `--version`.

| Area | Commands |
|---|---|
| author | `new` · `capture` · `import` · `write` · `rm` |
| ingest | `clip` · `inbox` · `inbox read` · `rss` · `enrich` |
| retrieve | `search` · `ask` · `read` · `list` |
| graph | `graph` · `path` · `orphans` · `graph-data` · `links suggest` · `links accept` · `export-viz` |
| review | `review` · `review done` · `review snooze` |
| claims | `take` · `resolve` · `calibrate` |
| maintain | `index` · `rebuild` · `embed` · `doctor` · `upgrade` · `jobs` · `sync` |
| serve | `serve` · `bookmarklet` · `mcp` |
| setup | `init` · `brains` · `version` |

## Configuration

`config.json` lives in your per-user config dir (`~/.config/okbrain` on
Linux/macOS, `%APPDATA%\okbrain` on Windows), written by `okb init` and safe
to edit — unknown keys survive rewrites. Notable keys: `defaultBundle`,
`actor`, `ai.*` (providers/models), `retrieval.profile`, `review.*` (queue
size, cooldown, signal weights incl. `expired`/`draft`), `clip.*`,
`rss.feeds`, `serve.open`, `brains`.

Environment overrides: `OKB_BUNDLE`, `OKB_BRAIN`,
`OKB_CHAT_/EMBED_/RERANK_PROVIDER|MODEL|BASE_URL`, `OKB_SQLITE_VEC`,
`OKB_SQLITE_LIB` (macOS), `OKB_LOG_LEVEL`, `OKB_LOG_JSON`. API keys:
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`,
`OPENROUTER_API_KEY`, `VOYAGE_API_KEY`.

## Develop

```bash
bun install            # dependencies
bun run okb <args>     # run the CLI in dev
bun run typecheck      # tsc --noEmit (strict)
bun test               # test suite (no network)
bun run build          # compile bin/okb (+ vec0 beside it)
bun run package        # offline release archive for this machine → dist/
```

CI runs typecheck + tests on macOS, Linux, and Windows with a pinned Bun; a
feature isn't done until it's green on all three. Releases are
cross-compiled for five targets by `.github/workflows/release.yml` (see
[`packaging/`](packaging/)). `bundles/acme_retail/` is the OKF project's own
v0.2 sample, vendored as a read-only conformance fixture; `bundles/example/`
is a tiny bundle written by okbrain itself.

| Doc | What it is |
|---|---|
| `CLAUDE.md` | North Star, invariants, iron rules (always-loaded orientation) |
| `CONTEXT.md` | Living design reference (how it works and why) |
| `ROADMAP.md` | Granular tasks, bug log, backlog, progress log |
| `skills/` | Agent skills: capture, ingest, enrich, query, daily-note, link-suggest |

## License

MIT — see `LICENSE`. `bundles/acme_retail/` is Apache-2.0 (upstream OKF sample).
