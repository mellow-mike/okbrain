# Coding sessions

Use the **Coding** workspace in the Mac app or local web app to review source files, discuss an implementation, or draft a patch in a recoverable Pi Durable session. Git enables scoped source previews. Coding sessions have their own storage.

## Work in the app

1. Open **Coding** and choose **Add a project**. Enter the repository's absolute path on this computer, set the permitted directories, and choose a Pi provider, model, and optional reasoning level.
2. Save a provider key for that project or use an existing environment key for local runs. Projects can use OpenAI, Anthropic, or Google Gemini. The app shows which credential source the project uses.
3. Describe the task and select tracked excerpts or explicit files. Choose **Preview source**, inspect the actual text, and approve sending it with the task and active conversation history. Sending with a changed file selection requires a fresh preview.
4. Select the request in **Run history**. Ordinary requests can show a short preview of the answer as it arrives. When the run finishes, inspect the full result and its recorded provider usage before choosing **Accept result** or **Request changes**. An interrupted run can resume with its stored input, or be cancelled. A follow-up uses the same session and a new request ID.

For explicit files and repository excerpts, you can let the model look up line numbers inside the current request’s approved source. Select the option before previewing, then review the selection and approve it. Each lookup reads at most 24 consecutive lines from a single saved file or excerpt. The provider may make an extra request to turn the lookup results into an answer. Completed requests report usage from both turns. A later request starts with its own choice.

Use **Project settings** to rotate or remove an API key, inspect the audit log, or set transcript retention. Project audit events include the action, actor, timestamp, and session or request ID when applicable. The audit log remains after transcript deletion.

### Open a standalone session

In the Mac or local web app, open **Coding → Standalone sessions** to open an existing `okb code` session or start a new one without registering a project. The same session name opens the same private transcript from either surface. An existing session keeps its workspace, provider, and model. Standalone requests run on the local operator’s computer. Registered projects provide team access, audit and review records, and worker isolation.

Choose a workspace, enter a task, and preview explicit files or tracked repository excerpts. Check the source and approve sending it with the task and the active history. The app uses the selected provider’s environment key or API key saved in **Settings → AI providers**. Inspect the saved task, source, response, and usage in **Run history**.

After an interruption, inspect the saved task and source before choosing **Resume request**. Pi uses the saved bytes, so you can resume even if the original workspace is absent. **Cancel request** withdraws a waiting or running request. If a session is open in another invocation, wait for that invocation to finish before refreshing the list.

## Give a team member access

Save a project-specific provider API key and create a token for the member in **Project settings → Team access**. Copy the token when it appears. Each token grants access to a single project and expires after seven days. The operator can revoke it before then.

In **Coding → Team browser access**, start a separate listener. A member opens the team workspace URL and enters their project token. They can preview and approve sources, inspect project runs, cancel or resume runs, and record reviews. Project configuration, credentials, token management, and transcript deletion stay with the local operator.

The team listener binds to `127.0.0.1`. For remote access, an operator can configure a TLS reverse proxy that directs the declared HTTPS origin to the team listener and sets the upstream Host header to `127.0.0.1:<team port>`. The listener serves only the coding workspace and its project-token routes. Keep the separate local operator listener private. Team listener settings reset when the okbrain server stops.

## Start a request in the CLI

Set `OPENAI_API_KEY` in your environment and choose an exact model ID from Pi 1.0's OpenAI catalog. For Anthropic, set `ANTHROPIC_API_KEY` and use `--provider anthropic --model claude-sonnet-4-6`. For Gemini, set `GEMINI_API_KEY` and use `--provider google --model gemini-3.5-flash-lite`. Coding sessions use provider API keys and their billing accounts. [Gemini API keys](https://ai.google.dev/gemini-api/docs/api-key), [Gemini 3.5 Flash-Lite](https://aistudio.google.com/docs/models/gemini-3.5-flash-lite)

```sh
okb code run --workspace ./my-project --session app-review --request-id review-1 \
  --provider openai --model gpt-5-mini \
  --prompt 'Review the startup flow and propose a patch for any error handling gaps.' \
  --files src/app.ts,src/example.ts
```

`--files` takes a comma-separated list of workspace-relative UTF-8 text files. Each file must resolve inside the workspace. A request can attach up to 12 files, with a maximum of 32 KiB per file and 64 KiB combined. The prompt can be up to 16 KiB. Review the returned text before applying any suggested changes.

## Scope context in a monorepo

Choose the owning package and the shared packages the task actually needs. Query for a function name, path, or distinctive term. The preview runs locally and needs no model or credentials.

