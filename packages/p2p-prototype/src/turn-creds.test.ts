import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readTurnCreds } from "./turn-creds.js";

const file = (body: string): string => {
  const path = join(mkdtempSync(join(tmpdir(), "turn-creds-")), "creds");
  writeFileSync(path, body);
  return path;
};
const sample = file(
  "TURN_URLS=turn:203.0.113.5:3479?transport=udp,turn:203.0.113.5:3479?transport=tcp,turns:203.0.113.5:5350?transport=tcp\nTURN_USERNAME=1:u\nTURN_CREDENTIAL=c=\nEXPIRES_AT_UNIX=1\n",
);

describe("readTurnCreds", () => {
  it("maps each url to a relay type and keeps '=' inside values", () => {
    expect(readTurnCreds(sample)).toEqual([
      {
        hostname: "203.0.113.5",
        port: 3479,
        username: "1:u",
        password: "c=",
        relayType: "TurnUdp",
      },
      {
        hostname: "203.0.113.5",
        port: 3479,
        username: "1:u",
        password: "c=",
        relayType: "TurnTcp",
      },
      {
        hostname: "203.0.113.5",
        port: 5350,
        username: "1:u",
        password: "c=",
        relayType: "TurnTls",
      },
    ]);
  });
  it("filters transports and overrides the host", () => {
    const servers = readTurnCreds(sample, { hostOverride: "10.0.0.1", transports: ["TurnTcp"] });
    expect(servers.map((s) => [s.hostname, s.relayType])).toEqual([["10.0.0.1", "TurnTcp"]]);
  });
  it("rejects incomplete files without echoing values", () => {
    expect(() => readTurnCreds(file("TURN_USERNAME=x\n"))).toThrow(/incomplete/);
  });
});
