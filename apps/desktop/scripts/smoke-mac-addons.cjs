// Run with the packaged Electron, ELECTRON_RUN_AS_NODE=1, on each physical CPU.
const { createRequire } = require("node:module");
const path = require("node:path");
const assert = require("node:assert/strict");
const resources = path.resolve(process.argv[2]);
const appRequire = createRequire(path.join(resources, "app.asar/package.json"));
const serverRequire = createRequire(path.join(resources, "server/db/package.json"));
const rtc = appRequire("node-datachannel");
const peer = new rtc.PeerConnection("packaged-smoke", { iceServers: [] });
peer.close();
assert.equal(typeof appRequire("koffi").load, "function");
serverRequire("koffi").load(null);
serverRequire("sharp")({ create: { width: 1, height: 1, channels: 3, background: "white" } })
  .png()
  .toBuffer()
  .then((buffer) => {
    assert(buffer.length > 0);
    console.log(
      JSON.stringify({
        kind: "packaged-addon-load",
        platform: process.platform,
        arch: process.arch,
        rtc: true,
        koffi: true,
        sharp: true,
      }),
    );
    rtc.cleanup();
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
