import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readKeyFile, writeKeyFile } from "./key-file.js";
import { generateKeyPair } from "./pairing.js";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function keyPath() {
  const directory = mkdtempSync(join(tmpdir(), "p2p-key-test-"));
  directories.push(directory);
  return join(directory, "key.json");
}
describe("key files", () => {
  it("saves the node key, pinned gateway and user with owner-only permissions", () => {
    const path = keyPath();
    const identity = {
      ...generateKeyPair(),
      gatewayPublicKey: generateKeyPair().publicKey,
      user: "test-user",
    };
    expect(readKeyFile(path)).toBeUndefined();
    writeKeyFile(path, identity);
    expect(readKeyFile(path)).toEqual(identity);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
  it("restores owner-only permissions when overwriting an existing file", () => {
    const path = keyPath();
    const key = generateKeyPair();
    writeKeyFile(path, key);
    chmodSync(path, 0o644);
    writeKeyFile(path, key);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
