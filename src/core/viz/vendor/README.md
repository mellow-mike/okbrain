# Vendored browser libraries

Copied verbatim from their npm packages; inlined into `viz.html` by
`core/viz/export.ts` and served to the GUI by `api.ts` via Bun text imports
(their `exports` maps hide the browser builds from `import`).

| File | Package | Version | License |
|---|---|---|---|
| `cytoscape.min.js` | `cytoscape` | see file header | MIT |
| `marked.umd.js` | `marked` | 18.0.5 | MIT |

To update: copy the `dist/` build from the package tarball and bump this table.

okbrain's own browser scripts live one level up (`core/viz/safe-markdown.js`,
the sanitizing renderer; `core/viz/render.js`, the shared viewer helpers) and
are loaded after these, in that order.
