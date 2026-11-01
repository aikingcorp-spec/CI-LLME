type Env = Record<string, string | undefined>;

/** Vite exposes only apps/web env files to the client, so P2P settings also come from the root. */
export function p2pBuildEnv(webEnv: Env, rootEnv: Env) {
  return {
    gatewayUrl: webEnv.VITE_P2P_GATEWAY_URL ?? rootEnv.VITE_P2P_GATEWAY_URL ?? "",
    iceServers: webEnv.VITE_P2P_ICE_SERVERS ?? rootEnv.VITE_P2P_ICE_SERVERS ?? "",
  };
}
