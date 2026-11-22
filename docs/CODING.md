# Coding sessions

Use `okb code run` to review source files, discuss an implementation, or draft a patch in a recoverable Pi Durable session. Choose any existing workspace directory. A Git repository and an okbrain knowledge bundle are optional.

## Start a request

Set `OPENAI_API_KEY` in your environment and choose an exact model ID from Pi 1.0's OpenAI catalog. For Anthropic, set `ANTHROPIC_API_KEY` and use `--provider anthropic --model claude-sonnet-4-6`. Coding sessions use provider API keys and their billing accounts.

```sh
okb code run --workspace ./my-project --session app-review --request-id review-1 \
  --provider openai --model gpt-5-mini \
  --prompt 'Review the startup flow and propose a patch for any error handling gaps.' \
  --files src/app.ts,src/example.ts
```

`--files` takes a comma-separated list of workspace-relative UTF-8 text files. Each file must resolve inside the workspace. A request can attach up to 12 files, with a maximum of 32 KiB per file and 64 KiB combined. The prompt can be up to 16 KiB. Review the returned text before applying any suggested changes.

## Resume or follow up

Reuse the workspace, session, provider, model, and request ID. Omit `--prompt` and `--files` to resume an admitted request with its saved copies of the attachments.

```sh
okb code run --workspace ./my-project --session app-review --request-id review-1 \
  --provider openai --model gpt-5-mini
```

An interrupted provider call can be attempted again, with normal provider billing. A completed request returns its saved answer without a provider call. If an interruption happened before admission, run the original command again. To ask a follow-up or retry an unanswered request, supply a new request ID and prompt. Follow-ups share the session transcript. Use a new session name to change the workspace, provider, or model.

Use `--json` to capture a machine-readable result. A `done` result carries the assistant's `text`. An `unanswered` result carries a `reason` and exits with status 1. CLI validation and runtime errors are reported on stderr.

## Runtime and storage

okbrain pins Pi Durable, Pi AI, and Chord at `1.0.0`. It opens `Harness` with the portable `SqliteStorage` and a Bun SQLite adapter. Each session maps to a root conversation with a fixed workspace and model. `Conversation.submit()` admits input under a request ID, and `Submission.wait()` drives generation or recovery. Pi uses the prompt, attached text, and transcript with an empty tool registry. Applying edits, running commands, and making Git changes are operator actions. [Pi Durable announcement](https://earendil.com/posts/pi-durable/) · [Pi Durable package documentation](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/README.md)

Sessions live under `$XDG_DATA_HOME/okbrain/coding` on Linux and macOS, defaulting to `~/.local/share/okbrain/coding`. On Windows they live under `%LOCALAPPDATA%\okbrain\coding`, defaulting to `AppData\Local\okbrain\coding` in the user profile. Each `session-<name>` directory holds an SQLite transcript and an ownership database. A SQLite lock allows one invocation per session and releases on process exit. Keep the session directory on a local filesystem.

The transcript stores prompts, attached source, and responses as local SQLite data. The chosen provider receives the context needed to answer each request, including relevant conversation history. Keep credentials out of prompt and attachment text. Protect session directories and backups with the same controls as the source files. To delete a local transcript and its attachments, remove its `session-<name>` directory after all invocations have exited. The `code run` operation is available from the local CLI.

## Enterprise deployment milestones

1. Add an authenticated control plane with tenant and project access policies.
2. Run each project in an isolated workspace and use worker-owned provider credentials. Validate worker recovery, cancellation, and concurrency before enabling shared deployments.
3. Add change review and approval state, audit events, and retention and deletion controls for transcripts and attachments.
4. Introduce approved execution and repository integration after those controls are verified. Record who approved each side effect and apply replay policy to the associated task.