```sh
okb code context --workspace ./my-project --projects apps/web,packages/auth \
  --query 'refreshSession auth/session' --context-tokens 2500 --show-content
```

The preview reports workspace-relative paths, inclusive line ranges, estimated excerpt tokens, and any scan or packing limits reached. `--show-content` prints the selected text. With `--json`, the default result contains `manifest` and `--show-content` adds `excerpts`. Use the displayed context ID with the same selection options to submit.

```sh
okb code run --workspace ./my-project --session auth-review --request-id auth-1 \
  --provider openai --model gpt-5-mini \
  --projects apps/web,packages/auth --query 'refreshSession auth/session' \
  --context-tokens 2500 --context-id '<ID from the preview>' \
  --prompt 'Review refreshSession and cite the relevant paths and lines.'
```

Choose up to eight workspace-relative directories. Use `.` to scope to the workspace root when appropriate. Discovery uses tracked paths from the Git index and reads their current working-tree contents, including local edits. It skips symlinks, binary files, common generated and credential paths, and `db_only/`. Review the selected lines before approving the selection, since ordinary source files can also contain secrets. A changed selection requires a fresh preview. Use one source mode per request. `--files` is available when you know the exact paths or need a file outside the tracked selection.

The excerpt budget defaults to 4,096 estimated tokens and accepts 1–16,384. It estimates one token per two UTF-8 bytes of serialized excerpts, including paths and line labels. It is independent of the full request budget, which also includes the prompt, instructions, and active history. The preview checks up to 256 eligible files after ranking tracked paths, reads up to 64 KiB from each, and selects at most 12 excerpts. When a limit is reached or a result is missing, narrow the directories or use a more specific path or identifier. Open a new session when earlier turns should be outside the new task's context.

### Reuse a project profile

A version 1 profile is a JSON document you can keep alongside the project. Select the primary directories for each task and optionally allow direct imports from other tracked directories. Exclusions are literal workspace-relative files or directories. Short guidance and the excerpt budget are optional. Review the guidance and excerpts before sending, since both are saved with the admitted request and passed to the chosen provider.

```json
{
  "version": 1,
  "name": "Customer web app",
  "projects": ["apps/web"],
  "sharedProjects": ["packages/contracts"],
  "exclude": ["apps/web/fixtures"],
  "guidance": "Cite affected routes and tests.",
  "tokenBudget": 2500
}
```

The CLI accepts `--profile-json` in place of `--projects` for preview and submission. Supply the same profile and query when using the context ID. Profile previews prioritize exact paths and compound identifiers with a private index of up to 4,096 tracked paths. Matching source methods and documentation headings can anchor an excerpt. Nearby query terms help locate the most relevant part of a file. The index recognizes common JavaScript, TypeScript, Go, Python, and Rust declarations. JavaScript and TypeScript excerpts can add up to six direct relative imports or imports from visible workspace packages. An import with no matching text ranks below direct search matches. Each preview identifies the reason for selecting an excerpt. The index checks the current Git revision and tracked paths, detects worktree changes, and can be rebuilt from the checkout by removing the derived `coding/context-index/` directory within per-user app data. The index stores structural metadata including paths, symbol names, and import specifiers.

Run `bun run scripts/benchmark-coding-context.ts` to compare explicit files, lexical preview, and indexed profile preview on a generated 1,024-file monorepo fixture. It reports evidence recall, deterministic citation acceptance, p50 and p95 preview latency, context bytes, and Pi's simulated input, output, and cache counters across eight tasks. The fixture covers direct cross-package evidence, similarly named services, a worktree edit, and repeated requests in a session. Human acceptance and live-model performance require separate evaluation.

### Measure repository previews on Vite

