// Types for Bun text imports of the GUI assets (served by api.ts and embedded
// into the compiled binary; the compiler can't type raw-file-as-string imports).
// `*/index.html` outranks bun-types' `*.html` (HTMLBundle) — with
// `with { type: "text" }` the runtime really does hand back a string.
declare module "*/index.html" {
  const text: string;
  export default text;
}
declare module "*/coding-team.html" {
  const text: string;
  export default text;
}
declare module "*.css" {
  const text: string;
  export default text;
}
declare module "*/app.js" {
  const text: string;
  export default text;
}
declare module "*/graph-view.js" {
  const text: string;
  export default text;
}
declare module "*/mcp-settings.js" {
  const text: string;
  export default text;
}
declare module "*/coding.js" {
  const text: string;
  export default text;
}
declare module "*/coding-evaluation.js" {
  const text: string;
  export default text;
}
declare module "*/github.js" {
  const text: string;
  export default text;
}
declare module "*/notion.js" {
  const text: string;
  export default text;
}
declare module "*/accounts.js" {
  const text: string;
  export default text;
}
declare module "*/focused-map.js" {
  const text: string;
  export default text;
}
declare module "*/computation.js" {
  const text: string;
  export default text;
}
// `with { type: "file" }`: a path — on disk in dev, in the binary once compiled.
declare module "*.woff2" {
  const path: string;
  export default path;
}
declare module "*.txt" {
  const text: string;
  export default text;
}
