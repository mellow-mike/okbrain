# okbrain

[![CI](https://github.com/mellow-mike/okbrain/actions/workflows/ci.yml/badge.svg)](https://github.com/mellow-mike/okbrain/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-4c6ef5?style=flat)](LICENSE)

okbrain is a local-first second brain and a review workspace for recoverable
coding requests. Use the macOS app, the local web app, or the `okb` CLI.

- **Knowledge** captures notes and imports conversations, bookmarks, Markdown,
  Notion pages, email, and calendar files. Browse, search, map, and review notes
  offline. Ask questions with citations using a local model, a provider API key,
  or an eligible ChatGPT plan. [Personal guide](docs/PERSONAL.md)
- **Work** previews source from explicit files or tracked repository excerpts,
  runs coding requests through Pi Durable, and saves the exact approved input
  for inspection and recovery. Import a large repository into a local map, split
  cross-package work into previewed orders, and review results before applying
  or publishing changes. [Coding guide](docs/CODING.md)

Knowledge lives in portable Markdown and YAML compatible with
[Open Knowledge Format v0.2](https://github.com/GoogleCloudPlatform/open-knowledge-format).
Review and source provenance travel with each note. Search and graph caches can
be rebuilt from the bundle. Coding transcripts and account credentials live in
per-user application data.

## Install

Download the macOS app or the VS Code and Cursor extension from a successful
[CI run](https://github.com/mellow-mike/okbrain/actions/workflows/ci.yml).
Open the app, then use **File → Open Brain Folder** to open an existing bundle.
In the editor, use **Extensions → Install from VSIX**.

Build the CLI and local browser app from source with [Bun](https://bun.com)
1.4.3 or newer. CI tests macOS, Linux, and Windows.

```sh
git clone https://github.com/mellow-mike/okbrain.git
cd okbrain
bun install --frozen-lockfile
bun run build
```

Keep `bin/okb` and the adjacent `vec0` library together. Add `bin` to your
`PATH`, or call the executable directly. On Windows it is `bin/okb.exe`.
Run `okb --version` to verify the installation. `bun run package` builds an
offline archive for your current platform. The packaging guide covers macOS
SQLite setup, native builds, release assets, and signature status.
[Packaging and release](packaging/README.md)

## Save and find a note

Open **Knowledge** and capture a note. Use **Library** to browse the bundle,
**Sources** to preview an import, and **Ask** to choose an answer route. To
launch the browser app from your terminal, run `okb serve --open` from your
brain directory. The server binds to loopback.

To create a brain and search it from the terminal:

```sh
mkdir -p "$HOME/brain"
cd "$HOME/brain"
okb init --actor human:you
okb capture 'Review the trail map before the weekend hike.'
okb index
okb search 'weekend hike'
```

`okb init` makes this folder the default. Use `--no-default-bundle` to keep the
current default. Choose a mounted brain with `--brain <name>` or choose a
folder with `--bundle <path>`. In the app, use the brain picker or open
**Settings → Brain folders** to manage mounts.

The repository includes an [example bundle](bundles/README.md) and the upstream
Acme OKF v0.2 conformance fixture. From the repository root, inspect either
bundle without using your default brain:

```sh
okb --bundle bundles/example list --detail
okb --bundle bundles/acme_retail doctor
```

## Preview and review a coding request

Open **Work** in the Mac app or local browser. Register a project or open a
standalone session. Choose the model, describe the task, and inspect the exact
source preview before approving the send. Reopen an interrupted run with its
saved request ID. A finished result can be inspected alongside its admitted
source, usage, and project review history.

To preview tracked source in the terminal from the project directory:

```sh
okb code context --workspace . --projects . \
  --query 'configuration' --context-tokens 2500 --show-content
```

Use the displayed ID and the same source options to approve the selection in
`okb code run`, or use **Preview source** in Work to review a new selection
there. Hosted runs require a provider API key. The coding guide covers
standalone runs, repository maps, team access, model routing, and GitHub
handoff. [Coding guide](docs/CODING.md)

## Configure and connect

- Use **Settings** for AI defaults, provider keys, brain folders, cache
  backend, and maintenance. **Advanced operations** provides typed forms and
  JSON output for shared CLI commands. Choose SQLite or local PostgreSQL with
  pgvector for the derived cache. Export Markdown or synchronize the bundle through Git.
  [Personal guide](docs/PERSONAL.md)
- Personal provider keys can come from the environment or be saved explicitly
  in the per-user provider store through the app. `config.json` holds app
  defaults under `$XDG_CONFIG_HOME/okbrain` or `~/.config/okbrain` on macOS and
  Linux, or `%APPDATA%\okbrain` on Windows. Settings and source previews show
  the model or account used for an AI call. [AI setup](docs/PERSONAL.md#ai-defaults)
- Run `okb help` for the command list, and `okb help <command>` for arguments
  and options. `--json` selects machine-readable output where a command
  returns a result. Exit status `2` signals a usage problem and `1` a failed
  operation or an unhealthy result such as a Doctor error.
- Connect an MCP client using the local app’s setup section or `okb mcp` for
  stdio. MCP defaults to read access. `okb mcp --trusted` grants the supported
  write operations to a client you trust. `okb mcp --http` starts loopback
  Streamable HTTP. [MCP setup](docs/PERSONAL.md#connect-an-mcp-client)
- For VS Code or Cursor, start the local server or connect to an authorized
  HTTPS team workspace. The extension previews scoped sources and opens
  run inspection and review from the editor. [Editor guide](integrations/vscode/README.md)

Private `db_only/` notes are excluded from app-managed Git publication and
from graph and Markdown exports by default. A writable local operator can
explicitly include them in supported exports.

## Develop

```sh
bun install --frozen-lockfile
bun run okb help
bun run typecheck
bun test
bun run build
```

Run `bunx --bun playwright install --only-shell chromium` once to prepare the
browser smoke test, then run `bun run smoke:browser`. Follow
[AGENTS.md](AGENTS.md) for repository rules, [CONTEXT.md](CONTEXT.md) for
current architecture and design history, and [ROADMAP.md](ROADMAP.md) for
release status and open work. See the [product plan](docs/PRODUCT-PLAN.md)
and [usability protocol](docs/USABILITY.md) for product validation.

## License

[MIT](LICENSE). The vendored `bundles/acme_retail/` upstream sample uses
Apache-2.0. Bundled dependencies and fonts carry their own notices.
