---
type: format
title: Open Knowledge Format
description: Markdown files with YAML frontmatter, arranged so both humans and machines can read the same bundle.
timestamp: 2026-07-05T09:00:00Z
resource: https://example.com/okf-spec
tags:
  - format
---
OKF is a convention, not a database. Every concept is a markdown file with a
`type` in its frontmatter; every directory carries an `index.md` listing and a
`log.md` history. Bundle-absolute links keep references stable when files move.

[okbrain](/okbrain.md) reads and writes OKF natively, and its
[knowledge graph](/concepts/knowledge-graph.md) is extracted straight from OKF
links — no sidecar metadata.

# Citations

- [OKF specification](https://example.com/okf-spec) — placeholder source for
  this example bundle.
