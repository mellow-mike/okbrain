# Sample bundles

| Bundle | What it is | Origin |
|---|---|---|
| `example/` | A tiny OKF v0.2 bundle written by okbrain's own conformance writer (4 cross-linked concepts). Drives the Stage-0 acceptance test and doubles as a demo: `okb index --bundle bundles/example`, then `search` / `graph` / `doctor` / `export-viz` / `serve`. | okbrain |
| `acme_retail/` | The OKF reference project's v0.2 showcase: metrics, policies, an Attested Computation with executor skill + attester, `generated`/`verified`/`status`/`stale_after`/`sources` throughout, an agent-generated `index.md` style (H1 sections, relative links) and a `log.md` with frontmatter. okbrain must read it permissively and unchanged — it is the conformance fixture for `tests/e2e.acme.test.ts`. | [GoogleCloudPlatform/open-knowledge-format](https://github.com/GoogleCloudPlatform/open-knowledge-format) `bundles/acme_retail` (Apache-2.0; see `acme_retail/LICENSE`), vendored 2026-09-03, `viz.html` omitted |

Derived files (`viz.html`, `.okb/`) written next to these bundles are gitignored.
