/** Approved artwork is immutable. Verify checked-in exports instead of regenerating old artwork. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const root = new URL("../../../", import.meta.url);
const approved: Record<string, string> = {
  "apps/web/public/favicon-16x16.png":
    "e05447376258b55685de9a07273f0569e1709994daa6b579af9d6326bf93b771",
  "apps/web/public/favicon-32x32.png":
    "9608bc3f011df02a26e970ed984ef26a5904126dc52a16ea295838a1dac9c6f7",
  "apps/web/public/favicon.png": "8a762a5e5769f57bfc50497491618daccac371ccde7233a9f7553df070f39dbb",
  "apps/web/public/favicon.ico": "37bb43f2832dc22cb2e9da61123ae190481c10c18905a218106e64240fcaab28",
  "apps/web/public/apple-touch-icon.png":
    "ffc80a970e86227a1dd587cd9f6ce48eb14eeab7848f9abe328d58e683fd4b69",
  "apps/web/public/icon-192.png":
    "198dfbcfdd812a64354713e0ee9b559131815c2d67f62383ee781cdb77ddfc19",
  "apps/web/public/icon-512.png":
    "590b37dd5ab69dbd616b8aca9baf18f223a6a8b0e8c1d7ab112fcbbe1bb0e0ba",
  "apps/web/public/icon-maskable-192.png":
    "ca6a44eee63293f47e0d140a3af288f3a54afdebf1aa9ae16f693917c408e756",
  "apps/web/public/icon-maskable-512.png":
    "942c996d8c717c7a4edf26f2aa40d4ae6d6693563a4d1ba978ee0e0b2a03622d",
  "apps/web/public/brand/vnbot-wordmark-light.svg":
    "1b22b871f49674db423a9c01688d42568b5524e93af570406e177815ab1e48d3",
  "apps/web/public/brand/vnbot-wordmark-dark.svg":
    "c24395f3dfd6bbc15984a9b72e2aac4ab793d4f12e3ef42194ededd6038a6acd",
  "apps/web/public/brand/vnbot-wordmark-powered-light.svg":
    "00e05c593b2e731813b8ea938ef34f6eded89d9d4471548c73e16a5fca5bd081",
  "apps/web/public/brand/vnbot-wordmark-powered-dark.svg":
    "2d51b47b3aff948da68d95244b3965ee49231cb860366808378df496f34e8c7d",
  "apps/desktop/assets/icon.png":
    "840e99e838fd45ced16ca3f89c16cd14527e4b1b49cbfa664d9d3802ab508320",
  "apps/desktop/assets/icon.ico":
    "b389b6812757c7224135e188ae4c1543ed3d784f91b4948127bd0ea4aebca470",
  "apps/desktop/assets/icon.icns":
    "5827aa3ab3138340bb9748395f03aac5f0e85a67a1e51558a04d1ffc1115b59d",
  "apps/desktop/assets/icon-macos.png":
    "840e99e838fd45ced16ca3f89c16cd14527e4b1b49cbfa664d9d3802ab508320",
  "apps/mobile/assets/icon.png": "89da68e9ce676f63d9152268407d6946dc932155667d2bb587ec55e43fe08dd8",
  "apps/mobile/assets/splash-icon.png":
    "840e99e838fd45ced16ca3f89c16cd14527e4b1b49cbfa664d9d3802ab508320",
  "apps/mobile/assets/adaptive-icon.png":
    "b671006e42af9ecc86a9827781aa40602813fbdf3740b27aa3af5f023ded97b7",
  "apps/mobile/assets/icon-background.png":
    "20843cab81b65c92f23bed63108804f3b1d22e1b795631aaa5efad987d20598c",
  "apps/mobile/assets/favicon.png":
    "8a762a5e5769f57bfc50497491618daccac371ccde7233a9f7553df070f39dbb",
  "apps/www/public/favicon-16x16.png":
    "e05447376258b55685de9a07273f0569e1709994daa6b579af9d6326bf93b771",
  "apps/www/public/favicon-32x32.png":
    "9608bc3f011df02a26e970ed984ef26a5904126dc52a16ea295838a1dac9c6f7",
  "apps/www/public/favicon.png": "8a762a5e5769f57bfc50497491618daccac371ccde7233a9f7553df070f39dbb",
  "apps/www/public/favicon.ico": "37bb43f2832dc22cb2e9da61123ae190481c10c18905a218106e64240fcaab28",
  "apps/www/public/apple-touch-icon.png":
    "ffc80a970e86227a1dd587cd9f6ce48eb14eeab7848f9abe328d58e683fd4b69",
  "apps/www/public/icon-192.png":
    "198dfbcfdd812a64354713e0ee9b559131815c2d67f62383ee781cdb77ddfc19",
  "apps/www/public/icon-512.png":
    "590b37dd5ab69dbd616b8aca9baf18f223a6a8b0e8c1d7ab112fcbbe1bb0e0ba",
  "apps/www/public/icon-maskable-192.png":
    "ca6a44eee63293f47e0d140a3af288f3a54afdebf1aa9ae16f693917c408e756",
  "apps/www/public/icon-maskable-512.png":
    "942c996d8c717c7a4edf26f2aa40d4ae6d6693563a4d1ba978ee0e0b2a03622d",
};
for (const [path, expected] of Object.entries(approved)) {
  const actual = createHash("sha256")
    .update(await readFile(new URL(path, root)))
    .digest("hex");
  if (actual !== expected) throw new Error(`Unapproved brand asset: ${path}`);
}
console.log("Approved VNBot brand assets verified. Copy approved exports when updating artwork.");
