/** Bun resolves `with { type: "text" }` at build time and inlines the contents. */
declare module "*.sql" {
  const content: string;
  export default content;
}
