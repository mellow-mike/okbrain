# ingest — bring outside material into the bundle in bulk

Parameters:
- `source` (required): a markdown file/directory, a feed URL, or a list of
  page URLs.
- `dest` (optional): bundle directory for imports.
- `limit` (optional): cap per feed pull.

Steps:
1. Route by source type:
   - Markdown file/tree → `okb import <path> [--dest …] [--type …]`
     (re-runs dedupe by id; `--overwrite` only when the user says replace).
   - Feed URL → `okb rss <url> [--limit N]`; to make it recurring, add it to
     `rss.feeds` in config.json so `okb jobs` pulls it nightly.
   - Individual pages → `okb clip <url>` per page (see capture skill).
2. `okb index` — then read the stats line; a large `removed` you didn't
   expect means the source moved things, stop and check.
3. `okb doctor` — imports carry foreign frontmatter; warnings are fine
   (permissive read), errors are not: fix or report them.
4. Tell the user what landed (`okb inbox` for the unread pile) and suggest a
   triage pass; imported material often deserves `okb links suggest` on the
   few pieces that matter.

Don't: import into `references/` (that namespace belongs to clip/rss/enrich);
don't bulk-accept link suggestions on a fresh import.
