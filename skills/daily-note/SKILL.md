# daily-note — today's working note with a "worth revisiting" section

Parameters:
- `date` (optional): ISO date, default today (UTC to match `timestamp`s).
- `focus` (optional): the user's stated priority for the day.

Steps:
1. Gather, all deterministic:
   - `okb review --json` — the resurface queue (add `--garnish` only if the
     user likes the AI one-liners and a provider is configured).
   - `okb inbox --json` — unread clips/notes.
   - `okb sync --status` — anything uncommitted from yesterday.
2. Write `okb write journal/<date> --type note --title "<date>"
   --description "Daily note" --body "<markdown>"` with sections:
   - `# Focus` — the `focus` parameter or a one-liner asked of the user.
   - `# Worth revisiting` — each review-queue item as a link with its
     *reasons verbatim* (they are the point: "orphan", "stale hub…");
     the user marks progress with `okb review done <n>` / `snooze <n>`.
   - `# Inbox` — links to unread items, count in the heading.
   - `# Log` — empty bullet for the user to fill during the day.
3. If yesterday's `journal/` note has unfinished `# Log` bullets, carry them
   into `# Focus` rather than losing them.

Don't: mark review items done yourself — the queue is the user's; don't run
this more than once a day (re-running updates the same `journal/<date>` id).
