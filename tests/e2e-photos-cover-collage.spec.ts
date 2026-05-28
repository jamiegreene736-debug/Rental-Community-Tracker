// Live smoke tests for PR #26 — photo persistence + cover-collage banner.
//
// Runs as a plain tsx script against the production Railway URL. Uses
// Playwright's core browser API (not @playwright/test) to avoid dragging
// in the test runner.
//
// Pre-merge: the "cover collage banner visible when no listing selected"
// assertion is expected to FAIL, because it's the fix this PR introduces.
// Post-merge + volume attached: all assertions should pass. Re-running
// this after the deploy is the acceptance check for PR #26.
//
// Run:  npx tsx tests/e2e-photos-cover-collage.spec.ts
// Env:  E2E_URL overrides the default production URL.

import { chromium, type Page } from "playwright";

const URL = process.env.E2E_URL ?? "https://rental-community-tracker-production.up.railway.app";
const PROPERTY_ID = 32; // Pili Mai — matches the screenshots in the bug report

type CheckResult = { name: string; pass: boolean; detail: string };
const results: CheckResult[] = [];
const record = (name: string, pass: boolean, detail: string) => {
  results.push({ name, pass, detail });
  const icon = pass ? "✓" : "✗";
  console.log(`${icon} ${name}\n    ${detail}`);
};

async function goToPhotosTab(page: Page): Promise<void> {
  await page.goto(`${URL}/builder/${PROPERTY_ID}/build`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="tab-photos"]', { timeout: 30_000 });
  await page.click('[data-testid="tab-photos"]');
  // Photos tab fetches per-folder file listings then renders a channel-
  // limits banner containing "Airbnb · max 100". Wait for that specific
  // banner to appear so we know the tab content has mounted, not just
  // the tab button.
  await page
    .getByText(/Airbnb.*max 100/s)
    .first()
    .waitFor({ timeout: 20_000 })
    .catch(() => { /* empty-photo properties won't render the banner; handled by later checks */ });
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await goToPhotosTab(page);

    // --- CHECK 1: photo folder endpoints return content ----------------
    const folderProbes = [
      { folder: "community-pili-mai", minCount: 2 },
      { folder: "pili-mai-unit-a",    minCount: 8 },
      { folder: "pili-mai-unit-b",    minCount: 8 },
    ];
    for (const { folder, minCount } of folderProbes) {
      const r = await page.request.get(`${URL}/api/photos/community/${folder}`);
      const body = await r.json().catch(() => []);
      const n = Array.isArray(body) ? body.length : 0;
      record(
        `[folder endpoint] /api/photos/community/${folder} returns ≥${minCount} photos`,
        n >= minCount,
        `got ${n} photos`,
      );
    }

    // --- CHECK 2: cover-collage banner visibility (fix target) ---------
    // Pre-fix: banner is gated on !!selectedId — so it's hidden until the
    // user picks a Guesty listing. Post-fix: banner is always visible
    // when photos.length >= 2, and the button is disabled with an amber
    // hint when no listing is selected. The button text we look for is
    // "Auto-Set Cover Collage" (from PhotoCurator.tsx).
    const bannerVisible = await page.getByRole("button", { name: /Auto-Set Cover Collage/i }).isVisible().catch(() => false);
    record(
      "[cover collage] banner visible on Photos tab with no Guesty listing selected",
      bannerVisible,
      bannerVisible ? "banner rendered" : "banner missing — expected post-fix visibility",
    );

    if (bannerVisible) {
      // If the banner is visible, verify the gating hint shows and the
      // button is disabled (since no Guesty listing is selected).
      const hintText = await page.getByText(/Select a Guesty listing above/i).isVisible().catch(() => false);
      record(
        "[cover collage] amber hint points at the listing picker",
        hintText,
        hintText ? "hint rendered" : "hint missing",
      );

      const buttonDisabled = await page
        .getByRole("button", { name: /Auto-Set Cover Collage/i })
        .isDisabled()
        .catch(() => false);
      record(
        "[cover collage] button is disabled when no listing is selected",
        buttonDisabled,
        buttonDisabled ? "disabled" : "enabled (unexpected — would silently no-op on click)",
      );
    }

    // --- CHECK 3: photo count banner renders a number ------------------
    // The banner text lives in two sibling <span>s with NO whitespace
    // between them ("22 photos" + "total" joined visually by marginLeft).
    // Read the count span directly instead of trying to match concatenated
    // innerText.
    const countSpanText = await page
      .locator('span', { hasText: /^\s*\d+\s+photos?\s*$/ })
      .first()
      .textContent()
      .catch(() => null);
    const countMatch = countSpanText?.match(/(\d+)\s+photos?/);
    record(
      "[photos tab] total-count banner renders a number",
      !!countMatch,
      countMatch ? `parsed: ${countMatch[1]} photos` : `count span not found`,
    );

    // Diagnostic dump on any failure — easier than re-running with extra logs.
    if (results.some((r) => !r.pass)) {
      await page.screenshot({ path: "tests/e2e-photos-cover-collage.debug.png", fullPage: true });
      console.log("\n(screenshot saved to tests/e2e-photos-cover-collage.debug.png for debugging)");
    }
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log(`\nFAILED:\n${failed.map((f) => `  - ${f.name}\n    ${f.detail}`).join("\n")}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("e2e run crashed:", e);
  process.exit(2);
});
