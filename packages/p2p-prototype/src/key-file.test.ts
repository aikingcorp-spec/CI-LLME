import { execFileSync } from "node:child_process";
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
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });
  it("restores owner-only permissions when overwriting an existing file", () => {
    const path = keyPath();
    const key = generateKeyPair();
    writeKeyFile(path, key);
    chmodSync(path, 0o644);
    writeKeyFile(path, key);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });
  it.skipIf(process.platform !== "win32")(
    "inherits a private Windows profile ACL without broad file-read grants",
    () => {
      const file = keyPath();
      writeKeyFile(file, generateKeyPair());
      const script = `
      $ErrorActionPreference = 'Stop'
      $broad = @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545')
      foreach ($entry in (Get-Acl -LiteralPath $env:VNBOT_KEY_ACL_TEST_PATH).Access) {
        $sid = $entry.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
        if ($entry.AccessControlType -eq 'Allow' -and ($entry.FileSystemRights -band 1) -and $broad.Contains($sid)) {
          throw 'Private key grants file-read access to a broad principal'
        }
      }
    `;
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        { env: { ...process.env, VNBOT_KEY_ACL_TEST_PATH: file }, stdio: "pipe" },
      );
    },
  );
});
