import { access } from "node:fs/promises";
import path from "node:path";

/** The pre-rename Electron userData directory, checked without opening its contents. */
export async function legacyProfilePath(input: {
  appDataDir: string;
  platform: string;
  checkAccess?: typeof access;
}): Promise<string | null> {
  const p = input.platform === "win32" ? path.win32 : path.posix;
  const candidate = p.join(input.appDataDir, "Rakazo");
  try {
    await (input.checkAccess ?? access)(candidate);
    return candidate;
  } catch {
    return null;
  }
}
