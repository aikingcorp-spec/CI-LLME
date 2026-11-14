import type { PrismaClient } from "@rakazo/db";
import { expect, it } from "vitest";
import { admitRemoteVisitor } from "./remote-visitor.js";

function database(input: {
  userId?: string;
  member?: boolean;
  inviteOpen?: boolean;
}): PrismaClient {
  return {
    account: {
      findFirst: async () => (input.userId ? { userId: input.userId } : null),
    },
    spaceMember: {
      findFirst: async () => (input.member ? { id: "member" } : null),
    },
    spaceInvite: {
      findUnique: async () =>
        input.inviteOpen
          ? {
              acceptedAt: null,
              expiresAt: new Date(Date.now() + 60_000),
              space: { deletingAt: null },
            }
          : null,
    },
  } as unknown as PrismaClient;
}

it("admits an existing member and does not create another user", async () => {
  let created = 0;
  const userId = await admitRemoteVisitor(database({ userId: "owner", member: true }), {
    accountId: "account",
    email: "owner@example.test",
    createUser: async () => {
      created += 1;
      return "other";
    },
  });
  expect(userId).toBe("owner");
  expect(created).toBe(0);
});

it("does not create a user for a ticket without an open invite", async () => {
  let created = 0;
  const userId = await admitRemoteVisitor(database({}), {
    accountId: "account",
    email: "guest@example.test",
    inviteToken: "invite-token",
    createUser: async () => {
      created += 1;
      return "guest";
    },
  });
  expect(userId).toBeNull();
  expect(created).toBe(0);
});
