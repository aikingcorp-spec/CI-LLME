import type { RemotePortal } from "@rakazo/contracts";
import { expect, it } from "vitest";
import type { ComputerPreferenceStore } from "./remembered-computer";
import {
  portalEntry,
  readRememberedComputer,
  rememberComputer,
  rememberedComputerKey,
} from "./remembered-computer";

const origin = "https://app.vnbot.run";

function store(seed: Record<string, string> = {}): ComputerPreferenceStore & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem(key) {
      return data.get(key) ?? null;
    },
    setItem(key, value) {
      data.set(key, value);
    },
  };
}

function portal(kind: RemotePortal["kind"], devices: RemotePortal["devices"]): RemotePortal {
  const ready = devices.find((device) => device.state === "ready");
  if (kind === "open") {
    if (!ready) throw new Error("An open portal needs a ready computer");
    return { kind, deviceId: ready.deviceId, logicalHost: ready.logicalHost, devices };
  }
  return { kind, devices };
}

const offlineA = {
  deviceId: "a",
  logicalHost: "ha",
  remoteEnabled: true,
  state: "offline" as const,
};
const readyB = {
  deviceId: "b",
  logicalHost: "hb",
  remoteEnabled: true,
  state: "ready" as const,
};

it("keeps a remembered offline computer from selecting the only other ready one", () => {
  expect(
    portalEntry({
      portal: portal("open", [offlineA, readyB]),
      rememberedDeviceId: "a",
    }),
  ).toEqual({ kind: "choose", rememberedAbsent: false });
});

it("opens a remembered computer only when it is the sole ready one", () => {
  const readyA = { ...readyB, deviceId: "a", logicalHost: "ha" };
  expect(portalEntry({ portal: portal("open", [readyA]), rememberedDeviceId: "a" })).toEqual({
    kind: "auto",
    deviceId: "a",
  });
  const readyC = { ...readyB, deviceId: "c", logicalHost: "hc" };
  expect(
    portalEntry({
      portal: portal("choose", [readyA, readyC]),
      rememberedDeviceId: "a",
    }),
  ).toEqual({ kind: "choose", rememberedAbsent: false });
});

it("follows the server on the first visit and names a remembered computer that is gone", () => {
  expect(portalEntry({ portal: portal("open", [readyB]), rememberedDeviceId: null })).toEqual({
    kind: "auto",
    deviceId: "b",
  });
  expect(
    portalEntry({ portal: portal("choose", [readyB, readyB]), rememberedDeviceId: null }),
  ).toEqual({
    kind: "choose",
    rememberedAbsent: false,
  });
  expect(portalEntry({ portal: portal("unavailable", []), rememberedDeviceId: null })).toEqual({
    kind: "choose",
    rememberedAbsent: false,
  });
  expect(portalEntry({ portal: portal("open", [readyB]), rememberedDeviceId: "a" })).toEqual({
    kind: "choose",
    rememberedAbsent: true,
  });
});

it("stores only the device id for one account and one site", () => {
  const saved = store();
  const key = rememberedComputerKey("user-a", origin);
  const other = rememberedComputerKey("user-b", origin);
  const elsewhere = rememberedComputerKey("user-a", "https://other.example");
  if (key === null || other === null || elsewhere === null) throw new Error("Missing key");
  rememberComputer(saved, {
    userId: "user-a",
    origin,
    deviceId: "a",
  });
  expect(JSON.parse(saved.data.get(key) ?? "")).toEqual({ deviceId: "a" });
  expect(saved.data.get(key)).not.toMatch(/href|ticket|token|@/i);
  expect(readRememberedComputer(saved, { userId: "user-b", origin })).toBeNull();
  expect(
    readRememberedComputer(saved, { userId: "user-a", origin: "https://other.example" }),
  ).toBeNull();
  saved.setItem(other, JSON.stringify({ deviceId: "stolen", href: "https://stolen.example" }));
  expect(readRememberedComputer(saved, { userId: "user-a", origin })).toBe("a");
  expect(readRememberedComputer(saved, { userId: null, origin })).toBeNull();
  rememberComputer(saved, { userId: null, origin, deviceId: "b" });
  rememberComputer(saved, { userId: "user-a", origin, deviceId: "" });
  expect(saved.data.get(key)).toBe(JSON.stringify({ deviceId: "a" }));
  expect(elsewhere in Object.fromEntries(saved.data)).toBe(false);
});

it("ignores a broken preference and a denied store", () => {
  const key = rememberedComputerKey("user-a", origin);
  if (key === null) throw new Error("Missing key");
  const saved = store({
    [key]: JSON.stringify({ href: "https://stolen.example", email: "a@example.test" }),
  });
  expect(readRememberedComputer(saved, { userId: "user-a", origin })).toBeNull();
  saved.setItem(key, "not-json");
  expect(readRememberedComputer(saved, { userId: "user-a", origin })).toBeNull();
  saved.setItem(key, JSON.stringify({ deviceId: "a", href: "https://stolen.example" }));
  expect(readRememberedComputer(saved, { userId: "user-a", origin })).toBe("a");
  const denied: ComputerPreferenceStore = {
    getItem() {
      throw new DOMException("denied");
    },
    setItem() {
      throw new DOMException("denied");
    },
  };
  expect(readRememberedComputer(denied, { userId: "user-a", origin })).toBeNull();
  expect(() => rememberComputer(denied, { userId: "user-a", origin, deviceId: "a" })).not.toThrow();
  expect(readRememberedComputer(null, { userId: "user-a", origin })).toBeNull();
});
