import { readFileSync } from "node:fs";
import type { IceServer, RelayType } from "node-datachannel";

const RELAY: Record<string, RelayType> = {
  "turn:udp": "TurnUdp",
  "turn:tcp": "TurnTcp",
  "turns:tcp": "TurnTls",
};

/**
 * Reads coturn REST credentials (KEY=VALUE lines: TURN_URLS, TURN_USERNAME, TURN_CREDENTIAL)
 * into node-datachannel ice servers. `hostOverride` points every server at a local forwarder
 * while keeping port and transport. The credential is returned only inside the servers.
 */
export function readTurnCreds(
  path: string,
  opts: { hostOverride?: string; transports?: string[] } = {},
): IceServer[] {
  const vars = new Map<string, string>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) vars.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  const username = vars.get("TURN_USERNAME");
  const password = vars.get("TURN_CREDENTIAL");
  const urls = (vars.get("TURN_URLS") ?? "").split(",").filter(Boolean);
  if (!username || !password || urls.length === 0)
    throw new Error(`incomplete TURN creds in ${path}`);
  const servers: IceServer[] = [];
  for (const url of urls) {
    const m = /^(turns?):([^:?]+):(\d+)(?:\?transport=(udp|tcp))?$/.exec(url);
    if (!m) throw new Error("unsupported TURN url");
    const [, scheme, host, port, transport = scheme === "turns" ? "tcp" : "udp"] = m;
    const relayType = RELAY[`${scheme}:${transport}`];
    if (!relayType || !host || !port) throw new Error("unsupported TURN url");
    if (opts.transports && !opts.transports.includes(relayType)) continue;
    servers.push({
      hostname: opts.hostOverride ?? host,
      port: Number(port),
      username,
      password,
      relayType,
    });
  }
  return servers;
}
