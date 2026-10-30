import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  missingAssetMiddleware,
  sourceMapBlockMiddleware,
  sourceMapBlockPlugin,
} from "./missing-asset";

const assetsDir = path.resolve("/srv/dist/assets");
const archiveDir = path.resolve("/srv/archive/assets");
const present = new Set([path.join(assetsDir, "index-new.js")]);

function request(url: string, archive: string | null = null) {
  const res = { statusCode: 200, setHeader: vi.fn(), end: vi.fn() };
  const next = vi.fn();
  missingAssetMiddleware(assetsDir, "/assets/", archive, (file) => present.has(file))(
    { url, method: "HEAD" } as IncomingMessage,
    res as unknown as ServerResponse,
    next,
  );
  return { res, next };
}

describe("missing asset middleware", () => {
  it("answers 404 for a chunk from an older build instead of falling back to index.html", () => {
    const { res, next } = request("/assets/index-old.js");
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(404);
    expect(res.end).toHaveBeenCalled();
  });

  it("serves assets that exist and leaves app routes to the SPA fallback", () => {
    expect(request("/assets/index-new.js?v=1").next).toHaveBeenCalled();
    expect(request("/app/settings").next).toHaveBeenCalled();
  });

  it("serves a chunk an earlier build left in the archive", () => {
    present.add(path.join(archiveDir, "index-old.js"));
    const { res, next } = request("/assets/index-old.js", archiveDir);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.setHeader).toHaveBeenCalledWith("content-type", "text/javascript");
    expect(res.setHeader).toHaveBeenCalledWith(
      "cache-control",
      "public, max-age=31536000, immutable",
    );
    expect(request("/assets/gone.js", archiveDir).res.statusCode).toBe(404);
    const outside = path.resolve(archiveDir, "../builds/1.json");
    present.add(outside);
    expect(request("/assets/..%2Fbuilds%2F1.json", archiveDir).res.statusCode).toBe(404);
    present.delete(outside);
    present.delete(path.join(archiveDir, "index-old.js"));
  });

  it("does not resolve outside the assets directory", () => {
    expect(request("/assets/..%2Fassets%2Findex-new.js").next).toHaveBeenCalled();
    expect(request("/assets/..%2F..%2Fetc%2Fpasswd").res.statusCode).toBe(404);
    expect(request("/assets/%E0%A4%A").res.statusCode).toBe(404);
  });
});

describe("sourceMapBlockMiddleware", () => {
  const run = (url: string) => {
    const res = { statusCode: 200, setHeader: vi.fn(), end: vi.fn() };
    const next = vi.fn();
    sourceMapBlockMiddleware({ url }, res, next);
    return { res, next };
  };
  it.each([
    "/assets/desktop-abc.js.map",
    "/assets/index.JS.MAP?x=1",
    "/assets/index.js%2Emap",
    "/assets/..%2Fapp.js.map",
    "/assets/index.js.map%00",
  ])("answers 404 for %s unless it only looks like a map", (url) => {
    const { res, next } = run(url);
    if (url.endsWith("%00")) {
      expect(next).toHaveBeenCalled();
      return;
    }
    expect(res.statusCode).toBe(404);
    expect(next).not.toHaveBeenCalled();
  });
  it.each(["/assets/index.js", "/map", "/assets/a.map/b.js", "/"])("passes %s on", (url) => {
    const { res, next } = run(url);
    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });
});

describe("sourceMapBlockPlugin", () => {
  it("installs the middleware and returns nothing, so Vite runs no post-hook", () => {
    const plugin = sourceMapBlockPlugin();
    for (const hook of [plugin.configureServer, plugin.configurePreviewServer]) {
      const connectApp = () => undefined;
      const use = vi.fn(() => connectApp);
      expect(hook.call(plugin, { middlewares: { use } })).toBeUndefined();
      expect(use).toHaveBeenCalledWith(sourceMapBlockMiddleware);
    }
  });
});
