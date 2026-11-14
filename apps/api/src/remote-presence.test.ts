import { expect, it, vi } from "vitest";
import {
  localRemoteActor,
  pinnedRegistrationId,
  presentPinnedDevice,
  remoteProviderForDeployment,
} from "./remote-presence.js";

it("does not let a guest session act as this computer", () => {
  expect(localRemoteActor({ localDeviceId: "device-1", guestOnly: true })).toBe("guest");
  expect(localRemoteActor({ localDeviceId: "device-1", guestOnly: false })).toBe("host");
  expect(localRemoteActor({ localDeviceId: undefined, guestOnly: true })).toBe("central");
});

it("does not register or heartbeat when this server has no pinned computer", async () => {
  const register = vi.fn(async () => ({ kind: "registered" }));
  const heartbeat = vi.fn(async () => "beat");
  const list = vi.fn(async () => "listed");
  await expect(
    presentPinnedDevice({ localDeviceId: undefined, register, heartbeat, list }),
  ).resolves.toBe("listed");
  expect(register).not.toHaveBeenCalled();
  expect(heartbeat).not.toHaveBeenCalled();
});

it("registers the pinned computer and then reports it online", async () => {
  const register = vi.fn(async () => ({ kind: "registered" }));
  const heartbeat = vi.fn(async (deviceId: string) => deviceId);
  const list = vi.fn(async () => "listed");
  await expect(
    presentPinnedDevice({
      localDeviceId: "device-1",
      register,
      heartbeat,
      list,
    }),
  ).resolves.toBe("device-1");
  expect(register).toHaveBeenCalledWith("device-1");
  expect(heartbeat).toHaveBeenCalledWith("device-1");
  expect(list).not.toHaveBeenCalled();
});

it("does not give the host install the central provider", () => {
  const provider = { provision: () => Promise.resolve({ objectId: "1" }) };
  expect(
    remoteProviderForDeployment({ localDeviceId: "device-1", configured: provider }),
  ).toBeUndefined();
  expect(remoteProviderForDeployment({ localDeviceId: undefined, configured: provider })).toBe(
    provider,
  );
  expect(
    remoteProviderForDeployment({ localDeviceId: undefined, configured: undefined }),
  ).toBeUndefined();
});

it("registers only the computer pinned to this install", () => {
  expect(pinnedRegistrationId(undefined, "device-1")).toBeUndefined();
  expect(pinnedRegistrationId("device-1", "device-2")).toBeUndefined();
  expect(pinnedRegistrationId("device-1", "device-1")).toBe("device-1");
});

it("does not heartbeat a pinned computer that belongs to someone else", async () => {
  const register = vi.fn(async () => ({ kind: "conflict" }));
  const heartbeat = vi.fn(async () => "beat");
  const list = vi.fn(async () => "listed");
  await expect(
    presentPinnedDevice({ localDeviceId: "device-1", register, heartbeat, list }),
  ).resolves.toBe("listed");
  expect(heartbeat).not.toHaveBeenCalled();
});
