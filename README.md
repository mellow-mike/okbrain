# okbrain

[![CI](https://github.com/mellow-mike/okbrain/actions/workflows/ci.yml/badge.svg)](https://github.com/mellow-mike/okbrain/actions/workflows/ci.yml)
[![Platforms: macOS, Linux, Windows](https://img.shields.io/badge/platforms-macOS%20%7C%20Linux%20%7C%20Windows-4c6ef5?style=flat)](.github/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-4c6ef5?style=flat)](LICENSE)

A local-first second brain and a review workspace for recoverable coding requests.

Your knowledge lives in a portable Markdown and YAML bundle compatible with
[Open Knowledge Format v0.2](https://github.com/GoogleCloudPlatform/open-knowledge-format).
Capture notes from the web and AI conversations, map how they relate, and ask
questions with sources. Use a local model, a provider API key, or an eligible
ChatGPT plan. The macOS app, local web app, CLI, and MCP server share the same
knowledge store. You can rebuild search and the graph from the files.

Start on **Home** with a note, or open **Sources** to preview and import
exports as private drafts. Search, review, and build focused maps offline.
When using a ChatGPT plan, review the excerpts in **Ask with ChatGPT** before
sending them.

Open **Coding** to register a permitted workspace, preview source excerpts,
send a Pi Durable request, and inspect, resume, or review its result. Save
project request presets for recurring work. The VS Code and Cursor extension
previews saved editor files or project presets and opens run results for
review. Connect a GitHub remote from Coding to review repository activity and
hand off accepted work.
See the [personal guide](docs/PERSONAL.md) and [coding guide](docs/CODING.md).

> [!NOTE]
> Download the macOS app and editor extension from a successful [CI run](https://github.com/mellow-mike/okbrain/actions/workflows/ci.yml).
> Use **File → Open Brain Folder** in the app and **Extensions → Install from VSIX** in the editor.
> [Packaging](packaging/README.md) covers local installation and builds. The [roadmap](ROADMAP.md) tracks release and deployment verification.

## Why

Most knowledge tools own your data in a proprietary store and rent you access
to it. okbrain inverts that: the markdown *is* the database.

- **Portable knowledge.** `okb rebuild` reconstructs the keyword and graph
  index from Markdown. `okb embed` builds the optional vector cache.
- **Provenance, trust, and lifecycle are first-class.** Every write records
  who changed it (`generated`), reviews become `verified` events with derived
  trust tiers (unverified → machine-confirmed → human-reviewed), concepts carry
  a `status` and a `stale_after` date, and clips, feeds, and the enrichment
  agent cite their `sources` in frontmatter — all of it OKF v0.2, readable by
  any other OKF tool. `okb upgrade` migrates older bundles.
- **Local knowledge.** Notes, the graph, keyword search, and conversation
  imports work offline. Choose when a hosted model receives your context.
- **Shared knowledge operations.** The CLI, macOS app, local web app, and
  MCP server share the knowledge operations. Local app routes handle selected
  file uploads, account consent, and coding sessions.
- **Hybrid retrieval.** Keyword (FTS5/BM25) + semantic vectors (sqlite-vec) +
  graph expansion + typed-edge relational recall, fused into one ranking.
  `okb ask` answers with citations post-verified against your actual notes.
- **Explicit access.** MCP exposes read tools by default. Trusted clients can
  write with their own attribution, and brains can be mounted read-only.

## See it work

Write a note:

```bash
okb new note "Spaced repetition" "Reviewing material at increasing intervals" \
  --tags pkm,method \
  --body 'Retrieval effort is what strengthens memory — see [Zettelkasten](zettelkasten.md).'
```

```text
created notes/spaced-repetition
```

A real file you can open in any editor — frontmatter scaffolded, the change
attributed to you, the relative link rewritten to bundle-absolute, `index.md`
and `log.md` updated alongside:

```markdown
---
type: note
title: Spaced repetition
description: Reviewing material at increasing intervals
tags:
  - pkm
  - method
generated:
  by: human:you
  at: 2026-09-03T12:53:02Z
---
Retrieval effort is what strengthens memory — see [Zettelkasten](/notes/zettelkasten.md).
```

Then index and search it:

```bash
okb index
okb search "atomic notes"
```

```text
indexed 5, skipped 0, removed 0, edges 8

0.016  notes/zettelkasten — Zettelkasten  [keyword]
0.004  notes/evergreen-notes — Evergreen notes  [graph]
0.004  notes/spaced-repetition — Spaced repetition  [graph]
0.004  projects/okbrain — okbrain  [graph]
0.004  references/open-knowledge-format — Open Knowledge Format  [graph]
```

The bracketed tag is the retrieval arm that surfaced each hit — the new note
never mentions "atomic notes", but the link it just made to Zettelkasten pulled
it in. Run `okb embed` and `[vector]` joins the mix. Every command takes
`--json`.

## Install

Requires [Bun](https://bun.sh) ≥ 1.1. Build the binary:

```bash
git clone https://github.com/mellow-mike/okbrain && cd okbrain
bun install
bun run build
```

That produces `bin/okb` plus the `sqlite-vec` extension beside it. Keep the two
together — `okb` looks for `vec0.{so,dylib,dll}` next to its own executable —
then put the directory on your `PATH` and check it works:

```bash
export PATH="$PWD/bin:$PATH"
okb --version
```

For a self-contained, fully offline package of this machine's build, run
`bun run package`: it writes `dist/okb-<version>-<os>-<arch>.tar.gz` (or
`.zip` on Windows) with the binary, extension, README, license, and user
guides. Unpack it anywhere and put the directory on `PATH`.

<details>
<summary>macOS: enabling vector search</summary>

`bun:sqlite` links Apple's system SQLite, which cannot load extensions. Install
an extension-capable build once and okbrain finds it automatically:

```bash
brew install sqlite
```

Or point `$OKB_SQLITE_LIB` at any real `libsqlite3.dylib`. Everything except
vector search works without this.

</details>

<details>
<summary>Prebuilt binaries and package managers</summary>

<!-- TODO: no release tagged yet (version 0.1.0, zero GitHub releases).
     Revisit once the first tag ships. -->

No release has been tagged yet. Tagging `vX.Y.Z` triggers
[`release.yml`](.github/workflows/release.yml), which cross-compiles five
targets (linux-x64/arm64, darwin-x64/arm64, windows-x64), pairs each with its
platform's `vec0`, and publishes archives plus `SHA256SUMS.txt` to GitHub
Releases — the same archive layout `bun run package` builds locally. Homebrew
and Scoop manifest templates for running your own tap or bucket live in
[`packaging/`](packaging/); artifacts are unsigned.

</details>

## Quick start

Try it against the example bundle that ships with the repo, without touching
your own notes:

```bash
okb --bundle bundles/example index
okb --bundle bundles/example stats
```

```text
4 concepts, 7 links (0 typed), 4 tags
by type:  note 2, project 1, reference 1
top tags: pkm 2, format 1, method 1, software 1
orphans 0, inbox 0, never reviewed 4, stale 0 (>180d), past stale_after 0
status:   draft 0, stable 4, deprecated 0
trust:    unverified 4, machine-confirmed 0, human-reviewed 0
freshest 2026-07-05, oldest 2026-07-05
```

`bundles/acme_retail` is the OKF project's own v0.2 showcase (metrics,
policies, an attested computation), vendored as a read-only conformance
fixture — `okb --bundle bundles/acme_retail doctor` shows the trust and
lifecycle signals on a bundle okbrain did not write.

Then start your own brain. It's just a directory:

```bash
mkdir ~/brain && cd ~/brain
okb init --actor human:you                  # persists this bundle as the default
okb capture "An idea I had on the train"    # → inbox/, zero friction
okb import ~/old-notes                      # map existing markdown into concepts
okb index && okb search "train"
```

`okb init` is non-interactive: with an API key exported (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, …) it selects that provider, with none it configures a local
model. Keys are read from the environment only, never written to disk. The
**actor** is the identity stamped on everything you write (`generated.by`,
`verified.by`); it defaults to `human:<os user>`.

## Commands

`okb help` lists everything; `okb help <command>` shows one command's options.
Global flags: `--json`, `--bundle <path>`, `--brain <name>`, `--version`.

| Area | Commands |
|---|---|
| author | `new` · `capture` · `import` · `write` · `rm` |
| ingest | `clip` · `rss` · `enrich` · `inbox` · `inbox read` |
| AI accounts | `chatgpt connect` · `chatgpt status` · `chatgpt use` · `chatgpt models` · `chatgpt disconnect` · `import-conversations` |
| retrieve | `search` · `ask` · `read` · `list` |
| ChatGPT plan | `ask-plan` |
| graph | `graph` · `path` · `orphans` · `graph-data` · `export-viz` · `links suggest` · `links accept` |
| review | `review` · `review done` · `review snooze` |
| claims | `take` · `resolve` · `calibrate` |
| maintain | `index` · `rebuild` · `embed` · `doctor` · `upgrade` · `stats` · `jobs` · `sync` |
| serve | `serve` · `bookmarklet` · `mcp` |
| coding | `code context` · `code run` · `code status` |
| setup | `init` · `brains` · `version` |

### Provenance and trust

```bash
okb read notes/spaced-repetition --json      # frontmatter + body + derived signals (status, trust, stale)
okb list --detail --status draft             # every concept with its signals; filter by type/tag/status
okb write notes/x --status deprecated        # lifecycle: draft | stable | deprecated
okb write notes/x --stale-after 2026-12-31T00:00:00Z --sources https://…,/notes/y.md
okb review done 1                            # records `verified: [{ by: human:you, at: … }]`
okb doctor                                   # conformance + trust/lifecycle summary; flags v0.1 leftovers
okb upgrade --dry-run && okb upgrade         # timestamp → generated, # Citations → sources, …
```

Clips and feed items record the page under `sources` (with byline and
publication date as credibility signals); the enrichment agent must cite its
pages the same way and is stamped `okb-enrich/<model>`. Provenance entries
that point at other concepts become `cites` edges in the graph.

### Asking questions

```bash
okb embed                                        # incremental; resumes if interrupted
okb ask "what did I conclude about spaced repetition?"
```

`ask` retrieves across every arm, packs the best concepts into a prompt, and
verifies each citation against your bundle before printing it — a concept id
the model invented is never shown as a source. `--profile lean|balanced|max`
trades recall against cost (`lean` keeps a local model comfortable).

For eligible ChatGPT accounts, sign in with `okb chatgpt connect`, then use
`okb ask-plan "What did I conclude about spaced repetition?"`. `ask-plan`
uses local keyword and graph retrieval and sends the selected context to
OpenAI for synthesis. You can also bring exported ChatGPT and Claude
conversations into your brain as private drafts. [Personal guide](docs/PERSONAL.md)

### The other two surfaces

```bash
okb serve --open         # web app on http://127.0.0.1:6522, loopback only
okb bookmarklet          # a clip-this-page bookmarklet for your browser
okb mcp                  # stdio MCP, read-only tools
okb mcp --trusted        # enable writes for a client you trust
```

The GUI is a full surface over the same operations: a Home page (brain at a
glance, quick capture, today's review queue, inbox, recent changes, one-click
conformance check), Browse (every concept with status, trust tier, staleness),
a Concept reader (provenance, footnote attribution, links to / cited by,
verify / deprecate / delete), an editor with the v0.2 fields and a sources
editor, the live graph, search, ask, review, inbox, add (capture, clip, feeds,
import, the bookmarklet), Sources (conversation previews and private draft
import), claims, stats, and settings (your actor, providers,
sync, enrichment, maintenance including jobs and the v0.2 upgrade, MCP setup,
a brain switcher). It is dark-first ink on a ground — colour only marks
state and concept types, your notes read in Literata while okbrain speaks in
Recursive — and its fonts ship inside the binary, so it needs no network.
Every request is token-gated, and rendered markdown never executes HTML from
a clipped page. MCP tool schemas are generated from the
same contract as the CLI; writes made over MCP are attributed to the connected
client, and admin operations (`rebuild`, `init`, `serve`) never appear there.
`okb mcp --http` serves Streamable HTTP on port 6523.

### Sync and maintenance

```bash
okb sync                 # git init + commit, and pull/push when origin is set
okb review               # today's "worth another look" queue, with reasons
okb jobs                 # one pass: index, embed, rss, review, doctor
```

Multi-device sync uses Git. On a second device, open **Settings → Brain folders
→ Restore from GitHub** to download a shared brain and rebuild its local search
index. Directories named `db_only/` stay on disk and in the index but out of Git
when using `okb sync`. Static HTML exports also
omit these notes by default. The review queue ranks concepts past their
`stale_after` first, nudges drafts, and never queues deprecated ones.

In the Mac or web app, use **Settings → Maintenance → Schedule maintenance**
to run selected jobs while the app server is open. RSS and embedding schedules
require separate approval of the current settings. `okb jobs` also runs a
single pass for scripts using cron, launchd, or Task Scheduler. Use **Enrich**
for a deliberate AI web pass with limits on depth, hosts, paths, and pages.

## Configuration

`config.json` lives in your per-user config directory — `~/.config/okbrain` on
Linux and macOS, `%APPDATA%\okbrain` on Windows. `okb init` writes it and it's
safe to hand-edit; unknown keys survive rewrites.

| Key | What it controls |
|---|---|
| `defaultBundle` | Bundle used when neither `--bundle` nor `$OKB_BUNDLE` is set |
| `actor` | Who your writes are attributed to (`human:<id>`); default `human:<os user>` |
| `ai.*` | Chat / embed / rerank provider, model, and base URL |
| `retrieval.profile` | Default retrieval profile: `lean`, `balanced`, or `max` |
| `review.*` | Queue size, cooldown days, scoring weights (incl. `expired`, `draft`) |
| `clip.*` | Body size cap, default tags, stripped query params, auto-tagging |
| `rss.feeds` | Feeds pulled by `okb rss` with no URL, and by `okb jobs` |
| `serve.open` | Open the browser when `okb serve` starts |
| `brains` | Named bundle mounts and their read-only policy |

`brains` is how you run more than one: name each bundle, then address it with
`--brain work`, `$OKB_BRAIN`, or the GUI's sidebar switcher. A mount marked
`readonly` refuses every write and admin operation on all three surfaces
alike.

Environment variables override the config file, and flags override both:

| Variable | Purpose |
|---|---|
| `OKB_BUNDLE`, `OKB_BRAIN` | Active bundle or named mount |
| `OKB_AI_PROVIDER` | Provider for every capability it supports |
| `OKB_{CHAT,EMBED,RERANK}_{PROVIDER,MODEL,BASE_URL}` | Per-capability overrides |
| `OKB_SQLITE_VEC`, `OKB_SQLITE_LIB` | Explicit `vec0` / SQLite library paths |
| `OKB_LOG_LEVEL`, `OKB_LOG_JSON` | Logging verbosity and format |
| `{ANTHROPIC,OPENAI,GEMINI,OPENROUTER,VOYAGE}_API_KEY` | Hosted-provider keys; local models need none |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Runtime failure — missing bundle, engine or AI error, `doctor` found problems, a job failed |
| `2` | Usage error — unknown flag, missing or invalid argument |

`okb doctor` returning `1` on conformance findings makes it usable as a CI gate
over your notes.

## How it works

```mermaid
flowchart TD
    CLI["CLI · okb"] --> OPS
    GUI["GUI · okb serve"] --> OPS
    MCP["MCP · okb mcp"] --> OPS
    OPS["Operations contract<br/>read / write / admin + trust + actor"]
    OPS --> BUNDLE[("OKF v0.2 bundle<br/>markdown + git")]
    OPS --> ENGINE[("Engine<br/>SQLite + sqlite-vec + FTS5")]
    OPS --> AI["AI gateway<br/>local or hosted"]
    OPS --> PLAN["ChatGPT plan<br/>local sign-in"]
    OPS --> PI["Pi Durable<br/>coding sessions and transcripts"]
    BUNDLE -.->|okb rebuild| ENGINE
```

Surfaces only call operations; operations read and write the bundle and refresh
the engine; the engine is always reconstructible from the bundle. The engine
sits behind an interface, so Postgres can drop in later without canonical state
ever living behind it.

## Documentation

| Doc | What it covers |
|---|---|
| [CONTEXT.md](CONTEXT.md) | Living design reference — how each component works and why |
| [ROADMAP.md](ROADMAP.md) | Granular tasks, bug log, backlog, progress log |
| [AGENTS.md](AGENTS.md) | Architecture and working rules for contributors |
| [Product plan](docs/PRODUCT-PLAN.md) | Personal and enterprise direction |
| [Personal guide](docs/PERSONAL.md) | Subscription accounts, conversation imports, and data sharing |
| [Coding guide](docs/CODING.md) | Run and recover local Pi Durable requests |
| [skills/](skills/) | Agent skills: capture, ingest, enrich, query, daily-note, link-suggest |
| [bundles/](bundles/README.md) | The example bundle and the vendored OKF v0.2 sample |
| [packaging/](packaging/) | Release flow, offline packaging, Homebrew and Scoop manifests, signing notes |

## Development

```bash
bun install
bun run okb <args>     # run the CLI from source
bun run typecheck      # tsc --noEmit, strict
bun test               # test suite with local provider fixtures
bun run build          # bin/okb + vec0 beside it
bun run package        # offline release archive for this machine → dist/
```

CI runs typecheck and tests on macOS, Linux, and Windows with a pinned Bun.
Read [AGENTS.md](AGENTS.md) for contributor guidance and update the design,
roadmap, and user guides when behavior changes.

## License

[MIT](LICENSE) © mellow-mike. `bundles/acme_retail/` is Apache-2.0 (upstream
OKF sample).
