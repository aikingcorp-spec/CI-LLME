import { DOCS_SLUGS, docsPath } from "./docs";

const REPO = new URL("https://repo.invalid/");
const MARKDOWN_LINK = /\[([^\]]*)\]\(([^)\s]+)\)/g;

/** Resolves a repo doc's relative links: published docs become site pages, any other file loses its link. */
export function rewriteDocsLinks(markdown: string, slug: string): string {
  const source = new URL(`docs/${slug}.md`, REPO);
  return markdown.replace(MARKDOWN_LINK, (match, label: string, href: string) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(href)) return match;
    const target = new URL(href, source);
    if (target.origin !== REPO.origin) return match;
    const doc = /^\/docs\/([\w-]+)\.md$/.exec(target.pathname)?.[1];
    return doc && DOCS_SLUGS.includes(doc) ? `[${label}](${docsPath(doc)}${target.hash})` : label;
  });
}
