import { EMAIL_NOT_INVITED } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystemInTransaction } from "@rakazo/db";
import { APIError } from "better-auth/api";

/** English body. Clients map `EMAIL_NOT_INVITED`; they do not show this sentence. */
export const EMAIL_NOT_INVITED_MESSAGE = "This email is not invited yet";

/** Zero-width characters a pasted address can carry: U+200B, U+200C, U+200D, U+2060, U+FEFF. */
const ZERO_WIDTH = /\u200B|\u200C|\u200D|\u2060|\uFEFF/g;

/**
 * Fixed order, matching the `auth_email_allowlist` CHECK: trim, Unicode NFC,
 * strip zero-width characters, lowercase. Plus-tags and dots stay, so the
 * invite is the exact address.
 */
export function normalizeEmail(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .normalize("NFC")
    .replace(ZERO_WIDTH, "")
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

/** "team" uses everything VNBot offers; "free" uses the desktop app on the person's own computer. */
export type Edition = "team" | "free";
export const EDITIONS: readonly Edition[] = ["team", "free"];

/**
 * A row with this address admits every other address as free. Adding it opens free sign-up to
 * everyone; removing it returns to approving each address.
 */
export const FREE_FOR_EVERYONE = "*@*";

/** The address's edition, or null when the list does not admit it. Throws when the list cannot be read. */
export async function emailEdition(prisma: PrismaClient, raw: unknown): Promise<Edition | null> {
  const email = normalizeEmail(raw);
  if (!isAllowlistEmail(email) || email === FREE_FOR_EVERYONE) return null;
  // The shared API client does not set bypass on every checkout. This system
  // context does, so the lookup connection gets app.rls_bypass = 'on'.
  return runAsSystemInTransaction(prisma, "read the sign-in invite list", async () => {
    const own = await prisma.authEmailAllowlist.findUnique({
      where: { email },
      select: { edition: true },
    });
    if (own) return own.edition === "free" ? "free" : "team";
    const everyone = await prisma.authEmailAllowlist.findUnique({
      where: { email: FREE_FOR_EVERYONE },
      select: { email: true },
    });
    return everyone ? "free" : null;
  });
}

export async function isEmailInvited(prisma: PrismaClient, raw: unknown): Promise<boolean> {
  return (await emailEdition(prisma, raw)) !== null;
}

/** The edition, with a failed read treated as not admitted. */
export async function lookupEdition(prisma: PrismaClient, raw: unknown): Promise<Edition | null> {
  try {
    return await emailEdition(prisma, raw);
  } catch {
    return null;
  }
}

/** A failed read is not an empty list. Callers deny both, and revoke sessions only for "absent". */
export type InviteLookup = "listed" | "absent" | "unavailable";

export async function lookupInvite(prisma: PrismaClient, raw: unknown): Promise<InviteLookup> {
  try {
    return (await isEmailInvited(prisma, raw)) ? "listed" : "absent";
  } catch {
    return "unavailable";
  }
}

export interface AllowlistEntry {
  email: string;
  edition: string;
  note: string | null;
  addedBy: string | null;
  createdAt: Date;
}

export async function addAllowlistEmail(
  prisma: PrismaClient,
  raw: unknown,
  meta: { note?: string | null; addedBy?: string | null; edition?: Edition } = {},
): Promise<{ email: string; created: boolean; changed: boolean }> {
  const email = normalizeEmail(raw);
  if (!isAllowlistEmail(email)) throw new Error("Email is not a usable invite address");
  const note = blankToNull(meta.note);
  const addedBy = blankToNull(meta.addedBy);
  const edition = meta.edition ?? "team";
  try {
    await prisma.authEmailAllowlist.create({ data: { email, note, addedBy, edition } });
    return { email, created: true, changed: false };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Adding a listed address again moves it to the edition asked for. The runtime login has no
    // UPDATE on this table, so the row is replaced; its sessions stay, as the address stays listed.
    const changed = await prisma.$transaction(async (tx) => {
      const row = await tx.authEmailAllowlist.findUnique({ where: { email } });
      if (!row || row.edition === edition) return false;
      await tx.authEmailAllowlist.deleteMany({ where: { email } });
      await tx.authEmailAllowlist.create({ data: { ...row, edition } });
      return true;
    });
    return { email, created: false, changed };
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
  // Interactive, not batch: a batch cannot carry the system row-security context.
  const [removed, revoked] = await prisma.$transaction(async (tx) => [
    await tx.authEmailAllowlist.deleteMany({ where: { email } }),
    await tx.session.deleteMany({
      where: { user: { email: { equals: email, mode: "insensitive" } } },
    }),
  ]);
  return { email, removed: removed.count > 0, sessionsRevoked: revoked.count };
}

export async function listAllowlistEmails(prisma: PrismaClient): Promise<AllowlistEntry[]> {
  return prisma.authEmailAllowlist.findMany({
    orderBy: { email: "asc" },
    select: { email: true, edition: true, note: true, addedBy: true, createdAt: true },
  });
}

export type AllowlistCommand =
  | { action: "add"; email: string; note?: string; addedBy?: string; edition?: Edition }
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
    edition: command.edition,
  });
  const edition = command.edition ?? "team";
  if (result.created) return `added ${result.email} (${edition})\n`;
  if (result.changed) return `moved ${result.email} to ${edition}\n`;
  return `already listed ${result.email} (${edition})\n`;
}

function allowlistLine(row: AllowlistEntry): {
  email: string;
  edition: string;
  note: string | null;
  addedBy: string | null;
  createdAt: string;
} {
  return {
    email: row.email,
    edition: row.edition,
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
      ...(action === "add" && values.edition ? { edition: values.edition } : {}),
    };
  }
  throw new Error(ALLOWLIST_USAGE);
}

export const ALLOWLIST_USAGE =
  "Usage: email-allowlist <add|remove|list> [email] [--free|--team] [--note text] [--added-by text]";

function parseAllowlistArgs(args: string[]) {
  return parseArgs(args);
}

function parseArgs(args: string[]): {
  values: { note?: string; "added-by"?: string; edition?: Edition };
  positionals: string[];
} {
  const values: { note?: string; "added-by"?: string; edition?: Edition } = {};
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--free" || arg === "--team") {
      const edition = arg === "--free" ? "free" : "team";
      if (values.edition && values.edition !== edition) throw new Error(ALLOWLIST_USAGE);
      values.edition = edition;
      continue;
    }
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
