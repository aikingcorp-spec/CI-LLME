import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { resolveWithSpaceOwnerFallback } from "./space-owner-fallback.js";

describe("resolveWithSpaceOwnerFallback", () => {
  it("prefers the caller's own resource before consulting the Space Owner", async () => {
    const findFirst = vi.fn();
    const prisma = { spaceMember: { findFirst } } as unknown as PrismaClient;
    const lookedUp: Array<{ userId: string; borrowed: boolean }> = [];
    const result = await resolveWithSpaceOwnerFallback(
      prisma,
      { userId: "employee-1", spaceId: "space-shared" },
      "test own resource",
      async (effectiveScope, borrowed) => {
        lookedUp.push({ userId: effectiveScope.userId, borrowed });
        return effectiveScope.userId === "employee-1" ? { key: "own-key" } : null;
      },
    );
    expect(result).toEqual({
      value: { key: "own-key" },
      effectiveUserId: "employee-1",
      borrowed: false,
    });
    expect(lookedUp).toEqual([{ userId: "employee-1", borrowed: false }]);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("falls back to the Space Owner when the member has no own resource", async () => {
    const prisma = {
      spaceMember: {
        findFirst: vi.fn(async () => ({ userId: "boss-1" })),
      },
    } as unknown as PrismaClient;
    const lookedUp: Array<{ userId: string; borrowed: boolean }> = [];
    const result = await resolveWithSpaceOwnerFallback(
      prisma,
      { userId: "employee-1", spaceId: "space-shared" },
      "test space owner fallback",
      async (effectiveScope, borrowed) => {
        lookedUp.push({ userId: effectiveScope.userId, borrowed });
        return effectiveScope.userId === "boss-1" ? { key: "boss-key" } : null;
      },
    );
    expect(result).toEqual({
      value: { key: "boss-key" },
      effectiveUserId: "boss-1",
      borrowed: true,
    });
    expect(lookedUp).toEqual([
      { userId: "employee-1", borrowed: false },
      { userId: "boss-1", borrowed: true },
    ]);
  });

  it("does not query twice when the caller is already the Space Owner", async () => {
    const prisma = {
      spaceMember: {
        findFirst: vi.fn(async () => ({ userId: "boss-1" })),
      },
    } as unknown as PrismaClient;
    const lookedUp: string[] = [];
    const result = await resolveWithSpaceOwnerFallback(
      prisma,
      { userId: "boss-1", spaceId: "space-shared" },
      "test owner no-op",
      async (effectiveScope) => {
        lookedUp.push(effectiveScope.userId);
        return null;
      },
    );
    expect(result).toEqual({
      value: null,
      effectiveUserId: "boss-1",
      borrowed: false,
    });
    expect(lookedUp).toEqual(["boss-1"]);
  });
});
