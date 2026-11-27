# Product plan

okbrain has two workspaces. **Knowledge** helps people capture, find, and share
portable notes with the sources and AI accounts they choose. **Work** helps
engineers give Pi scoped project context, recover requests, and review
proposed changes before applying them.

## Current foundation

- The Markdown and YAML bundle is the source of truth for knowledge. OKF v0.2
  is the interchange baseline. Keyword, vector, and graph data are derived.
  The read-only Acme bundle checks compatibility with upstream tooling.
- The app and CLI share operations and settings. Task-specific views explain
  consequential choices and show previews before approval. Host administration
  belongs to the local operator. Team and MCP access retain their own scopes.
- The app uses the supplied Figma design for its workspace structure. Knowledge
  centers browsing, Ask, and Sources. Work centers the request, its repository
  and session navigation, and the review inspector. Both show real state and
  support keyboard and narrow-window use.

## Knowledge

Optimize for the first useful result. A new user can start with a note or an
existing source, find it again, and understand where it came from. Local
capture, search, mapping, and review work without a model. [Personal guide](PERSONAL.md)

1. **First use and return.** Route an empty brain to capture or import and
   then to the saved note, search, or review. Recheck keyboard and narrow
   viewport flows after navigation changes. Measure time to a first saved
   note and successful re-finding with opt-in, local usability sessions.
   [Usability protocol](USABILITY.md), [Jones et al.](https://doi.org/10.1145/502585.502607)
2. **Deliberate source access.** Build on local ChatGPT and Claude exports,
   bookmarks, Markdown, Notion exports and selected live pages, email, and
   calendar imports. Show skipped items, preserve provenance, and make
   repeated imports distinguish saved items from changes. Preserve local
   edits and require review for connecting or importing a source.
   [Source workflows](PERSONAL.md#import-conversations)
3. **Deliberate inference.** Keep the local and API-key routes and the
   explicitly selected ChatGPT plan route. Show the selected account and
   source visibility before sending a plan request. Store credentials in
   per-user application data. Keep plan failures on the selected billing
   route. [ChatGPT plan workflow](PERSONAL.md#ask-questions-with-your-chatgpt-plan)
4. **Inspectable relationships.** Let a user reopen the notes behind a
   question or project, filter by source, privacy, and recency, and see why
   each relationship appears. Keep the representation editable as Markdown.
   [Focused maps](PERSONAL.md#start-on-macos-or-in-a-browser)

## Work

The primary workflow is **scope → preview → submit → inspect → review**. A
request binds the task and the selected workspace source to its approval.
Show estimated context separately from recorded provider input, output, and
cache usage. [Coding guide](CODING.md)

1. **Bounded repository context.** Build on explicit files, scoped lexical
   retrieval, indexed profiles, and the imported repository map. The map is
   derived and rebuildable. It directs selection to current tracked source
   under one fixed budget. Show file and line references, omissions, map
   facts, and any approved source for deferred lookup. Imports record
   project-declared checks without running them.
   [Repository map](CODING.md#work-in-a-large-repository)
2. **Durable, reviewed requests.** Bind a request to its workspace, ID, source,
   and model. Store the exact approved input and reuse it on recovery. Keep
   application and publication approvals separate from generation. Keep the
   alternative review, context reset, and compaction receipts inspectable.
   [Pi Durable v1.0.0](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/README.md)
3. **Scoped orchestration and routing.** Split work across packages when the
   evidence calls for it. Show each work order, its source, model, reasoning,
   and provider preferences before submission. Publish the fixed baseline
   beside each routed choice. Use separate project learned state, tie updates
   to accepted reviews, and measure skills before making delivery routine.
   [Orchestration](CODING.md#split-a-task-across-packages), [Model routing](CODING.md#choose-models-by-role)
4. **Evaluation and deployment.** Compare retrieval on pinned and representative
   repositories before adding complexity. Track evidence recall, preview and
   import latency, context size, provider usage, and independent review
   outcomes. Use real provider runs to measure tokens per accepted result and
   verify the configured enterprise host’s isolation, egress, and retention.
   [Evaluation workflow](CODING.md#evaluate-provider-runs-with-independent-review), [Roadmap](../ROADMAP.md#stage-8--enterprise-coding)

The [reference registry](context/REFERENCES.md) records the research and source
material behind these principles. [CONTEXT.md](../CONTEXT.md) describes the
implementation and its decision history.
