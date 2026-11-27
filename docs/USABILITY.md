# Run a usability session

This protocol measures two things from the [product plan](PRODUCT-PLAN.md): how long a new person takes to save a first note, and how often they find a saved note again. okbrain records the timeline locally while a session runs. The facilitator adds written observations and exports one JSON file per participant.

Run these tasks in **Knowledge**. The Mac app and the web app share the same interface.

## What a session records

Recording is off until you start it. It covers one brain and stays in your per-user application data on this device, in `usability/sessions.db` under okbrain's data folder. Nothing is sent anywhere. A session is deleted 30 days after it starts, the next time you use okbrain, or at once when you choose **Clear sessions**.

| Recorded | Never recorded |
| --- | --- |
| The kind of each action: `save`, `search`, `open`, `browse`, `map`, `ask`, `review`, or `error` | Note text, titles, descriptions, tags, IDs, and file paths |
| The time from the session start to each action, in milliseconds | Search queries and questions |
| How long the app took to complete the action | Answers and other model output |
| How many results a search returned, and how many notes a save created | Error messages. Only an error code is kept |
| The position of the result a person opened, and the kind of list it came from | Which brain folder was used. The export has no brain identifier |
| The task labels the facilitator enters, such as `T3` | Participant names. Use a code on the observation sheet |
| Whether the action came from the app (`gui`) or the terminal (`cli`) | Anything an MCP client does |

A task label is 1 to 16 letters, digits, hyphens, or underscores. Use codes such as `T3`. A label is the only free value in the record, so keep words that describe a participant or their notes out of it.

## Before the session

1. Create a new, empty brain for each participant. In **Settings → Brain folders → Add a brain folder**, choose **Create a new brain folder**. An empty brain is the starting point for the first task, and it keeps one participant's notes away from the next.
2. Decide the variant and note it on the observation sheet: standard, keyboard-only, or narrow.
   - **Keyboard-only.** Put the pointer away. Tab moves between controls, Enter activates them, and `/` moves to the workspace search.
   - **Narrow.** Use the web app in a browser window 375 px wide. Use the navigation button in the workspace rail to reveal the available views.
3. The session works offline. Capture, import, search, browse, and review need no provider. Skip Ask unless a local model is already configured.
4. Download [`docs/usability/chatgpt-export/conversations.json`](usability/chatgpt-export/conversations.json) to the participant's device for the import task. It is an invented export of five short conversations and contains no real data.
5. Read the consent wording aloud and wait for a clear yes.

### Consent wording

> While we work, okbrain will keep a record on this computer of what kind of action you take: saving, searching, opening a note, browsing a list, viewing a map, asking a question, reviewing, or an action that fails. It records when each one happens after we start, how long the app takes, how many results a search returns, which position in a list you open, and short task codes that I type, such as T3.
>
> It does not record anything you type or read. That means no note text, titles, tags, file names, or search words, and no answers or error messages. The record stays on this computer until I export it as a file at the end. I will also take written notes about the app. They will use a code and not your name.
>
> You can stop at any time. If you ask, I will clear the record before you leave.

### Start recording

Open **Settings → Usability session** in the participant's brain and choose **Start session**. The workspace status shows **Recording usability session** on every view until the session stops. Selecting it returns to these controls.

From a terminal, `okb usability start` does the same. Pass `--brain <name>` or `--bundle <path>` to choose the participant's brain.

## Tasks

Give each task as written. Do not point at the screen or name a view. If the participant asks for help, say "do what you would normally do" once, then note any help you give.

Mark only the tasks that end with a found or not found result: T3 to T6. Enter the label under **Task label**, choose **Start task** as you finish reading the task aloud, and choose one of **End as found**, **End as not found**, or **End as abandoned** when the participant stops. T1 and T2 are measured from the timeline, so leave them unmarked.

