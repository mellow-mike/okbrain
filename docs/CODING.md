# Coding sessions

Use the **Coding** workspace in the Mac app or local web app to review source files, discuss an implementation, or draft a patch in a recoverable Pi Durable session. Git enables scoped source previews. Coding sessions have their own storage.

## Work in the app

1. Open **Coding** and choose **Add a project**. Enter the repository's absolute path on this computer, set the permitted directories, and choose a Pi provider, model, and optional reasoning level.
2. Save a provider key for that project or use an existing environment key for local runs. The app shows which credential source the project uses.
3. Describe the task and select tracked excerpts or explicit files. Choose **Preview source**, inspect the actual text, and approve sending it with the task and active conversation history. Sending with a changed file selection requires a fresh preview.
4. Watch **Run history** for the answer or interruption. Inspect the result and its recorded provider usage before choosing **Accept result** or **Request changes**. An interrupted run can resume with its stored input, or be cancelled. A follow-up uses the same session and a new request ID.

Use **Project settings** to rotate or remove an API key, inspect the audit log, or delete a session and its transcript. Project audit events include the action, actor, timestamp, and session or request ID when applicable. The audit log remains after transcript deletion.

## Give a team member access

Save a project-specific provider API key and create a token for the member in **Project settings → Team access**. Copy the token when it appears. Each token grants access to a single project and expires after seven days. The operator can revoke it before then.

In **Coding → Team browser access**, start a separate listener. A member opens the team workspace URL and enters their project token. They can preview and approve sources, inspect project runs, cancel or resume runs, and record reviews. Project configuration, credentials, token management, and transcript deletion stay with the local operator.

The team listener binds to `127.0.0.1`. For remote access, an operator can configure a TLS reverse proxy that directs the declared HTTPS origin to the team listener and sets the upstream Host header to `127.0.0.1:<team port>`. The listener serves only the coding workspace and its project-token routes. Keep the separate local operator listener private. Team listener settings reset when the okbrain server stops.

## Start a request in the CLI

Set `OPENAI_API_KEY` in your environment and choose an exact model ID from Pi 1.0's OpenAI catalog. For Anthropic, set `ANTHROPIC_API_KEY` and use `--provider anthropic --model claude-sonnet-4-6`. Coding sessions use provider API keys and their billing accounts.

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

The CLI accepts `--profile-json` in place of `--projects` for preview and submission. Supply the same profile and query when using the context ID. Profile previews prioritize exact paths and source declarations with a private index of up to 4,096 tracked paths. The index recognizes common JavaScript, TypeScript, Go, Python, and Rust declarations. JavaScript and TypeScript excerpts can add up to six direct relative imports or imports from visible workspace packages. Each preview identifies the reason for selecting an excerpt. The index checks the current Git revision and tracked paths, detects worktree changes, and can be rebuilt from the checkout by removing the derived `coding/context-index/` directory within per-user app data. The index stores structural metadata including paths, symbol names, and import specifiers.

Run `bun run scripts/benchmark-coding-context.ts` to compare explicit files, lexical preview, and indexed profile preview on a generated 1,024-file monorepo fixture. It reports evidence recall, deterministic citation acceptance, p50 and p95 preview latency, context bytes, and Pi's simulated input, output, and cache counters across eight tasks. The fixture covers direct cross-package evidence, similarly named services, a worktree edit, and repeated requests in a session. Human acceptance and live-model performance require separate evaluation.

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

`code status` reads the session without calling a provider. It shows pending request IDs, estimated active context, model-window and output limits, and usage recorded by Pi Durable. With a request ID it also reports that request's state, saved source manifest, and any recorded response usage. Input, output, cache-read, and cache-write counters come from Pi's persisted records. Pi receives an opaque session ID so providers can reuse a stable prefix across follow-ups. Provider support, cache lifetime, and history compaction affect the observed counts. An interrupted provider attempt may incur usage that the local process never recorded.

