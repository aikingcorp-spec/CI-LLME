import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export async function loadMermaidAsset(): Promise<{
  version: string;
  body: Uint8Array<ArrayBuffer>;
}> {
  const { version } = require("mermaid/package.json") as { version: string };
  const file = await readFile(require.resolve("mermaid/dist/mermaid.min.js"));
  return { version, body: new Uint8Array(file) };
}
