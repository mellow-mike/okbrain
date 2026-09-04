// okbrain's own version, read once from package.json (Bun embeds the JSON in
// the compiled binary). Distinct from the OKF format version the bundle
// declares (`OKF_VERSION` in core/okf/indexmd.ts).

import pkg from "../../package.json" with { type: "json" };

export const VERSION: string = pkg.version;

/** Actor (OKF §7) for content okb itself produces (clips, feed pulls, imports). */
export const TOOL_ACTOR = `okb/${VERSION}`;
