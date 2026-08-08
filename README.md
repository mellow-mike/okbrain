# okbrain

[![CI](https://github.com/mellow-mike/okbrain/actions/workflows/ci.yml/badge.svg)](https://github.com/mellow-mike/okbrain/actions/workflows/ci.yml)
[![Platforms: macOS, Linux, Windows](https://img.shields.io/badge/platforms-macOS%20%7C%20Linux%20%7C%20Windows-4c6ef5?style=flat)](.github/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-4c6ef5?style=flat)](LICENSE)

A self-hosted personal knowledge manager whose entire database is plain markdown in git.

Your notes are a conformant [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf)
(OKF) bundle — one markdown file per idea, YAML frontmatter, links between
them. Search, vectors, and the graph are a **derived cache** that rebuilds from
those files with one command. Delete okbrain tomorrow and your knowledge is
still there, readable by any editor you like.

> [!NOTE]
> Pre-1.0 and not yet published to a package registry, so installing means a
> one-command build from source. Stages 0–5 of the [roadmap](ROADMAP.md) are
> complete: CLI, local web GUI, and MCP server all work today, with 398 tests
> green on macOS, Linux, and Windows.

## Why

Most knowledge tools own your data in a proprietary store and rent you access
to it. okbrain inverts that: the markdown *is* the database.

- **No lock-in, provable.** `okb rebuild` deletes the index and reconstructs it
  from the markdown. Anything the database knows, the files already said.
- **Runs fully offline.** Six runtime dependencies, one compiled binary, no
  Docker, no daemon, no mandatory network. AI is opt-in and never implicit — no
  command spends tokens unless you asked it to.
- **One contract, three surfaces.** 38 operations defined once drive the CLI
  (`okb`), a local web app (`okb serve`), and an MCP server (`okb mcp`) so your
  own agents can query your brain as a tool.
- **Hybrid retrieval.** Keyword (FTS5/BM25) + semantic vectors (sqlite-vec) +
  graph expansion + typed-edge relational recall, fused into one ranking.
  `okb ask` answers with citations post-verified against your actual notes.
- **Fail-closed trust.** MCP exposes 15 read-only tools by default and 29 only
  when you pass `--trusted`; brains can be mounted read-only.

Not for you if you want mobile apps, hosted sync, WYSIWYG editing, or
multi-user collaboration. This is a single-user tool for a laptop.

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

A real file you can open in any editor — frontmatter scaffolded, the relative
link rewritten to bundle-absolute, `index.md` and `log.md` updated alongside:

```markdown
---
type: note
title: Spaced repetition
description: Reviewing material at increasing intervals
timestamp: 2026-08-08T12:53:02Z
tags:
  - pkm
  - method
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
okb help
```

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

<!-- TODO: no release tagged yet (v0.0.0, zero GitHub releases). Revisit once
     the first tag ships. -->

No release has been tagged yet. Tagging `vX.Y.Z` triggers
[`release.yml`](.github/workflows/release.yml), which cross-compiles five
targets (linux-x64/arm64, darwin-x64/arm64, windows-x64), pairs each with its
platform's `vec0`, and publishes archives plus `SHA256SUMS.txt` to GitHub
Releases. Homebrew and Scoop manifest templates for running your own tap or
bucket live in [`packaging/`](packaging/); artifacts are unsigned.

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
orphans 0, inbox 0, never reviewed 4, stale 0 (>180d)
freshest 2026-07-05, oldest 2026-07-05
```

Then start your own brain. It's just a directory:

```bash
mkdir ~/brain && cd ~/brain
okb init                                    # persists this bundle as the default
okb capture "An idea I had on the train"    # → inbox/, zero friction
okb import ~/old-notes                      # map existing markdown into concepts
okb index && okb search "train"
```

`okb init` is non-interactive: with an API key exported (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, …) it selects that provider, with none it configures a local
model. Keys are read from the environment only, never written to disk.

## Commands

`okb help` lists everything; `okb help <command>` shows one command's options.
Global flags: `--json`, `--bundle <path>`, `--brain <name>`.

| Area | Commands |
|---|---|
| author | `new` · `capture` · `import` · `write` |
| ingest | `clip` · `rss` · `enrich` · `inbox` · `inbox read` |
| retrieve | `search` · `ask` · `read` · `list` |
| graph | `graph` · `path` · `orphans` · `graph-data` · `export-viz` · `links suggest` · `links accept` |
| review | `review` · `review done` · `review snooze` |
| claims | `take` · `resolve` · `calibrate` |
| maintain | `index` · `rebuild` · `embed` · `doctor` · `stats` · `jobs` · `sync` |
| serve | `serve` · `bookmarklet` · `mcp` |
| setup | `init` · `brains` |

### Asking questions

```bash
okb embed                                        # incremental; resumes if interrupted
okb ask "what did I conclude about spaced repetition?"
```

`ask` retrieves across every arm, packs the best concepts into a prompt, and
verifies each citation against your bundle before printing it — a concept id
the model invented is never shown as a source. `--profile lean|balanced|max`
trades recall against cost (`lean` keeps a local model comfortable).

### The other two surfaces

```bash
okb serve                # web app on http://127.0.0.1:6522, loopback only
okb bookmarklet          # a clip-this-page bookmarklet for your browser
okb mcp                  # stdio MCP, 15 read-only tools
okb mcp --trusted        # 29 tools including writes — only for clients you trust
```

The GUI covers graph, editor, search, ask, review queue, inbox, claims, stats,
and settings, token-gated on every request. MCP tool schemas are generated from
the same contract as the CLI, and admin operations (`rebuild`, `init`, `serve`)
never appear there. `okb mcp --http` serves Streamable HTTP on port 6523.

### Sync and maintenance

```bash
okb sync                 # git init + commit, and pull/push when origin is set
okb review               # today's "worth another look" queue, with reasons
okb jobs                 # one pass: index, embed, rss, review, doctor
```

Multi-device sync **is** git — add an `origin` remote, and the other machine
runs `okb index` after cloning. Directories named `db_only/` stay on disk and
in the index but out of git.

Schedule `okb jobs` with cron, launchd, or Task Scheduler; there is no daemon,
and its embed step skips itself until you have run `okb embed` once, so a
nightly run can't start spending on a hosted provider behind your back.
Deliberate AI enrichment is its own command — `okb enrich` turns an LLM loose
on the web inside hard caps on depth, hosts, paths, and pages, every one of
them enforced in the tool rather than the prompt.

## Configuration

`config.json` lives in your per-user config directory — `~/.config/okbrain` on
Linux and macOS, `%APPDATA%\okbrain` on Windows. `okb init` writes it and it's
safe to hand-edit; unknown keys survive rewrites.

| Key | What it controls |
|---|---|
| `defaultBundle` | Bundle used when neither `--bundle` nor `$OKB_BUNDLE` is set |
| `ai.*` | Chat / embed / rerank provider, model, and base URL |
| `retrieval.profile` | Default retrieval profile: `lean`, `balanced`, or `max` |
| `review.*` | Queue size, cooldown days, scoring weights |
| `clip.*` | Body size cap, default tags, stripped query params, auto-tagging |
| `rss.feeds` | Feeds pulled by `okb rss` with no URL, and by `okb jobs` |
| `brains` | Named bundle mounts and their read-only policy |

`brains` is how you run more than one: name each bundle, then address it with
`--brain work` or `$OKB_BRAIN`. A mount marked `readonly` refuses every write
and admin operation on all three surfaces alike.

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
    OPS["Operations contract<br/>38 ops · read / write / admin + trust"]
    OPS --> BUNDLE[("OKF bundle<br/>markdown + git")]
    OPS --> ENGINE[("Engine<br/>SQLite + sqlite-vec + FTS5")]
    OPS --> AI["AI gateway<br/>local or hosted"]
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
| [CLAUDE.md](CLAUDE.md) | North Star, invariants, and working rules |
| [skills/](skills/) | Agent skills: capture, ingest, enrich, query, daily-note, link-suggest |
| [packaging/](packaging/) | Release flow, Homebrew and Scoop manifests, signing notes |

## Development

```bash
bun install
bun run okb <args>     # run the CLI from source
bun run typecheck      # tsc --noEmit, strict
bun test               # 398 tests, no network
bun run build          # bin/okb + vec0 beside it
```

CI runs typecheck and tests on macOS, Linux, and Windows; a change isn't done
until it's green on all three. Contributions are welcome — open an issue before
a large change, and read [CLAUDE.md](CLAUDE.md) first for the invariants a
patch has to hold. Every bug fix lands with a test that fails before and passes
after, and behavior changes update `CONTEXT.md` and `ROADMAP.md` in the same
commit.

## License

[MIT](LICENSE) © mellow-mike
