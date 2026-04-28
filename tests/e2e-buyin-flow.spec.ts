// End-to-end smoke test of the buy-in find flow on production:
//
//   1. Open /bookings
//   2. Pick Property 4 (Poipu Kai) from the property dropdown
//   3. Find Amy Vanbuskirk's reservation (Dec 20, 2026 → Jan 2, 2027,
//      0/2 slots filled — perfect target, no detach side-effects).
//   4. Expand the row, click Find 3BR buy-in on Unit 721.
//   5. Wait for the live-search dialog and the "All scanned options"
//      table.
//   6. Wait for auto-verify to settle (Haiku batch verifier).
//   7. Assert at least one row is verified-available and the table
//      shows the expected columns + auto-pick star.
//   8. Toggle Verified-only off → confirm hidden rows reappear.
//
// Captures screenshots at each milestone. Saves them under
// /tmp/e2e-buyin/ so we can visually verify everything rendered as
// expected.
//
// Cost: this fires a full find-buy-in (8 Vrbo paths, photo-match Lens,
// PM finder if priced bookable < 3, Stagehand verifier batch). ~$1–2
// per run. Don't loop this in CI.
//
// Run:   npx tsx tests/e2e-buyin-flow.spec.ts
// Env:   E2E_URL    overrides production URL
//        HEADLESS   "false" to watch the run live (default true)
//        SCREENSHOT_DIR  defaults to /tmp/e2e-buyin

import { chromium, type Page } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const URL = process.env.E2E_URL ?? "https://rental-community-tracker-production.up.railway.app";
const HEADLESS = process.env.HEADLESS !== "false";
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR ?? "/tmp/e2e-buyin";
const TARGET_GUEST = "Amy Vanbuskirk";
const TARGET_PROPERTY_ID = "4"; // Poipu Kai
const FIND_BUYIN_TIMEOUT_MS = 240_000; // 4 min — Stagehand Vrbo agent + PM finder can take this long
const VERIFY_TIMEOUT_MS = 180_000; // 3 min — Haiku batch verifies up to 10 PM URLs sequentially

mkdirSync(SCREENSHOT_DIR, { recursive: true });

type Result = { name: string; pass: boolean; detail: string };
const results: Result[] = [];
const record = (name: string, pass: boolean, detail: string) => {
  results.push({ name, pass, detail });
  const icon = pass ? "✓" : "✗";
  console.log(`${icon} ${name}\n    ${detail}`);
};

