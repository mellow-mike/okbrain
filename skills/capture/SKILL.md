# capture — get a thought or page into the brain, fast

Parameters:
- `content` (required): the text, or a URL.
- `tags` (optional): comma-separated extra tags.
- `deliberate` (optional, default false): true when this deserves a proper
  home now instead of the inbox.

Steps:
1. Pick the entry point:
   - URL → `okb clip <url> [--tags …] [--quote "<selection>"]` (add
     `--auto-tag` only if the user wants topical tags and a provider is
     configured).
   - Fleeting text → `okb capture "<text>" [--tags …]` — lands in `inbox/`
     tagged `inbox`; triage later (`okb inbox`, then `okb inbox read <id>`
     or a proper home via `okb write`).
   - `deliberate` → `okb new <type> "<title>" "<one-line description>"
     [--body …]`; derive a clean, specific title; the description is one
     honest sentence, not a repeat of the title.
2. If the text obviously names existing concepts, run
   `okb links suggest <new-id> --json` and accept the genuinely related ones
   (`okb links accept <new-id> <target>`); skip anything you'd have to
   rationalize.
3. Echo back the concept id so the user can find it.

Don't: summarize away the user's wording on capture (fidelity first);
don't file into a directory you invented — inbox exists for undecided things.
