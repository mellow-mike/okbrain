# RESOLVER — intent → skill

Thin router for agents working inside an okbrain bundle. Match the user's
intent to one skill, read it, follow it. Everything deterministic (lookups,
lists, status) is a CLI call — never re-implement what an `okb` command
already does (`okb help` lists them, `--json` everywhere).

| Intent sounds like | Skill |
|---|---|
| "note this down", "remember that…", "save this page" | `capture/SKILL.md` |
| "pull in these files / this feed / these docs" | `ingest/SKILL.md` |
| "flesh out X", "research X into my notes", "update from the web" | `enrich/SKILL.md` |
| "what do I know about…", any question answerable from the bundle | `query/SKILL.md` |
| "write my daily note", "what should I look at today" | `daily-note/SKILL.md` |
| "connect my notes", "what should link to what" | `link-suggest/SKILL.md` |

Ground rules (apply in every skill):
- **Brain-first:** query the bundle before answering from model memory; cite
  concept ids.
- **Conformance is free:** all writes go through `okb` commands, which write
  conformant OKF — never edit frontmatter by hand.
- **No silent spend:** AI extras (`--garnish`, `--auto-tag`, `okb enrich`,
  `okb ask`) only when the task calls for them; deterministic commands first.
- After any batch of writes: `okb doctor`, and `okb sync` if the user wants
  it committed.
