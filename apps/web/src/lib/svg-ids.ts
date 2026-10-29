export function prefixSvgIds(svg: string, prefix: string): string {
  const safe = prefix.replace(/[^a-zA-Z0-9_-]/g, "") || "svg";
  return svg
    .replace(/\sid="([\w-]+)"/g, ` id="${safe}-$1"`)
    .replace(/((?:xlink:)?href)="#([\w-]+)"/g, `$1="#${safe}-$2"`)
    .replace(/url\(#([\w-]+)\)/g, `url(#${safe}-$1)`);
}
