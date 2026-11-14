import { afterEach, expect, it, vi } from "vitest";
import { reserveMailboxAttempt } from "./mailbox-rate-limit.js";

afterEach(() => vi.restoreAllMocks());

it("reserves ten slots across concurrent callers without deleting another caller's slot", async () => {
  const held = new Set<string>();
  const adapter = {
    async reserveVerificationValue(input: { identifier: string }) {
      if (held.has(input.identifier)) return false;
      held.add(input.identifier);
      return true;
    },
  };
  const clock = vi.spyOn(Date, "now").mockReturnValue(900_000);
  const burst = () =>
    Promise.all(
      Array.from({ length: 30 }, () =>
        reserveMailboxAttempt(adapter, "example@example.test", "/send"),
      ),
    );
  expect((await burst()).filter(Boolean)).toHaveLength(10);
  expect(await reserveMailboxAttempt(adapter, " EXAMPLE@example.test ", "/send")).toBe(false);
  expect(await reserveMailboxAttempt(adapter, "other@example.test", "/send")).toBe(true);
  expect(await reserveMailboxAttempt(adapter, "example@example.test", "/verify")).toBe(true);
  clock.mockReturnValue(1_800_000);
  expect((await burst()).filter(Boolean)).toHaveLength(10);
  expect([...held].join()).not.toContain("example@example.test");
});
