import path from "node:path";

export const DESKTOP_APP_NAME = "VNBot";

/** Set before ready and before the single-instance lock; metadata keeps its package name. */
export function configureUserDataName(input: {
  app: {
    setName(name: string): void;
    getPath(name: "appData"): string;
    setPath(name: "userData", value: string): void;
  };
  platform: string;
  pathModule?: Pick<typeof path, "join">;
  userDataDir?: string;
}): void {
  const p = input.pathModule ?? (input.platform === "win32" ? path.win32 : path.posix);
  input.app.setName(DESKTOP_APP_NAME);
  input.app.setPath(
    "userData",
    input.userDataDir ?? p.join(input.app.getPath("appData"), DESKTOP_APP_NAME),
  );
}
