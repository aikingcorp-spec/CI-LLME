import { expect, it } from "vitest";
import { p2pBuildEnv } from "./p2p-build-env";

it("reads P2P settings from the root env when apps/web has none", () => {
  expect(
    p2pBuildEnv(
      {},
      { VITE_P2P_GATEWAY_URL: "https://root.example.test", VITE_P2P_ICE_SERVERS: "[]" },
    ),
  ).toEqual({ gatewayUrl: "https://root.example.test", iceServers: "[]" });
});

it("prefers apps/web and defaults to blank", () => {
  expect(
    p2pBuildEnv(
      { VITE_P2P_ICE_SERVERS: "[]" },
      { VITE_P2P_ICE_SERVERS: '[{"urls":"stun:root.example.test"}]' },
    ),
  ).toEqual({ gatewayUrl: "", iceServers: "[]" });
});
