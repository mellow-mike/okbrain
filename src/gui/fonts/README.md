# GUI fonts

The design system's (R5) four faces, subset to Latin plus the interface
glyphs (✓ · … and the arrows). `api.ts` serves them at `/gui/fonts/` and Bun
`file` imports embed them in the compiled binary (366 KB); nothing is fetched
from a network. The static viewer does not carry them — `viz.html` falls back
through the same family stacks in `core/viz/tokens.css`.

| File | CSS family | Axes | Upstream | License |
|---|---|---|---|---|
| `RecursiveSans-VF.woff2` | Recursive Sans | wght 300–800 | Recursive 1.085 (MONO 0, CASL 0) | OFL-1.1 |
| `RecursiveMono-VF.woff2` | Recursive Mono | wght 400–700 | Recursive 1.085 (MONO 1, CASL 0) | OFL-1.1 |
| `Literata-VF.woff2` | Literata | opsz 12–72, wght 400–700 | Literata 3.103 | OFL-1.1 |
| `Literata-Italic-VF.woff2` | Literata, italic | opsz 12–72, wght 400–700 | Literata 3.103 | OFL-1.1 |

Copyright notices and the license text: `OFL.txt`. Glyphs outside the subset
(☼ ☾ ✕ ↳) render in a system face.
