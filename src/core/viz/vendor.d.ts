// Types for Bun text imports (`with { type: "text" }`) of the vendored viewer
// libraries in vendor/ — the compiler can't type raw-.js-as-string imports.
declare module "*.min.js" {
  const text: string;
  export default text;
}
declare module "*.umd.js" {
  const text: string;
  export default text;
}
declare module "*/render.js" {
  const text: string;
  export default text;
}
