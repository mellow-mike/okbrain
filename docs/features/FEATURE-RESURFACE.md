# Revisit knowledge with the review queue

The review queue brings back notes worth another look and explains why each item is there. Run `okb index` to create the brain’s search index first.

```bash
okb review
okb review done notes/spaced-repetition
okb review snooze notes/evergreen-notes --days 7
```

`done` and `snooze` accept a concept ID or a one-based position in the current queue. Use IDs when working from a saved queue because positions can change. Open concepts and manage the queue in the **Review** view of the web app. The Home view also shows the current queue.

## How the queue is ranked

The queue is computed on demand from the index and graph. It works offline. The default queue shows up to five concepts and skips deprecated notes, active snoozes, and notes reviewed within the past 30 days. Ties go to the older content timestamp and then to concept ID.

| Signal | When it is added | Default weight |
| --- | --- | --- |
| Content age | Days since the last content change, scaled up to a year | 1.0 |
| Orphan | No resolved links or backlinks | 2.0 |
| Stale hub | At least three backlinks and more than 90 days since the last change | 1.5 |
| Recent neighbor | A linked neighbor changed within seven days and the note is over 30 days old | 1.0 |
| Inbox | The note carries the `inbox` tag | 1.5 |
| Anniversary | Within one day of a 365-day multiple since the last content change | 0.5 |
| Expired | `stale_after` has passed | 2.0 |
| Draft | `status` is `draft` | 1.0 |

Change queue size, cooldown, or signal weights under `review` in `config.json`. `okb review --limit 10` changes the size for one call. `okb review --garnish` optionally asks the configured model to connect items to recently changed notes. The `lean` profile disables that extra. Use `okb jobs --only review` to include the queue in a maintenance report, or the [daily-note skill](../../skills/daily-note/SKILL.md) to include it in a journal note.

## What survives a rebuild

Marking a concept reviewed adds a `verified` event with the current actor and time to its frontmatter. The note body and content change timestamp stay as they were. The cooldown uses the latest human verification, with a fallback to the legacy `last_reviewed` key. Verification stays with the Markdown. Snoozes are local index state and `okb rebuild` clears them.
