import type { PrismaClient } from "@rakazo/db";
import { afterEach, expect, it, vi } from "vitest";
import { hostRemoteAccount, soleSignedInAccount, startLocalPresence } from "./local-presence.js";

afterEach(() => {
  vi.useRealTimers();
});

const intervalMs = 1_000;

it("keeps the host account when a guest is also signed in", () => {
  expect(
    hostRemoteAccount([
      { userId: "guest", guestOnly: true },
      { userId: "owner", guestOnly: false },
    ]),
  ).toBe("owner");
  expect(hostRemoteAccount([{ userId: "guest", guestOnly: true }])).toBeNull();
  expect(
    hostRemoteAccount([
      { userId: "owner-a", guestOnly: false },
      { userId: "owner-b", guestOnly: false },
    ]),
  ).toBeNull();
});

it("does not select a guest session as this computer's account", async () => {
  const now = new Date("2026-11-11T00:00:00Z");
  const db = {
    session: {
      findMany: async () => [{ userId: "guest" }, { userId: "owner" }],
    },
    member: {
      findMany: async () => [
        { userId: "guest", role: "guest" },
        { userId: "owner", role: "owner" },
      ],
    },
  } as unknown as PrismaClient;
  await expect(soleSignedInAccount(db, now)).resolves.toBe("owner");
  const guestOnly = {
    session: { findMany: async () => [{ userId: "guest" }] },
    member: { findMany: async () => [{ userId: "guest", role: "guest" }] },
  } as unknown as PrismaClient;
  await expect(soleSignedInAccount(guestOnly, now)).resolves.toBeNull();
});

it("prefers machineOwnerUserId when both owner and another non-guest are signed in", async () => {
  const now = new Date("2026-11-11T00:00:00Z");
  const db = {
    user: {
      findFirst: async () => ({ id: "owner" }),
    },
    session: {
      findFirst: async ({ where }: { where: { userId: string } }) =>
        where.userId === "owner" ? { id: "s-owner" } : null,
      findMany: async () => [{ userId: "owner" }, { userId: "co-member" }],
    },
    member: {
      findMany: async () => [
        { userId: "owner", role: "owner" },
        { userId: "co-member", role: "member" },
      ],
    },
  } as unknown as PrismaClient;
  await expect(soleSignedInAccount(db, now)).resolves.toBe("owner");
});

it("keeps reporting the account this process already named", async () => {
  vi.useFakeTimers();
  const present = vi.fn(async () => undefined);
  const signedInAccount = vi.fn(async () => null);
  const presence = startLocalPresence({
    intervalMs,
    signedInAccount,
    accountStillSignedIn: async () => true,
    present,
  });
  presence.note("account-1");
  await vi.advanceTimersByTimeAsync(intervalMs);
  expect(present).toHaveBeenCalledWith("account-1");
  expect(signedInAccount).not.toHaveBeenCalled();
  await presence.stop();
  vi.useRealTimers();
});

it("reports the only signed-in account when the window has not named one", async () => {
  vi.useFakeTimers();
  const present = vi.fn(async () => undefined);
  const presence = startLocalPresence({
    intervalMs,
    signedInAccount: async () => "account-1",
    accountStillSignedIn: async () => true,
    present,
  });
  await vi.advanceTimersByTimeAsync(intervalMs);
  expect(present).toHaveBeenCalledWith("account-1");
  await presence.stop();
  vi.useRealTimers();
});

it("does not guess when nobody is signed in or more than one account is", async () => {
  vi.useFakeTimers();
  const present = vi.fn(async () => undefined);
  const presence = startLocalPresence({
    intervalMs,
    signedInAccount: async () => null,
    accountStillSignedIn: async () => false,
    present,
  });
  await vi.advanceTimersByTimeAsync(intervalMs);
  expect(present).not.toHaveBeenCalled();
  await presence.stop();
  vi.useRealTimers();
});

it("stops reporting an account after its session is gone", async () => {
  vi.useFakeTimers();
  const present = vi.fn(async () => undefined);
  const presence = startLocalPresence({
    intervalMs,
    signedInAccount: async () => null,
    accountStillSignedIn: async () => false,
    present,
  });
  presence.note("account-1");
  await vi.advanceTimersByTimeAsync(intervalMs);
  expect(present).not.toHaveBeenCalled();
  await presence.stop();
  vi.useRealTimers();
});

it("keeps the next report after one report fails", async () => {
  vi.useFakeTimers();
  const present = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error("down"))
    .mockResolvedValue(undefined);
  const onError = vi.fn();
  const presence = startLocalPresence({
    intervalMs,
    signedInAccount: async () => "account-1",
    accountStillSignedIn: async () => true,
    present,
    onError,
  });
  await vi.advanceTimersByTimeAsync(intervalMs);
  await vi.advanceTimersByTimeAsync(intervalMs);
  expect(onError).toHaveBeenCalledOnce();
  expect(present).toHaveBeenCalledTimes(2);
  await presence.stop();
  vi.useRealTimers();
});

it("does not report after it is stopped", async () => {
  vi.useFakeTimers();
  const present = vi.fn(async () => undefined);
  const presence = startLocalPresence({
    intervalMs,
    signedInAccount: async () => "account-1",
    accountStillSignedIn: async () => true,
    present,
  });
  await presence.stop();
  await vi.advanceTimersByTimeAsync(intervalMs);
  expect(present).not.toHaveBeenCalled();
  vi.useRealTimers();
});
