# Packaging & release

The compiled runtime loads `vec0.{so,dylib,dll}` from its executable directory,
the development dependency, or the path set in `OKB_SQLITE_VEC`.

## macOS and editor builds

On a macOS CI job for your architecture, download the corresponding `okbrain-macos-*` artifact. Unzip the app archive, move **okbrain.app** to Applications, and open it. The app includes okbrain, its interface, and the SQLite libraries it needs. **File → Open in Browser** uses the same running server. Download `okbrain-editor-extension` from CI and install the `.vsix` in VS Code or Cursor. [Editor setup](../integrations/vscode/README.md)

Run `bun run package:mac --smoke` on macOS with Xcode command-line tools to build and launch the app. The packager checks the upstream SQLite amalgamation hash before building the embedded library. Run `bun run package:ide` with Node.js 22 and Bun to build the VSIX.

## Release flow

1. Bump `version` in `package.json`, commit, tag `vX.Y.Z`, push the tag.
2. `.github/workflows/release.yml` cross-compiles all five targets
   (linux-x64/arm64, darwin-x64/arm64, windows-x64) via
   `scripts/package-release.ts`, pairs each with its platform's vec0 (pulled
   from the npm registry at the repo's pinned sqlite-vec version), and uploads
   `okb-<ver>-<os>-<arch>.tar.gz` / `.zip` + `SHA256SUMS.txt` to a GitHub
   release. It also builds the macOS app on both architectures and includes the VSIX.
3. Update the manifests here from `SHA256SUMS.txt`:
   - `homebrew/okb.rb` → copy into a tap repo (`<owner>/homebrew-okb`).
   - `scoop/okb.json` → copy into a Scoop bucket.

Local single-platform build: `bun run build` → `bin/okb` + `bin/vec0.*`.

Offline local package: `bun run package` (= `scripts/package-release.ts
--local`) builds this machine's archive into `dist/` using the vec0 already
in `node_modules`. The archive includes the CLI, local API, embedded GUI,
MCP server, SQLite extension, README, license, and the personal and coding
guides. The Pi runtime is bundled. ChatGPT plan usage and hosted coding
providers require network access when invoked.

Both workflows pin the Bun version (`bun-version: 1.3.14`); bump it
deliberately — a floating `latest` once broke Windows CI (B6).

## Signing and notarization

The macOS app builds use ad hoc signatures. Developer ID signing, notarization, and signed Windows binaries require publisher credentials.

- **macOS** uses `codesign` with a Developer ID certificate, then `notarytool submit` and `stapler`. Downloaded CI builds may require approval under **System Settings → Privacy & Security**.
- **Windows**: `signtool` with a code-signing certificate — unsigned binaries
  trip SmartScreen on first run.
- **Linux**: convention is checksums + (optionally) a detached GPG signature
  of `SHA256SUMS.txt`.
