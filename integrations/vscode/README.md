# okbrain Coding for VS Code and Cursor

Install `okbrain-coding.vsix` with **Extensions → Install from VSIX**. Open a trusted local workspace and start the okbrain macOS app or the local web server. The extension discovers the macOS app or the default server address. Set **okbrain: Server** in user settings to use a different local port.

1. Choose **okbrain: Open Coding Workspace** from the Command Palette and register the repository, permitted folders, model, and provider credential.
2. Save a local file. Open **okbrain: Preview Active File for Coding Request** in the editor context menu or Command Palette.
3. Enter the request and session name. Inspect the preview in the editor, then select **Send Request**. Choose **Send with Source Lookup** to let Pi look up line numbers in that approved file.
4. Choose **okbrain: Inspect and Review Coding Runs** to reopen a result, record a review, cancel an active run, or resume a saved request. Choose **Refresh** while a request runs to see Pi's task counts and read the answer so far.
5. For a saved request, choose **View saved request source** to open a read-only editor with the original task and the exact files or excerpts supplied to Pi.

The local server enforces project scope and binds the approved preview to the source bytes. Requests use the project model and any active session history. Editor review records a decision in okbrain. On an accepted result, choose **Prepare GitHub pull request in okbrain** to open the web workflow. There you can publish an applied patch on a new branch and create a GitHub pull request.
