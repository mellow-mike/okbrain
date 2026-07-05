# Vendored viewer libraries

Minified browser builds inlined into the static `viz.html` export (and embedded
into the compiled binary via Bun text imports). Vendored — not npm runtime
deps — because neither package's `exports` map exposes these files to import.

| file | package | version | license |
|------|---------|---------|---------|
| `cytoscape.min.js` | [cytoscape](https://js.cytoscape.org) | 3.34.0 | MIT |
| `marked.umd.js` | [marked](https://marked.js.org) | 18.0.5 | MIT |

To update: `bun add -d <pkg>`, copy `dist/cytoscape.min.js` /
`lib/marked.umd.js` here, strip any `sourceMappingURL` comment, update this
table, `bun remove <pkg>`.
