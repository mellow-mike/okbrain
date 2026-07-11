# Feature framework: Resurface — review queue & resurfacing engine

Status: proposed. Destination: `docs/features/FEATURE-RESURFACE.md`. The
kickoff prompt at the bottom has the agent merge this into `CONTEXT.md` /
`ROADMAP.md` before building. Binding rules: `CLAUDE.md`.

## Why

The default fate of a PKM is write-only memory: notes go in, nothing comes
back, the graph rots invisibly. Resurface makes stored knowledge return on its
own — a small daily queue of concepts worth another look, each with a stated
reason — and gives the tool a habit-forming "home screen". Deterministic, zero
new dependencies, fully offline: the cheapest high-leverage feature available.

## Design

### Scoring (deterministic, no AI required)

Nightly (or on demand) score every concept from data the engine already holds:

| Signal | Trigger | Default weight |
|---|---|---|
| staleness | `min(days_since_timestamp, 365)/365` | 1.0 |
| orphan | degree == 0 | 2.0 |
| stale hub | in-degree ≥ 3 and stale > 90d | 1.5 |
| neighbor activity | a neighbor changed ≤ 7d, self stale > 30d | 1.0 |
| inbox | has `inbox` tag (Clip synergy) | 1.5 |
| anniversary | created ≈ n·365d ago (±1d) | 0.5 |

Exclusions: `last_reviewed` within cooldown (default 30d) or snoozed. Weights,
cooldown, and queue size (default 5) live under `review.*` config. Every queue
item carries human-readable reasons ("orphan for 84d", "cited by 9, untouched
6mo") — the reasons are the UX.

### State — what survives a rebuild

- **Reviewed** is user knowledge → bundle. On "done", the writer sets a
  `last_reviewed` (ISO 8601) frontmatter key. This is an okbrain extension key:
  OKF-safe because consumers must tolerate and we preserve unknown keys; it is
  *not* `timestamp` (which means content change).
- **Snooze** is an ephemeral scheduling preference → DB-only (`review_state`
  table). Lost on `okb rebuild` by design; documented, acceptable.
- The computed queue is a DB cache, recomputed freely.

### Ops & surfaces

- `review_queue` (read) → top-N with scores + reasons.
- `review_action` (write) → `done` (stamp `last_reviewed`) | `snooze --days N`.
- CLI: `okb review` (numbered list with reasons, `--json`),
  `okb review done <id|n>`, `okb review snooze <id|n> [--days 7]`. Open/edit is
  just the id — the bundle is plain markdown.
- GUI (Stage 3): Review view — card stack for today's queue; actions done /
  snooze / open / suggest-links.
- Cron (Stage 4): nightly job recomputes the queue; the daily-note skill embeds
  a "worth revisiting" section so the morning note surfaces it.
- Optional AI garnish (Stage 2+, off in `lean`): one line per item connecting
  it to recent captures. Never required for the feature to work.

### Non-goals (v1)

No spaced-repetition scheduling (SM-2), no flashcard generation, no archive
action (moving files rewrites inbound links — Gardener territory, backlogged).

### Dependencies & timing

Needs Stage 1 (timestamps in writer, graph degrees in engine). Queue + CLI can
ship immediately after; GUI card stack folds into Stage 3; cron wiring into
Stage 4. Zero new dependencies.

## Roadmap insert (paste as a feature block after Stage 1)

```
## Feature: Resurface — review queue (after Stage 1)
- [ ] F-B.1 `core/review/score.ts` — signals + weighted score + reason strings; config `review.*`
- [ ] F-B.2 Engine: degree/in-degree + last-change lookups; `review_state` table (snooze); queue cache
- [ ] F-B.3 Ops: `review_queue` (read), `review_action` (write: done|snooze); `last_reviewed` via conformance writer
- [ ] F-B.4 CLI: `okb review`, `okb review done`, `okb review snooze`; `--json`
- [ ] F-B.5 Scoring tests: each signal in isolation; exclusion windows; deterministic ordering on a fixture bundle
- [ ] F-B.6 GUI Review card stack (fold into Stage 3.2)
- [ ] F-B.7 Cron: nightly recompute (fold into Stage 4.5); daily-note skill section
- [ ] F-B.8 Optional AI one-liner per item (off in lean)
```

## Acceptance criteria

1. On a fixture bundle with a known shape (one orphan, one stale hub, one
   fresh note, one inbox clip), `okb review` returns the expected order with
   correct reasons.
2. `done` writes `last_reviewed`, the doc still passes `okb doctor`, unknown
   keys elsewhere untouched; the item leaves the queue for the cooldown.
3. `snooze` hides the item; after `okb rebuild` the snooze is gone (documented)
   but `last_reviewed` persists.
4. Whole feature works offline with no AI provider configured.
5. CI green on macOS/Linux/Windows.

## Open questions (small; agent decides + records)

- Should `done` optionally also append a `**Review**` line to `log.md`, or is
  the frontmatter key alone enough? (Default: key only — less churn.)
- Queue tie-breaking (suggest: older `timestamp` first, then id) — just make it
  deterministic.

## Kickoff prompt

```
Add the Resurface feature to okbrain. First read CLAUDE.md, CONTEXT.md,
ROADMAP.md, docs/context/REFERENCES.md, and
docs/features/FEATURE-RESURFACE.md (this framework).

MERGE DOCS FIRST (same-change rule):
- CONTEXT.md: add a "Resurface — review queue" section (scoring table,
  last_reviewed frontmatter extension, snooze-is-DB-only rationale); add a
  Decisions Log entry for the state-representation choice.
- ROADMAP.md: insert the F-B block from the framework after Stage 1; add a
  Progress Log line.

THEN BUILD in F-B order. Gate: requires the Stage-1 writer and engine degree
queries — finish those first if missing. Hold the iron rules: efficient code
(this feature should be small — a scorer, two ops, CLI glue; resist
abstraction), bugs fix-or-log with regression tests, cross-platform, captured
test/typecheck output with real exit codes.

Correctness notes: `last_reviewed` writes go through the conformance writer and
must not touch `timestamp` or other keys; scoring must be deterministic (fixed
tie-break) so tests are stable; everything must run with zero AI providers
configured.

End with the updated ROADMAP and a one-line summary of what shipped and what's
next.
```
