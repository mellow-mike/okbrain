# Packaging & release

The compiled runtime loads `vec0.{so,dylib,dll}` from its executable directory,
the development dependency, or the path set in `OKB_SQLITE_VEC`.

## macOS and editor builds

On a macOS CI job for your architecture, download the corresponding `okbrain-macos-*` artifact. Unzip the app archive, move **okbrain.app** to Applications, and open it. The app includes okbrain, its interface, and the SQLite libraries it needs. **File → Open in Browser** uses the same running server. Download `okbrain-editor-extension` from CI and install the `.vsix` in VS Code or Cursor. [Editor setup](../integrations/vscode/README.md)

Run `bun run package:mac --smoke` on macOS with Xcode command-line tools to build and launch the app. The packager checks the upstream SQLite amalgamation hash before building the embedded library. Run `bun run package:ide` with Node.js 22 and Bun to build the VSIX.

The Linux browser smoke test uses the bundled app assets at a 375 px viewport with outbound requests blocked. After `bunx --bun playwright install --only-shell chromium`, run `bun run smoke:browser` to repeat the keyboard flow.

## Release flow

The **Verify complete release candidate** CI job assembles and checksums the eight release assets using the same checks as the tag workflow. Mac app and editor downloads remain available from their CI packaging jobs.

1. Set `version` in `package.json`, commit, and check that CI passes. Tag the reviewed commit `vX.Y.Z` with the exact package version and push the tag.
2. `.github/workflows/release.yml` cross-compiles all five targets
   (linux-x64/arm64, darwin-x64/arm64, windows-x64) via
   `scripts/package-release.ts`, pairs each with its platform's vec0 (pulled
   from the npm registry at the repo's pinned sqlite-vec version), and uploads
   `okb-<ver>-<os>-<arch>.tar.gz` / `.zip` + `SHA256SUMS.txt` to a GitHub
   release. It also builds the macOS app on both architectures and includes the VSIX. A separate publishing job verifies the assembled checksums before creating the release.
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

Run local packaging commands with Bun 1.4.3 or newer. CI, release, and the
coding worker build pin Bun 1.4.3. A floating `latest` previously broke Windows CI (B6).

## Signing and notarization

The macOS CI artifacts use ad hoc signatures and may require approval under **System Settings → Privacy & Security** when opened after download.

For a distribution build, install the organization's **Developer ID Application** certificate and its private key in the macOS build user's Keychain. Create a notarytool profile using Apple's credential setup. Set `OKB_MAC_SIGN_IDENTITY` to the full certificate name or fingerprint and `OKB_MAC_NOTARY_PROFILE` to the existing profile name. Both values select credentials already in Keychain. [Developer ID signing](https://developer.apple.com/documentation/xcode/creating-distribution-signed-code-for-the-mac) · [Notarytool setup](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)

Run `bun run package:mac --sign --smoke` on each supported Mac architecture. The command signs the bundled libraries and runtime before signing the app. The smoke test opens the app, indexes a temporary brain, loads sqlite-vec, and opens the Coding workspace locally. The packager submits a temporary ZIP to Apple, waits for acceptance, and validates the stapled ticket before writing `dist/okbrain-<version>-macos-<arch>-notarized.zip`. Check the extracted app on a Mac outside the signing environment before publishing it. [Stapling and distribution](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow#Staple-the-ticket-to-your-distribution)

To build a signed Windows archive, install the Windows SDK and open a shell with `signtool.exe` on `PATH`. The signing certificate and its accessible private key must be in the build user's **Personal** certificate store. Set `OKB_WINDOWS_SIGN_THUMBPRINT` to the certificate's 40-digit hexadecimal thumbprint and `OKB_WINDOWS_TIMESTAMP_URL` to your publisher's HTTPS RFC 3161 timestamp endpoint. Run `bun run package --sign` on Windows x64. SignTool signs and timestamp-verifies both `okb.exe` and `vec0.dll` before the packager writes `dist/okb-<version>-windows-x64-signed.zip` and `dist/SHA256SUMS-windows-signed.txt`. [Microsoft SignTool](https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool)

The tag workflow produces ad hoc macOS app bundles and unsigned standalone CLI archives. Publishing signed and notarized artifacts requires authorized native signing hosts and publisher credentials.

- **Linux**: convention is checksums + (optionally) a detached GPG signature
  of `SHA256SUMS.txt`.
