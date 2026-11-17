import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { isAdmin, isHostedCentralPortal, isLocalMcpAdmin } from "./admins.js";

describe("isAdmin", () => {
  const users = [
    { id: "verified", email: "Admin@Example.test", emailVerified: true },
    { id: "unverified", email: "admin@example.test", emailVerified: false },
  ];
  const prisma = {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        users.find((user) => user.id === where.id) ?? null,
      findFirst: async () => ({ id: "verified" }),
    },
  } as unknown as PrismaClient;

  it("requires a listed, verified email", async () => {
    const deps = { prisma, env: { adminEmails: ["admin@example.test"] } as never };
    expect(await isAdmin(deps, "verified")).toBe(true);
    expect(await isAdmin(deps, "unverified")).toBe(false);
    expect(await isAdmin({ prisma, env: {} as never }, "verified")).toBe(false);
  });

  it("grants local MCP stdio only to the machine owner on local/self-hosted hosts and never on the central portal", async () => {
    const localDeps = { prisma, env: {} as never, billing: undefined };
    expect(isHostedCentralPortal(localDeps)).toBe(false);
    expect(await isLocalMcpAdmin(localDeps, "verified")).toBe(true);
    expect(await isLocalMcpAdmin(localDeps, "employee-2")).toBe(false);

    const centralDeps = {
      prisma,
      env: {} as never,
      issueRemoteEnter: (() => Promise.resolve({ href: null })) as never,
    };
    expect(isHostedCentralPortal(centralDeps)).toBe(true);
    expect(await isLocalMcpAdmin(centralDeps, "verified")).toBe(false);

    const explicitListDeps = {
      prisma,
      env: { adminEmails: ["other@example.test"] } as never,
    };
    expect(await isLocalMcpAdmin(explicitListDeps, "verified")).toBe(false);
  });
});
