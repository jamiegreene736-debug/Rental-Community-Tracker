// One-off probe: can we exceed VRBO's ~90-card SRP cap by varying sort order
// and/or bedroom filters? Connects to the running sidecar Chrome via CDP, loads
// the Princeville SRP for several sort/filter variants, scrolls each toward the
// ~90 cap, and reports how many NEW property IDs each variant contributes beyond
// the recommended-sort baseline. If the union grows well past 90, a merged
// multi-pass harvest can approach the full 218.
import { chromium } from "playwright";

const CDP = process.env.PROBE_CDP || "http://127.0.0.1:9222";
const BASE =
  "https://www.vrbo.com/search?destination=Princeville%2C+Hawaii%2C+United+States+of+America" +
  "&regionId=1509&startDate=2026-06-20&endDate=2026-06-26&adults=2";

const VARIANTS = [
  { label: "sort=RECOMMENDED", url: `${BASE}&sort=RECOMMENDED` },
  { label: "sort=PRICE_LOW_TO_HIGH", url: `${BASE}&sort=PRICE_LOW_TO_HIGH` },
  { label: "sort=PRICE_HIGH_TO_LOW", url: `${BASE}&sort=PRICE_HIGH_TO_LOW` },
  { label: "sort=PRICE_RELEVANT", url: `${BASE}&sort=PRICE_RELEVANT` },
  { label: "sort=DISTANCE", url: `${BASE}&sort=DISTANCE` },
  // Bedroom filter (Expedia uses bedroom_count_gt / filters). Try the common ones.
  { label: "bedrooms>=2", url: `${BASE}&sort=RECOMMENDED&bedroom_count_gt=1` },
  { label: "bedrooms>=3", url: `${BASE}&sort=RECOMMENDED&bedroom_count_gt=2` },
];

async function scrollAndCollect(page, maxPasses = 26) {
  let last = 0, stable = 0;
  for (let i = 0; i < maxPasses; i++) {
    await page.evaluate(() => {
      const cards = document.querySelectorAll('[data-stid="lodging-card-responsive"]');
      const seed = cards[0];
      let el = seed;
      for (let d = 0; el && d < 18; d++, el = el.parentElement) {
        const ov = (el.scrollHeight || 0) - (el.clientHeight || 0);
        if (ov > 80 && el.querySelectorAll('[data-stid="lodging-card-responsive"]').length) {
          el.scrollTop = el.scrollTop + Math.round((el.clientHeight || 640) * 0.72);
          el.dispatchEvent(new Event("scroll", { bubbles: true }));
          return;
        }
      }
      window.scrollBy(0, Math.round((window.innerHeight || 640) * 0.85));
    }).catch(() => {});
    await page.waitForTimeout(800);
    const n = await page.evaluate(() => {
      const ids = new Set();
      document.querySelectorAll('[data-stid="lodging-card-responsive"] a[href]').forEach((a) => {
        const m = (a.getAttribute("href") || "").match(/\/(\d{5,})/);
        if (m) ids.add(m[1]);
      });
      if (!window.__probeIds) window.__probeIds = new Set();
      ids.forEach((x) => window.__probeIds.add(x));
      return window.__probeIds.size;
    }).catch(() => last);
    if (n <= last) stable++; else stable = 0;
    last = n;
    if (stable >= 5 && i > 10) break;
  }
  return page.evaluate(() => {
    const total = (document.body.innerText.match(/(\d{1,4})\s+propert/i) || [])[1] || null;
    return { ids: Array.from(window.__probeIds || []), total };
  });
}

const browser = await chromium.connectOverCDP(CDP);
const ctx = browser.contexts()[0] || (await browser.newContext());
const page = await ctx.newPage();
const union = new Set();
let baseTotal = null;
for (const v of VARIANTS) {
  try {
    await page.evaluate(() => { window.__probeIds = new Set(); }).catch(() => {});
    await page.goto(v.url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(2500);
    const r = await scrollAndCollect(page);
    baseTotal = baseTotal || r.total;
    const before = union.size;
    r.ids.forEach((id) => union.add(id));
    console.log(`${v.label.padEnd(26)} total=${r.total} harvested=${r.ids.length} unionNow=${union.size} (+${union.size - before} new)`);
  } catch (e) {
    console.log(`${v.label.padEnd(26)} ERROR ${e?.message ?? e}`);
  }
}
console.log(`\nREPORTED TOTAL ~ ${baseTotal}; UNION ACROSS VARIANTS = ${union.size}`);
await page.close().catch(() => {});
await browser.close().catch(() => {});
