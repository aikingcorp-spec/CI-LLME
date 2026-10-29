// Guard (apps/web build): fail when the shipped web bundle carries paywall, billing or Stripe
// payment code. VNBot is fully free (PRODUCT.md, billing:false); a hidden flag is not enough,
// the code must not reach the bundle. Run after `vite build`; scans apps/web/dist/**/*.{js,html,css}.
// Markers are payment-specific: plain "stripe" also names CSS stripes, the Stripe integration logo
// and cookie names in third-party libraries, so it is not a marker on its own.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const PAYWALL_MARKERS: ReadonlyArray<RegExp> = [
  /js\.stripe\.com/iu,
  /(?:checkout|billing)\.stripe\.com/iu,
  /@stripe\//iu,
  /\bloadStripe\b/u,
  /\bStripe Checkout\b/iu,
  /\bpaywall\b/iu,
  /\bAdd credits\b/iu,
  /\bManage billing\b/iu,
  /\bcredits in Billing\b/iu,
  /\bSubscribe in Billing\b/iu,
  /\bmodel credits\b/iu,
  /\bBuy credits\b/iu,
  /\bUpgrade to (?:Pro|Plus|paid)\b/iu,
  /\/billing\/(?:checkout|portal)\b/iu,
];

export type Finding = { file: string; marker: string; context: string };

export function scanText(file: string, text: string): Finding[] {
  return PAYWALL_MARKERS.flatMap((marker) => {
    const m = marker.exec(text);
    if (!m) return [];
    const at = m.index;
    return [{ file, marker: marker.source, context: text.slice(Math.max(0, at - 50), at + 60) }];
  });
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(?:m?js|html|css)$/u.test(name) ? [path] : [];
  });
}

export function scanDist(dist: string): Finding[] {
  return walk(dist).flatMap((p) => scanText(relative(dist, p), readFileSync(p, "utf8")));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dist = process.argv[2] ?? fileURLToPath(new URL("../apps/web/dist", import.meta.url));
  let findings: Finding[];
  try {
    findings = scanDist(dist);
  } catch (error) {
    console.error(
      `paywall-bundle: không đọc được ${dist}. Chạy vite build trước. (${String(error)})`,
    );
    process.exit(1);
  }
  if (findings.length === 0) {
    console.log(`paywall-bundle: OK (${dist})`);
  } else {
    for (const f of findings)
      console.error(`paywall-bundle: /${f.marker}/ trong ${f.file}: ${JSON.stringify(f.context)}`);
    console.error(
      `paywall-bundle: ${findings.length} chỗ. VNBot miễn phí hoàn toàn: bỏ hẳn import/route billing, ví, Stripe khỏi cây import của web, không chỉ ẩn.`,
    );
    process.exit(1);
  }
}
