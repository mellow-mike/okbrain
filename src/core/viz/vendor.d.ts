// Types for Bun text imports (`with { type: "text" }`) of the viewer scripts —
// the vendored libraries in vendor/ plus our own browser-side sanitizer — since
// the compiler can't type raw-.js-as-string imports.
declare module "*/safe-markdown.js" {
  const text: string;
  export default text;
}
declare module "*.min.js" {
  const text: string;
  export default text;
}
declare module "*.umd.js" {
  const text: string;
  export default text;
}
