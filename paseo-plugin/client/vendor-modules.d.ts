// Paseo's neutral-platform compiler needs explicit file entry points for the
// browser bundles. Keep their public types by forwarding those entries to the
// package declarations used by the regular TypeScript resolver.
declare module "prism-react-renderer/dist/index.mjs" {
  export * from "prism-react-renderer";
}

declare module "prismjs/prism.js" {
  import Prism from "prismjs";

  export default Prism;
}
