# Product plan

okbrain serves two workflows. In the personal workflow, people bring their own knowledge and AI accounts, connect sources deliberately, and build a map they can inspect and edit. In the coding workflow, teams give Pi scoped project context, keep run history recoverable, and review proposed changes before applying them.

## Starting point

The Bun application already has a portable Markdown and YAML store, keyword and optional vector retrieval, a typed knowledge graph, a local web app, a CLI, and MCP. The first product release can build on all of those. OKF v0.2 is the current interchange baseline. Product extensions may add portable metadata and concepts as needed. Google’s reference implementation remains a compatibility fixture and design reference.

## First implementation pass

1. **Personal context.** Import text conversations from local ChatGPT and Claude exports with stable identities, provenance, preview, and duplicate handling. Use the canonical writer so conversation content is searchable and editable as Markdown. Keep external files and tokens out of the bundle.
2. **Subscription inference.** Add an explicit ChatGPT plan route using OpenAI’s documented local open-source sign-in and plan usage permissions. Keep existing API-key and local model routes. Prove a clean failure path for disconnected accounts and avoid switching billing routes on failure. Start with cited questions from the CLI. [OpenAI’s integration guide](https://developers.openai.com/siwc/token-sharing-open-source)
3. **Knowledge mapping.** Reduce database work per link suggestion and per concept refresh. Preserve results and provenance resolution. Cover the changed behaviors against actual SQLite.
4. **Coding sessions.** Add a local, supervised coding workflow built on Pi’s 1.x Durable APIs. Accept an explicit workspace and file context, use named persisted sessions and request IDs, and return a reviewable response. Keep coding run state outside the brain. [Pi documentation](https://docs.pi.dev/latest), [Pi Durable](https://earendil.com/posts/pi-durable/)
5. **Integration and documentation.** Verify normal entry points and feature boundaries. Update setup, operations, architecture and contributor instructions before opening the PR.

## Follow-on milestones

For the personal product, add an account and sources screen, incremental imports with review, and an interactive map focused on the question or project at hand. Extend live connectors as providers publish supported account access. Use [Meta Muse](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/) as a reference for persistent, user-directed assistance.

For the enterprise product, add an authenticated control plane, project policies, isolated workspaces, review and approval state, and an audit trail. Validate recovery, cancellation, and retention in a worker deployment before adding approved execution and repository integration.
