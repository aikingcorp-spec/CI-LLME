import { expect, it } from "vitest";
import {
  createRemoteDeviceKey,
  remoteDevicePublicKey,
  remoteDeviceSignature,
  remoteDeviceSignatureMatches,
} from "./remote-device-key.js";

const body = JSON.stringify({ action: "present", originService: "http://127.0.0.1:3100" });

it("accepts a signature from that device key and rejects another key or another body", () => {
  const device = createRemoteDeviceKey();
  const other = createRemoteDeviceKey();
  const input = { deviceId: "device-1", time: "1000", nonce: "nonce-1", body };
  const signature = remoteDeviceSignature(device.privateKey, input);
  expect(remoteDevicePublicKey(device.privateKey)).toBe(device.publicKey);
  expect(remoteDeviceSignatureMatches(device.publicKey, input, signature)).toBe(true);
  expect(remoteDeviceSignatureMatches(other.publicKey, input, signature)).toBe(false);
  expect(
    remoteDeviceSignatureMatches(device.publicKey, { ...input, body: `${body} ` }, signature),
  ).toBe(false);
  expect(signature).not.toContain(device.privateKey);
  expect(body).not.toContain(device.privateKey);
});
