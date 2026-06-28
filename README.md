# okbrain

A self-hosted, cross-platform personal knowledge manager. Its on-disk store is a
conformant **[Open Knowledge Format](https://openknowledge.foundation/) (OKF)**
bundle — markdown + YAML frontmatter in git — and the database is a derived,
fully-rebuildable cache. Lightweight and correct over feature-rich; runs offline
on a laptop and grows for years.

- **Source of truth:** the OKF bundle (markdown + git). The DB rebuilds from it.
- **Stack:** TypeScript on [Bun](https://bun.sh), compiled to a single binary,
  SQLite + sqlite-vec + FTS5, AI via a provider-agnostic gateway (local or API).
- **Surfaces:** one operations contract → CLI, local GUI, and MCP server.

> Status: early. See `ROADMAP.md` for what's built and what's next.

## Develop

Requires [Bun](https://bun.sh) ≥ 1.1.

```bash
bun install            # install dependencies
bun run okb <args>     # run the CLI in dev
bun run typecheck      # tsc --noEmit (strict)
bun test               # unit tests
bun run build          # compile a local binary to bin/okb
```

## Docs

| File | What it is |
|---|---|
| `CLAUDE.md` | North Star, invariants, iron rules (always-loaded orientation) |
| `CONTEXT.md` | Living design reference (how it works and why) |
| `ROADMAP.md` | Granular tasks, bug log, backlog, progress log |

## License

MIT — see `LICENSE`.
