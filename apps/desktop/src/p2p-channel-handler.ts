/**
 * The slice of `@rakazo/p2p-prototype` a channel handler needs. Desktop does not depend on
 * that package, so the shape is restated here.
 */
export interface P2PChannelHandler {
  call(
    procedure: string,
    headers: Record<string, string>,
    body: Uint8Array,
  ): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }>;
  subscribe(
    procedure: string,
    headers: Record<string, string>,
    body: Uint8Array,
    signal: AbortSignal,
  ): AsyncIterable<Uint8Array>;
}

/**
 * Serves the data channel from the local API. Only `health` and `/rpc/*` calls pass, so a
 * remote client cannot reach any other path of the local web origin.
 */
export function desktopChannelHandler(
  webUrl: string,
  rpc: P2PChannelHandler,
  request: typeof fetch = fetch,
): P2PChannelHandler {
  return {
    async call(procedure, headers, body) {
      if (procedure !== "health") return rpc.call(procedure, headers, body);
      const res = await request(new URL("/health", webUrl), { method: "GET" });
      return {
        status: res.status,
        headers: Object.fromEntries(res.headers),
        body: new Uint8Array(await res.arrayBuffer()),
      };
    },
    subscribe: (procedure, headers, body, signal) =>
      rpc.subscribe(procedure, headers, body, signal),
  };
}
