/** Capability install and tool-routing failures. Clients show their own (translated) copy for each
 * code; the server never sends a sentence for these. */
export const PLUGIN_SKILL_CONFLICT = "PLUGIN_SKILL_CONFLICT";
/** A connector tool resolved to the name of a built-in tool, so the call was refused. */
export const CONNECTOR_TOOL_NAME_CONFLICT = "CONNECTOR_TOOL_NAME_CONFLICT";

export const CAPABILITY_ERROR_CODES = [
  PLUGIN_SKILL_CONFLICT,
  CONNECTOR_TOOL_NAME_CONFLICT,
] as const;
export type CapabilityErrorCode = (typeof CAPABILITY_ERROR_CODES)[number];

export function isCapabilityErrorCode(value: unknown): value is CapabilityErrorCode {
  return (CAPABILITY_ERROR_CODES as readonly unknown[]).includes(value);
}
