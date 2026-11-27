# GUI fonts

The Knowledge and Work interface uses Inter and JetBrains Mono from the
Figma design. The note reader keeps Literata, with Recursive and system
fallbacks for the interface. Bun embeds the files in the compiled binary and
`api.ts` serves them from the local origin at `/gui/fonts/`. Static exports
use their own type stack and can embed the original viewer fonts.

| File | CSS family | Axes | Upstream | License |
|---|---|---|---|---|
| `Inter-Latin.woff2` | Inter | wght 100–900 | [Fontsource variable 5.3.0](https://fontsource.org/fonts/inter/about) | OFL-1.1 |
| `JetBrainsMono-Latin.woff2` | JetBrains Mono | wght 100–800 | [Fontsource variable 5.3.0](https://fontsource.org/fonts/jetbrains-mono/about) | OFL-1.1 |
| `RecursiveSans-VF.woff2` | Recursive Sans | wght 300–800 | Recursive 1.085 (MONO 0, CASL 0) | OFL-1.1 |
| `RecursiveMono-VF.woff2` | Recursive Mono | wght 400–700 | Recursive 1.085 (MONO 1, CASL 0) | OFL-1.1 |
| `Literata-VF.woff2` | Literata | opsz 12–72, wght 400–700 | Literata 3.103 | OFL-1.1 |
| `Literata-Italic-VF.woff2` | Literata, italic | opsz 12–72, wght 400–700 | Literata 3.103 | OFL-1.1 |

Copyright and license notices ship beside the fonts and in the hosted CSS.
Glyphs outside the subsets use the fallback fonts.
