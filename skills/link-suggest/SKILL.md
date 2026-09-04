# link-suggest — weave concepts together, deliberately

Parameters:
- `id` (optional): one concept to connect; default = a small sweep of the
  most recently touched concepts (`okb inbox --json`, recent writes).
- `budget` (optional): max accepts this pass, default 5.

Steps:
1. `okb links suggest <id> --json` — deterministic candidates with reasons
   (title mention, similar content, shared tags). Reasons are evidence, not
   verdicts.
2. Judge each candidate by opening it (`okb read <target>`): would a reader
   of `<id>` genuinely want this next? Accept only those:
   `okb links accept <id> <target>` — appends a normalized link under
   `# Related` (a content change: `generated` + log update, correctly).
3. Prefer editing prose over `# Related` when a suggestion belongs in a
   sentence: open the concept and link the mention inline instead (the
   editor's insert button, or edit the body with `okb write`).
4. Stop at the budget. Orphans first when sweeping: `okb orphans` lists
   concepts with no links at all — one good link each beats ten on a hub.

Don't: accept for score alone (a shared tag is weak evidence); don't
double-link — already-connected pairs never show up, so every suggestion
you see is genuinely new.
