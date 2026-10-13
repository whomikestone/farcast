// Markdown files are bundled as plain text (see "rules" in wrangler.jsonc).
declare module '*.md' {
  const text: string;
  export default text;
}
