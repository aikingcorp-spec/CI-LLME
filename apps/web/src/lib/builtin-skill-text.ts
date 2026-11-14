import { t } from "@lingui/core/macro";
import type { AgentSkillCatalogEntry } from "@rakazo/contracts";

/** Built-in skill descriptions come from the server in English; show them in the chosen language. */
export function skillDescription(
  skill: Pick<AgentSkillCatalogEntry, "name" | "source" | "description">,
) {
  if (skill.source !== "builtin") return skill.description;
  switch (skill.name) {
    case "Interrogate":
      return t`Adversarial review of a diff, PR or plan. Reviews only; never applies fixes.`;
    case "VNBot":
      return t`How to use VNBot: sign-in, bots, apps, voice, routines, remote access`;
    default:
      return skill.description;
  }
}
