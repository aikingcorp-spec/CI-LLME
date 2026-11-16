import { describe, expect, it } from "vitest";
import { desktopDownloads, parseFeed } from "./desktop-downloads.js";

const feeds: Record<string, string> = {
  "latest.yml":
    "version: 0.4.1\nfiles:\n  - url: VNBot-Setup-0.4.1.exe\n    sha512: x\npath: VNBot-Setup-0.4.1.exe\n",
  "latest-mac.yml":
    "version: 0.4.1\nfiles:\n  - url: VNBot-0.4.1-universal-mac.zip\n  - url: VNBot-0.4.1-universal.dmg\n",
  "latest-linux.yml":
    "version: 0.4.0\nfiles:\n  - url: VNBot-0.4.0.AppImage\n  - url: vnbot_0.4.0_amd64.deb\n",
};

function fakeFetch(calls: string[]) {
  return (async (input: RequestInfo | URL) => {
    const name = String(input).split("/").pop()!;
    calls.push(name);
    return new Response(feeds[name] ?? "", { status: feeds[name] ? 200 : 404 });
  }) as typeof fetch;
}

describe("desktop downloads", () => {
  it("reads the version and file names of a feed", () => {
    expect(parseFeed(feeds["latest-mac.yml"]!)).toEqual({
      version: "0.4.1",
      files: ["VNBot-0.4.1-universal-mac.zip", "VNBot-0.4.1-universal.dmg"],
    });
  });

  it("links each system's current installer, and caches the feeds", async () => {
    const calls: string[] = [];
    let time = 0;
    const read = desktopDownloads(fakeFetch(calls), "https://downloads.example.test", () => time);
    const base = "https://downloads.example.test";
    expect(await read()).toEqual({
      windows: { version: "0.4.1", url: `${base}/VNBot-Setup-0.4.1.exe` },
      mac: { version: "0.4.1", url: `${base}/VNBot-0.4.1-universal.dmg` },
      linuxDeb: { version: "0.4.0", url: `${base}/vnbot_0.4.0_amd64.deb` },
      linuxAppImage: { version: "0.4.0", url: `${base}/VNBot-0.4.0.AppImage` },
    });
    time = 60_000;
    await read();
    expect(calls).toHaveLength(3);
    time = 10 * 60_000;
    await read();
    expect(calls).toHaveLength(6);
  });
});
