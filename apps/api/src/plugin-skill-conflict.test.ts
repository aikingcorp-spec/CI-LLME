import { BUILTIN_AGENT_SKILLS } from "@rakazo/adapters";
import { isCapabilityErrorCode, PLUGIN_SKILL_CONFLICT } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { assertNoBuiltinSkillNames } from "./plugin-installs.js";

describe("plugin skill name conflicts", () => {
  it("answers a stable code for the client to translate, not an English sentence", () => {
    const builtin = BUILTIN_AGENT_SKILLS[0]?.name ?? "";
    expect(builtin).not.toBe("");
    const plugin = { skills: [{ name: builtin.toUpperCase() }] } as Parameters<
      typeof assertNoBuiltinSkillNames
    >[0];
    let thrown: unknown;
    try {
      assertNoBuiltinSkillNames(plugin);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: PLUGIN_SKILL_CONFLICT, status: 409 });
    expect(isCapabilityErrorCode((thrown as { code: string }).code)).toBe(true);
    expect((thrown as Error).message).toBe(PLUGIN_SKILL_CONFLICT);
  });

  it("accepts a plugin whose skills do not shadow a built-in", () => {
    const plugin = { skills: [{ name: "vnbot-unique-skill" }] } as Parameters<
      typeof assertNoBuiltinSkillNames
    >[0];
    expect(() => assertNoBuiltinSkillNames(plugin)).not.toThrow();
  });
});
