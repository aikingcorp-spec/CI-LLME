import { describe, expect, it, vi } from "vitest";
import { machineOwnerUserId } from "./machine-owner.js";

describe("machineOwnerUserId", () => {
  it("picks the first verified account, oldest first", async () => {
    const findFirst = vi.fn(async () => ({ id: "first-user" }));
    expect(await machineOwnerUserId({ user: { findFirst } } as never)).toBe("first-user");
    expect(findFirst).toHaveBeenCalledWith({
      where: { emailVerified: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });
  });

  it("has no owner before anyone verified an email", async () => {
    const findFirst = vi.fn(async () => null);
    expect(await machineOwnerUserId({ user: { findFirst } } as never)).toBeNull();
  });
});
