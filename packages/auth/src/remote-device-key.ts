import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";

const PURPOSE = "rakazo-remote-device";

export interface RemoteDeviceKey {
  publicKey: string;
  privateKey: string;
}

export function createRemoteDeviceKey(): RemoteDeviceKey {
  const generated = generateKeyPairSync("ed25519");
  return {
    publicKey: generated.publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: generated.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

export function remoteDevicePublicKey(privateKey: string): string {
  return createPublicKey(createPrivateKey(privateKey))
    .export({ type: "spki", format: "pem" })
    .toString();
}

export function remoteDeviceSignature(
  privateKey: string,
  input: { deviceId: string; time: string; nonce: string; body: string },
): string {
  return sign(null, Buffer.from(remoteDeviceMessage(input)), createPrivateKey(privateKey)).toString(
    "base64url",
  );
}

export function remoteDeviceSignatureMatches(
  publicKey: string,
  input: { deviceId: string; time: string; nonce: string; body: string },
  signature: string,
): boolean {
  try {
    return verify(
      null,
      Buffer.from(remoteDeviceMessage(input)),
      createPublicKey(publicKey),
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}

function remoteDeviceMessage(input: {
  deviceId: string;
  time: string;
  nonce: string;
  body: string;
}): string {
  const bodyHash = createHash("sha256").update(input.body).digest("base64url");
  return [PURPOSE, "1", input.deviceId, input.time, input.nonce, bodyHash].join("\n");
}
