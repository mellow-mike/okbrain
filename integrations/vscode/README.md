# okbrain Coding for VS Code and Cursor

Install `okbrain-coding.vsix` with **Extensions → Install from VSIX**. Open a trusted local workspace and start the okbrain macOS app or the local web server. The extension discovers the macOS app or the default server address. Set **okbrain: Server** in user settings to use a different local port.

1. Choose **okbrain: Open Coding Workspace** from the Command Palette and register the repository, permitted folders, model, and provider credential.
2. Save a local file. Open **okbrain: Preview Active File for Coding Request** in the editor context menu or Command Palette.
3. Enter the request and session name. Inspect the preview in the editor, then select **Send Request** in the notification.
4. Choose **okbrain: Inspect and Review Coding Runs** to reopen a result, record a review, cancel an active run, or resume a saved request.

The local server enforces project scope and binds the approved preview to the source bytes. Requests use the project model and any active session history. Editor review records a decision in okbrain. Edit and publish code through your repository tools.
