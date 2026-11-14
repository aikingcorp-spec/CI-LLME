import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parseEnv } from "node:util";

const [publicArchive, mailEnv, destination] = process.argv.slice(2);
if (!publicArchive || !mailEnv || !destination) {
  throw new Error(
    "Usage: node scripts/prepare-vnbot-private-kit.mjs PUBLIC.zip MAIL.env PRIVATE.zip",
  );
}
if (existsSync(destination)) throw new Error("Private destination already exists");
const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "apps/api/package.json"));
const { unzipSync, zipSync } = require("fflate");
const entries = unzipSync(readFileSync(publicArchive));
const prefix = "VNBot-Docker/";
if (!entries[`${prefix}VNBot.ps1`] || entries[`${prefix}mail.private.json`]) {
  throw new Error("Expected a clean public Docker bundle");
}
const env = parseEnv(readFileSync(mailEnv, "utf8"));
const smtpUrl = env.SMTP_URL;
const from = env.EMAIL_FROM;
if (!smtpUrl || !from || /['\r\n]/.test(smtpUrl + from)) {
  throw new Error("Private mail configuration is missing or invalid");
}
let valid = false;
try {
  const smtp = new URL(smtpUrl);
  valid = ["smtp:", "smtps:"].includes(smtp.protocol) && !!smtp.hostname && !!smtp.username;
} catch {
  // Do not include the URL in an error: it contains a password.
}
if (!valid) throw new Error("Private mail configuration is invalid");
entries[`${prefix}mail.private.json`] = Buffer.from(JSON.stringify({ smtpUrl, from }));
entries[`${prefix}DOC-TRUOC.txt`] = Buffer.from(
  "VNBOT - BAN THU RIENG\r\n\r\n" +
    "1. Mo Docker Desktop (Linux containers / WSL 2).\r\n" +
    "2. Giai nen TOAN BO ZIP, bam CHAY-VNBOT.cmd. Khong can nhap cau hinh.\r\n" +
    "3. Doi Docker tai va build xong. Trinh duyet tu mo http://127.0.0.1:54173.\r\n" +
    "4. Nhap email va ma OTP. Ket noi AI trong Cai dat > Mo hinh, tao bot va thu chat/cong cu/voice.\r\n\r\n" +
    "Mail da duoc chuan bi. Khoa du lieu tao rieng tren may va giu qua lan mo lai.\r\n" +
    "DUNG-VNBOT.cmd dung stack, khong xoa bot/chat/key.\r\n" +
    "Lan dau can Internet, khoang 20 GB trong va it nhat 6 GB RAM cho Docker.\r\n" +
    "Day la goi source-build, khong can Git/Node.js tren may.\r\n" +
    "GOI RIENG CO THONG TIN MAIL CUA DU AN. KHONG CHIA SE, UPLOAD LEN REPO HAY PUBLIC.\r\n" +
    "Khong di chuyen mail.private.json vao thu muc source; file nay khong nam trong Docker image.\r\n" +
    "Da kiem launcher/config. Chua nghiem thu Docker Desktop Windows hay AI that tren may anh.\r\n",
);
// Preserve executable source modes when repacking, including Docker build scripts.
const commit = Buffer.from(entries[`${prefix}SOURCE-COMMIT.txt`]).toString().trim();
if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Invalid source revision");
const tree = execFileSync("git", ["ls-tree", "-r", "-z", commit], {
  cwd: root,
  encoding: "utf8",
});
const modes = new Map(
  tree
    .split("\0")
    .filter(Boolean)
    .map((row) => {
      const [metadata, name] = row.split("\t");
      return [`${prefix}source/${name}`, Number.parseInt(metadata.split(" ")[0], 8)];
    }),
);
const files = Object.fromEntries(
  Object.entries(entries).map(([name, value]) => {
    const mode =
      modes.get(name) ??
      (name.endsWith("/") ? 0o40755 : name.endsWith("mail.private.json") ? 0o100600 : 0o100644);
    return [name, [value, { os: 3, attrs: (mode << 16) >>> 0 }]];
  }),
);
const bytes = zipSync(files, { level: 6 });
writeFileSync(destination, bytes, { mode: 0o600, flag: "wx" });
const sha256 = createHash("sha256").update(bytes).digest("hex");
writeFileSync(`${destination}.sha256`, `${sha256}  ${path.basename(destination)}\n`, {
  mode: 0o600,
});
console.log(
  JSON.stringify({ sizeBytes: bytes.length, sha256, privateConfigurationIncluded: true }),
);

import { execFileSync } from "node:child_process";
