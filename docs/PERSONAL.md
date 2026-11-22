# Use okbrain as a second brain

An okbrain bundle is a directory of Markdown notes with Open Knowledge Format metadata. Start with your own notes or use the bundled example. Run the commands below from your brain directory, or select it with `okb --bundle /path/to/brain`.

## Ask questions with your ChatGPT plan

Sign in through your browser, choose your ChatGPT account and workspace, and grant plan usage. OpenAI offers this integration for eligible ChatGPT Plus and Pro subscribers. The connection authorizes inference for okbrain. To bring over your ChatGPT history, use the export workflow below. [OpenAI’s Sign in with ChatGPT guide](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt)

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

`okb ask` and the web app's Ask screen use the configured AI provider. To run those with an API-backed provider, set its API key in your environment. Usage follows that provider's API account. Choose a local model for inference on your machine.

## Import conversations

Request a data export from ChatGPT or Claude and extract the archive locally. Find the conversations JSON file inside it. If the export splits conversations across JSON files, run the importer once for each file. [Export ChatGPT data](https://help.openai.com/en/articles/7260999-exporting-your-chatgpt-history-and-data), [Export Claude data](https://support.claude.com/en/articles/9450526-export-your-claude-data)

```bash
okb import-conversations ~/Downloads/chatgpt/conversations.json --provider chatgpt --dry-run
okb import-conversations ~/Downloads/chatgpt/conversations.json --provider chatgpt
okb import-conversations ~/Downloads/claude/conversations.json --provider claude --dry-run
okb import-conversations ~/Downloads/claude/conversations.json --provider claude
okb index
okb list --type conversation --status draft --detail
okb search 'spaced repetition'
```

The import accepts one JSON file up to 128 MiB. The preview reports which records would become notes and gives skip reasons by row. The import runs locally and writes text transcripts as `conversation` drafts under `db_only/conversations/<provider>/`. It includes user and assistant text from the selected ChatGPT branch or the Claude message list, plus source provenance. Attachments and hidden messages stay in the original export. Existing notes keep their contents when you import the same provider conversation again, including when a newer archive contains additional turns.

`okb index` builds or repairs the local keyword and graph index. Import refreshes an existing index and leaves embeddings for a separate `okb embed` run. If you configure a remote embedding provider, that run can send note text to it. The regular `okb search` command can also use configured remote embedding and reranking providers when those retrieval arms are available.

## Open and share a brain

```bash
okb serve --open
okb export-viz
```

The local GUI can browse, search, and edit conversation drafts in its selected bundle. `okb sync` keeps untracked `db_only/` files out of Git and omits private note metadata from the shared root index and log. When managing the bundle directly with Git, verify that `db_only/` is ignored and untracked. `okb export-viz` omits notes under `db_only/` by default. Pass `--include-private` only when you want the generated HTML to contain those notes and their contents.

## Connect Claude Desktop over MCP

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

Claude Desktop runs `okb mcp` locally and uses your native Claude account for the conversation. The default tool access is read-only and includes private drafts in the configured bundle. Tool outputs can be shared with Claude when the connector is used. Choose a separate bundle if you only want to share a subset of notes. Direct Claude inference from `okb ask` uses `ANTHROPIC_API_KEY` and Anthropic API billing. [Claude's local MCP guide](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop), [Anthropic’s authentication guidance](https://code.claude.com/docs/en/legal-and-compliance)
