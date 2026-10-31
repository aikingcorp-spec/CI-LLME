import { timingSafeEqual } from "node:crypto";
import {
  isLocalhostOrLoopbackIp,
  LOCAL_COMPUTER_HOST_PATH,
  LOCAL_NODE_SESSION_PATH,
  LOCAL_SETTINGS_TOKEN_HEADER,
  localNodeSessionBody,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { Hono } from "hono";
import { readBoundedBody } from "./http-body.js";

export function validLocalSettingsToken(
  expected: string | undefined,
  supplied: string | undefined,
): boolean {
  return Boolean(
    expected &&
      supplied &&
      /^[a-f0-9]{64}$/.test(expected) &&
      /^[a-f0-9]{64}$/.test(supplied) &&
      timingSafeEqual(Buffer.from(expected), Buffer.from(supplied)),
  );
}

/** Native host choice uses a local OS capability, never an app account. */
export function mountLocalComputerHost(
  app: Hono,
  deps: {
    token?: string;
    sandboxProvider?: string;
    prisma: PrismaClient;
  },
) {
  // Only the native main process holds this token. Public sessions never authorize this route.
  app.post(LOCAL_COMPUTER_HOST_PATH, async (c) => {
    c.header("cache-control", "no-store");
    if (!validLocalSettingsToken(deps.token, c.req.header(LOCAL_SETTINGS_TOKEN_HEADER))) {
      return c.json({ error: "Local settings are unavailable" }, 401);
    }
    if (deps.sandboxProvider !== "docker") return c.json({ error: "Unavailable" }, 403);
    const body = await readBoundedBody(c.req.raw, 1024);
    if (body === null) return c.json({ error: "Request too large" }, 413);
    let computerHost: unknown;
    try {
      computerHost = JSON.parse(body).computerHost;
    } catch {
      /* invalid JSON */
    }
    if (computerHost !== "docker" && computerHost !== "this-mac") {
      return c.json({ error: "Invalid computer host" }, 400);
    }
    const selected = computerHost;
    await runAsSystem("locally authorized computer host choice", () =>
      deps.prisma.deploymentSettings.upsert({
        where: { id: "default" },
        create: { id: "default", computerHost: selected },
        update: { computerHost: selected },
      }),
    );
    return c.json({ ok: true });
  });
  // Old native clients must fail closed rather than select a profile implicitly.
  app.all("/api/desktop-settings/rpc/*", (c) => c.json({ error: "Unavailable" }, 403));
}

/**
 * This computer's node has no mail of its own, so the desktop app's verified address opens the
 * session. Only the native main process holds the token, and a node served beyond loopback never
 * answers: the native API binds 127.0.0.1 and the managed stack publishes on 127.0.0.1 only.
 */
export function mountLocalNodeSession(
  app: Hono,
  deps: {
    token?: string;
    webOrigin: string;
    mint: (email: string) => Promise<string[]>;
  },
) {
  app.post(LOCAL_NODE_SESSION_PATH, async (c) => {
    c.header("cache-control", "no-store");
    if (!validLocalSettingsToken(deps.token, c.req.header(LOCAL_SETTINGS_TOKEN_HEADER))) {
      return c.json({ error: "Local settings are unavailable" }, 401);
    }
    if (!isLocalhostOrLoopbackIp(new URL(deps.webOrigin).hostname)) {
      return c.json({ error: "Unavailable" }, 403);
    }
    const body = await readBoundedBody(c.req.raw, 1024);
    if (body === null) return c.json({ error: "Request too large" }, 413);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      /* invalid JSON */
    }
    const request = localNodeSessionBody.safeParse(parsed);
    if (!request.success) return c.json({ error: "Invalid email" }, 400);
    try {
      const cookies = await runAsSystem("desktop app sign-in on its own node", () =>
        deps.mint(request.data.email),
      );
      for (const cookie of cookies) c.header("set-cookie", cookie, { append: true });
      return c.json({ ok: true });
    } catch (error) {
      getLogger().error("local node session refused", error);
      return c.json({ error: "Could not open a session" }, 403);
    }
  });
}
