# enrich — improve the bundle with well-cited web material

Parameters:
- `focus` (required): a concept id to deepen, or a topic phrase.
- `seeds` (required for web work): starting URLs worth trusting.
- `caps` (optional): page/depth limits; default 5 pages, depth 1.

Steps:
1. Set the guardrails *before* running — they are enforced in-tool, so the
   run can only do what you allow:
   `okb enrich [task] --concept <id> --web-seed <url,url>
   [--web-max-pages 5] [--web-max-depth 1] [--allow-host h1,h2]
   [--deny-path /login,/admin] [--no-web]`
   - Seeds should already be authoritative (docs, papers, primary sources);
     the crawler may only follow links it discovers on them.
   - `--no-web` runs purely from the bundle (reorganize/summarize passes).
2. Read the run report: every `created`/`enriched` id, then open each and
   check the `# Citations` section actually supports the claims. Delete or
   fix anything the model asserted without a source.
3. `okb doctor` after the pass; then `okb links suggest` on new references
   to weave them into the graph.
4. Report spend honestly: pages fetched, concepts written, what was skipped.

Don't: raise the caps to "just let it finish" — split into more runs with
better seeds instead; don't seed with search-result pages (link farms).
