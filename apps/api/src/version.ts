import { readFileSync } from "node:fs";
import { Hono } from "hono";

/** Docker writes this file even when the build receives no BUILT_AT argument. */
export function readBuildTime(path = "/app/BUILT_AT"): string | undefined {
  try {
    return readFileSync(path, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Public deployment identity, without consulting sessions or storage. */
export function versionRoutes(env: { gitSha?: string; builtAt?: string }) {
  const app = new Hono();
  app.get("/api/version", (c) => {
    c.header("cache-control", "no-store");
    return c.json({ sha: env.gitSha ?? null, builtAt: env.builtAt ?? null });
  });
  return app;
}
