import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const updaterRequire = createRequire(require.resolve("electron-updater/package.json"));
const { load } = updaterRequire("js-yaml");
const [resources, feedPath] = process.argv.slice(2);
if (!resources || !feedPath) throw new Error("Expected packaged resources and update feed paths");
const desktop = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const config = load(await readFile(path.join(resources, "app-update.yml"), "utf8"));
if (config.provider !== "generic" || config.url !== desktop.build.publish.url)
  throw new Error("Packaged updater does not use the public download channel");
const feed = load(await readFile(feedPath, "utf8"));
if (feed.version !== desktop.version || !Array.isArray(feed.files) || feed.files.length === 0)
  throw new Error("Update feed version or files do not match the packaged release");
for (const file of feed.files) {
  if (typeof file.url !== "string" || file.url !== path.basename(file.url))
    throw new Error("Update artifact must be in the release directory");
  const artifact = path.join(path.dirname(feedPath), file.url);
  const digest = createHash("sha512");
  for await (const chunk of createReadStream(artifact)) digest.update(chunk);
  if (digest.digest("base64") !== file.sha512 || (await stat(artifact)).size !== file.size)
    throw new Error("Update artifact digest or size differs from the feed");
}
console.log(`Verified public update feed for ${feed.version}, ${feed.files.length} artifacts`);
