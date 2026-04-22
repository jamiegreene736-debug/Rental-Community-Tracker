// Standalone scraper test — no server boot required.
// Exercises the same __NEXT_DATA__ extraction path the prod endpoint uses,
// against a known Zillow URL. Writes the photos to a temp folder and
// reports what it got (count + filenames) so we can eyeball whether bedrooms
// are in the set.
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import os from "os";

const URL_ARG = process.argv[2];
if (!URL_ARG) {
  console.error("Usage: node scripts/test-scraper.mjs <zillow_url>");
  process.exit(1);
}

async function scrape(url) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    console.log(`[scrape] HTTP ${resp?.status()} ${resp?.url()}`);
    await page.waitForTimeout(2500);

    const photoUrls = await page.evaluate(() => {
      const nd = window.__NEXT_DATA__;
      if (!nd) return { error: "__NEXT_DATA__ not found", urls: [] };
      const urls = [];
      function walk(obj, depth) {
        if (depth > 14 || !obj || typeof obj !== "object") return;
        if (Array.isArray(obj)) { obj.forEach(v => walk(v, depth + 1)); return; }
        if (obj.mixedSources?.jpeg && Array.isArray(obj.mixedSources.jpeg)) {
          const jpegs = obj.mixedSources.jpeg;
          if (jpegs.length > 0) {
            const biggest = jpegs.reduce((a, b) => ((b.width ?? 0) > (a.width ?? 0) ? b : a), jpegs[0]);
            if (biggest.url) urls.push(biggest.url);
          }
          return;
        }
        Object.values(obj).forEach(v => walk(v, depth + 1));
      }
      walk(nd, 0);
      return { urls: [...new Set(urls)] };
    });
    return photoUrls;
  } finally {
    await browser.close();
  }
}

const out = await scrape(URL_ARG);
console.log(`[scrape] result: ${out.urls?.length ?? 0} photo urls`);
if (out.error) console.log(`[scrape] error: ${out.error}`);
if (!out.urls?.length) process.exit(2);

const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "scraper-test-"));
console.log(`[scrape] writing to ${tmpdir}`);

let saved = 0, failed = 0;
for (let i = 0; i < Math.min(20, out.urls.length); i++) {
  const u = out.urls[i];
  try {
    const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0 (compatible; VRB/1.0)" } });
    if (!r.ok) { failed++; console.log(`  ✗ [${i}] HTTP ${r.status}`); continue; }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 5000) { failed++; console.log(`  ✗ [${i}] too small (${buf.length}B)`); continue; }
    const filename = `photo_${String(i).padStart(2, "0")}.jpg`;
    fs.writeFileSync(path.join(tmpdir, filename), buf);
    saved++;
    console.log(`  ✓ [${i}] ${filename} (${(buf.length / 1024).toFixed(0)} KB)`);
  } catch (e) {
    failed++;
    console.log(`  ✗ [${i}] ${e.message}`);
  }
}

console.log(`\n[result] saved=${saved} failed=${failed} dir=${tmpdir}`);
console.log(`[result] files:`);
for (const f of fs.readdirSync(tmpdir).sort()) {
  const stat = fs.statSync(path.join(tmpdir, f));
  console.log(`  ${f}  ${(stat.size / 1024).toFixed(0)} KB`);
}
