# query — answer from the brain, not from model memory

Parameters:
- `question` (required).
- `depth` (optional): `quick` (search only) | `synthesis` (ask) — default
  by judgment: factual lookup → quick, "explain/compare/summarize" → synthesis.

Steps:
1. `okb search "<terms>" --json` — hybrid recall; each hit shows which arms
   found it (`keyword`/`vector`/`graph`/`relational`). Relational phrasings
   work as-is: "what cites X", "X depends on", "part of X".
2. Expand promising hits when the question is about connections:
   `okb graph <id>` (neighborhood, `→`/`←` direction tags),
   `okb path <a> <b>` (how two ideas connect), `okb read <id>` for the text.
3. For synthesis: `okb ask "<question>" [--profile lean|balanced|max]` —
   citations are post-verified against retrieved context; relay them as
   concept ids. An "I found nothing" answer is real signal: say so and offer
   to capture/enrich instead of filling the gap from model memory.
4. Answer with the bundle's content, cite ids inline, and note when your own
   knowledge disagrees with a note (the note may be stale — offer to update
   it, don't silently override it).

Don't: answer bundle questions without running step 1; don't cite a concept
you didn't read or that `okb ask` didn't verify.
