# Use okbrain as a second brain

An okbrain bundle is a directory of Markdown notes with Open Knowledge Format metadata. Start with your own notes or use the bundled example.

## Start on macOS or in a browser

Open **okbrain.app** and choose **File → Open Brain Folder** if you have an existing bundle. **File → Open in Browser** opens the same brain in your browser. To start the local web server without the macOS app, run `okb serve --open` from the bundle directory. [Installation and packaging](../packaging/README.md)

On **Home**, enter a **Quick note**, select **Capture**, and open the saved note. Select **Enable search and review** to build the local index. **Search** uses local keywords by default and highlights matches in result excerpts. Open **Review** to see suggested notes and the reasons they surfaced. Overdue claims link directly to the outcome controls. These actions work offline. **Browse** can open notes before the index is built.

Open **Inbox** and choose **File note** on an unread capture. Enter a new concept ID such as `projects/garden-notes`, preview the destination, then confirm. Filing preserves the note and its provenance in the chosen folder and removes the inbox tag. A forwarding note at the old address lets existing links reach the filed note. Links to old heading anchors land on the forwarding note, and the graph shows the forward as a separate link. Keep private notes within `db_only/`. If interrupted after copying, preview the same destination and confirm to finish an unchanged filing.

The terminal equivalent is `okb inbox file <inbox-id> <destination-id>`. Run it again with `--confirm <preview-id>` to approve the displayed move.

In **Review**, you can change the queue size and the number of days to snooze notes. To ask your configured model to relate queue items to recent notes, opt in, select a retrieval profile, and choose **Update queue**. This sends note titles and descriptions to the configured model. The lean profile skips that model call.

Open **Add** to give a capture its own title and tags, include a quote and comment with a web clip, or import a Markdown file or folder from the local server's disk with a default note type.

Open **Focused map** with a question, project, or note. Filter by source, date, or private drafts. Each row explains the link direction and can move the map to the linked note.

In a note's links panel, set **Neighborhood depth** and choose **Show links** to see which notes are within that many hops. In **Stats → Path between two concepts**, set **Max path hops** to bound the shortest-path search.

Use **Sources** to import conversations, bookmarks, Markdown, Notion exports, email, and calendar events. It also links to web capture, RSS, and AI settings. The import forms show which brain receives drafts. If you have multiple brains mounted, select a writable brain before importing.

In **Add → Manage saved feeds**, enter one URL per line and select **Save feed URLs**. The list is shared across brain folders on this device. In **Pull RSS feeds**, enter one URL or leave it blank to pull every saved feed into the selected brain. Set **Max new items per feed** to limit how many entries each feed can add. The terminal equivalent for viewing the saved list is `okb rss settings`.

### Manage brain folders

Use **Settings → Brain folders → Add a brain folder** to create a brain in a new or empty directory, or register an existing folder by its absolute path. Create writes a portable OKF index. Registering an existing folder keeps its contents. The new named brain opens immediately and appears in the sidebar picker.

Choose **Use as default brain** in Settings to select the active writable folder for `okb` launches without a folder argument. The macOS app remembers the last folder opened from its File menu.

In **Settings → Folder change log**, enter a public folder path such as `notes/projects` to create its `log.md`. It records subsequent changes in that folder and its descendants. The root log records changes across the brain. Private drafts are excluded from both logs. The CLI equivalent is `okb log create notes/projects`.

In **Settings → Markdown indexes**, choose **OKF reference headings and relative links** for a brain you share with reference tooling. The layout choice travels in the root `index.md`. You can restore the grouped layout at any time, including with `okb manifests style grouped`.

In **Settings → Local note usage**, choose **Turn on local counts** for the current brain. Notes show the last 30 days of explicit opens and citations verified by Ask. A note’s internal sources also show their own local counts when recorded. These aggregate counts stay in per-user application data on this device. They survive an index rebuild and exclude MCP activity. **Turn off and clear counts** deletes the current brain’s counts. In the CLI, use `okb usage settings on` and read the `localUsage` field from `okb read <id> --json`.

### Choose a search cache

SQLite is ready to use with the app. To use a local PostgreSQL database, install pgvector in the database and give your database user permission to create its own schema. In **Settings → Search and graph cache → Change cache backend**, enter the connection URL and choose **Connect and use PostgreSQL**. Use a loopback address such as `127.0.0.1` or `[::1]` so searches and ChatGPT source previews stay on this computer. The database stores searchable note text, including private drafts, and graph data. It also stores any embeddings you choose to build. Use a database you trust.

The app checks the database before saving the selection. A connection URL stays in private per-user application data. Each brain uses a separate schema. Under **Settings → Maintenance**, choose **Re-index** to populate search and graph. Run **Embed** if you use vector search. PostgreSQL and SQLite use different keyword indexes, so the order of search hits can differ. Markdown and YAML remain the source for either cache.

