import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor = { spaceId: "space-1", userId: "user-1", email: "user@example.test" } satisfies Actor;

describe("removed paymentWallet routes", () => {
  it.each(["status", "connect", "disconnect"])(
    "does not handle %s or access stored wallets",
    async (path) => {
      const prisma = new Proxy(
        {},
        {
          get() {
            throw new Error("Wallet requests must not access the database");
          },
        },
      );
      const secrets = { delete: vi.fn(), put: vi.fn(), load: vi.fn() };
      const deps = { prisma, secrets, env: {}, dataDir: "/tmp/test" } as unknown as RouterDeps;
      const handler = new RPCHandler(createRouter(deps));
      const result = await handler.handle(
        new Request(`https://example.test/rpc/paymentWallet/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        }),
        { prefix: "/rpc", context: { actor } },
      );
      expect(result.matched).toBe(false);
      expect(secrets.delete).not.toHaveBeenCalled();
      expect(secrets.put).not.toHaveBeenCalled();
      expect(secrets.load).not.toHaveBeenCalled();
    },
  );
});
