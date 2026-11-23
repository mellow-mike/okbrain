# Open items handoff (2026-11-23)

This plan covers every open roadmap item after the 2026-11-23 project review.
It follows the maintainer's answers recorded in the
[CONTEXT.md Decisions Log](../../CONTEXT.md#decisions-log). Read
[AGENTS.md](../../AGENTS.md), the [product plan](../PRODUCT-PLAN.md), and the
[roadmap](../../ROADMAP.md) first.

## State at review

- `bun install --frozen-lockfile` and `bun run typecheck` pass. `bun test` ran
  746 tests with 0 failures. The 8 skips depend on PostgreSQL, Docker, or the
  platform, and CI covers them in dedicated jobs.
- CI on `main` (run 45098829343) is green. There are no open pull requests or
  issues.
- Every Stage 7 and Stage 8 item is done except two blocked on external access.
  `v0.1.0` has not been tagged, and the release workflow publishes ad hoc
  signed Mac apps and CLI archives with no publisher signature.

## Decisions

| Question | Answer | Effect |
| --- | --- | --- |
| How should v0.1.0 ship? | Sign first, then tag | WP1 runs before the tag |
| Which signatures? | GPG on `SHA256SUMS.txt` and GitHub attestations | macOS Developer ID and Windows Authenticode stay deferred |
| Where does signing run? | In the release workflow | Credentials go in a protected `release` environment |
| Distribution channels | GitHub Releases only. Homebrew, Scoop, VS Code Marketplace, and Open VSX are 1.0 candidates | Backlog entry only |
| Live provider evaluation | Defer, not a blocker | Stays `[!]` with no work now |
| Intended enterprise host verification | Defer, not a blocker | Stays `[!]` with no work now |
| Usability measurement | Local metrics plus a session script | WP2 |
| Concept type vocabulary | Free-form with starter suggestions | Recorded in CONTEXT.md, no code |

Assumption: the `v0.1.0` tag waits only for WP1. WP2 can ship in a later
release. Confirm with the maintainer before holding the tag for WP2.

## WP1: Signed v0.1.0 release

**Goal.** Each tagged release publishes the existing assets plus a detached
GPG signature, `SHA256SUMS.txt.asc`, over the checksum manifest, and a GitHub
build provenance attestation for every asset. A dry run proves the signing
path without publishing anything.

### Maintainer prerequisites

Only the maintainer can do these. Never put key material or passphrases in
chat, commits, or logs.

1. **Create the release key.** Generate a dedicated Ed25519 key with a
   certify-only primary key, a signing subkey, and an expiry of about two
   years. The maintainer chooses the user ID. Export the public key in armored
   form for `packaging/okbrain-release-key.asc` and share the primary key
   fingerprint for pinning. For CI, export only the signing subkey's secret by
   naming the **signing subkey's** fingerprint with a trailing `!`
   (`gpg --armor --export-secret-subkeys <SIGNING-SUBKEY-FPR>!`), so a CI leak
   cannot certify new keys. With the primary fingerprint, `!` selects the
   primary key alone and the export cannot sign ("No secret key"). Signing
   with `--local-user <primary FPR>` still selects the subkey.
2. **Create the `release` environment** in the repository settings. Add the
   maintainer as a required reviewer, and allow deployments from `v*` tags and
   the `main` branch (the dry run needs `main`). Add the environment secrets
   `OKB_RELEASE_GPG_PRIVATE_KEY` (the armored subkey export) and
   `OKB_RELEASE_GPG_PASSPHRASE`.
3. **Push the tag** after WP1 merges and a dry run passes (step 9). An agent
   pushes a tag only with the maintainer's explicit approval in that session.

### Implementation

1. **Commit the public key** at `packaging/okbrain-release-key.asc`. Pin its
   primary fingerprint as a constant in the new signing script and print it
   in `packaging/README.md`.
2. **Add `scripts/release-signing.ts`**, following `scripts/mac-signing.ts`
   and `scripts/windows-signing.ts`:
   - `sign`: create a temporary `GNUPGHOME` (mode `0700`) and import
     `OKB_RELEASE_GPG_PRIVATE_KEY` through stdin. Run
     `gpg --batch --yes --pinentry-mode loopback --passphrase-fd 0 --local-user <pinned FPR> --armor --detach-sign --output dist/SHA256SUMS.txt.asc dist/SHA256SUMS.txt`
     with the passphrase on stdin. Remove the home directory in `finally`.
   - `verify`: in a fresh `GNUPGHOME`, import the committed public key and run
     `gpg --batch --status-fd 1 --verify`. Require a `VALIDSIG` line whose
     primary fingerprint equals the pinned constant, and refuse `EXPKEYSIG`,
     `REVKEYSIG`, `BADSIG`, and missing status lines. This catches a secret
     that does not match the published key.
   - Use argument-array `Bun.spawn` calls, check every exit status, and never
     log the environment. Export pure helpers (argument construction and
     status parsing) that take the key path and fingerprint as parameters, so
     tests can inject them.
3. **Extend `scripts/release-assets.ts`** with a `verify-signed` mode. It
   expects the current asset set plus `SHA256SUMS.txt.asc`: a non-empty
   armored signature of at most 8 KiB. Any other extra file is still refused.
   Leave `assemble` and `verify` unchanged.
4. **Update `.github/workflows/release.yml`:**
   - Add a `workflow_dispatch` trigger. A dispatch is always a dry run.
   - `validate-tag`: on a tag push, match the tag as today. On a dispatch,
     require `github.ref == 'refs/heads/main'`. The job always runs, so the
     `needs` chain stays simple.
   - Add a `sign` job (`needs: assemble`, `environment: release`,
     `permissions: contents: read`). It downloads `okbrain-release-assets`,
     runs `release-assets.ts verify`, `release-signing.ts sign`,
     `release-signing.ts verify`, then `release-assets.ts verify-signed`, and
     uploads `okbrain-signed-release-assets`. The environment approval gates
     both dry runs and tag runs.
   - `release` job: `needs: sign`, `if: github.event_name == 'push'`, and
     permissions `contents: write`, `id-token: write`, `attestations: write`.
     Download the signed set and run `verify-signed` and `release-signing.ts
     verify` again. Run `actions/attest-build-provenance` (pin its current
     major version) with a
     `subject-path` covering every `.tar.gz`, `.zip`, and `.vsix` plus
     `SHA256SUMS.txt`, then create the release with `dist/SHA256SUMS.txt.asc`
     added to `files`. The repository is public, so attestations need no
     extra plan.
5. **Tests:**
   - `tests/release-signing.test.ts`: status parsing cases (valid, wrong
     fingerprint, expired, revoked, bad, empty) and argument construction.
     Add an integration test with `test.skipIf(!Bun.which("gpg"))` that
     generates a throwaway key in a temporary `GNUPGHOME`, signs a sample
     manifest, and verifies it. Tampering with the manifest must fail
     verification, as must a second throwaway key.
   - `tests/release-assets.test.ts`: `verify-signed` accepts the signed set
     and refuses a missing, empty, oversized, or extra signature file. The
     existing modes refuse a stray `.asc`.
6. **Docs:**
   - `packaging/README.md`: add a **Verify a download** section. Import the
     committed key and compare the fingerprint, then run
     `gpg --verify SHA256SUMS.txt.asc SHA256SUMS.txt`. Check archives with
     `sha256sum --check --ignore-missing SHA256SUMS.txt` (`shasum -a 256 -c`
     on macOS, `Get-FileHash` on Windows), and attestations with
     `gh attestation verify <asset> --repo mellow-mike/okbrain`. Explain the
     first-launch approval for the ad hoc Mac app (already documented) and
     SmartScreen for the Windows CLI. State that publisher signing is
     deferred.
   - `README.md`: in the prebuilt binaries block, replace "artifacts are
     unsigned" with the signed-checksums and attestation wording. Replace the
     TODO comment once the tag ships.
   - `CONTEXT.md`, Packaging & distribution: update the current-truth
     paragraph ("artifacts stay unsigned until org certificates exist").
   - `docs/context/REFERENCES.md`: add GitHub artifact attestations,
     `gh attestation verify`, and the GnuPG detached-signature documentation.
   - `ROADMAP.md`: check off the v0.1.0 release items and add a Progress Log line.
7. **Verify locally.** Run `bun run typecheck`, `bun test`, and `bun run build`.
   Run the signing script end to end against a staged `dist/` using a
   throwaway key, by setting the pinned values through the test-only
   parameters, not by editing the constant.
8. **Dry run** (needs prerequisites 1 and 2). Dispatch the Release workflow on
   `main` and approve the `release` environment. Confirm that the
   `okbrain-signed-release-assets` artifact contains `SHA256SUMS.txt.asc`, that
   `gpg --verify` passes locally against the committed key, and that the run
   created no release and no attestation.
9. **Tag and check.** The maintainer runs
   `git tag -a v0.1.0 -m "okbrain 0.1.0"` on the merged `main`, pushes it, and
   approves the environment. Download every published asset, then verify the
   GPG signature, each checksum, and each attestation. Update the README
   block and the roadmap.

**Done when** the `v0.1.0` GitHub release carries the 8 assets,
`SHA256SUMS.txt`, and `SHA256SUMS.txt.asc`, all three checks pass on a
downloaded copy, and the docs describe exactly that.

## WP2: Opt-in, local-only usability sessions

**Goal.** Measure the product plan's time to first saved item and re-finding
success during facilitated sessions, with locally collected performance data
and no source-content telemetry. Covers both the web app and the Mac app,
which share the GUI.

### Constraints

- Off by default, per brain, started explicitly. Ordinary use never creates
  the store.
- Store in per-user application data, never in the bundle or Git:
  `dataDir()/usability/sessions.db`, directory mode `0700`. Call
  `ensureExtensionCapableSqlite()` before the first connection, as
  `src/core/local-usage.ts` does. Identify the brain by a SHA-256 of its real
  path, as `local-usage.ts` does.
- Never record note IDs, titles, paths, tags, bodies, query text, model
  output, or OpError messages (messages can contain paths). Record event
  kinds, offsets from session start, durations, result counts, ranks, outcome
  codes, and facilitator task labels restricted to `^[A-Za-z0-9_-]{1,16}$`.
- MCP callers never generate events and cannot drive sessions. Reuse the
  `ctx.localUsage` signal (`actor === undefined` in `src/core/context.ts`),
  and refuse the usability ops when it is false.
- Expire sessions after 30 days, matching the local note usage window. **Clear**
  deletes them at once.

### Implementation

1. **Add `src/core/usability.ts`** with the store, session lifecycle, event
   recording, and export.
   - Tables: `sessions(id, brain, started_at, ended_at, app_version, platform)`
     and `events(session_id, seq, offset_ms, kind, surface, duration_ms,
     outcome, count, rank, via, label)`. Constrain `kind`, `surface`, `via`,
     and `outcome` with `CHECK` enums. Allow one active session per brain.
   - `recordOpEvent(ctx, opName, result | error, durationMs)` returns at once
     when the store file does not exist, so the per-op cost is one `existsSync`.
2. **Add an `OpContext.surface`** (`"gui" | "cli" | "mcp"`), set by the three
   adapters.
3. **Hook `runOp`** in `src/core/operations.ts` to call `recordOpEvent` after
   each handler settles. Keep an explicit allowlist that maps op names to
   kinds in `usability.ts`:
   - `save`: capture, new and edit concept, clip, reviewed imports
     (conversations, Markdown, Notion, bookmarks), Ask draft save
   - `search`: with the result count
   - `open`: concept read
   - `browse`, `map`, `ask`, `review`
   - `error`: a failed allowlisted op, recording its OpError code only

   A test asserts that every allowlisted name exists in the registry, so
   renames cannot silently stop recording.
4. **Give the concept read op optional `via` and `rank` params**, declared in
   `operations.ts`: `via` is one of search, browse, map, link, review, direct,
   and `rank` is an integer of 1 or more. The GUI passes them from search
   results, Browse, focused maps, links, and Review. They are ignored when no
   session is active.
5. **Declare the ops** in `operations.ts`, scope `admin`, not `localOnly`, so
   the GUI can reach them through the local API:
   - `usability_session` (CLI `okb usability [status|start|stop|clear]`)
   - `usability_task` (CLI `okb usability task start <label>` /
     `okb usability task end <label> --outcome found|not_found|abandoned`)
   - `usability_export` (CLI `okb usability export`, which prints JSON)
6. **Export schema `okbrain-usability/1`:** session metadata (random ID, start
   and end, app version, platform), events, and a summary. The summary holds
   `timeToFirstSaveMs`, `firstSaveKind`, per-task duration, outcome, searches,
   opens, and first-open rank and source, re-find success rate and median
   duration, and search p50/p95 latency. Leave out the brain key.
7. **Add a Usability session card** in Settings (`src/gui/app.js`). It states
   exactly what is and is not recorded, and offers Start and Stop, a task
   label with Start task, End task with Found, Not found, and Abandoned,
   **Export JSON** through the existing `saveFile()` (the Mac app answers it
   with a native save panel), and Clear. Show a visible recording indicator
   in the status footer while a session runs. Follow the design-system copy
   rules: verb-first buttons, one primary button per view. Support keyboard
   use at 375 px.
8. **Write `docs/USABILITY.md`**, the facilitator protocol:
   - consent wording that matches the recorded fields
   - setup: a fresh empty brain, offline allowed, session started from Settings
   - tasks: T1 first capture from an empty brain. T2 import a provided
     synthetic export; add a small synthetic fixture with no real data. T3–T5
     re-find earlier notes from a description, after a filler interval. T6
     resume after closing and reopening the app.
   - keyboard-only and 375 px variants
   - a manual observation sheet with no participant identity
   - how to combine exports across participants
9. **Tests** (`tests/usability.test.ts`, plus the CLI, API, and smoke drives):
   - Ordinary ops with no session create no store.
   - Start, stop, and clear work, and a brain cannot run two active sessions.
   - GUI and CLI contexts record capture, search, and read events. An MCP
     context records nothing and is refused by the usability ops.
   - **No-content check:** seed sentinel strings in a note title, body, tag,
     ID, and search query, then assert they appear in neither the export nor
     the raw `sessions.db` bytes.
   - Summary math: first-save timing, task outcomes, medians, p50/p95.
   - Bad labels are refused, brains stay isolated, sessions expire, and a
     read-only mount behaves like `note_usage_settings`.
   - The existing registry-derived GUI wiring test passes with the new
     Settings card.
   - Extend `scripts/smoke-browser.ts`: start a session, capture, search, open
     the second result, end the task as found, and export. Parse the
     downloaded JSON for `rank: 2` and the absence of sentinels, at 375 px
     using the keyboard.
10. **Docs:** add a **Run a usability session** section to
    `docs/PERSONAL.md`. Add the store and its trust boundary to `CONTEXT.md`
    (GUI and Trust boundary sections), and check off the roadmap item with a
    Progress Log line.
11. **Verify:** run `bun run typecheck`, `bun test`, `bun run build`, and
    `bun run smoke:browser`. Run `okb usability` against a temporary brain with
    the compiled binary, and confirm nothing exists under
    `dataDir()/usability` before the first start.

**Done when** a facilitator can run the protocol in the web or Mac app, export
a summary with time to first save and re-find results, and the no-content
tests pass on all three CI operating systems.

## WP3: Deferred items (no work now)

Keep these as they are in the roadmap. Pick one up only when its entry
condition is met.

| Item | Entry condition | Starting point |
| --- | --- | --- |
| Live provider evaluation (36 Vite trials) | Approved provider account, budget, and an independent reviewer | `docs/CODING.md`, "Evaluate provider runs with independent review" |
| Intended enterprise host verification | Access to the host | `docs/CODING.md` deployment checks and the Docker backup and restore drill |
| macOS Developer ID and Windows Authenticode | Apple Developer Program membership; a cloud-held Windows signing key for CI | `scripts/mac-signing.ts`, `scripts/windows-signing.ts`, the `release` environment from WP1 |
| Homebrew, Scoop, VS Code Marketplace, Open VSX | Planning 1.0 | `packaging/homebrew`, `packaging/scoop`, `integrations/vscode/package.json` (claim the `okbrain` publisher ID or rename it) |

## Order and pull requests

1. **Decisions** (this PR, docs only): CONTEXT.md, ROADMAP.md, and this plan.
2. **WP1** (one PR): the signing script, the asset check, the workflow, tests,
   and docs. After merge, the maintainer completes the prerequisites, runs the
   dry run, and pushes `v0.1.0`.
3. **WP2** (one PR, independent of WP1): the usability store, ops, GUI,
   protocol, and tests.

Run `/verify` before each code commit. Follow the AGENTS.md rules
throughout: cross-platform paths, argument-array subprocesses, ops declared
in `operations.ts` with thin adapters, and a regression test for any fixed
behavior.
