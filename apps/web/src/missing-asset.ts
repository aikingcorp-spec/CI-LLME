import { createReadStream, existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".map": "application/json",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
};

function inside(root: string, relative: string): string | null {
  try {
    const file = path.resolve(root, decodeURIComponent(relative));
    return file.startsWith(root + path.sep) ? file : null;
  } catch {
    // A malformed escape is never a real asset.
    return null;
  }
}

/**
 * A tab from an older deploy asks for hashed chunks this build no longer has. Serve them from the
 * archive of earlier builds when it holds them; otherwise answer 404 instead of the SPA's
 * index.html, which the browser would try to run as a script.
 */
export function missingAssetMiddleware(
  assetsDir: string,
  urlPrefix: string,
  archiveDir: string | null = null,
  exists: (file: string) => boolean = existsSync,
) {
  const root = path.resolve(assetsDir);
  const archive = archiveDir && path.resolve(archiveDir);
  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const pathname = req.url?.split("?", 1)[0] ?? "/";
    if (!pathname.startsWith(urlPrefix)) {
      next();
      return;
    }
    const relative = pathname.slice(urlPrefix.length);
    const file = inside(root, relative);
    if (file && exists(file)) {
      next();
      return;
    }
    const archived = archive ? inside(archive, relative) : null;
    if (archived && (req.method === "GET" || req.method === "HEAD") && exists(archived)) {
      res.statusCode = 200;
      res.setHeader(
        "content-type",
        CONTENT_TYPES[path.extname(archived)] ?? "application/octet-stream",
      );
      // The name carries the content hash, so it never changes.
      res.setHeader("cache-control", "public, max-age=31536000, immutable");
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      createReadStream(archived)
        .on("error", () => res.destroy())
        .pipe(res);
      return;
    }
    res.statusCode = 404;
    res.setHeader("cache-control", "no-store");
    res.end("Not found");
  };
}

/** Source maps are never served: a request path ending in .map, raw or URL-decoded, is a 404. */
export function sourceMapBlockMiddleware(
  req: Pick<IncomingMessage, "url">,
  res: Pick<ServerResponse, "statusCode" | "setHeader" | "end">,
  next: () => void,
): void {
  const pathname = (req.url ?? "/").split("?", 1)[0] ?? "/";
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A malformed escape is judged by its raw form.
  }
  if (!/\.map$/i.test(pathname) && !/\.map$/i.test(decoded)) {
    next();
    return;
  }
  res.statusCode = 404;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end("Not found");
}

/**
 * The source-map 404 as a Vite plugin. The hooks have block bodies on purpose: Vite runs a
 * function returned from configureServer/configurePreviewServer as a post-hook, and
 * middlewares.use() returns the connect app, which then crashes the dev server on start.
 */
export function sourceMapBlockPlugin(): {
  name: string;
  configureServer(server: {
    middlewares: { use(fn: typeof sourceMapBlockMiddleware): unknown };
  }): void;
  configurePreviewServer(server: {
    middlewares: { use(fn: typeof sourceMapBlockMiddleware): unknown };
  }): void;
} {
  return {
    name: "rakazo-sourcemap-404",
    configureServer(server) {
      server.middlewares.use(sourceMapBlockMiddleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(sourceMapBlockMiddleware);
    },
  };
}
