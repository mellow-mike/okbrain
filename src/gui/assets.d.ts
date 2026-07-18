// Types for Bun text imports of the GUI assets (served by api.ts and embedded
// into the compiled binary; the compiler can't type raw-file-as-string imports).
// `*/index.html` outranks bun-types' `*.html` (HTMLBundle) — with
// `with { type: "text" }` the runtime really does hand back a string.
declare module "*/index.html" {
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
