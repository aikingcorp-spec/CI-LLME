import { EMAIL_NOT_INVITED } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  addAllowlistEmail,
  EMAIL_NOT_INVITED_MESSAGE,
  isAllowlistEmail,
  isEmailInvited,
  normalizeEmail,
  notInvited,
  parseEmailAllowlistArgs,
  removeAllowlistEmail,
  runEmailAllowlist,
} from "./email-allowlist.js";

describe("invite addresses", () => {
  it("trims and lowercases without stripping plus-tags", () => {
    expect(normalizeEmail("  Lan+Tag@Gmail.com ")).toBe("lan+tag@gmail.com");
    expect(isAllowlistEmail("lan+tag@gmail.com")).toBe(true);
    expect(isAllowlistEmail("lan@gmail.com")).toBe(true);
    expect(isAllowlistEmail("not-an-email")).toBe(false);
    expect(isAllowlistEmail("@gmail.com")).toBe(false);
    expect(isAllowlistEmail("lan@")).toBe(false);
  });

  it("normalizes in the fixed order: trim, NFC, strip zero-width, lowercase", () => {
    expect(normalizeEmail(" Eve@Example.com ")).toBe("eve@example.com");
    expect(normalizeEmail("eve\u200b@example.com")).toBe("eve@example.com");
    for (const mark of ["\u200b", "\u200c", "\u200d", "\u2060", "\ufeff"]) {
      expect(normalizeEmail(`${mark}Eve@Exa${mark}mple.com${mark}`)).toBe("eve@example.com");
    }
    // NFD "e + combining acute" becomes the single NFC code point before lowercasing.
    expect(normalizeEmail("Re\u0301my@example.com")).toBe("r\u00e9my@example.com");
    expect(normalizeEmail("R\u00c9MY@example.com")).toBe("r\u00e9my@example.com");
    expect(isAllowlistEmail("eve\u200b@example.com")).toBe(false);
  });

  it("returns HTTP 403 EMAIL_NOT_INVITED", () => {
    const error = notInvited();
    expect(error.status).toBe("FORBIDDEN");
    expect(error.body).toMatchObject({
      code: EMAIL_NOT_INVITED,
      message: EMAIL_NOT_INVITED_MESSAGE,
    });
  });
});

describe("invite list commands", () => {
  function memory() {
    const rows = new Map<
      string,
      { email: string; note: string | null; addedBy: string | null; createdAt: Date }
    >();
    const sessions: { userEmail: string }[] = [
      { userEmail: "Lan@Gmail.com" },
      { userEmail: "x@y.z" },
    ];
    const prisma: Record<string, unknown> = {
      $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(prisma)),
      session: {
        deleteMany: vi.fn(async ({ where }: { where: { user: { email: { equals: string } } } }) => {
          const before = sessions.length;
          const kept = sessions.filter(
            (row) => row.userEmail.toLowerCase() !== where.user.email.equals,
          );
          sessions.splice(0, sessions.length, ...kept);
          return { count: before - kept.length };
        }),
      },
      $queryRaw: vi.fn(async () => [{ bypass: "off" }]),
      $executeRaw: vi.fn(async () => 0),
      authEmailAllowlist: {
        findUnique: vi.fn(
          async ({ where }: { where: { email: string } }) => rows.get(where.email) ?? null,
        ),
        findMany: vi.fn(async () =>
          [...rows.values()].sort((a, b) => a.email.localeCompare(b.email)),
        ),
        create: vi.fn(
          async ({
            data,
          }: {
            data: { email: string; note: string | null; addedBy: string | null };
          }) => {
            if (rows.has(data.email)) {
              const error = new Error("unique") as Error & { code: string };
              error.code = "P2002";
              throw error;
            }
            const row = { ...data, createdAt: new Date("2026-10-28T00:00:00.000Z") };
            rows.set(data.email, row);
            return row;
          },
        ),
        deleteMany: vi.fn(async ({ where }: { where: { email: string } }) => {
          const removed = rows.delete(where.email);
          return { count: removed ? 1 : 0 };
        }),
      },
    };
    return { prisma: prisma as never, rows, sessions };
  }

  it("adds, lists, and removes normalized addresses", async () => {
    const { prisma, rows, sessions } = memory();
    expect(
      parseEmailAllowlistArgs(["add", "Lan@Gmail.com", "--note", "wave 1", "--added-by", "ops"]),
    ).toEqual({
      action: "add",
      email: "Lan@Gmail.com",
      note: "wave 1",
      addedBy: "ops",
    });
    expect(
      await addAllowlistEmail(prisma, "Lan@Gmail.com", { note: "wave 1", addedBy: "ops" }),
    ).toEqual({
      email: "lan@gmail.com",
      created: true,
    });
    expect(await addAllowlistEmail(prisma, "lan@gmail.com")).toEqual({
      email: "lan@gmail.com",
      created: false,
    });
    expect(await isEmailInvited(prisma, "LAN@gmail.com")).toBe(true);
    expect(await isEmailInvited(prisma, "other@gmail.com")).toBe(false);
    expect(rows.size).toBe(1);
    const listed = await runEmailAllowlist(prisma, { action: "list" });
    expect(listed).toContain('"email":"lan@gmail.com"');
    expect(listed).toContain('"note":"wave 1"');
    expect(await removeAllowlistEmail(prisma, "lan@gmail.com")).toEqual({
      email: "lan@gmail.com",
      removed: true,
      sessionsRevoked: 1,
    });
    expect(sessions).toEqual([{ userEmail: "x@y.z" }]);
    expect(await isEmailInvited(prisma, "lan@gmail.com")).toBe(false);
    expect(
      await runEmailAllowlist(prisma, parseEmailAllowlistArgs(["remove", "missing@x.test"])),
    ).toBe("not listed missing@x.test\n");
  });

  it("rejects a command that is not add, remove, or list", () => {
    expect(() => parseEmailAllowlistArgs([])).toThrow(/Usage/);
    expect(() => parseEmailAllowlistArgs(["add"])).toThrow(/Usage/);
    expect(() => addAllowlistEmail({} as never, "not-an-email")).rejects.toThrow(/usable invite/);
  });
});
