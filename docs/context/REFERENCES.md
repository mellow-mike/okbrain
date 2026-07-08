# REFERENCES.md

Registry of user-supplied reference material dropped into `docs/context/`
(PDFs, markdown, repos) or added as links. See `CLAUDE.md` §"Added reference
material" and `CONTEXT.md` §"Reference materials convention".

Status flow: `unread` → `read` → `applied` (or `needs-fetch` if a URL can't be
retrieved in-agent yet, so the user can paste the content).

| id | source (path or URL) | type | informs | status | notes |
|----|----------------------|------|---------|--------|-------|
| R1 | https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf (spec: `okf/SPEC.md`) | URL (spec) | OKF format & conformance | applied | Canonical OKF reference (earlier links in repo were hallucinated). Spec confirms current design: only `type` required; `title`/`description`/`resource`/`tags`/`timestamp` recommended; bundle-absolute links recommended; `index.md`/`log.md` reserved, no frontmatter; readers tolerate unknown keys/types/broken links. |