Choose **Use SQLite** to switch back and remove the saved connection URL. Choose **Re-index** again to pick up any changes since you used SQLite. Old derived tables stay in your PostgreSQL database. Your database administrator can remove the brain’s cache schema.

In the CLI, set a local environment variable containing the URL, then use `okb cache-settings postgres --connection-env OKB_CACHE_URL`. The commands `okb cache-settings` and `okb cache-settings sqlite` show the selection and switch to SQLite, respectively.

### AI defaults

Set **Default retrieval profile** on a named brain folder to choose how Search and Ask use that brain by default. Use **Use app default** to inherit the global retrieval setting. A profile selected for a specific search or answer takes precedence.

In **AI defaults for this brain**, choose a chat provider and an embedding provider independently. You can set a model for either capability. **Use app default** inherits the provider configured for the app. Leave a model blank to inherit the app's model for that provider or use the selected provider's default. Command overrides and `OKB_*` environment settings take precedence. Provider keys stay in the app's per-user settings. A custom endpoint carries over only when it belongs to the selected provider.

On **Home** in an empty, writable brain, open **Start with a template** to choose **Personal knowledge** or **Projects and decisions**. Each adds one editable `start-here.md` guide with suggested types and tags. You can also begin by capturing a note or importing your own files. The terminal equivalents are `okb brain-templates` to list the starters and `okb init --template personal` or `okb init --template projects` to add one from the bundle folder. Add `--no-default-bundle` to keep your current default brain.

Expand a named mount in **Brain folders** to rename it, set its read-only status, or remove it from the picker. Removing the mount leaves the directory and its contents in place. To change a mount while viewing a read-only brain, switch the sidebar picker to a writable brain first.

If you also edit notes in another app, open **Settings → Watch brain folder** and select **Start watching**. okbrain refreshes keyword search and graph links after saves, moves, and deletions. The watch runs while the macOS app or local server is open. Select **Stop watching** to end it sooner. The terminal equivalent is `okb watch`. Watching a named brain stops if its folder or write permission changes. Embeddings can be refreshed separately with **Settings → Embed**.

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

`ask-plan` searches the local keyword index and expands matches through the knowledge graph. It sends your question and selected excerpts, titles, and note IDs to OpenAI for the answer. Add `--include-private` to allow private notes in that context. The answer lists citations that match the supplied context. Use `--json` to inspect the full list of notes supplied as context.