| Task | Say to the participant | Ends when |
| --- | --- | --- |
| T1 First capture | "This is a new, empty notebook. Save a note about something you want to remember this week." | A note is saved. The export reports the time from the session start |
| T2 Import | "You exported your chats from another app. The file is called conversations.json. Bring those chats into this notebook." | The five drafts are imported, or the participant gives up |
| Filler | Talk about something else for five minutes, away from the app. Ask about their current note-taking habits and write the answers on the sheet | Five minutes pass |
| T3 Re-find an import | "One of the chats said how often to feed a starter that is kept on the counter. Find it." | The note is open, or the participant gives up |
| T4 Re-find own note | "Find the note you saved yourself at the start." | The note is open, or the participant gives up |
| T5 Re-find by content | "One of the chats compared a river path with a main road. Find it." | The note is open, or the participant gives up |
| T6 Resume | "Close okbrain completely. Now open it again and get back to the note you just had open." | The note from T5 is open again, or the participant gives up |

Recording continues across T6. A session belongs to the brain, so it is still recording when the app reopens, and the workspace status shows it again.

End a task as **found** when the right note is open, **not found** when the participant says they are done without it, and **abandoned** when they stop trying or you run out of time. A task that is still open when the session stops is recorded as abandoned.

## After the session

1. Choose **Stop session**.
2. Choose **Export JSON** and save `okbrain-usability.json`. Rename it to the participant code, such as `p07.json`. The Mac app opens a save panel, and a browser saves it with its other downloads. The terminal equivalent is `okb usability export > p07.json`.
3. Open the file with the participant if they want to see it.
4. Choose **Clear sessions** once the file is saved. Then choose **Remove mount** for the participant's brain in **Settings → Brain folders**, and delete its folder if the notes should not stay on the device.

## Observation sheet

Print one per participant. Write a code, never a name, and leave out anything that identifies the person or what they wrote in their notes.

```text
Participant code: ______      Variant: standard / keyboard-only / narrow      App: Mac / web

T1 First capture     Saved without help: yes / no     First place they looked: ______________
                     Hesitations or wrong turns: ____________________________________________
T2 Import            Imported: yes / no               Help given: ___________________________
                     Hesitations or wrong turns: ____________________________________________
Filler               Current note-taking habits: ____________________________________________
T3 Re-find import    Result: found / not found / abandoned     Route: search / browse / map / other
T4 Re-find own note  Result: found / not found / abandoned     Route: search / browse / map / other
T5 Re-find content   Result: found / not found / abandoned     Route: search / browse / map / other
T6 Resume            Result: found / not found / abandoned     Route: ______________________
Errors the participant saw (what they were doing, not the text of their notes): ______________
What they said about the app, in their words: _______________________________________________
One thing to change: ________________________________________________________________________
```

## Read the export

The file follows the schema `okbrain-usability/1`. It holds every stored session for the brain, normally one.

```json
{
  "schema": "okbrain-usability/1",
  "exportedAt": "2026-11-23T10:41:07.512Z",
  "retentionDays": 30,
  "sessions": [{
    "id": "2458df99-5432-48b8-8140-25f81c06bb2b",
    "startedAt": "2026-11-23T10:02:11.004Z",
    "endedAt": "2026-11-23T10:40:52.310Z",
    "appVersion": "0.1.0",
    "platform": "darwin",
    "events": [
      { "seq": 1, "offsetMs": 48210, "kind": "save", "surface": "gui", "durationMs": 34, "count": 1, "via": "capture" },
      { "seq": 7, "offsetMs": 921040, "kind": "task_start", "surface": "gui", "label": "T3" },
      { "seq": 8, "offsetMs": 934400, "kind": "search", "surface": "gui", "durationMs": 6, "count": 4 },
      { "seq": 9, "offsetMs": 941870, "kind": "open", "surface": "gui", "durationMs": 3, "rank": 2, "via": "search" },
      { "seq": 10, "offsetMs": 949010, "kind": "task_end", "surface": "gui", "outcome": "found", "label": "T3" }
    ],
    "summary": {
      "durationMs": 2321306,
      "events": 10,
      "timeToFirstSaveMs": 48210,
      "firstSaveKind": "capture",
      "errors": 0,
      "tasks": [
        { "label": "T3", "outcome": "found", "durationMs": 27970, "searches": 1, "opens": 1, "firstOpenRank": 2, "firstOpenVia": "search" }
      ],
      "refind": { "tasks": 1, "found": 1, "notFound": 0, "abandoned": 0, "successRate": 1, "medianFoundMs": 27970 },
      "search": { "count": 1, "p50Ms": 6, "p95Ms": 6 }
    }
  }]
}
```

The example leaves out five of the ten events to stay short.

The session `id` is random and is not derived from the brain, the device, or the person.