The local input cap is 32,768 estimated tokens, reduced for smaller model windows after reserving room for output and estimation error. Output is capped at up to 8,192 tokens depending on the model. As a session grows, Pi Durable compacts older turns into a bounded local recap with task and answer excerpts and source references. The recap costs no separate provider call, and the original entries stay in SQLite. Reattach source when an old line or decision is important to a follow-up.

## Runtime and storage

okbrain pins Pi Durable, Pi AI, and Chord at `1.0.0`. It opens `Harness` with the portable `SqliteStorage` and a Bun SQLite adapter. Each session maps to a root conversation with a fixed workspace and model. `Conversation.submit()` admits input under a request ID, and `Submission.wait()` drives generation or recovery. Pi uses the prompt, selected text, and active history with an empty tool registry. Applying edits, running commands, and making Git changes are operator actions. [Pi Durable announcement](https://earendil.com/posts/pi-durable/) · [Pi Durable package documentation](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/README.md)

Sessions live under `$XDG_DATA_HOME/okbrain/coding` on Linux and macOS, defaulting to `~/.local/share/okbrain/coding`. On Windows they live under `%LOCALAPPDATA%\okbrain\coding`, defaulting to `AppData\Local\okbrain\coding` in the user profile. Each `session-<name>` directory holds an SQLite transcript and an ownership database. A SQLite lock allows one invocation per session and releases on process exit. Keep the session directory on a local filesystem.

The transcript stores prompts, selected source, and responses as local SQLite data. The chosen provider receives the prompt, selected source text, and active conversation history. The source manifest stays local. Protect session directories and backups with the same controls as the source files. For a CLI session, delete its `session-<name>` directory after all invocations have exited.

Browser, Mac and IDE projects use a separate `coding-projects` directory within the same per-user application data. Each project has its own transcript directory. The project database holds the run index, review state, metadata-only audit, hashed team tokens, and any provider credentials the operator saved. A local worker subprocess receives one scoped request and the selected provider credential over its private input pipe. It reports admission and completion separately. Workers run under the server's operating-system account and have no model-facing workspace tools. A server restart leaves unsettled work available by the same request ID. An interrupted provider attempt can still have incurred upstream charges.

## Review a project on GitHub

Open the project in **Coding**, then open **GitHub → Connection settings** and choose **Detect GitHub remotes**. Select the repository already configured in the project's Git checkout and save the connection. The current integration supports GitHub.com. To read a private repository, use a fine-grained personal access token restricted to that repository with **Issues** and **Pull requests** read permissions. The token stays in the project's local application data. Disconnecting removes the saved binding and credential. [Create a fine-grained personal access token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token)

Choose **Refresh GitHub activity** to load recent open issues and pull requests. The app sends the token and repository requests to GitHub. The activity view displays titles and URLs. Refresh stops if the configured Git remote now points at a different repository.

After accepting a coding request, open **Prepare GitHub review**, choose the accepted request, and enter the base and head branches already on GitHub. **Open GitHub comparison** opens GitHub's review screen so you can inspect and publish there. okbrain records the handoff against the accepted request in the project audit log. Your coding transcript and source excerpts stay on the local device during the handoff. [Compare branches in GitHub](https://docs.github.com/en/pull-requests/committing-changes-to-your-project/viewing-and-comparing-commits/comparing-commits)

## Enterprise deployment milestones

1. Evaluate retrieval quality, runtime, and tokens per accepted result on monorepo tasks. Add reusable project profiles, revision-aware context indexes, and measured cache reuse.
2. Add an authenticated control plane, project policies, isolated workers, per-project credentials, and short-lived repository access. Validate worker recovery, cancellation, and concurrency before enabling shared deployments.
3. Add change review and approval state, audit events, and transcript retention and deletion controls.
4. Evaluate Pi Durable child conversations for scoped package review, then introduce approved execution and repository integration after the worker controls are verified. Record who approved each side effect and apply replay policy to the associated task. [Product plan](PRODUCT-PLAN.md)
