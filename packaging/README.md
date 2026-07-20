# Packaging & release

How okbrain ships (Stage 5). The compiled binary and the sqlite-vec `vec0`
extension always travel **side by side** — `okb` looks for `vec0.{so,dylib,dll}`
next to its own executable (then the `sqlite-vec` npm package in dev, with
`$OKB_SQLITE_VEC` as the universal override).

## Release flow

1. Bump `version` in `package.json`, commit, tag `vX.Y.Z`, push the tag.
2. `.github/workflows/release.yml` cross-compiles all five targets
   (linux-x64/arm64, darwin-x64/arm64, windows-x64) via
   `scripts/package-release.ts`, pairs each with its platform's vec0 (pulled
   from the npm registry at the repo's pinned sqlite-vec version), and uploads
   `okb-<ver>-<os>-<arch>.tar.gz` / `.zip` + `SHA256SUMS.txt` to a GitHub
   release.
3. Update the manifests here from `SHA256SUMS.txt`:
   - `homebrew/okb.rb` → copy into a tap repo (`<owner>/homebrew-okb`).
   - `scoop/okb.json` → copy into a Scoop bucket.

Local single-platform build: `bun run build` → `bin/okb` + `bin/vec0.*`.

## Signing (not automated)

Artifacts are **unsigned** until org certificates exist; the hooks belong
right after the package step in `release.yml`:

- **macOS**: `codesign` with a Developer ID certificate, then `notarytool
  submit` + `stapler` — unsigned binaries make Gatekeeper prompt
  (`xattr -d com.apple.quarantine okb` is the user-side workaround).
- **Windows**: `signtool` with a code-signing certificate — unsigned binaries
  trip SmartScreen on first run.
- **Linux**: convention is checksums + (optionally) a detached GPG signature
  of `SHA256SUMS.txt`.
