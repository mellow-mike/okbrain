# Clip web pages and manage the reading inbox

Clip saves the readable part of a web page as a Markdown reference. Add a quote or note to capture what you wanted to remember.

```bash
okb clip 'https://example.com/article' --tags research --note 'Read the section on retrieval.'
okb index                      # create the index if the brain does not have one
okb inbox
okb inbox read references/article
```

Replace `references/article` with the concept ID printed by `okb clip`. Use `--quote` to save a passage or `--read` to skip the automatic `inbox` tag. Marking an item read removes its `inbox` tag and preserves its content and change timestamp. The inbox includes any concept with that tag and lists the most recent first. Unread items also receive a boost in the [review queue](FEATURE-RESURFACE.md).

## Clip from a browser

Run `okb serve --open` and use the **Clip** form in **Add**. The bookmarklet in **Add** or **Settings** can be saved to your bookmarks bar and used on the page you want to clip. To print the same bookmarklet on the command line, run `okb bookmarklet`.

The bookmarklet needs the local server running on the port it was generated for. It sends the page URL and selected text to the loopback server in a popup. It carries a clip token that the server accepts for clipping and for nothing else. The page you clip can read that token, so it is kept separate from the access token the web app uses. The server validates the token on the clip request and restricts allowed hosts and cross-origin access. An MCP client can clip when the MCP server was started with `--trusted`.

A bookmarklet saved from an earlier version carries the web app's access token. It still clips, and its result window asks you to replace it. Drag the current one from **Add** or **Settings** to your bookmarks bar and delete the old one.

## What is saved

- A new clip becomes `references/<slug>.md`, with numeric suffixes for title collisions. The file records the normalized canonical URL in `resource` and the article’s title, byline, and publication date in `sources` when available.
- Re-clipping a known URL reuses the existing reference. A supplied quote or note goes under `# Highlights`. URL comparison ignores fragments and common tracking parameters. A match against the URL you supplied can be handled without fetching the page again.
- Fetches use HTTP or HTTPS, check addresses at each redirect, and apply limits to the response size, request time, and redirect count. Readability extracts the article, and Turndown converts it to Markdown.
- A clip refreshes an existing search index. The normal write path also refreshes embeddings when enabled. `okb index` creates the first keyword index for a new brain.

In `config.json`, `clip.maxBodyBytes` sets the extracted article limit, which defaults to 100,000 bytes. `clip.defaultTags` supplies tags, and `clip.stripParams` adds query parameter names to remove. Enable `clip.autoTag` or pass `--auto-tag` to suggest tags with the configured model. The `lean` retrieval profile disables these suggestions.
