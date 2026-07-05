---
type: idea
title: knowledge graph
description: Treat the links between notes as first-class structure you can query, walk, and visualize.
timestamp: 2026-07-05T09:00:00Z
tags:
  - graph
---
A note gains meaning from what it points at and what points back at it. Ordinary
markdown links — like this relative one to [OKF](okf.md) — become directed
edges, and backlinks fall out for free by reversing them.

Graphs also pair naturally with [local-first](/concepts/local-first.md) storage:
edges derived from files can always be rebuilt from those files.
