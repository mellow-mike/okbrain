# okbrain Coding for VS Code and Cursor

Install `okbrain-coding.vsix` with **Extensions → Install from VSIX**.

## Team workspace

In the Command Palette, choose **okbrain: Connect to Team Workspace** and enter the HTTPS origin and project token from your operator. The editor keeps this project connection in its secret store.

- **okbrain: Preview Team Coding Request** previews server-side excerpts from a saved preset or an explicit task and repository query. Review the exact text and approve sending it with the task and active session history. The team server supplies the repository, so a local clone is optional.
- **okbrain: Inspect and Review Team Coding Runs** opens progress, results, and saved request source. You can review, cancel, or resume a run.
- **okbrain: Open Team Workspace in Browser** opens the HTTPS workspace sign-in page. **okbrain: Disconnect from Team Workspace** removes the saved editor connection.

See the [team setup guide](https://github.com/mellow-mike/okbrain/blob/main/docs/CODING.md#give-a-team-member-access) for issuing project tokens and configuring the HTTPS listener.

## Local operator workspace

Open a trusted local workspace and start the okbrain macOS app or the local web server. The extension discovers the macOS app or the default server address. Set **okbrain: Server** in user settings to use a different local port.

1. Choose **okbrain: Open Coding Workspace** from the Command Palette and register the repository, permitted folders, model, and provider credential.
2. Save a local file. Open **okbrain: Preview Active File for Coding Request** in the editor context menu or Command Palette.
3. Enter the request and session name. Inspect the preview in the editor, then select **Send Request**. Choose **Send with Source Lookup** to let Pi look up line numbers in that approved file.
4. Choose **okbrain: Inspect and Review Coding Runs** to reopen a result, record a review, cancel an active run, or resume a saved request. Inspection shows the session’s estimated active context, input limit, output allowance, and model window. Choose **Refresh** while a request runs to see Pi's task counts and read the answer so far.
5. For a saved request, choose **View saved request source** to open a read-only editor with the original task and the exact files or excerpts supplied to Pi.
6. On an accepted result, choose **Review proposed patch in okbrain** to open that request in the patch review form. Preview the diff in okbrain and confirm it before applying.

With the registered project folder open, choose **okbrain: Preview Saved Request Preset** from the Command Palette. Select a preset and session, then choose whether Pi can look up lines within the selected excerpts. Review the saved task and the fresh repository excerpts before choosing **Send Request**. Create or edit presets in the okbrain Coding workspace.

Choose **Start fresh context** from a finished run’s actions to leave earlier turns out of future requests in that session. Enter a single-line note under **Optional handoff for the next request** to keep a decision or next step, or press Enter to leave it blank. Review the session and exact note, then confirm **Start Fresh Context**. The note accompanies the next request to the session’s provider. Saved runs, sources, review decisions, and usage remain available.

Choose **Compact context locally** from a finished run’s actions to keep recent turns and make a short local recap of older active context. Review the session and choose **Compact Context**. The recap uses no provider call, and saved runs stay available. If the editor shows **Local compaction is awaiting recovery**, reopen the action and choose **Resume Compaction** to finish before sending another request.

The local server enforces project scope and binds the approved preview to the source bytes. Requests use the project model and any active session history. Editor review records a decision in okbrain. On an accepted result, choose **Prepare GitHub pull request in okbrain** to open the web workflow. There you can publish an applied patch on a new branch and create a GitHub pull request.