`bun run scripts/benchmark-coding-vite.ts` clones a temporary Vite checkout and measures six development traces across 2,380 tracked files. The suite covers a failed dynamic import, scaffold template selection, legacy build targets, HMR lifecycle, split CSS in the build manifest, and dependency scan inputs. Use `--workspace /path/to/vite` to reuse a clean checkout at the pinned commit. The script checks the revision and hand-labeled evidence before timing and reads the checkout without running its install, build, or test scripts. [Vite v7.0.0 at b85f322](https://github.com/vitejs/vite/tree/b85f32275b443bf6b647572a9209f1e078b5b4dd)

The wide setting uses package directories and a 4,096-token excerpt budget. `--narrow --token-budget 12288` uses tighter subsystem directories and a larger budget. Lexical preview searches all permitted directories directly. Indexed preview searches primary directories and can reach a shared directory only through a direct import. Five of the 15 evidence targets are documentation or tests in shared directories without such an import. Explicit attachments use the already known evidence files as a reference. File recall counts expected paths that appeared. Evidence recall counts excerpts containing the specific expected text.

The first baseline run used Linux x64, Bun 1.3.14, an Intel i7-1260P, and eight repetitions per task. Each row summarizes 48 previews with 120 expected evidence targets.

| Settings | Strategy | File recall | Evidence recall | p50 / p95 preview | Mean context |
|---|---|---:|---:|---:|---:|
| Package, 4,096 tokens | Explicit known files | 100% | 100% | 0.65 / 1.58 ms | 31.1 KB |
| Package, 4,096 tokens | Lexical | 66.7% | 33.3% | 242.02 / 277.02 ms | 8.2 KB |
| Package, 4,096 tokens | Indexed | 66.7% | 20.0% | 295.97 / 336.82 ms | 7.8 KB |
| Subsystem, 12,288 tokens | Explicit known files | 100% | 100% | 0.56 / 1.54 ms | 31.1 KB |
| Subsystem, 12,288 tokens | Lexical | 100% | 60.0% | 60.01 / 108.13 ms | 11.5 KB |
| Subsystem, 12,288 tokens | Indexed | 66.7% | 20.0% | 30.43 / 87.92 ms | 8.0 KB |

The same eight-repetition suite with the current indexed ranking found 64 of 120 exact evidence targets in each setting, up from 24. File recall stayed at 66.7%. Indexed preview included every target for the legacy plugin trace. Lexical preview included every target for two traces at subsystem scope.

| Settings | Strategy | Evidence recall | p50 / p95 preview | Mean context |
|---|---|---:|---:|---:|
| Package, 4,096 tokens | Lexical | 33.3% | 249.14 / 300.95 ms | 8.2 KB |
| Package, 4,096 tokens | Current indexed | 53.3% | 312.92 / 387.94 ms | 8.1 KB |
| Subsystem, 12,288 tokens | Lexical | 60.0% | 55.35 / 109.85 ms | 11.5 KB |
| Subsystem, 12,288 tokens | Current indexed | 53.3% | 34.18 / 86.69 ms | 8.0 KB |

The Vite suite makes zero provider calls. Its JSON includes an evaluation series ID, a fixed prompt, and exact expected file and line references for each task. The live workflow can use that rubric against the same checkout. A completed local preview measures retrieval quality only.

### Evaluate provider runs with independent review

1. Choose a pinned checkout or a stable revision and agree on expected evidence before running the task. Use the same provider, model, prompt, and evidence targets across strategies. Use fresh sessions for independent trials and disclose when measuring repeated turns or cache reuse.
2. In **Coding → New request → Independent evaluation**, opt the request into a measurement series. Enter the series ID, task ID, and expected workspace-relative citations one per line, such as `src/client.ts:12-18`. Choose the explicit files, lexical excerpts, indexed profile, or independent package review strategy through the usual source controls.
3. Preview source and approve as usual. Preview timing is recorded when you opt in before previewing. Enrollment and evidence targets stay in the evaluation catalog. The provider receives only the normal approved coding input, and evaluating the result makes no model call. Reuse the same series and task ID to compare strategies with identical prompt and evidence.
4. A different authenticated project member opens the attempt under **Evaluation results**. Compare the response against the task and the approved source saved in Pi Durable. Check each citation that the response supports and accept a complete response or request changes. Acceptance requires every expected citation. This assessment is separate from the human review that authorizes a patch.
5. Compare strategies in **Evaluation results** and copy the aggregate metrics as JSON. The report separates injected test providers from the normal provider path and shows preview p50/p95, verified citations, average serialized approved source bytes, and recorded input, output, cache read, and cache write tokens. The tokens-per-acceptance numerator includes rejected reviewed attempts, and appears when there is at least one acceptance and recorded usage for every reviewed attempt in the group. It excludes pending reviews and provider calls that never recorded usage. The copy action includes aggregate metrics, and deleting an evaluated session also deletes its evaluation records.

An independent reviewer and approved live provider credentials are needed to collect live evidence. All automated checks use an injected fixture provider.

### Review independent packages

In the Coding workspace, choose **Independent package review** for a task spanning two or three separate directories. Enter a search query and optional excerpt budget for each directory. **Preview source** shows each package separately. Approve the shared task and selected text before sending.

Each Pi Durable child conversation receives the task and only its own package's selected excerpts. It starts without the parent session history and has no workspace tools. The run shows a bounded summary, source references, stable request ID, and recorded usage for each package. Review the combined result and record your decision. A resumed review uses the saved source selection and recovers any unfinished package conversations. Aborting the run cancels its outstanding package reviews.

## Resume or follow up

Reuse the workspace, session, provider, model, and request ID. Omit the prompt and source-selection flags to resume an admitted request with its saved source snapshot.

```sh
okb code run --workspace ./my-project --session app-review --request-id review-1 \
  --provider openai --model gpt-5-mini
```

An interrupted provider call can be attempted again, with normal provider billing. A completed request returns its saved answer without a provider call. If an interruption happened before admission, run the original command again. To ask a follow-up or retry an unanswered request, supply a new request ID and prompt. Follow-ups share the session transcript. Use a new session name to change the workspace, provider, or model.

Use `--json` to capture a machine-readable result. A `done` result carries the assistant's `text`, `stopReason`, and `usage`. An `unanswered` result carries a `reason` and exits with status 1. Requests using a preview include the saved `repositoryContext` manifest. CLI validation and runtime errors are reported on stderr.

## Inspect context and usage

```sh
okb code status --workspace ./my-project --session auth-review --request-id auth-1 \
  --provider openai --model gpt-5-mini --json
```

`code status` reads the session without calling a provider. It shows pending request IDs, estimated active context, model-window and output limits, and usage recorded by Pi Durable. With a request ID it also reports that request's state, saved source manifest, and any recorded response usage. In **Run history**, open **Session usage** under any saved request to see model totals and the portions from the main and child conversations. The panel shows provider-reported token categories, reasoning within output, an estimated USD cost when available, and any tracked tool usage. It includes failed and cancelled attempts when Pi saved their usage. An interrupted provider attempt may incur usage that the local process never recorded.

Pi receives an opaque session ID so providers can reuse a stable prefix across follow-ups. Provider support, cache lifetime, and history compaction affect the observed counts.

The local input cap is 32,768 estimated tokens, reduced for smaller model windows after reserving room for output and estimation error. Output is capped at up to 8,192 tokens depending on the model. As a session grows, Pi Durable compacts older turns into a bounded local recap with task and answer excerpts and source references. The recap costs no separate provider call, and the original entries stay in SQLite. Reattach source when an old line or decision is important to a follow-up.

## Runtime and storage

okbrain pins Pi Durable, Pi AI, and Chord at `1.0.0`. It opens `Harness` with the portable `SqliteStorage` and a Bun SQLite adapter. Each session maps to a root conversation with a fixed workspace and model. `Conversation.submit()` admits input under a request ID, and `Submission.wait()` drives generation or recovery. Pi uses the prompt, selected text, and active history. When approved, the source lookup tool reads only the current request’s stored selection and can replay after an interruption. Applying edits, running commands, and making Git changes are operator actions. [Pi Durable announcement](https://earendil.com/posts/pi-durable/) · [Pi Durable package documentation](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/README.md)

Sessions live under `$XDG_DATA_HOME/okbrain/coding` on Linux and macOS, defaulting to `~/.local/share/okbrain/coding`. On Windows they live under `%LOCALAPPDATA%\okbrain\coding`, defaulting to `AppData\Local\okbrain\coding` in the user profile. Each `session-<name>` directory holds an SQLite transcript and an ownership database. A SQLite lock allows one invocation per session and releases on process exit. Keep the session directory on a local filesystem.

The transcript stores prompts, selected source, and responses as local SQLite data. The chosen provider receives the prompt, selected source text, and active conversation history. The source manifest stays local. Protect session directories and backups with the same controls as the source files. For a CLI session, delete its `session-<name>` directory after all invocations have exited.

Browser, Mac and IDE projects use a separate `coding-projects` directory within the same per-user application data. Each project has its own transcript directory. The project database holds the run index, review state, metadata-only audit, hashed team tokens, and any provider credentials the operator saved. Workers receive one scoped request and the selected provider credential over their private input pipe. They report admission and completion separately. A server restart leaves unsettled work available by the same request ID. An interrupted provider attempt can still have incurred upstream charges.

### Run isolated workers on Linux

The regular launcher uses a process under the server's operating-system account. A Linux deployment can start each request in a Docker container with a read-only root, a non-root identity, and a private bind mount of the selected session directory. The control plane checks the preview digest against current source before sending the approved snapshot. The worker can then admit it without opening the host workspace. It receives no Docker socket, checkout, personal bundles, other sessions, or project catalog. Resume reads from persisted Pi state and also works when the original checkout has moved or been removed.

Build the image from the same checkout as the host application and set the pinned local image ID in the environment of the okbrain service account. That non-root account must have access to the local Docker socket at `/var/run/docker.sock`. The Coding view shows whether the server uses Docker. If the configured image is unavailable, the run enters an interrupted state and reports the launch error.

```sh
docker build --file packaging/coding-worker/Dockerfile --tag okbrain-coding-worker:local .
export OKB_CODING_WORKER_IMAGE=$(docker image inspect --format '{{.Id}}' okbrain-coding-worker:local)
```

`OKB_CODING_WORKER_NETWORK` selects the deployment's Docker bridge network. The default is `bridge`. A deployment can restrict provider egress through that network. Use `none` for offline verification. Run the following smoke check to exercise the production worker through the local Coding API, inspect the container boundary, and confirm that a missing image never starts a local worker. [Docker runtime controls](https://docs.docker.com/reference/cli/docker/container/run/)

```sh
bun run packaging/coding-worker/smoke.ts "$OKB_CODING_WORKER_IMAGE"
```

### Limit transcript retention

In **Project settings → Transcript retention**, set the number of days to keep inactive sessions. Leave the field blank to keep transcripts until you delete them. Saving a limit checks sessions in the selected project immediately. The Coding server also checks at startup and hourly, processing up to 24 expired sessions per check. Activity includes the latest run status, review, or patch application. A running or interrupted request or a pending approved patch protects its entire session.

Expiry removes the session directory and its catalog records through the same recoverable deletion ledger as manual deletion. Metadata for the audit and expired request IDs remains. An expired ID returns an explicit expiration error when retried. If a service uses backups, apply the deployment's retention policy to backup copies separately.

## Apply a reviewed patch locally

After accepting a finished request, open **Apply a reviewed patch** as the local project owner. Choose the result and paste the Git unified diff. **Preview patch** checks the changes against the tracked worktree files in a temporary checkout and lists the affected paths. Confirm the exact diff and choose **Apply to worktree**. The staging area, commits, and remote remain untouched.

The patch can edit up to eight existing tracked UTF-8 files within the project scope. It accepts portable unquoted paths and a diff up to 48 KiB. File creation, deletion, renames, binary patches, symlinks, hard links, and permission changes are outside this workflow. A change to the previewed worktree bytes or diff requires a fresh preview.

The audit records separate patch-approval and application events. Repeating the same completed approval returns its receipt. After interruption, the same approval can recover against the recorded before or after bytes. Inspect the listed files manually if the worktree matches neither state.

## Review a project on GitHub

Open the project in **Coding**, then open **GitHub → Connection settings** and choose **Detect GitHub remotes**. Select the repository already configured in the project's Git checkout and save the connection. The current integration supports GitHub.com. To read a private repository, use a fine-grained personal access token restricted to that repository with **Issues** and **Pull requests** read permissions. The token stays in the project's local application data. Disconnecting removes the saved binding and credential. [Create a fine-grained personal access token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token)

Choose **Refresh GitHub activity** to load recent open issues and pull requests. The app sends the token and repository requests to GitHub. The activity view displays titles and URLs. Refresh stops if the configured Git remote now points at a different repository.

After accepting a coding request, open **Prepare GitHub review**, choose the accepted request, and enter the base and head branches already on GitHub. Use **Prepare comparison** to open GitHub's review screen. In VS Code and Cursor, choose **Prepare GitHub pull request in okbrain** from an accepted run to open the same form. [Compare branches in GitHub](https://docs.github.com/en/pull-requests/committing-changes-to-your-project/viewing-and-comparing-commits/comparing-commits)

To open a pull request from okbrain, the local owner saves a separate fine-grained **Pull request publishing token** under **Connection settings**. Restrict it to the connected repository and grant **Pull requests** write permission. In **Create a pull request**, enter the title and Markdown, choose whether to open a draft, and preview the exact text and branch comparison. After checking the preview, confirm and choose **Publish to GitHub**. okbrain submits the title, Markdown, branch names, and draft choice. The branches must already exist in that repository. The transcript, excerpts, and local worktree stay on the machine. [GitHub create pull request API](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#create-a-pull-request)

The preview includes a Markdown comment that links GitHub's receipt to the local approval after a lost response or restart. Choose **Find or recover pull request** to look up that receipt. Repeating the same approval returns a recorded result when one is available. If GitHub already has another open pull request for those branches, review the existing comparison. okbrain records approval and publication or recovery in the project audit log.

## Validation status

The HTTP tests exercise admission, interruption, recovery, cancellation, project authorization, retention, review and approved patch replay. A local HTTPS reverse proxy was exercised in Chromium with a project token. The Linux Docker smoke check exercises the worker filesystem boundary, stale approval, offline Pi admission and fail-closed launch. Live provider evaluation needs an independently reviewed set of tasks and an approved provider account. The intended enterprise host, provider egress, backups and deployment policy still need verification. [Roadmap](../ROADMAP.md)
