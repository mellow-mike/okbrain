# Use okbrain as a second brain

An okbrain bundle is a directory of Markdown notes with Open Knowledge Format metadata. Start with your own notes or use the bundled example.

## Start on macOS or in a browser

Open **okbrain.app** and choose **File → Open Brain Folder** if you have an existing bundle. **File → Open in Browser** opens the same brain in your browser. To start the local web server without the macOS app, run `okb serve --open` from the bundle directory. [Installation and packaging](../packaging/README.md)

On **Home**, enter a **Quick note**, select **Capture**, and open the saved note. Select **Enable search and review** to build the local index. **Search** uses local keywords by default. Open **Review** to see suggested notes and the reasons they surfaced. These actions work offline. **Browse** can open notes before the index is built.

Open **Focused map** with a question, project, or note. Filter by source, date, or private drafts. Each row explains the link direction and can move the map to the linked note.

Use **Sources** to import conversations, browser bookmarks, Markdown, and Notion export files, find web capture and RSS tools, or get to AI settings. The import forms show which brain receives drafts. If you have multiple brains mounted, select a writable brain before importing.

### Manage brain folders

Use **Settings → Brain folders → Add a brain folder** to create a brain in a new or empty directory, or register an existing folder by its absolute path. Create writes a portable OKF index. Registering an existing folder keeps its contents. The new named brain opens immediately and appears in the sidebar picker.

Expand a named mount in **Brain folders** to rename it, set its read-only status, or remove it from the picker. Removing the mount leaves the directory and its contents in place. To change a mount while viewing a read-only brain, switch the sidebar picker to a writable brain first.

## Ask questions with your ChatGPT plan

Sign in through your browser, choose your ChatGPT account and workspace, and grant plan usage. OpenAI offers this integration for eligible ChatGPT Plus and Pro subscribers. The connection authorizes inference for okbrain. To bring over your ChatGPT history, use the export workflow below. [OpenAI’s Sign in with ChatGPT guide](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt)

1. Open **Accounts**, give the connection a label, and select **Start ChatGPT sign-in**. Open **Continue with ChatGPT** and return to okbrain after granting access.
2. Open **Ask with ChatGPT**, check the account, choose a model, and enter a question. **Preview sources** searches locally and leaves private drafts out by default.
3. Expand the source rows and inspect the exact excerpts. Select **Send question and excerpts** to use the displayed account and model. The answer links to verified citations.
4. Switch accounts or select **Sign out** in **Accounts**. A local sign-out also attempts to revoke the grant with OpenAI.

The terminal offers the same account controls for scripted or headless use. Run the following from your bundle directory.

```bash
okb chatgpt connect --account personal
okb chatgpt status
okb chatgpt models
okb index
okb ask-plan 'What did I conclude about spacing my reviews?'
```

`--account` gives the connection a local label. Without it, `connect` uses the selected label or creates `default` on first sign-in. Use `okb chatgpt use personal` to select an existing connection. To choose a specific model, pass `--model <slug>` from the `chatgpt models` list.

`ask-plan` searches the local keyword index and expands matches through the knowledge graph. It sends your question and selected excerpts, titles, and note IDs to OpenAI for the answer. This can include drafts from `db_only/` in the chosen bundle. The answer lists citations that match the supplied context. Use `--json` to inspect the full list of notes supplied as context.

