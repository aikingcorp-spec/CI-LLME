import { useLingui } from "@lingui/react/macro";
import type { BuiltinToolName } from "@rakazo/contracts";
import { BUILTIN_TOOL_NAMES } from "@rakazo/contracts";
import { Switch } from "@rakazo/ui-web";
import { useId } from "react";

type CapabilityId = "web" | "browser" | "files" | "computer" | "media" | "memory" | "addTools";

/** What a bot can do, grouped from its built-in tools. A group is on while none of its tools is off. */
export const CAPABILITY_TOOLS: Record<CapabilityId, readonly BuiltinToolName[]> = {
  web: ["web_search", "web_fetch"],
  browser: ["browser_navigate", "browser_snapshot", "browser_act"],
  files: ["list_files", "read_file", "write_file", "attach_file"],
  computer: [
    "computer_observe",
    "computer_act",
    "shell",
    "user_computer_shell",
    "open_path",
    "launch_app",
  ],
  media: ["generate_image", "generate_video", "render_plot"],
  memory: ["remember", "save_shared_memory", "search_history"],
  addTools: ["add_mcp_server", "connect_app"],
};

/** Next disabled list when a capability is switched; other tools keep their state. */
export function toggleCapability(
  disabled: readonly string[],
  id: CapabilityId,
  enabled: boolean,
): string[] {
  const tools = CAPABILITY_TOOLS[id].filter((name) =>
    (BUILTIN_TOOL_NAMES as readonly string[]).includes(name),
  );
  if (enabled) return disabled.filter((name) => !tools.includes(name as BuiltinToolName));
  return [...disabled, ...tools.filter((name) => !disabled.includes(name))];
}

export function BotCapabilityMap({
  disabled,
  saving,
  onChange,
}: {
  disabled: readonly string[];
  saving: boolean;
  onChange: (next: string[]) => void;
}) {
  const { t } = useLingui();
  const ids = useId();
  const labels: Record<CapabilityId, string> = {
    web: t`Search the web`,
    browser: t`Use a browser`,
    files: t`Read and write files`,
    computer: t`Use the computer`,
    media: t`Make images and videos`,
    memory: t`Remember things`,
    addTools: t`Add tools and apps`,
  };
  return (
    <ul className="space-y-0" aria-label={t`What this bot can do`}>
      {(Object.keys(CAPABILITY_TOOLS) as CapabilityId[]).map((id) => {
        const on = CAPABILITY_TOOLS[id].every((name) => !disabled.includes(name));
        return (
          <li key={id} className="flex min-h-11 items-center justify-between gap-3 text-body">
            <label htmlFor={`${ids}-${id}`} className="min-w-0 flex-1">
              {labels[id]}
            </label>
            <Switch
              id={`${ids}-${id}`}
              checked={on}
              disabled={saving}
              onCheckedChange={(checked) => onChange(toggleCapability(disabled, id, checked))}
            />
          </li>
        );
      })}
    </ul>
  );
}
