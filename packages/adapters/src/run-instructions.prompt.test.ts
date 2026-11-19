import { describe, expect, it } from "vitest";
import {
  connectedPluginsInstruction,
  hostComputerInstruction,
  taughtSkillsInstruction,
} from "./run-instructions.prompt.js";

describe("connectedPluginsInstruction", () => {
  it("names each connected plugin and prefers its tools to browsing", () => {
    expect(
      connectedPluginsInstruction([
        { displayName: "Mail", connectorId: "apps", provider: "mail" },
        { displayName: "Code", connectorId: "apps", provider: "code" },
      ]),
    ).toBe(
      "Connected plugins: Mail (apps:mail), Code (apps:code). Prefer those plugin tools over the computer browser or web search when reading app data (repos, releases, mail, calendar, and similar).",
    );
  });

  it("says so when nothing is connected", () => {
    expect(connectedPluginsInstruction([])).toBe("No plugins are connected yet.");
  });
});

describe("taughtSkillsInstruction", () => {
  it("lists each taught skill with when to use it", () => {
    expect(
      taughtSkillsInstruction([
        { name: "File expenses", whenToUse: "When a receipt arrives" },
        { name: "Book travel", whenToUse: "Book a trip" },
      ]),
    ).toBe(
      "Saved taught skills:\n- File expenses: When a receipt arrives\n- Book travel: Book a trip\nWhen the user asks to run a taught skill by name, follow that skill's playbook exactly. The full playbook is included in the user task when they invoke it.",
    );
  });

  it("adds nothing when no skill was taught", () => {
    expect(taughtSkillsInstruction([])).toBeUndefined();
  });
});

describe("hostComputerInstruction", () => {
  it("guides local Windows hosts to use PowerShell / Start-Process without declining", () => {
    const text = hostComputerInstruction("local", {
      home: "C:\\Users\\demo",
      shell: "powershell.exe",
      platform: "win32",
    });
    expect(text).toContain("Start-Process");
    expect(text).toContain("Do not decline a local computer task");
    expect(text).not.toContain("graphical screen control is unavailable");
  });

  it("guides local macOS and Linux hosts with their native launchers", () => {
    const mac = hostComputerInstruction("local", {
      home: "/Users/demo",
      shell: "/bin/zsh",
      platform: "darwin",
    });
    expect(mac).toContain("open or osascript");
    const linux = hostComputerInstruction("local", {
      home: "/home/demo",
      shell: "/bin/bash",
      platform: "linux",
    });
    expect(linux).toContain("xdg-open");
  });

  it("preserves Windows cloud computer guidance for wuying", () => {
    const cloud = hostComputerInstruction("wuying", {
      home: "C:\\Users\\bot",
      shell: "powershell.exe",
      platform: "win32",
    });
    expect(cloud).toContain("Windows cloud computer");
    expect(cloud).toContain("graphical tools");
  });
});