Model calls use the selected account's ChatGPT plan allowance or available credits. If permission, usage, or the connection is unavailable when okbrain needs a model, the command returns an error on that route. An empty retrieval result ends before inference. Account credentials are stored per user outside the bundle. `okb chatgpt disconnect` clears the selected connection's local credentials and attempts remote revocation. If revocation fails, remove the connection from ChatGPT. [ChatGPT usage and connection controls](https://chatgpt.com/settings/usage)

`okb ask` and the app's **Ask** screen use the configured AI provider. Choose the provider, model, and optional endpoint in **Settings**. For an API-backed provider, save its key under **Provider API keys**, or supply its environment variable. Saved keys stay in per-user application data. A local model runs without an API key.

Select **Restore default chat endpoint** or **Restore default embedding endpoint**, then save to remove a custom endpoint from your settings.

**Ask** displays text as the provider returns it and verifies citations when the answer completes. **Stop** cancels the in-flight answer. Providers that return a complete response display it in one piece. Use `okb ask --stream 'your question'` for incremental terminal output. `--json` returns a single completed result.

In **Settings → Enrichment**, enter comma-separated **Allowed path prefixes** to restrict fetching to those paths. Denied path prefixes still apply. In **Settings → OKF v0.2 migration**, enter **Actor to credit** to attribute legacy timestamps and reviews during migration. Preview the changes before choosing **Upgrade bundle**.

## Import conversations

Request a data export from ChatGPT or Claude and extract the archive locally. Find the conversations JSON file inside it. If the export splits conversations across JSON files, run the importer once for each file. [Export ChatGPT data](https://help.openai.com/en/articles/7260999-exporting-your-chatgpt-history-and-data), [Export Claude data](https://support.claude.com/en/articles/9450526-export-your-claude-data)

In the web app, open **Sources → Conversation exports**, choose the provider, pick the JSON file, and select **Preview import**. Review the draft titles, message counts, and skipped rows, then select **Import drafts**. Use **Next draft rows** and **Next skipped rows** to review every row in reports with more than 50 entries. The local okbrain server reads the selected file and writes private notes into the active brain. **Browse conversation drafts** opens the imported notes.

The CLI also supports reviewing and importing an export.

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

## Import files and Notion pages

In **Sources → Import files**, choose the format, name the source, and select the files. Use a browser's bookmarks HTML export for bookmarks. For Notion, extract the **Markdown & CSV** ZIP first, then pick the Markdown files or an extracted folder. Selecting a folder preserves relative paths. Choose up to 500 files and 24 MiB total, or up to 2,000 items in one bookmarks export. [Export Firefox bookmarks](https://support.mozilla.org/en-US/kb/export-firefox-bookmarks-to-backup-or-transfer) · [Export content from Notion](https://www.notion.com/help/export-your-content)

Select **Preview files** to see new, changed, saved, and skipped items. Markdown imports carry text and source paths. Links between selected Markdown notes point to their drafts. Bookmark import keeps folder names and web addresses. CSV tables and attachments appear as skipped items. Review the checkboxes and select **Import selected drafts**.

Use the same source name and relative paths for a later import. A Notion page ID in the exported filename also identifies renamed pages. A changed source is an optional new draft. Earlier drafts retain any local edits, and files absent from the new selection leave the existing notes intact. Save location and source history stay within the selected brain.

Expand a source in **Import history** to review recent imports and open drafts. **Import from this source again** reuses the format and source name. The history is derived from saved draft provenance and follows the drafts if you move the bundle. Editing a draft keeps its source identifiers and import history unless you remove the source. Deleting a draft removes it from the history. Earlier ChatGPT and Claude drafts may lack the date of import.

### Import email and calendar files

In **Sources → Import files**, choose **Email (.eml)** or **Calendar (.ics)**. Select the files, choose **Preview files**, and select the items you want to save as private drafts. These imports work offline. The app accepts up to 2 MiB per file, 24 MiB per selection, 2,000 preview items, and 128 KiB of readable text per draft.

Email drafts keep the subject, sender, date, and readable message text. The importer converts HTML-only messages to inert text and skips attachments, including forwarded messages attached as files. Calendar drafts keep the event time and any supplied time zone, summary, location, and description. A recurring series is one draft with its rule. Explicit exceptions appear as their own drafts. The importer skips attachments and alarms and never schedules or expands an event.

Use the same source name to preview later exports. Email Message-IDs and calendar UIDs identify the same items when filenames change. An email without a Message-ID uses its file path. Existing drafts retain edits when you save a changed source as a separate draft.

The terminal uses the same two steps. First run `okb source import ~/Downloads/schedule.ics --kind calendar --name "Calendar export"`. To save selected rows, repeat the command with `--preview <receipt> --selected 1,3`. For email use `--kind email` and an `.eml` file. A directory imports matching files from its top level.

### Connect selected Notion pages

Open **Sources → Live Notion pages**. A Notion workspace owner can create an internal connection with **Read content** access and share the desired page using **Add connections** in Notion. In okbrain, enter the internal connection token, acknowledge access to the selected pages, and connect. okbrain stores the token in per-user application data. [Set up an internal Notion connection](https://developers.notion.com/docs/authorization#internal-connection-auth-flow-set-up)

Enter a shared Notion page URL or ID and select **Preview page**. This reads the page text using Notion's Markdown API. The preview indicates when the response omits or truncates blocks. Imported drafts include the source page link. Embedded media and meeting transcripts are excluded. **Save private draft** saves the reviewed snapshot locally, and a later import of changed text creates a separate draft. Select **Disconnect Notion** to remove the local token, and remove the page's shared connection in Notion to revoke its access. [Notion's page Markdown API](https://developers.notion.com/reference/retrieve-page-markdown)

**Settings → Re-index** builds or repairs the local keyword and graph index. Import refreshes an existing index. Use **Settings → Embeddings** to refresh that cache separately. Set **Max notes this run** to cap how many notes are sent for embedding. The provider and model override fields apply to that run. Changing the provider or model rebuilds the vector cache. If you choose a remote embedding provider, the run can send note text to it. The regular `okb search` command can also use configured remote embedding and reranking providers when those retrieval arms are available.

## Open and share a brain

```bash
okb serve --open
okb export-viz
```

The local app can browse, search, and edit conversation drafts in its selected bundle. **Settings → Export viz.html** omits private drafts by default. To embed them in the HTML, explicitly select **Include private drafts in graph export** and confirm. The CLI equivalent is `okb export-viz --include-private`. Select **Embed app fonts in graph export** or pass `--fonts` to include the app's typefaces for offline viewing.

### Set up Git sync

In the Mac or web app, open **Settings → Git sync** for a writable brain. Set the name and email Git should record on commits for this brain. Saving identity creates a local repository if needed. Choose **Sync now** to make a local commit. Enter a commit message or leave it blank to use the timestamped default.

For remote sync, create an empty repository with your Git host. Add its HTTPS URL as the brain’s `origin` and review the displayed fetch and push destinations. Saving changes the local repository configuration. Choose **Sync now** to contact the host. Git can use the credential helper configured on your computer. Keep credentials out of the remote URL. If Git cannot publish to the remote, the local commit remains available for retry. [Git credentials](https://git-scm.com/docs/gitcredentials) · [Git remotes](https://git-scm.com/docs/git-remote)

For an origin connected through Settings on GitHub.com, open **GitHub credentials**. Enter your GitHub username and a fine-grained token limited to this repository with **Contents** read and write access. okbrain saves it in your local application data and uses it for fetch and push when you choose **Sync now** or run `okb sync` directly. Saving the token makes no network request. Use **Remove GitHub credential** to clear the app’s copy. Revoke it from your GitHub account if you want to end its access on GitHub. [GitHub personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)

Sync keeps untracked `db_only/` files out of Git and omits private note metadata from the shared root index and log. Remote sync stops when Git history still contains a `db_only/` directory, even after its files have been deleted.

If Git pauses a rebase, open the conflict in **Git sync**. For regular UTF-8 files up to 256 KiB, compare the saved local commit with the upstream version, then choose a version or edit merged text. After resolving each conflict, continue the rebase. You may also abort the rebase to restore the original branch, which discards conflict-resolution edits from that rebase. Review the result before using **Sync now** to publish it. The app refreshes the existing keyword and graph index after the rebase finishes. [Git rebase](https://git-scm.com/docs/git-rebase)

### Export notes to Markdown or Obsidian

From a writable brain, open **Settings → Markdown and Obsidian export**. Enter the absolute path to a new folder outside the brain. The new folder's parent must already exist. Choose **Export Markdown**, then use Obsidian's **Open folder as vault** or open the files in any Markdown editor.

The export copies the note folders and YAML frontmatter, including custom fields. Markdown body links between exported notes use relative paths. Generated indexes, logs, attachments, app caches, and private notes are omitted by default. Text and metadata already present in exported notes remain visible, including references to notes or attachments outside the export. Review the folder before sharing it.

Select **Include private drafts in Markdown export** and confirm to include those notes. The CLI equivalent is `okb export-markdown /absolute/path/to/new-vault` with the optional `--include-private` flag. An export supports up to 10,000 notes, 16 MiB per source note, and 256 MiB total.

### Keep a note private

Set an explicit concept ID and select **Keep this note private** when creating a note. For an existing unpublished note, open **Edit → Note privacy → Keep note private**. The equivalents are `okb write <id> --type note --title "Title" --description "Summary" --private` and `okb keep-private <id>`. Both save `db_only: true` in the note's YAML. Notes under a `db_only/` directory remain private.

Private notes remain in local search. Git sync keeps them out of staging and records their paths only in the repository's local `info/exclude`. Generated public indexes and logs omit them. okbrain refuses to change the privacy of a note already tracked or recorded by Git, and sync stops if Git currently tracks a private path. Earlier Git history and previously shared copies remain visible to their existing recipients.

Ask, ChatGPT previews, focused maps, embeddings, and both export workflows have an explicit private-note option. Ask and embeddings send private text only when enabled for that request. Web enrichment excludes private notes. Authorized MCP clients can still read local notes within their connected brain.

## Verify a local CSV computation

Add an **Attested Computation** concept and place the source CSV inside the writable brain's folder. On the concept screen, open **Configure CSV computation** and save the contract. This example counts rows where the integer `year` column equals the supplied `year` parameter.

```json
{
  "parameters": [{ "name": "year", "type": "integer", "required": true }],
  "executor": {
    "source": "data/revenue.csv",
    "operation": "count",
    "filters": [{ "column": "year", "parameter": "year" }]
  }
}
```

Use `operation: "sum"` with a `column` for integer sums. Use whole units such as cents when decimals need exact results. The runtime accepts a UTF-8 CSV with a header, up to 256 KiB, 10,000 data rows, 32 columns, and four equality filters. Filter values can be strings, integers, or booleans. Declare a private concept for data under `db_only/`.

Enter the parameter values and choose **Preview computation** to review the exact contract and source text. Approve the selection, then choose **Run approved computation**. The receipt includes the result, parameter values, and hashes of the plan and source. You can copy the receipt for another review.

Choose **Verify receipt** to recompute against the original contract and current CSV. A change to the contract, source bytes, or claimed result requires a new matching receipt. To record a passing verification on the concept, separately approve and choose **Record process verification**. okbrain saves a `process:okbrain-csv-aggregate-v1` event and scoped receipt hashes. The event applies to the hashed inputs and result. **Settings → Doctor** reports syntax and conformance.

The CLI equivalents are `okb computation configure`, `okb computation preview`, `okb computation run`, `okb computation verify`, and `okb computation attest`. Run requires the preview's `--approval` digest. Attest requires the verification digest and `--confirm`. The built-in CSV runtime runs locally from the Mac app, local web app, and CLI. External contracts, including the Acme examples, remain available for reference.

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
