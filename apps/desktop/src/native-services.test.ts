import { describe, expect, it, vi } from "vitest";
import { readPrivateFile } from "./setup-store.js";
import { createNativeServices } from "./native-services.js";

describe("native services", () => {
  it("starts utility processes with desktop sandbox and serves the web", async () => {
    const forks: Array<{ entry: string; env: NodeJS.ProcessEnv }> = [];
    const children = () => ({ once: vi.fn().mockReturnThis(), kill: vi.fn() });
    const root = "/tmp/rakazo-native-test";
    const services = createNativeServices({
      userDataDir: root,
      appPath: "/workspace/leo/wt-desktop-native/apps/desktop",
      allocatePort: vi.fn().mockResolvedValueOnce(43101).mockResolvedValueOnce(43102).mockResolvedValueOnce(43103),
      fork: (entry, _args, options) => { forks.push({ entry, env: options.env }); return children(); },
      fetch: vi.fn().mockResolvedValue({ ok: true }),
      webDir: "/tmp/does-not-exist",
      serveWeb: false,
    });
    const result = await services.start();
    expect(result.webUrl).toBe("http://127.0.0.1:43103");
    expect(forks).toHaveLength(3);
    expect(forks[1]!.env.SANDBOX_PROVIDER).toBe("desktop");
    expect(forks[1]!.entry).toContain("apps/api/dist/index.js");
    expect(await readPrivateFile(`${root}/native-stack-env`, 65536)).toContain("BETTER_AUTH_SECRET");
    await services.stop();
  });
});
