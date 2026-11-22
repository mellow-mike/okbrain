# Working on okbrain

okbrain has two workflows. The personal brain helps people capture, map, and revisit portable knowledge with the AI accounts or models they choose. The coding workflow uses Pi 1.x and Pi Durable to keep project context and coding requests recoverable for human review. Read [the product plan](docs/PRODUCT-PLAN.md) and [the roadmap](ROADMAP.md) before changing scope.

## Keep the data portable

- The Markdown and YAML bundle is the source of truth for knowledge. The FTS, vector, and graph stores are derived. Keep rebuilding from the bundle possible and keep the bundle readable in an ordinary editor.
- Use `src/core/okf/write.ts` for concept writes. Preserve unknown frontmatter and permissive reads, including legacy OKF. Retain the OKF v0.2 interchange baseline and the read-only Acme fixture. The product can add portable fields and types when a workflow needs them.
- Stamp generated content with its actual actor. Keep review and source provenance legible. Keep `db_only/` notes out of shared Git manifests and exclude them by default from static HTML exports.

## Preserve the trust boundaries

- Declare commands in `src/core/operations.ts` and keep CLI, local API, and MCP adapters thin. Check caller trust and brain mount policy before writing. `localOnly` commands stay out of API and MCP discovery and dispatch.
- Keep sign-in and subscription use explicit. Account credentials belong in per-user application data. The personal plan route uses local retrieval and sends only the selected context to its provider. Preserve the existing API-key and local-model gateway behavior.
- Keep coding sessions separate from personal bundles. The current Pi Durable runner accepts explicit workspace files and persists the conversation and request state in per-user application data. Treat those transcripts as sensitive. Preserve stable request IDs, workspace and model binding, and the human review boundary.
- Use cross-platform path handling and argument-array subprocess calls. If code opens Bun SQLite, use the shared macOS SQLite setup before the first connection.

## Verify and document changes

Run `bun install --frozen-lockfile`, `bun run typecheck`, `bun test`, and `bun run build` as appropriate. Check the real exit status when capturing output. CI runs the test suite on Linux, macOS, and Windows. Exercise the normal CLI, API, or MCP entry point for behavior changes.

Keep [CONTEXT.md](CONTEXT.md), [ROADMAP.md](ROADMAP.md), and user guides consistent with code. Use [the personal guide](docs/PERSONAL.md) for subscription and import workflows, [the coding guide](docs/CODING.md) for Pi Durable, and [the reference registry](docs/context/REFERENCES.md) for upstream material. Record a regression test when a change fixes behavior that existing tests did not cover.
