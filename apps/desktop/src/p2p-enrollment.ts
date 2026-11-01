import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { P2PPairingModule } from "./p2p-node.js";
import { parseGatewayUrl } from "./p2p-node.js";
import { readPrivateFile, writePrivateFile } from "./setup-store.js";

/** Main-process only. Both the hosted account and local node session must already be verified. */
export async function enrollDesktop(input: {
  pairing: P2PPairingModule;
  gatewayUrl: string;
  appToken: string;
  localUser: string;
  userDataDir: string;
  platform: string;
  name: string;
  request?: typeof fetch;
}) {
  const gateway = parseGatewayUrl(input.gatewayUrl);
  if (!gateway) throw new Error("Invalid gateway");
  const dir = path.join(input.userDataDir, "p2p");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const keyFile = path.join(dir, "node-key.json");
  const saved = input.pairing.readKeyFile(keyFile);
  if (saved?.localUser && saved.localUser !== input.localUser)
    throw new Error("This computer belongs to another local account");
  const key = saved ?? input.pairing.generateKeyPair();
  if (!input.pairing.sign) throw new Error("Registration module unavailable");
  const previousId =
    saved?.nodeId ||
    (saved ? (await readPrivateFile(path.join(dir, "node-id"), 128))?.trim() : undefined);
  if (saved && !previousId) throw new Error("Incomplete machine identity");
  const nodeId = previousId || `desktop-${crypto.randomUUID()}`;
  const response = await (input.request ?? fetch)(`${gateway}/nodes/register`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${input.appToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      nodeId,
      nodePublicKey: key.publicKey,
      sig: input.pairing.sign(key, `register|${nodeId}|${input.appToken}`),
      name: input.name,
      kind:
        input.platform === "win32" ? "windows" : input.platform === "darwin" ? "macos" : "linux",
    }),
  });
  if (!response.ok) throw new Error("Machine registration refused");
  const result: unknown = await response.json();
  if (
    !result ||
    typeof result !== "object" ||
    !("user" in result) ||
    typeof result.user !== "string" ||
    !("gatewayPublicKey" in result) ||
    typeof result.gatewayPublicKey !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(result.gatewayPublicKey)
  )
    throw new Error("Invalid registration response");
  if (saved?.gatewayPublicKey && saved.gatewayPublicKey !== result.gatewayPublicKey)
    throw new Error("Gateway identity changed");
  // Keep the identity and ID in one atomic file so interrupted writes cannot split them.
  await writePrivateFile(
    keyFile,
    JSON.stringify({
      ...key,
      nodeId,
      user: result.user,
      gatewayPublicKey: result.gatewayPublicKey,
      localUser: input.localUser,
    }) + "\n",
  );
  return nodeId;
}
