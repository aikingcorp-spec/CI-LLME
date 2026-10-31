import type { Deps, RoomStub } from "./app.js";
import { handle } from "./app.js";
import type { Config } from "./config.js";
import { loadConfig } from "./config.js";
import type { Env } from "./env.js";

export { NodeRoom } from "./node-room.js";

let config: Promise<Config | undefined> | undefined;

function roomOf(env: Env, nodeId: string): RoomStub {
  const stub = env.NODE_ROOM.get(env.NODE_ROOM.idFromName(nodeId));
  return { fetch: (request) => stub.fetch(request), online: () => stub.online(), kick: () => stub.kick() };
}

/** Only fixed routes are logged by name: node ids and tokens never reach a log line. */
function loggedPath(pathname: string): string {
  if (pathname.startsWith("/nodes/")) return "/nodes/*";
  return ["/healthz", "/agent", "/signal", "/pair/start", "/pair/complete", "/sessions", "/nodes"].includes(
    pathname,
  )
    ? pathname
    : "*";
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    config ??= loadConfig(env);
    const resolved = await config;
    if (resolved === undefined) {
      config = undefined;
      console.log("CONFIG invalid");
      return new Response("gateway misconfigured", { status: 500 });
    }
    const deps: Deps = {
      db: env.DB,
      config: resolved,
      room: (nodeId) => roomOf(env, nodeId),
      now: Date.now,
    };
    const response = await handle(request, deps);
    console.log(`${request.method} ${loggedPath(new URL(request.url).pathname)} ${response.status}`);
    return response;
  },
};
