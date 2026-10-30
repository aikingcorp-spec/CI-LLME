export type StackRuntime = "native" | "docker";

export interface RuntimeSettings {
  runtime?: StackRuntime | string | null;
}

export function chooseRuntime(input: {
  platform: NodeJS.Platform | string;
  env?: NodeJS.ProcessEnv;
  settings?: RuntimeSettings | null;
}): StackRuntime {
  const requested = input.settings?.runtime?.trim() || input.env?.RAKAZO_DESKTOP_RUNTIME?.trim();
  if (requested === "docker") return "docker";
  if (requested === "native") return "native";
  return input.platform === "darwin" ? "docker" : "native";
}
