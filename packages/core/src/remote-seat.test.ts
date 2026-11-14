import { describe, expect, it } from "vitest";
import type { RemoteDevice } from "./remote-seat.js";
import {
  disableRemoteSeat,
  enableRemoteSeat,
  moveRemoteSeat,
  REMOTE_OFFLINE_AFTER_MS,
  registerRemoteDevice,
  remoteObjectId,
  remotePortal,
  remotePresence,
  remoteSeatPolicy,
} from "./remote-seat.js";

const policy = remoteSeatPolicy();

function device(accountId: string, deviceId: string, remoteEnabled = false): RemoteDevice {
  return { accountId, deviceId, remoteEnabled };
}

describe("remote seat", () => {
  it("uses one seat per account without a system-wide cap by default", () => {
    expect(remoteSeatPolicy()).toEqual({ accountSeats: 1 });
    expect(remoteSeatPolicy({ accountSeats: 2, pilotCap: 3 })).toEqual({
      accountSeats: 2,
      pilotCap: 3,
    });
    expect(() => remoteSeatPolicy({ accountSeats: 99 })).toThrow(
      "Remote seat limit must be 1 or 2",
    );
    expect(() => remoteSeatPolicy({ pilotCap: 0 })).toThrow(
      "Remote pilot cap must be a positive integer",
    );
  });

  it("allows another account beyond fifty enabled hosts while keeping the account seat limit", () => {
    const others = Array.from({ length: 50 }, (_, index) =>
      device(`account-${index}`, `computer-${index}`, true),
    );
    const registered = [...others, device("new-account", "new-a"), device("new-account", "new-b")];
    const enabled = enableRemoteSeat(registered, policy, {
      accountId: "new-account",
      deviceId: "new-a",
    });
    expect(enabled.kind).toBe("enabled");
    expect(enabled.devices.filter((host) => host.remoteEnabled)).toHaveLength(51);
    expect(enabled.devices.slice(0, 50)).toEqual(others);
    expect(
      enableRemoteSeat(enabled.devices, policy, { accountId: "new-account", deviceId: "new-b" }),
    ).toMatchObject({ kind: "occupied", changed: false });
  });

  it("registers a computer with remote off and does not grant a seat twice", () => {
    const first = registerRemoteDevice([], { accountId: "account", deviceId: "computer-a" });
    expect(first).toMatchObject({
      kind: "registered",
      changed: true,
      devices: [{ accountId: "account", deviceId: "computer-a", remoteEnabled: false }],
    });
    expect(
      registerRemoteDevice(first.devices, { accountId: "account", deviceId: "computer-a" }),
    ).toMatchObject({ kind: "registered", changed: false });
  });

  it("refuses a computer id that already belongs to another account", () => {
    const registered = registerRemoteDevice([], { accountId: "account", deviceId: "computer-a" });
    expect(
      registerRemoteDevice(registered.devices, { accountId: "other", deviceId: "computer-a" }),
    ).toMatchObject({ kind: "conflict", changed: false });
  });

  it("enables the only free seat and leaves a second computer waiting", () => {
    const registered = [device("account", "computer-a"), device("account", "computer-b")];
    const enabled = enableRemoteSeat(registered, policy, {
      accountId: "account",
      deviceId: "computer-a",
    });
    expect(enabled).toMatchObject({
      kind: "enabled",
      changed: true,
      devices: [device("account", "computer-a", true), device("account", "computer-b")],
    });
    const occupied = enableRemoteSeat(enabled.devices, policy, {
      accountId: "account",
      deviceId: "computer-b",
    });
    expect(occupied).toMatchObject({
      kind: "occupied",
      changed: false,
      holders: ["computer-a"],
    });
    expect(occupied.devices[0]?.remoteEnabled).toBe(true);
    expect(occupied.devices[1]?.remoteEnabled).toBe(false);
  });

  it("moves the seat only after confirmation and carries no host data", () => {
    const enabled = [
      device("account", "computer-a", true),
      device("account", "computer-b"),
      device("account", "notes", false),
    ];
    const pending = moveRemoteSeat(enabled, {
      accountId: "account",
      fromDeviceId: "computer-a",
      toDeviceId: "computer-b",
      confirmed: false,
    });
    expect(pending).toMatchObject({
      kind: "needs-confirmation",
      changed: false,
      interruptedDeviceId: "computer-a",
    });
    expect(pending.devices).toEqual(enabled);
    const moved = moveRemoteSeat(enabled, {
      accountId: "account",
      fromDeviceId: "computer-a",
      toDeviceId: "computer-b",
      confirmed: true,
    });
    expect(moved).toMatchObject({
      kind: "moved",
      changed: true,
      interruptedDeviceId: "computer-a",
    });
    expect(moved.devices.map((item) => item.remoteEnabled)).toEqual([false, true, false]);
    expect(JSON.stringify(moved)).not.toMatch(/space|vault|chat|message|credential/i);
  });

  it("turns remote off without removing the computer", () => {
    const enabled = [device("account", "computer-a", true)];
    const disabled = disableRemoteSeat(enabled, { accountId: "account", deviceId: "computer-a" });
    expect(disabled).toEqual({
      kind: "disabled",
      changed: true,
      devices: [device("account", "computer-a", false)],
    });
    expect(
      disableRemoteSeat(disabled.devices, { accountId: "account", deviceId: "computer-a" }),
    ).toMatchObject({ kind: "disabled", changed: false });
  });

  it("does not create a computer while enabling or disabling remote", () => {
    expect(enableRemoteSeat([], policy, { accountId: "account", deviceId: "missing" }).kind).toBe(
      "unregistered",
    );
    expect(disableRemoteSeat([], { accountId: "account", deviceId: "missing" }).kind).toBe(
      "unregistered",
    );
  });

  it("allows a second configured seat and still stops at that limit", () => {
    const two = remoteSeatPolicy({ accountSeats: 2 });
    const devices = [
      device("account", "computer-a"),
      device("account", "computer-b"),
      device("account", "computer-c"),
    ];
    const first = enableRemoteSeat(devices, two, { accountId: "account", deviceId: "computer-a" });
    const second = enableRemoteSeat(first.devices, two, {
      accountId: "account",
      deviceId: "computer-b",
    });
    expect(second.kind).toBe("enabled");
    expect(
      enableRemoteSeat(second.devices, two, { accountId: "account", deviceId: "computer-c" }),
    ).toMatchObject({ kind: "occupied", holders: ["computer-a", "computer-b"] });
  });

  it("stops a new grant at the pilot cap and still allows a move inside an account", () => {
    const capped = remoteSeatPolicy({ pilotCap: 2 });
    const devices = [
      device("one", "computer-1", true),
      device("two", "computer-2", true),
      device("three", "computer-3"),
      device("two", "computer-2b"),
    ];
    expect(
      enableRemoteSeat(devices, capped, { accountId: "three", deviceId: "computer-3" }),
    ).toMatchObject({ kind: "pilot-full", changed: false });
    const moved = moveRemoteSeat(devices, {
      accountId: "two",
      fromDeviceId: "computer-2",
      toDeviceId: "computer-2b",
      confirmed: true,
    });
    expect(moved.kind).toBe("moved");
    expect(moved.devices.filter((item) => item.remoteEnabled)).toHaveLength(2);
  });

  it("leaves the supplied registry unchanged", () => {
    const devices = [device("account", "computer-a")];
    enableRemoteSeat(devices, policy, { accountId: "account", deviceId: "computer-a" });
    expect(devices).toEqual([device("account", "computer-a")]);
  });

  it("rejects an empty computer id", () => {
    expect(() => registerRemoteDevice([], { accountId: "account", deviceId: "" })).toThrow(
      "Remote device is invalid",
    );
  });

  it("keeps remote off distinct from offline and releases a silent provider after 15 minutes", () => {
    const now = 1_000_000;
    expect(remotePresence({ remoteEnabled: false, heartbeatAt: now, now, error: false })).toEqual({
      state: "off",
      releaseProvider: true,
    });
    expect(remotePresence({ remoteEnabled: true, heartbeatAt: null, now, error: false })).toEqual({
      state: "connecting",
      releaseProvider: false,
    });
    expect(
      remotePresence({
        remoteEnabled: true,
        heartbeatAt: now - REMOTE_OFFLINE_AFTER_MS + 1,
        now,
        error: false,
      }),
    ).toEqual({ state: "ready", releaseProvider: false });
    expect(
      remotePresence({
        remoteEnabled: true,
        heartbeatAt: now - REMOTE_OFFLINE_AFTER_MS,
        now,
        error: true,
      }),
    ).toEqual({ state: "offline", releaseProvider: true });
    expect(remotePresence({ remoteEnabled: true, heartbeatAt: now, now, error: true })).toEqual({
      state: "error",
      releaseProvider: false,
    });
  });

  it("opens the only ready computer and keeps the others visible", () => {
    const devices = [
      { deviceId: "a", logicalHost: "ha", remoteEnabled: true, state: "ready" as const },
      { deviceId: "b", logicalHost: "hb", remoteEnabled: false, state: "off" as const },
    ];
    expect(remotePortal(devices)).toMatchObject({ kind: "open", deviceId: "a", logicalHost: "ha" });
    expect(remotePortal(devices).devices).toHaveLength(2);
    expect(
      remotePortal([
        { deviceId: "a", logicalHost: "ha", remoteEnabled: true, state: "ready" },
        { deviceId: "b", logicalHost: "hb", remoteEnabled: true, state: "ready" },
      ]).kind,
    ).toBe("choose");
    const offline = devices[1];
    if (!offline) throw new Error("missing computer");
    expect(remotePortal([offline]).kind).toBe("unavailable");
    remotePortal(devices);
    expect(devices[0]?.state).toBe("ready");
  });

  it("does not store a connector token as the provider object", () => {
    const token = "eyJ-test-connector-token";
    const objectId = "11111111-1111-4111-8111-111111111111";
    expect(remoteObjectId({ objectId, runToken: token })).toBe(objectId);
    expect(
      JSON.stringify({ providerObjectId: remoteObjectId({ objectId, runToken: token }) }),
    ).not.toContain(token);
    expect(() => remoteObjectId({ objectId: token, runToken: token })).toThrow("connector token");
  });
});
