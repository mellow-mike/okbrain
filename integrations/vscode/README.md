# okbrain Coding for VS Code and Cursor

Install `okbrain-coding.vsix` with **Extensions → Install from VSIX**.

## Team workspace

In the Command Palette, choose **okbrain: Connect to Team Workspace** and enter the HTTPS origin and project token from your operator. The editor keeps this project connection in its secret store.

- **okbrain: Preview Team Coding Request** previews server-side excerpts from a saved preset or an explicit task and repository query. Review the exact text and approve sending it with the task and active session history. The team server supplies the repository, so a local clone is optional.
- **okbrain: Inspect and Review Team Coding Runs** opens progress, results, and saved request source. You can compare a finished alternative run with its original and review either result. Cancel and resume are available for the team’s regular requests.
- **okbrain: Open Team Workspace in Browser** opens the HTTPS Work sign-in page. **okbrain: Disconnect from Team Workspace** removes the saved editor connection.

See the [team setup guide](https://github.com/mellow-mike/okbrain/blob/main/docs/CODING.md#give-a-team-member-access) for issuing project tokens and configuring the HTTPS listener.

## Local operator workspace

Open a trusted local workspace and start the okbrain macOS app or the local web server. The extension discovers the macOS app or the default server address. Set **okbrain: Server** in user settings to use a different local port.

1. Choose **okbrain: Open Coding Workspace** from the Command Palette to open the app’s **Work** workspace. Register the repository, permitted folders, model, and provider credential.
2. Save a local file. Open **okbrain: Preview Active File for Coding Request** in the editor context menu or Command Palette.
3. Enter the request and session name. Choose whether to allow source lookup, review the read-only preview, and select **Send Request**. Leaving the preview invalidates the approval.

   To keep a record of the selection first, choose **Copy Source Manifest** on the same confirmation. It copies JSON with the preview ID and each file's path, size or line range, and SHA-256 digest. The file text and your task are left out. Copying makes no request to okbrain or the provider. The confirmation returns so you can send the reviewed request. Repository, preset, and team request previews offer the same action.
4. Choose **okbrain: Inspect and Review Coding Runs** to reopen a result, record a review, cancel an active run, or resume a saved request. Inspection shows the session’s estimated active context, input limit, output allowance, and model window. Choose **Refresh** while a request runs to see Pi's task counts and read the answer so far.
5. For a saved request, choose **View saved request source** to open a read-only editor with the original task and the exact files or excerpts supplied to Pi.
6. On an accepted result, choose **Review proposed patch in okbrain** to open that request in the patch review form. Preview the diff in okbrain and confirm it before applying.

Choose **Preview alternative branch in okbrain** on an eligible accepted run to open its exact entry in the local Work workspace. Preview and approve the new review session there.

Choose **Compare with original** on a finished alternative run to open both saved answers, review decisions, source references, and request usage in a read-only editor. An accepted alternative has the same patch and GitHub handoffs as an accepted original run.

In either workspace, choose **Accept result** or **Request changes** on a finished run. Enter optional single-line feedback of up to 4 KiB, press Enter with a blank field to record just the decision, or press Esc to cancel. **Review history** shows recent decisions and feedback in the read-only run inspector for authorized project reviewers. If another review arrives first, choose **Refresh Review** to read it and reopen the same action with your feedback filled in.

Choose **Copy run report** on a saved request to copy JSON with the run status, model, context limits, usage, and relative source references. The task, response, and source contents stay in their existing inspection views. Project members can copy the report for runs they can inspect.

With the registered project folder open, choose **okbrain: Preview Repository Coding Request** from the Command Palette. Enter the task and search query, choose approved repository directories, and narrow them to subdirectories if needed. Choose a session and review the fresh excerpts and lookup choice before selecting **Send Request**.

Choose **okbrain: Preview Saved Request Preset** to start with a saved task and repository profile. Each request uses a fresh source preview and approval. Create or edit presets in Work.

Choose **Start fresh context** from a finished run’s actions to leave earlier turns out of future requests in that session. Enter a single-line note under **Optional handoff for the next request** to keep a decision or next step, or press Enter to leave it blank. Review the session and exact note, then confirm **Start Fresh Context**. The note accompanies the next request to the session’s provider. Saved runs, sources, review decisions, and usage remain available.

Choose **Compact context locally** from a finished run’s actions to keep recent turns and make a short local recap of older active context. Review the session and choose **Compact Context**. The recap uses no provider call, and saved runs stay available. If the editor shows **Local compaction is awaiting recovery**, reopen the action and choose **Resume Compaction** to finish before sending another request.

Repository map imports and orchestration previews are available in Work. The editor can inspect saved runs and their source. The local server enforces project scope and binds the approved preview to the source bytes. Requests use the project model and any active session history. Editor review records a decision in okbrain. On an accepted result, choose **Prepare GitHub pull request in okbrain** to open the web workflow. There you can publish an applied patch on a new branch and create a GitHub pull request.
