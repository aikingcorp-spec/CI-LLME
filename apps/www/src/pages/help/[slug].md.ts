import type { APIRoute, GetStaticPaths } from "astro";
import { getCollection } from "astro:content";
import { vnbotMarkdownResponse } from "../../vnbot-help";

export const getStaticPaths = (async () =>
  (await getCollection("vnbotDocs")).map((entry) => ({
    params: { slug: entry.id },
    props: { body: entry.body ?? "" },
  }))) satisfies GetStaticPaths;

export const GET: APIRoute<{ body: string }> = ({ props, request }) =>
  vnbotMarkdownResponse(props.body, request.method);
