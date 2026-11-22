# Coding sessions

Use the **Coding** workspace in the Mac app or local web app to review source files, discuss an implementation, or draft a patch in a recoverable Pi Durable session. Git enables scoped source previews. Coding sessions have their own storage.

## Work in the app

1. Open **Coding** and choose **Add a project**. Enter the repository's absolute path on this computer, set the permitted directories, and choose a Pi provider, model, and optional reasoning level.
2. Save a provider key for that project or use an existing environment key for local runs. Projects can use OpenAI, Anthropic, or Google Gemini. The app shows which credential source the project uses.
3. Describe the task and select tracked excerpts or explicit files. Choose **Preview source**, inspect the actual text, and approve sending it with the task and active conversation history. Sending with a changed file selection requires a fresh preview.
4. Select the request in **Run history**. Ordinary requests can show a short preview of the answer as it arrives. When the run finishes, inspect the full result and its recorded provider usage before choosing **Accept result** or **Request changes**. An interrupted run can resume with its stored input, or be cancelled. A follow-up uses the same session and a new request ID.

If you are starting from a GitHub link, expand **Prepare GitHub checkout** under **Add a project**. Enter the GitHub.com HTTPS repository and exact branch, then approve preparing a shallow checkout in private app data. For a private repository, supply your GitHub login and a fine-grained token restricted to that repository with **Contents** read access. The checkout uses the token for its fetch and keeps only the worktree and import receipt. Repeating the selected repository and branch reopens the saved copy and preserves local edits. The form fills the workspace path so you can set its permitted directories, model, and credentials before choosing **Add project**. [Git fetch](https://git-scm.com/docs/git-fetch), [Git checkout](https://git-scm.com/docs/git-checkout), [GitHub checkout setup](https://docs.github.com/en/repositories/creating-and-managing-repositories/cloning-a-repository)

Managed checkout preparation requires Git on the computer running okbrain. It supports branches with up to 10,000 regular files, 16 MiB per file, and 256 MiB total. Register an existing local checkout for a branch that requires symlinks, submodules, or a larger worktree.

Choose **View saved request source** in the app or editor to review a selected run’s task and approved files or excerpts. For an independent package review, the source is grouped by package. The preview reads from the saved Pi admission, so it includes the evidence the run used even if the checkout changes.

**Run history** shows the most recent requests. In the Mac or web app, open **Find saved request**, enter the session name and request ID, and choose **Open saved request**. In VS Code or Cursor, choose **Find saved request by ID…** from the run picker. A retained request opens even after it falls off the recent list. Exact run and GitHub review links can reopen retained results under the same project access rules.

For explicit files and repository excerpts, you can let the model look up line numbers inside the current request’s approved source. Select the option before previewing, then review the selection and approve it. Each lookup reads at most 24 consecutive lines from a single saved file or excerpt. The provider may make an extra request to turn the lookup results into an answer. Completed requests report usage from both turns. Open **Approved source lookups** in Run history to see the ranges Pi returned and the counts of refused or incomplete calls. The run report and editor inspection include the same bounded receipt. A later request starts with its own choice.

Use **Project settings** to rotate or remove an API key, inspect the audit log, or set transcript retention. Project audit events include the action, actor, timestamp, and session or request ID when applicable. The audit log remains after transcript deletion.

### Record review feedback

In **Run history**, select a finished project run, add an optional **Review note**, then choose **Accept result** or **Request changes**. Open **Review history** for the latest 20 decisions, reviewers, timestamps, and notes. VS Code and Cursor show the same history when you inspect a project run and ask for optional feedback when you record a decision. If someone reviews the run while you are preparing your feedback, reopen it and review their decision before submitting yours.

If the latest decision requests changes and has a note, choose **Use review note in follow-up** in the Mac or web app. The note fills the editable task for a new request in the same session. Review your task and sources before approving the send. The normal session history accompanies the request.

Review notes are visible to authorized project reviewers and expire with the run's transcript. Existing runs start their history with the last saved decision. The audit log keeps review action and identity metadata. The run report includes the current decision.

### Reuse a request preset

Presets keep a recurring task, repository search query, and [version 1 project profile](#reuse-a-project-profile) together. In the Mac or web app, choose **Tracked repository excerpts**, fill in the task and search query, and set the directories and budget or supply a profile under **Scope and budget**. Open **Run presets**, enter a name, and choose **Save new preset**. The local owner can select an existing preset to update it from the form or remove it. Project members can load the same presets. Keep prompts and profile guidance suitable for sharing with everyone who can access the project.

Load a preset from the project request form. Local operators can also use **okbrain: Preview Saved Request Preset** in VS Code or Cursor with the registered folder open. The request starts with the saved draft and current working-tree evidence. Review a fresh source preview, choose whether to allow approved-source lookup, and approve this request. Removing a preset leaves earlier Pi runs and their admitted sources available to the project's reviewers.

### Open a standalone session

In the Mac or local web app, open **Coding → Standalone sessions** to open an existing `okb code` session or start a new one without registering a project. The same session name opens the same private transcript from either surface. An existing session keeps its workspace, provider, and model. Standalone requests run on the local operator’s computer. Registered projects provide team access, audit and review records, and worker isolation.

Choose a workspace, enter a task, and preview explicit files or tracked repository excerpts. Check the source and approve sending it with the task and the active history. The app uses the selected provider’s environment key or API key saved in **Settings → AI providers**. Inspect the saved task, source, response, and usage in **Run history**.

After an interruption, inspect the saved task and source before choosing **Resume request**. Pi uses the saved bytes, so you can resume even if the original workspace is absent. **Cancel request** withdraws a waiting or running request. If a session is open in another invocation, wait for that invocation to finish before refreshing the list.

To erase a standalone transcript, select the session and open **Delete standalone session**. Type its name and choose **Delete session**. This removes the saved tasks, attachments, and responses from this device. A running session must finish or be cancelled first. If deletion was interrupted, select the session and choose **Retry deletion**. Review your backup retention separately.

## Give a team member access

Save a project-specific provider API key and create a token for the member in **Project settings → Team access**. Copy the token when it appears. Each token grants access to a single project and expires after seven days. The operator can revoke it before then.

In **Coding → Team browser access**, start a separate listener. A member opens the team workspace URL and enters their project token. They can preview and approve sources, inspect project runs and their saved task and source, cancel or resume runs, and record reviews. Project configuration, credentials, token management, and transcript deletion stay with the local operator.

The team listener binds to `127.0.0.1`. For remote access, an operator can configure a TLS reverse proxy that directs the declared HTTPS origin to the team listener and sets the upstream Host header to `127.0.0.1:<team port>`. The listener serves the coding workspace and its project-token routes. Keep the separate local operator listener private.

Choose a fixed port and select **Start on launch** to restore the team workspace when a writable okbrain server opens the same Coding state. While the listener is running, **Enable startup** saves its displayed port and HTTPS origin. **Disable startup** leaves the current listener running. **Stop listener** stops it and clears the startup preference. Closing okbrain saves the preference for the next launch.

If the saved port is occupied, the team listener stays stopped and the owner app shows the bind error. Free the port and choose **Retry startup**, or disable startup and choose another binding. The saved team port is reserved from the owner app, so the reverse proxy can keep targeting it across restarts.

### Connect from VS Code or Cursor

Install the okbrain VSIX and choose **okbrain: Connect to Team Workspace** from the Command Palette. Enter the HTTPS origin and project token from the operator. The editor saves them together with the project identity in its secret store. [Install the editor extension](../integrations/vscode/README.md) · [VS Code secret storage](https://code.visualstudio.com/api/extension-capabilities/common-capabilities#data-storage)

Choose **okbrain: Preview Team Coding Request**. Pick a saved preset or enter a task, repository query, and permitted directories. Inspect the fresh server-side excerpts in the editor, then approve the send. You can allow Pi to look up lines within those excerpts for this request. A local checkout is optional because the team server reads the registered repository.

Use **okbrain: Inspect and Review Team Coding Runs** to see progress and results, open saved request sources, record a review, cancel, or resume. Use **okbrain: Open Team Workspace in Browser** to open the HTTPS origin and sign in there. **okbrain: Disconnect from Team Workspace** clears the editor’s saved connection. The operator can revoke the project token from **Team access**.

For a local registered project, choose **okbrain: Preview Repository Coding Request** to create a one-off request from tracked excerpts. Enter the task and repository query, choose the permitted directories, and review the exact task and source in the read-only preview before sending. The active-file command also uses a read-only preview and requires a fresh review if the selected file or workspace changes before approval or retry.

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

The excerpt budget defaults to 4,096 estimated tokens and accepts 1–16,384. It estimates one token per two UTF-8 bytes of serialized excerpts, including paths and line labels. It is independent of the full request budget, which also includes the prompt, instructions, and active history. The preview checks up to 256 eligible files after ranking tracked paths, reads up to 64 KiB from each, and selects at most 12 excerpts. When a limit is reached or a result is missing, narrow the directories or use a more specific path or identifier. Use [Start fresh context](#start-fresh-context) when the next request should leave out earlier turns.

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

On a registered pinned Vite project, open **Coding → Source retrieval benchmark** in the Mac or web app. Select **Package directories** or **Subsystem directories**, set the repetitions and excerpt budget, and choose **Run retrieval benchmark**. Each repetition measures six cases with explicit files, lexical excerpts, and indexed excerpts. The panel shows progress and lets the local operator stop the run. Copy the result as JSON to keep the exact revision, per-case evidence measurements, and strategy comparisons after restarting okbrain. The benchmark makes no model calls and creates no Coding requests.

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
4. A different authenticated project member opens **Evaluation results** and selects **Ready to review**. Compare the response against the task and the approved source saved in Pi Durable. Check each citation that the response supports and accept a complete response or request changes. Acceptance requires every expected citation. This assessment is separate from the human review that authorizes a patch. The queue also shows work awaiting another member and reviewed attempts.
5. Compare strategies in **Evaluation results** and copy the aggregate metrics as JSON. The report separates injected test providers from the normal provider path and shows preview p50/p95, verified citations, average serialized approved source bytes, and recorded input, output, cache read, and cache write tokens. The tokens-per-acceptance numerator includes rejected reviewed attempts, and appears when there is at least one acceptance and recorded usage for every reviewed attempt in the group. It excludes pending reviews and provider calls that never recorded usage. The copy action includes aggregate metrics, and deleting an evaluated session also deletes its evaluation records.

To repeat a case with another strategy, open a finished attempt and choose **Use evaluation case**. The app fills in the saved task, series, task ID, and expected citations, and generates a fresh session and request ID. Choose the source for this trial, preview it again, and approve the preview before sending. Changing the evaluation fields also requires a fresh preview so its timing can be recorded. If clipboard access is unavailable, copy the selected text from **Evaluation metrics JSON**.

An independent reviewer and approved live provider credentials are needed to collect live evidence. The automated browser check exercises submission and review with separate project tokens and an injected fixture provider.

### Load a pinned Vite benchmark case

Under **Coding → Add a project**, open **Prepare Vite benchmark checkout** and review the repository, tag, and pinned commit. Select **Use this exact benchmark revision** and choose **Prepare benchmark checkout**. okbrain downloads the public Vite v7.0.0 tag and checks that it points to `b85f32275b443bf6b647572a9209f1e078b5b4dd`. The shallow checkout stores the tracked link as text, preserving the Git index entry. Preparing the checkout makes no model calls. You can also register the root of an existing clean checkout at the same revision. [Pinned Vite source](https://github.com/vitejs/vite/tree/b85f32275b443bf6b647572a9209f1e078b5b4dd)

Register the prepared workspace with permitted directories `packages, docs, playground` to cover the published cases. Select your approved provider and model before preparing a trial.

In **New request → Independent evaluation → Pinned Vite benchmark**, select a study, case, and strategy, then choose **Use pinned case**. Each study has six cases. **Package directories** uses a 4,096-token excerpt budget, and **Subsystem directories** uses 12,288. **Explicit files** starts with the known evidence paths. **Lexical** searches the permitted study directories, and **Indexed profile** uses the same budget with separate primary and shared directories.

The app fills the task, citation targets, and source recipe in a fresh session. Choose **Preview source**, check the selection, and approve sending it. The server verifies the pinned commit and clean tracked checkout before previewing and sending, and records timing for the approved preview. The reserved study IDs keep these trials separate from custom runs. Use the normal independent review to record results.

The app-prepared public checkout completed source previews for all 36 trial combinations through the local API without a model call. An offline rehearsal also submitted all 36 combinations through the team API using scripted answers. Separate fixture accounts exercised author and reviewer permissions, and the report recorded six strategy groups under the injected provider origin. Live provider quality and independently reviewed outcomes remain open.

### Review independent packages

In the Coding workspace, choose **Independent package review** for a task spanning two or three separate directories. Enter a search query and optional excerpt budget for each directory. **Preview source** shows each package separately. Approve the shared task and selected text before sending.

Each Pi Durable child conversation receives the task and only its own package's selected excerpts. It starts without the parent session history and has no workspace tools. The run shows a bounded summary, source references, stable request ID, and recorded usage for each package. Review the combined result and record your decision. A resumed review uses the saved source selection and recovers any unfinished package conversations. Aborting the run cancels its outstanding package reviews.

While a request runs, **Run history** shows the current Pi Durable tasks for that request. It counts tasks per stage, including package coordination and child work. The app also shows saved pending tasks when inspecting an interrupted request. These counts reflect the work Pi has recorded, and can change as tasks start or finish. [Pi Durable task graph](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/README.md)

## Resume or follow up

Reuse the workspace, session, provider, model, and request ID. Omit the prompt and source-selection flags to resume an admitted request with its saved source snapshot.

```sh
okb code run --workspace ./my-project --session app-review --request-id review-1 \
  --provider openai --model gpt-5-mini
```

An interrupted provider call can be attempted again, with normal provider billing. A completed request returns its saved answer without a provider call. If an interruption happened before admission, run the original command again. To ask a follow-up or retry an unanswered request, supply a new request ID and prompt. Follow-ups share the session transcript. Use a new session name to change the workspace, provider, or model.

Use `--json` to capture a machine-readable result. A `done` result carries the assistant's `text`, `stopReason`, and `usage`. An `unanswered` result carries a `reason` and exits with status 1. Requests using a preview include the saved `repositoryContext` manifest. CLI validation and runtime errors are reported on stderr.

### Start fresh context

In **Run history** for a project, or in a saved **Standalone session**, select an idle session. To carry forward a decision or next step, open **Add a handoff note** and enter up to 2,048 UTF-8 bytes. Choose **Start fresh context**, review the session and the exact note, and confirm **Reset context**. To start with an empty conversation, leave the note blank.

In VS Code or Cursor, open a finished run from **okbrain: Inspect and Review Coding Runs** and choose **Start fresh context**. Enter an optional single-line handoff, then review the session and note before choosing **Start Fresh Context**. These controls are available to the local owner in a writable workspace.

Pi excludes earlier turns from subsequent model requests in this session. An approved handoff becomes the first message in the fresh context and accompanies the next request sent to the bound provider and model. The workspace binding and saved tasks, sources, answers, reviews, and usage remain available. Resetting uses no provider call. Finish, resume, or cancel unsettled work first. If the note or active context changes during confirmation, preview it again. [Pi Durable context reset](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/README.md#reset-and-handoff)

### Compact context locally

To keep recent turns in a long session, select a saved request from an idle session in **Run history** or **Standalone sessions**, then choose **Compact context locally**. Verify the session name, check **Compact older context and keep saved run history**, and choose **Compact context**. In VS Code or Cursor, choose **Compact context locally** from the saved run’s actions and confirm **Compact Context**.

Pi uses a short recap of older active turns and keeps recent turns verbatim. The recap is generated on this device without a provider call. Saved requests, sources, answers, reviews, and usage remain available. If there is too little context, the action reports that and leaves the history as it was. The recap can omit details from older turns, so reattach important source before relying on it again.

If local compaction was interrupted, reopen the saved run and choose **Compact context locally** again. Review the same session and choose **Finish compaction** in the app or **Resume Compaction** in the editor before sending another request. These controls require the local owner on a writable mount. [Pi Durable compaction](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/README.md#compaction)

### Branch for an alternative review

On a writable mount, the local owner can branch from the latest saved answer in an idle project session after accepting that ordinary run. This gives you a separate conversation for comparing an alternative while retaining the original result and review.

1. Open the accepted result in **Run history** and choose **Preview alternative branch**. In VS Code or Cursor, choose **Preview alternative branch in okbrain** to open that exact run in the local Coding workspace.
2. Check the provider and model and read **Inherited context**. The preview shows the visible text that can accompany the next provider request, including instructions, prior tasks and approved source, answers, and tool calls and results. When the app indicates provider-managed reasoning or signatures, those records can accompany the visible history. Check **Create a separate session with this inherited context**, then choose **Create alternative branch**. Creation takes place locally without a provider request.
3. Choose **Use branch session**, enter a new task, and choose **Preview source**. Review the new scoped selection and **Context already in this branch**, then approve sending both with the task. Every new send requires a fresh source preview and approval bound to the current branch context. Later work in the parent stays in its own conversation.
4. Select the finished alternative in **Run history** and choose **Compare with original**. The Mac and web apps show the saved answers, tasks, source references, request usage, and review decisions together. The same action opens a read-only comparison in VS Code and Cursor. Authorized project members can compare and review. The comparison reads the exact original answer that the branch started from and uses the saved transcript, so it works without a model call or access to the checkout.

To use an accepted alternative's changes, choose **Review proposed patch** on that result and approve the patch preview. In **Prepare GitHub review**, select the same alternative, publish its applied patch as a new branch, then preview and approve the pull request. **Review the published patch on GitHub** compares the two recorded commits. The pull request targets the recorded branch names, and okbrain checks the recorded head commit at preview, before creation, and when accepting a returned or recovered receipt. [Compare GitHub commits](https://docs.github.com/en/pull-requests/how-tos/commit-changes/comparing-commits#comparing-commits) · [GitHub pull request API](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request)

Return to **Alternative review branches** in **Run history** to reopen a branch. If creation was interrupted, choose **Finish creating branch** to recover the saved approval or finish creating the same branch while the approved parent context is current. Branch request recovery uses the saved Pi admission.

The parent and its branches share one transcript, so work in any of them can occupy the same session lease. Retention and deletion apply to the whole transcript. Branches support ordinary file and repository reviews. Use a regular project session for independent package reviews, evaluations, and manual context reset or compaction. [Pi Durable conversation forks](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/README.md#more-conversations-and-forks)

## Inspect context and usage

```sh
okb code status --workspace ./my-project --session auth-review --request-id auth-1 \
  --provider openai --model gpt-5-mini --json
```

**Run history** in the Mac and web apps and run inspection in VS Code and Cursor show the session’s estimated active context, input limit, output allowance, and model window. These figures describe what can fit in a request. Open **Session usage** in the apps to see provider-reported totals for the session and for its main and child conversations. The panel shows input, output, and cache tokens, reasoning within output, estimated USD cost when available, and any tracked tool usage. It includes failed and cancelled attempts when Pi saved their usage. An interrupted provider attempt may incur usage that the local process never recorded.

`code status` reads the same session data without calling a provider. With a request ID it also reports that request's state, saved source manifest, and any recorded response usage.

In the Mac or web app, open a saved request in **Run history** and choose **Copy run report**. The same action appears in VS Code and Cursor run inspection, including for project members. It copies versioned JSON with run and review status, session and request IDs, model, active context estimates, recorded usage, and relative source references. Repository manifests include their saved line ranges and content hashes. Task text, answers, and source contents stay in their separate inspection controls. If the browser cannot write to the clipboard, copy the selected text from **Run report JSON**.

Pi receives an opaque session ID so providers can reuse a stable prefix across follow-ups. Provider support, cache lifetime, and history compaction affect the observed counts.

The local input cap is 32,768 estimated tokens, reduced for smaller model windows after reserving room for output and estimation error. Output is capped at up to 8,192 tokens depending on the model. As a session grows, Pi Durable compacts older turns into a bounded local recap with task and answer excerpts and source references. The recap costs no separate provider call, and the original entries stay in SQLite. Reattach source when an old line or decision is important to a follow-up.

## Runtime and storage

okbrain pins Pi Durable, Pi AI, and Chord at `1.0.0`. It opens `Harness` with the portable `SqliteStorage` and a Bun SQLite adapter. Each transcript has a root conversation with a fixed workspace and model. Alternative review branches use Pi’s native `Conversation.fork()` within that transcript. `Conversation.submit()` admits input under a request ID, and `Submission.wait()` drives generation or recovery. Pi uses the prompt, selected text, and active history. When approved, the source lookup tool reads only the current request’s stored selection and can replay after an interruption. Applying edits, running commands, and making Git changes are operator actions. [Pi Durable announcement](https://earendil.com/posts/pi-durable/) · [Pi Durable package documentation](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/README.md)

Sessions live under `$XDG_DATA_HOME/okbrain/coding` on Linux and macOS, defaulting to `~/.local/share/okbrain/coding`. On Windows they live under `%LOCALAPPDATA%\okbrain\coding`, defaulting to `AppData\Local\okbrain\coding` in the user profile. Each `session-<name>` directory holds an SQLite transcript and an ownership database. A SQLite lock allows one invocation per session and releases on process exit. Keep the session directory on a local filesystem.

The transcript stores prompts, selected source, and responses as local SQLite data. The chosen provider receives the prompt, selected source text, and active conversation history. The source manifest stays local. Protect session directories and backups with the same controls as the source files. Standalone transcript deletion keeps the local SQLite ownership file as the lock anchor for future sessions with that name.

Browser, Mac and IDE projects use a separate `coding-projects` directory within the same per-user application data. Each project has its own transcript directory. The project database holds the run index, review state, metadata-only audit, hashed team tokens, and any provider credentials the operator saved. Workers receive one scoped request and the selected provider credential over their private input pipe. They report admission and completion separately. A server restart leaves unsettled work available by the same request ID. An interrupted provider attempt can still have incurred upstream charges.

### Run isolated workers on Linux

The regular launcher uses a process under the server's operating-system account. A Linux deployment can start each request in a Docker container with a read-only root, a non-root identity, and a private bind mount of the selected session directory. The control plane checks the preview digest against current source before sending the approved snapshot. The worker can then admit it without opening the host workspace. It receives no Docker socket, checkout, personal bundles, other sessions, or project catalog. Resume reads from persisted Pi state and also works when the original checkout has moved or been removed.

Build the image from the same checkout as the host application and set the pinned local image ID in the environment of the okbrain service account. That non-root account must have access to the local Docker socket at `/var/run/docker.sock`. The Coding view shows whether the server uses Docker. If the configured image is unavailable, the run enters an interrupted state and reports the launch error.

```sh
docker build --file packaging/coding-worker/Dockerfile --tag okbrain-coding-worker:local .
export OKB_CODING_WORKER_IMAGE=$(docker image inspect --format '{{.Id}}' okbrain-coding-worker:local)
```

`OKB_CODING_WORKER_NETWORK` selects the deployment's Docker bridge network. The default is `bridge`. A deployment can restrict provider egress through that network. Use `none` for offline verification. Run the following smoke check to exercise the production worker through the local Coding API in disposable directories. It checks the container and network boundary, then closes the controller before copying and restoring its private state. The drill verifies replay after checkout removal, project-token isolation, and expiry records that still prevent replay after a second restore. A missing image fails closed. The drill uses no live provider credential. [Docker runtime controls](https://docs.docker.com/reference/cli/docker/container/run/)

```sh
bun run packaging/coding-worker/smoke.ts "$OKB_CODING_WORKER_IMAGE"
```

### Check a deployment from the app

In the Mac or local web app, open **Coding → Project settings → Deployment checks**. The local operator can review the worker mode, pinned image ID and configured network, project provider and model, credential source, transcript retention policy, and team listener status. The panel shows credential presence without revealing its value. Project member tokens cannot open this panel.

With a writable brain selected on a server using Linux Docker workers, choose **Run offline worker check**. The check looks up the pinned image in local Docker, inspects the configured network, and launches a disposable container with Docker's `none` network. The result lists the observed session mount, filesystem and process controls, and network isolation. Use the passing, failing, or skipped checks to see which controls ran. The probe uses synthetic files and requires no provider account. [Docker `none` network](https://docs.docker.com/engine/network/drivers/none/)

To check provider egress from the intended host, select **Test provider connection**, review the selected model and credential source, then choose **Run provider check**. Reopen Deployment checks and confirm again if the settings or key change. The configured process or Docker worker makes one model metadata request to the provider. The Docker worker uses the configured network and a disposable mount. The request carries only the model identifier and the credential needed for lookup. The panel shows the outcome and, when available, the HTTP status. A passing result verifies outbound HTTPS and model metadata access for that credential. Use a normally approved Coding run to verify generation access. [OpenAI model retrieval](https://developers.openai.com/api/reference/resources/models/methods/retrieve), [Claude model retrieval](https://platform.claude.com/docs/en/api/models/retrieve), [Gemini model retrieval](https://aistudio.google.com/api-reference/models/get-model)

Verify provider access, team access through the deployed HTTPS endpoint, and backup restoration on your actual enterprise host before inviting the team.

### Limit transcript retention

In **Project settings → Transcript retention**, set the number of days to keep inactive sessions. Leave the field blank to keep transcripts until you delete them. Saving a limit checks sessions in the selected project immediately. The Coding server also checks at startup and hourly, processing up to 24 expired sessions per check. Activity includes run status, review, patch application, and activity in any alternative review branch. A running or interrupted request or a pending approved patch protects the entire transcript.

Expiry removes the parent session and its alternative branches through the same recoverable deletion ledger as manual deletion. It clears their run records and the alternatives’ local patch and publication records. Delete the parent session to remove the transcript yourself. The audit, original-run GitHub publication receipts, and expired request IDs remain. GitHub keeps its published branches and pull requests. An expired ID returns an explicit expiration error when retried. If a service uses backups, apply the deployment's retention policy to backup copies separately.

## Apply a reviewed patch locally

After accepting a finished request, choose **Review proposed patch** in **Run history**. If the saved Pi response contains multiple eligible Git diffs, choose the one you want to review. In VS Code and Cursor, choose **Review proposed patch in okbrain** to open the same run in the app. You can also open **Apply a reviewed patch**, select the result, and paste a Git unified diff.

**Preview patch** checks the exact changes in a temporary Git checkout and marks new files in the affected paths. Confirm the preview and choose **Apply to worktree**. The patch can edit existing tracked files and create new regular UTF-8 files within the project scope, up to eight files and a 48 KiB Git unified diff. Use portable unquoted paths. New files remain untracked, and the staging area, commits, and remote stay unchanged. A change to the previewed worktree state or diff requires a fresh preview.

The audit records separate patch-approval and application events. Repeating the same completed approval returns its receipt. After interruption, the same approval can recover against the recorded before or after bytes. Inspect the listed files manually if the worktree matches neither state.

## Review a project on GitHub

Open the project in **Coding**, then open **GitHub → Connection settings** and choose **Detect GitHub remotes**. Select the repository already configured in the project's Git checkout and save the connection. The current integration supports GitHub.com. To read a private repository, use a fine-grained personal access token restricted to that repository with **Issues** and **Pull requests** read permissions. The token stays in the project's local application data. Disconnecting removes the saved binding and credential. [Create a fine-grained personal access token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token)

Choose **Refresh GitHub activity** to load recent open issues and pull requests. The app sends the token and repository requests to GitHub. The activity view displays titles and URLs. Refresh stops if the configured Git remote now points at a different repository.

Choose **Preview issue** next to an issue number to read its Markdown description in the Mac app, local web app, or team workspace. For a long issue, the app shows a shortened preview and links to the full issue. Select **Use issue in new draft** to start a fresh session with the issue title, link, and visible description in the editable task. If you have a draft open, confirm before replacing it. Check the task and repository query, choose **Preview source**, then approve the request as usual. [GitHub issue API](https://docs.github.com/en/rest/issues/issues#get-an-issue)

After accepting a coding request, open **Prepare GitHub review**, choose the accepted request, and enter the base and head branches already on GitHub. Use **Prepare comparison** to open GitHub's review screen. In VS Code and Cursor, choose **Prepare GitHub pull request in okbrain** from an accepted run to open the same form. [Compare branches in GitHub](https://docs.github.com/en/pull-requests/committing-changes-to-your-project/viewing-and-comparing-commits/comparing-commits)

### Publish an applied patch as a new branch

In the Mac or local web app, accept the result and apply its approved patch. In **GitHub → Connection settings**, save a separate fine-grained branch publishing token with **Contents** write access to this repository. Changes to GitHub Actions workflow files may also require **Workflows** write access. Open **Prepare GitHub review**, choose the same run, and enter an existing base branch, an unused head branch name, and a commit message.

Choose **Preview branch**. okbrain checks the original bytes and modes against the selected GitHub base, verifies that each new path is absent on that base, and checks that the worktree still contains the applied patch. The preview shows the base commit and the full file contents that will be sent. Review the contents, confirm, and choose **Publish branch**. Each publication creates one commit on the approved base and creates a new remote ref. Existing branches and the local index stay intact. [GitHub Git trees](https://docs.github.com/en/rest/git/trees) · [Create a Git reference](https://docs.github.com/en/rest/git/refs#create-a-reference)

If the base or applied file contents change before the commit is written, preview again. If a connection drops while GitHub creates the branch, choose **Find or recover branch**. okbrain saves the intended commit before creating the ref and verifies that the remote branch points at that exact commit. The receipt fills in the branch for the pull request workflow.

### Open a pull request

To open a pull request from okbrain, the local owner saves a separate fine-grained **Pull request publishing token** under **Connection settings**. Restrict it to the connected repository and grant **Pull requests** write permission. In **Create a pull request**, enter the title and Markdown, choose whether to open a draft, and preview the exact text and branch comparison. After checking the preview, confirm and choose **Publish to GitHub**. okbrain submits the title, Markdown, branch names, and draft choice. The branches must already exist in that repository. The transcript, excerpts, and local worktree stay on the machine. [GitHub create pull request API](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#create-a-pull-request)

The preview includes a Markdown comment that links GitHub's receipt to the local approval after a lost response or restart. Choose **Find or recover pull request** to look up that receipt. Repeating the same approval returns a recorded result when one is available. If GitHub already has another open pull request for those branches, review the existing comparison. okbrain records approval and publication or recovery in the project audit log.

## Validation status

The HTTP tests exercise admission, interruption, recovery, cancellation, project authorization, retention, review and approved patch replay. A local HTTPS reverse proxy was exercised in Chromium with a project token. The Linux Docker drill exercises offline Pi admission, the worker boundary, fail-closed launch, and a backup and restore using disposable local state. Live provider evaluation needs an independently reviewed set of tasks and an approved provider account. The intended enterprise host, its provider egress, backup policy and access controls still need verification. [Roadmap](../ROADMAP.md)
