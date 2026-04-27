/**
 * Type declarations for non-TypeScript text modules imported via wrangler's
 * [[rules]] `type = "Text"` loader. Each file is bundled as a plain string.
 */

declare module '*.sh' {
  const content: string;
  export default content;
}

declare module '*.py' {
  const content: string;
  export default content;
}
