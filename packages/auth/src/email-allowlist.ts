import { EMAIL_NOT_INVITED } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystemInTransaction } from "@rakazo/db";
import { APIError } from "better-auth/api";

/** English body. Clients map `EMAIL_NOT_INVITED`; they do not show this sentence. */
export const EMAIL_NOT_INVITED_MESSAGE = "This email is not invited yet";

/** Trim and lowercase only. Plus-tags and dots stay, so the invite is the exact address. */
export function normalizeEmail(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase();
}

/**
 * Same shape as the `auth_email_allowlist` CHECK: already trimmed and
 * lowercase, and at least one character on each side of an `@`.
 */
export function isAllowlistEmail(email: string): boolean {
  return email === normalizeEmail(email) && /.@./.test(email);
}

export function notInvited(): APIError {
  return new APIError("FORBIDDEN", {
    code: EMAIL_NOT_INVITED,
    message: EMAIL_NOT_INVITED_MESSAGE,
  });
}

/** A live session whose address left the invite list: 401 with the same code. */
export function sessionNotInvited(): APIError {
  return new APIError("UNAUTHORIZED", {
    code: EMAIL_NOT_INVITED,
    message: EMAIL_NOT_INVITED_MESSAGE,
  });
}

export async function isEmailInvited(prisma: PrismaClient, raw: unknown): Promise<boolean> {
  const email = normalizeEmail(raw);
  if (!isAllowlistEmail(email)) return false;
  // The shared API client does not set bypass on every checkout. This system
  // context does, so the lookup connection gets app.rls_bypass = 'on'.
  return runAsSystemInTransaction(prisma, "read the sign-in invite list", async () => {
    const row = await prisma.authEmailAllowlist.findUnique({
      where: { email },
      select: { email: true },
    });
    return row !== null;
  });
}

export interface AllowlistEntry {
  email: string;
  note: string | null;
  addedBy: string | null;
  createdAt: Date;
}

export async function addAllowlistEmail(
  prisma: PrismaClient,
  raw: unknown,
  meta: { note?: string | null; addedBy?: string | null } = {},
): Promise<{ email: string; created: boolean }> {
  const email = normalizeEmail(raw);
  if (!isAllowlistEmail(email)) throw new Error("Email is not a usable invite address");
  const note = blankToNull(meta.note);
  const addedBy = blankToNull(meta.addedBy);
  try {
    await prisma.authEmailAllowlist.create({ data: { email, note, addedBy } });
    return { email, created: true };
  } catch (error) {
    if (isUniqueViolation(error)) return { email, created: false };
    throw error;
  }
}

/**
 * Removes the invite and, in the same transaction, deletes every session of the
 * account with that address, so a removed person is signed out everywhere.
 */
export async function removeAllowlistEmail(
  prisma: PrismaClient,
  raw: unknown,
): Promise<{ email: string; removed: boolean; sessionsRevoked: number }> {
  const email = normalizeEmail(raw);
  if (!isAllowlistEmail(email)) throw new Error("Email is not a usable invite address");
  const [removed, revoked] = await prisma.$transaction([
    prisma.authEmailAllowlist.deleteMany({ where: { email } }),
    prisma.session.deleteMany({
      where: { user: { email: { equals: email, mode: "insensitive" } } },
    }),
  ]);
  return { email, removed: removed.count > 0, sessionsRevoked: revoked.count };
}

export async function listAllowlistEmails(prisma: PrismaClient): Promise<AllowlistEntry[]> {
  return prisma.authEmailAllowlist.findMany({
    orderBy: { email: "asc" },
    select: { email: true, note: true, addedBy: true, createdAt: true },
  });
}

export type AllowlistCommand =
  | { action: "add"; email: string; note?: string; addedBy?: string }
  | { action: "remove"; email: string }
  | { action: "list" };

export async function runEmailAllowlist(
  prisma: PrismaClient,
  command: AllowlistCommand,
): Promise<string> {
  if (command.action === "list") {
    const rows = await listAllowlistEmails(prisma);
    if (!rows.length) return "";
    return `${rows.map((row) => JSON.stringify(allowlistLine(row))).join("\n")}\n`;
  }
  if (command.action === "remove") {
    const result = await removeAllowlistEmail(prisma, command.email);
    if (!result.removed) return `not listed ${result.email}\n`;
    return `removed ${result.email} (signed out ${result.sessionsRevoked} session${result.sessionsRevoked === 1 ? "" : "s"})\n`;
  }
  const result = await addAllowlistEmail(prisma, command.email, {
    note: command.note,
    addedBy: command.addedBy,
  });
  return result.created ? `added ${result.email}\n` : `already listed ${result.email}\n`;
}

function allowlistLine(row: AllowlistEntry): {
  email: string;
  note: string | null;
  addedBy: string | null;
  createdAt: string;
} {
  return {
    email: row.email,
    note: row.note,
    addedBy: row.addedBy,
    createdAt: row.createdAt.toISOString(),
  };
}

export function parseEmailAllowlistArgs(args: string[]): AllowlistCommand {
  const { values, positionals } = parseAllowlistArgs(args);
  const [action, email, extra] = positionals;
  if (extra !== undefined) throw new Error(ALLOWLIST_USAGE);
  if (action === "list") {
    if (email !== undefined) throw new Error(ALLOWLIST_USAGE);
    return { action: "list" };
  }
  if ((action === "add" || action === "remove") && email) {
    return {
      action,
      email,
      ...(values.note !== undefined ? { note: values.note } : {}),
      ...(values["added-by"] !== undefined ? { addedBy: values["added-by"] } : {}),
    };
  }
  throw new Error(ALLOWLIST_USAGE);
}

export const ALLOWLIST_USAGE =
  "Usage: email-allowlist <add|remove|list> [email] [--note text] [--added-by text]";

function parseAllowlistArgs(args: string[]) {
  return parseArgs(args);
}

function parseArgs(args: string[]): {
  values: { note?: string; "added-by"?: string };
  positionals: string[];
} {
  const values: { note?: string; "added-by"?: string } = {};
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--note" || arg === "--added-by") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(ALLOWLIST_USAGE);
      values[arg.slice(2) as "note" | "added-by"] = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) throw new Error(ALLOWLIST_USAGE);
    positionals.push(arg);
  }
  return { values, positionals };
}

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : null;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}
