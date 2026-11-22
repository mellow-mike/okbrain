# Coding sessions

Use `okb code run` to review source files, discuss an implementation, or draft a patch in a recoverable Pi Durable session. You can attach files from any local workspace. Git enables scoped source previews. Coding sessions have their own storage.

## Start a request

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

`code status` reads the session without calling a provider. It shows pending request IDs, estimated active context, model-window and output limits, and usage recorded by Pi Durable. With a request ID it also reports that request's state, saved source manifest, and any recorded response usage. Input, output, cache-read, and cache-write counters come from Pi's persisted records. An interrupted provider attempt may incur usage that the local process never recorded.

The local input cap is 32,768 estimated tokens, reduced for smaller model windows after reserving room for output and estimation error. Output is capped at up to 8,192 tokens depending on the model. As a session grows, Pi Durable compacts older turns into a bounded local recap with task and answer excerpts and source references. The recap costs no separate provider call, and the original entries stay in SQLite. Reattach source when an old line or decision is important to a follow-up.

## Runtime and storage

okbrain pins Pi Durable, Pi AI, and Chord at `1.0.0`. It opens `Harness` with the portable `SqliteStorage` and a Bun SQLite adapter. Each session maps to a root conversation with a fixed workspace and model. `Conversation.submit()` admits input under a request ID, and `Submission.wait()` drives generation or recovery. Pi uses the prompt, selected text, and active history with an empty tool registry. Applying edits, running commands, and making Git changes are operator actions. [Pi Durable announcement](https://earendil.com/posts/pi-durable/) · [Pi Durable package documentation](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/README.md)

Sessions live under `$XDG_DATA_HOME/okbrain/coding` on Linux and macOS, defaulting to `~/.local/share/okbrain/coding`. On Windows they live under `%LOCALAPPDATA%\okbrain\coding`, defaulting to `AppData\Local\okbrain\coding` in the user profile. Each `session-<name>` directory holds an SQLite transcript and an ownership database. A SQLite lock allows one invocation per session and releases on process exit. Keep the session directory on a local filesystem.

The transcript stores prompts, selected source, and responses as local SQLite data. The chosen provider receives the prompt, selected source text, and active conversation history. The source manifest stays local. Protect session directories and backups with the same controls as the source files. To delete a local transcript and its attachments, remove its `session-<name>` directory after all invocations have exited. The coding commands are available from the local CLI.

## Enterprise deployment milestones

1. Evaluate retrieval quality, runtime, and tokens per accepted result on monorepo tasks. Add reusable project profiles, revision-aware context indexes, and measured cache reuse.
2. Add an authenticated control plane, project policies, isolated workers, per-project credentials, and short-lived repository access. Validate worker recovery, cancellation, and concurrency before enabling shared deployments.
3. Add change review and approval state, audit events, and transcript retention and deletion controls.
4. Evaluate Pi Durable child conversations for scoped package review, then introduce approved execution and repository integration after the worker controls are verified. Record who approved each side effect and apply replay policy to the associated task. [Product plan](PRODUCT-PLAN.md)