Model calls use the selected account's ChatGPT plan allowance or available credits. If permission, usage, or the connection is unavailable when okbrain needs a model, the command returns an error on that route. An empty retrieval result ends before inference. Account credentials are stored per user outside the bundle. `okb chatgpt disconnect` clears the selected connection's local credentials and attempts remote revocation. If revocation fails, remove the connection from ChatGPT. [ChatGPT usage and connection controls](https://chatgpt.com/settings/usage)

`okb ask` and the app's **Ask** screen use the configured AI provider. Choose the provider, model, and optional endpoint in **Settings**. For an API-backed provider, save its key under **Provider API keys**, or supply its environment variable. Saved keys stay in per-user application data. A local model runs without an API key.

## Import conversations

Request a data export from ChatGPT or Claude and extract the archive locally. Find the conversations JSON file inside it. If the export splits conversations across JSON files, run the importer once for each file. [Export ChatGPT data](https://help.openai.com/en/articles/7260999-exporting-your-chatgpt-history-and-data), [Export Claude data](https://support.claude.com/en/articles/9450526-export-your-claude-data)

In the web app, open **Sources → Conversation exports**, choose the provider, pick the JSON file, and select **Preview import**. Review the draft titles, message counts, and skipped rows, then select **Import drafts**. The local okbrain server reads the selected file and writes the notes into the active brain. **Browse conversation drafts** opens the imported notes. For large archives, the page shows the first 50 rows of each list and the total counts.

Use the terminal for the full row report or when the web app is closed.

```bash
okb import-conversations ~/Downloads/chatgpt/conversations.json --provider chatgpt --dry-run
okb import-conversations ~/Downloads/chatgpt/conversations.json --provider chatgpt
okb import-conversations ~/Downloads/claude/conversations.json --provider claude --dry-run
okb import-conversations ~/Downloads/claude/conversations.json --provider claude
okb index
okb list --type conversation --status draft --detail
okb search 'spaced repetition'
```

Both import flows accept one JSON file up to 128 MiB and write text transcripts as `conversation` drafts under `db_only/conversations/<provider>/`. The import includes user and assistant text from the selected ChatGPT branch or the Claude message list, plus source provenance. Attachments and hidden messages stay in the original export. Existing notes keep their contents when you import the same provider conversation again, including when a newer archive contains additional turns.

## Import bookmarks, Markdown, and Notion pages

In **Sources → Bookmarks and Markdown**, choose the format, name the source, and select the files. Use a browser's bookmarks HTML export for bookmarks. For Notion, extract the **Markdown & CSV** ZIP first, then pick the Markdown files or an extracted folder. Selecting a folder preserves relative paths. Choose up to 500 files and 24 MiB total, or up to 2,000 items in one bookmarks export. [Export Firefox bookmarks](https://support.mozilla.org/en-US/kb/export-firefox-bookmarks-to-backup-or-transfer) · [Export content from Notion](https://www.notion.com/help/export-your-content)

Select **Preview files** to see new, changed, saved, and skipped items. Markdown imports carry text and source paths. Links between selected Markdown notes point to their drafts. Bookmark import keeps folder names and web addresses. CSV tables and attachments appear as skipped items. Review the checkboxes and select **Import selected drafts**.

Use the same source name and relative paths for a later import. A Notion page ID in the exported filename also identifies renamed pages. A changed source is an optional new draft. Earlier drafts retain any local edits, and files absent from the new selection leave the existing notes intact. Save location and source history stay within the selected brain.

Expand a source in **Import history** to review recent imports and open drafts. **Import from this source again** reuses the format and source name. The history is derived from saved draft provenance and follows the drafts if you move the bundle. Deleting a draft removes it from the history. Earlier ChatGPT and Claude drafts may lack the date of import.

### Connect selected Notion pages

Open **Sources → Live Notion pages**. A Notion workspace owner can create an internal connection with **Read content** access and share the desired page using **Add connections** in Notion. In okbrain, enter the internal connection token, acknowledge access to the selected pages, and connect. okbrain stores the token in per-user application data. [Set up an internal Notion connection](https://developers.notion.com/docs/authorization#internal-connection-auth-flow-set-up)

Enter a shared Notion page URL or ID and select **Preview page**. This reads the page text using Notion's Markdown API. The preview indicates when the response omits or truncates blocks. Imported drafts include the source page link. Embedded media and meeting transcripts are excluded. **Save private draft** saves the reviewed snapshot locally, and a later import of changed text creates a separate draft. Select **Disconnect Notion** to remove the local token, and remove the page's shared connection in Notion to revoke its access. [Notion's page Markdown API](https://developers.notion.com/reference/retrieve-page-markdown)

`okb index` builds or repairs the local keyword and graph index. Import refreshes an existing index and leaves embeddings for a separate `okb embed` run. If you configure a remote embedding provider, that run can send note text to it. The regular `okb search` command can also use configured remote embedding and reranking providers when those retrieval arms are available.

## Open and share a brain

```bash
okb serve --open
okb export-viz
```

The local GUI can browse, search, and edit conversation drafts in its selected bundle. `okb sync` keeps untracked `db_only/` files out of Git and omits private note metadata from the shared root index and log. When managing the bundle directly with Git, verify that `db_only/` is ignored and untracked. **Settings → Export viz.html** omits private drafts by default. To embed them in the HTML, explicitly select **Include private drafts in graph export** and confirm. The CLI equivalent is `okb export-viz --include-private`.

## Connect an MCP client

Select the brain you want to share and open **Settings → MCP agent access**. Choose **Start MCP HTTP**, open **Connection details**, and copy the loopback URL and Authorization header into a client that supports Streamable HTTP with custom headers. The default is read-only. Enable **Allow trusted clients to write to this brain** before starting if the client should edit a writable brain.

The listener is bound to the selected brain and issues a fresh token each time it starts. Keep the token private. Choose **Stop MCP HTTP** to disconnect it. If you change the bound brain's path or remove its write permission while trusted access is active, stop and start the listener with the updated mount.

### Claude Desktop and stdio clients

In Claude Desktop, open **Settings → Developer → Edit Config** and add an MCP server entry. Use absolute paths to an installed `okb` executable and the bundle you want to share. Merge this entry with any existing MCP servers and restart Claude Desktop. [MCP setup guide for Claude Desktop](https://modelcontextprotocol.io/docs/develop/connect-local-servers)

```json
{
  "mcpServers": {
    "okbrain": {
      "command": "/absolute/path/to/okb",
      "args": ["--bundle", "/absolute/path/to/brain", "mcp"]
    }
  }
}
```

Claude Desktop launches `okb mcp` locally over stdio and uses your native Claude account for the conversation. This setup uses an executable and arguments in the client configuration. The default tool access is read-only and includes private drafts in the configured bundle. Tool outputs can be shared with Claude when the connector is used. Choose a separate bundle if you only want to share a subset of notes. Direct Claude inference from `okb ask` uses `ANTHROPIC_API_KEY` and Anthropic API billing. [Claude’s local MCP guide](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop), [Anthropic’s authentication guidance](https://code.claude.com/docs/en/legal-and-compliance)