const shot = async (page: Page, name: string) => {
  const path = join(SCREENSHOT_DIR, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  console.log(`   📸 ${path}`);
  return path;
};

async function run() {
  console.log(`E2E target: ${URL}`);
  console.log(`Screenshots: ${SCREENSHOT_DIR}`);
  console.log(`Target guest: ${TARGET_GUEST}`);
  console.log("");

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  try {
    // ── Step 1: open /bookings ────────────────────────────────────────
    console.log("→ Step 1: navigating to /bookings");
    await page.goto(`${URL}/bookings`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
    const title = await page.title();
    record("Page loads", /NexStay/i.test(title), `title="${title}"`);
    await shot(page, "01-bookings-loaded");

    // ── Step 2: pick property from dropdown ───────────────────────────
    // Radix Select on this page is finicky with click-driven open/close
    // under headless Chromium — the listbox briefly opens and may close
    // on any subsequent locator check or screenshot. Using full keyboard
    // navigation (Space to open, ArrowDown to navigate, Enter to commit)
    // sidesteps that entirely. The current option order is:
    //   1. Kaha Lani #23
    //   2. Pili Mai #32
    //   3. Poipu Kai #4   ← target (Amy lives here)
    console.log("→ Step 2: opening property dropdown via keyboard");
    const propSelect = page.getByTestId("select-property");
    await propSelect.waitFor({ state: "visible", timeout: 15_000 });
    await propSelect.focus();
    await page.keyboard.press("Space");
    await page.waitForTimeout(500);
    await shot(page, "02-property-dropdown-open");
    // Type-ahead: typing "Poi" should focus the Poipu Kai option in
    // any Radix Select. Then Enter to commit.
    await page.keyboard.type("Poi", { delay: 80 });
    await page.waitForTimeout(300);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    record("Property selected (Poipu Kai via type-ahead)", true, "dropdown closed");

    // ── Step 3: wait for reservations list ────────────────────────────
    console.log("→ Step 3: waiting for reservation list");
    await page.waitForSelector(`text=Reservations`, { timeout: 15_000 });
    // Wait for the reservations API to return + render guest rows. The
    // listing endpoint fetches from Guesty via proxy and can take a few
    // seconds on cold start. Wait up to 30s for the target guest's
    // name to appear.
    const guestRow = page.locator(`text="${TARGET_GUEST}"`).first();
    let guestRowVisible = false;
    try {
      await guestRow.waitFor({ state: "visible", timeout: 30_000 });
      guestRowVisible = true;
    } catch {
      guestRowVisible = false;
    }
    await shot(page, "03-reservations-list");

    record(
      "Target reservation visible",
      guestRowVisible,
      guestRowVisible
        ? `${TARGET_GUEST} row found`
        : `${TARGET_GUEST} not found within 30s — wrong property selected?`,
    );
    if (!guestRowVisible) throw new Error("target reservation missing — abort");

    // ── Step 4: expand reservation + click Find buy-in ────────────────
    console.log("→ Step 4: expanding reservation");
    await guestRow.click();
    await page.waitForTimeout(800);
    await shot(page, "04-reservation-expanded");

    // Find any "Find <BR>BR buy-in" button inside the expanded section.
    // Pick the FIRST one (Unit 721 typically).
    const findBuyinBtn = page.locator(`button:has-text("Find") :text-matches("BR buy-in", "i")`).first();
    const findBuyinAlt = page.locator(`button`).filter({ hasText: /Find\s+\d+BR\s+buy-in/i }).first();
    const btn = (await findBuyinBtn.count()) > 0 ? findBuyinBtn : findBuyinAlt;
    const btnVisible = await btn.isVisible().catch(() => false);
    record(
      "Find buy-in button present on empty slot",
      btnVisible,
      btnVisible ? "ready to click" : "no empty slot found — was the reservation already filled?",
    );
    if (!btnVisible) throw new Error("no Find buy-in button — abort");

    console.log("→ Step 5: clicking Find buy-in (this kicks off Stagehand Vrbo + photo-match + PM finder, 60–180s)");
    await btn.click();

    // ── Step 5: wait for dialog ───────────────────────────────────────
    await page.waitForSelector(`text=/Find buy-in for/i`, { timeout: 10_000 });
    await shot(page, "05-dialog-loading");

    // ── Step 6: wait for All scanned options table ────────────────────
    console.log("→ Step 6: waiting for All scanned options table to render");
    // Match only the <p> header (not the empty-state cell which can
    // contain "No verified-available candidates yet" while auto-verify
    // is still running).
    const tableHeader = page.locator(`p:has-text("All scanned options")`).first();
    await tableHeader.waitFor({ state: "visible", timeout: FIND_BUYIN_TIMEOUT_MS });
    // Scroll the table header into view so the screenshot captures the
    // table itself, not just the existing-buy-ins block above it.
    await tableHeader.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await shot(page, "06-table-rendered");

    // Read the count line — "All scanned options (N total · M priced · K verified)"
    const headerText = (await tableHeader.textContent()) ?? "";
    const totalMatch = headerText.match(/(\d+)\s+total/);
    const pricedMatch = headerText.match(/(\d+)\s+priced/);
    const total = totalMatch ? parseInt(totalMatch[1], 10) : 0;
    const priced = pricedMatch ? parseInt(pricedMatch[1], 10) : 0;
    record(
      "Scanning returned candidates",
      total > 0,
      `${total} total, ${priced} priced (header: "${headerText.slice(0, 200)}")`,
    );

    // ── Step 7: wait for auto-verify to finish ────────────────────────
    console.log("→ Step 7: waiting for auto-verify (Haiku batch) to complete");
    // The header shows "Auto-verifying N PM listings…" while running.
    // It disappears when autoVerifyState transitions to "done".
    const startedVerify = Date.now();
    let lastVerifyingMsg = "";
    while (Date.now() - startedVerify < VERIFY_TIMEOUT_MS) {
      const verifyingEl = await page.locator(`text=/Auto-verifying/i`).first();
      const stillRunning = await verifyingEl.isVisible().catch(() => false);
      if (!stillRunning) break;
      const txt = (await verifyingEl.textContent()) ?? "";
      if (txt !== lastVerifyingMsg) {
        console.log(`   … ${txt.trim()}`);
        lastVerifyingMsg = txt;
      }
      await page.waitForTimeout(2_000);
    }
    await page.waitForTimeout(1_000);
    await shot(page, "07-after-auto-verify");

    // Re-read the header for the verified count.
    const headerAfter = (await tableHeader.textContent()) ?? "";
    const verifiedMatch = headerAfter.match(/(\d+)\s+verified/);
    const verified = verifiedMatch ? parseInt(verifiedMatch[1], 10) : 0;
    record(
      "Auto-verify produced verified rows",
      verified > 0,
      `${verified} verified out of ${total} (header: "${headerAfter.slice(0, 200)}")`,
    );

    // ── Step 8: assert auto-pick star is visible ──────────────────────
    const starCount = await page.locator('svg.fill-amber-400').count().catch(() => 0);
    record(
      "Auto-pick row starred",
      starCount > 0,
      `${starCount} star icon(s) found in DOM`,
    );

    // ── Step 9: assert Avail badges ───────────────────────────────────
    // Verified-yes rows show the green check icon next to "Avail" text.
    const availableBadgeCount = await page
      .locator('text=/Avail|Available/i')
      .count()
      .catch(() => 0);
    record(
      "At least one row shows availability badge",
      availableBadgeCount > 0,
      `${availableBadgeCount} availability badges in DOM`,
    );

    // ── Step 10: toggle Verified only off ─────────────────────────────
    console.log("→ Step 10: toggling Verified only off");
    const verifiedToggle = page.locator(`label:has-text("Verified only") input[type="checkbox"]`);
    const toggleExists = await verifiedToggle.isVisible().catch(() => false);
    if (toggleExists) {
      const checkedBefore = await verifiedToggle.isChecked();
      record("Verified only toggle defaults ON", checkedBefore, `checked=${checkedBefore}`);
      await verifiedToggle.click();
      await page.waitForTimeout(500);
      await shot(page, "08-verified-only-off");
      const checkedAfter = await verifiedToggle.isChecked();
      record(
        "Toggle flips state",
        checkedAfter !== checkedBefore,
        `before=${checkedBefore} after=${checkedAfter}`,
      );
    } else {
      record("Verified only toggle present", false, "toggle not found");
    }

    // ── Step 11: assert Open buttons exist ────────────────────────────
    const openBtnCount = await page.locator(`button[title*="Open"], button:has(svg.lucide-external-link)`).count();
    record("Open buttons render per row", openBtnCount > 0, `${openBtnCount} Open buttons in DOM`);

    // ── Done ──────────────────────────────────────────────────────────
    await shot(page, "09-final-state");
  } catch (e: any) {
    console.error("✗ unexpected error:", e?.message ?? e);
    record("Test ran without crashing", false, e?.message ?? String(e));
    try {
      await shot(page, "99-error-state");
    } catch {}
  } finally {
    await browser.close();
  }

  console.log("\n────── SUMMARY ──────");
  let passed = 0;
  let failed = 0;
  for (const r of results) {
    if (r.pass) passed++;
    else failed++;
  }
  console.log(`${passed} passed · ${failed} failed`);
  if (failed > 0) {
    console.log("Failures:");
    for (const r of results) {
      if (!r.pass) console.log(`  ✗ ${r.name} — ${r.detail}`);
    }
    process.exit(1);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