### Events

| Kind | When it is recorded | Extra fields |
| --- | --- | --- |
| `save` | A capture, a new or edited note, a clip, a confirmed import, a saved answer draft, a claim, or an RSS pull that added notes. A preview and an unchanged save are not events | `via`: `capture`, `note`, `clip`, `import`, `answer`, `claim`, or `feed`. `count`: notes saved |
| `search` | A search finished | `count`: results returned |
| `open` | A note was loaded in the reader or the editor, including a reload after an action | `via`: `search`, `browse`, `map`, `link`, `review`, or `direct`. `rank`: position in that list, from 1 |
| `browse` | A note listing with details was loaded: Browse, and Home's recent notes | `count`: notes listed |
| `map` | A focused map or the graph was built | `count`: notes shown |
| `ask` | An answer completed. A stopped answer is not an event | `count`: verified citations |
| `review` | A note was marked reviewed or snoozed | |
| `error` | One of the actions above failed | `via`: the action that failed. `outcome`: `bad_params`, `not_found`, `refused`, `untrusted`, or `failed` |
| `task_start`, `task_end` | The facilitator marked a task | `label`. On `task_end`, `outcome`: `found`, `not_found`, or `abandoned` |

Every event has `seq`, `offsetMs` (milliseconds from the session start to when the event was recorded), and `surface` (`gui` for the Mac and web apps, `cli` for the terminal). Actions have `durationMs`, the time the app took.

For `open`, `via` says where the note link was followed: a search result, a list such as Browse, Inbox, or Home's recent notes (`browse`), a focused map or the graph (`map`), the review queue (`review`), or a link inside a note or another view (`link`). `direct` covers the address bar, Back and Forward, a reload after an action, and `okb read`.

### Summary

| Field | Meaning |
| --- | --- |
| `durationMs` | Session length. `null` while the session is still recording |
| `timeToFirstSaveMs`, `firstSaveKind` | Time from the session start to the first `save`, and its `via` |
| `tasks[]` | For each marked task: `label`, `outcome`, `durationMs`, the `searches` and `opens` inside it, and the `firstOpenRank` and `firstOpenVia` of the first note opened |
| `refind.tasks`, `found`, `notFound`, `abandoned` | Counts of marked tasks that ended |
| `refind.successRate` | `found / tasks`, from 0 to 1 |
| `refind.medianFoundMs` | Median duration of the tasks that ended as found |
| `search.count`, `p50Ms`, `p95Ms` | Number of searches, and the median and 95th percentile of their `durationMs`. Percentiles interpolate between neighbouring values |
| `errors` | Number of `error` events |

## Combine participants

Keep one export per participant and combine them when the study ends. Sessions never share an ID, so their `sessions` arrays can be joined directly.

```bash
jq -s '{ schema: .[0].schema, sessions: map(.sessions[]) }' p*.json > study.json

# Median time to a first saved note, in seconds.
jq '[.sessions[].summary.timeToFirstSaveMs | select(. != null)] | sort
    | if length == 0 then null else (.[(length - 1) / 2 | floor] + .[length / 2 | floor]) / 2000 end' study.json

# Re-find success across every marked task.
jq '[.sessions[].summary.refind] | { tasks: (map(.tasks) | add), found: (map(.found) | add) }
    | . + { successRate: (if .tasks == 0 then null else .found / .tasks end) }' study.json

# Search latency: pool the events, then take percentiles. Averaging per-session percentiles misleads.
jq '[.sessions[].events[] | select(.kind == "search") | .durationMs] | sort' study.json
```

Report the variant with each result. Keyboard-only and narrow sessions answer different questions from standard ones, so compare them separately.

## Terminal reference

| Command | Effect |
| --- | --- |
| `okb usability` | Show whether this brain is recording and how many sessions are stored |
| `okb usability start` / `stop` | Start or stop recording for this brain |
| `okb usability task start <label>` | Mark the start of a task |
| `okb usability task end <label> --outcome found\|not_found\|abandoned` | Mark its end |
| `okb usability export` | Print the stored sessions and summaries as JSON |
| `okb usability clear` | Delete this brain's stored sessions at once |

The controls are owner settings. They are unavailable on a read-only brain and to MCP clients, and an MCP client's reads and writes are never added to a session.
