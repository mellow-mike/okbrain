---
type: reference
title: Open Knowledge Format
description: Markdown + YAML frontmatter convention for portable knowledge bundles
timestamp: 2026-07-05T09:00:00Z
resource: https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf
tags:
  - format
---
# Open Knowledge Format

A convention for knowledge bundles: plain markdown files with YAML
frontmatter (`type`, `title`, `description`, `timestamp`), bundle-absolute
links, and per-directory `index.md` / `log.md` files — readable by any
markdown tool, versioned in git. [okbrain](/projects/okbrain.md) uses it as
the single source of truth.
