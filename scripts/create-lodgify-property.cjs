#!/usr/bin/env node

/**
 * Browser automation to create the 5BR Poipu Kai property in Lodgify.
 * Uses Nix-provided Chromium via Playwright.
 */

const { chromium } = require('playwright');
const { execSync } = require('child_process');

const EMAIL = process.env.LODGIFY_EMAIL;
const PASSWORD = process.env.LODGIFY_PASSWORD;

if (!EMAIL || !PASSWORD) {
  console.error('Missing LODGIFY_EMAIL or LODGIFY_PASSWORD environment variables');
  process.exit(1);
}

const PROPERTY = {
  name: "Regency at Poipu Kai - Sleeps 12 - 5BR AC Villas with Pool and Tennis - Poipu, Kauai",
  internalName: "5BR Poipu Kai (Units 723 + 611)",
  address: "1831 Poipu Rd",
  city: "Koloa",
  state: "HI",
  zip: "96756",
  country: "United States",
  bedrooms: 5,
  bathrooms: 5,
  maxGuests: 12,
  description: `This listing is comprised of two condos within the Regency at Poipu Kai resort, just a short walk apart from each other within the complex. Together they offer 5 bedrooms and can accommodate up to 12 guests, a great option for families or groups looking for comfortable south shore accommodations with AC.

Unit A is a 3-bedroom, 3-bathroom condo (~1,800 sq ft) with central AC, updated finishes, a granite kitchen, private balcony, and a loft bedroom. Sleeps 7 with a King bed, Queen bed, 2 Twins, and a sofa bed.

Unit B is a spacious corner 2-bedroom, 2-bathroom ground-floor condo (~1,400 sq ft) with central AC, extra natural light from the corner position, a Queen bed in the primary bedroom, and a King bed in the second bedroom. Sleeps 5.

All guests enjoy resort amenities including the swimming pool, hot tub, tennis and pickleball courts, and tropical garden paths. Poipu's beloved beaches are a short 10-minute walk from the resort. Walking distance to Poipu Beach Park, Brennecke's Beach, and Shipwreck Beach. Nearby: Poipu Shopping Village, Kukui'ula Village (dining/shops), Spouting Horn blowhole, National Tropical Botanical Garden, Koloa Town historic district. Snorkeling at Poipu Beach, sea turtles, monk seals. Great restaurants including The Beach House, Merriman's, Tidepools.

Important: This listing represents our managed portfolio of similar units within the same resort complex. Your specific unit will be confirmed prior to check-in and will match the advertised bedroom count, sleeping arrangements, and amenity standards described above. Individual unit decor and furnishings may vary.`
};

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function run() {
  // Use the Nix-provided Chromium to avoid glibc conflicts
  let chromiumPath;
  try {
    chromiumPath = execSync('nix-shell -p chromium --run "which chromium"', { timeout: 30000 }).toString().trim();
    console.log('Using Nix Chromium at:', chromiumPath);
  } catch (e) {
    console.error('Could not find Nix chromium:', e.message);
    process.exit(1);
  }

  console.log('Launching browser...');
  const browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  try {
    // Step 1: Log in
    console.log('Navigating to Lodgify login...');
    await page.goto('https://app.lodgify.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(4000);

    console.log('Current URL:', page.url());
    await page.screenshot({ path: '/tmp/lodgify-01-login.png', fullPage: true });

    // Log all inputs visible
    const allInputs = await page.$$('input');
    for (const inp of allInputs) {
      const info = await inp.evaluate(el => ({ type: el.type, name: el.name, placeholder: el.placeholder, id: el.id }));
      console.log('Input found:', JSON.stringify(info));
    }

    // Lodgify uses IdentityServer - find the email/username input
    // Try a broader selector approach
    const emailInput = page.locator('input').first();
    await emailInput.waitFor({ state: 'visible', timeout: 15000 });
    
    // Get info about inputs
    const inputCount = await page.locator('input').count();
    console.log('Total inputs:', inputCount);
    for (let i = 0; i < inputCount; i++) {
      const info = await page.locator('input').nth(i).evaluate(el => ({ type: el.type, name: el.name, placeholder: el.placeholder, id: el.id }));
      console.log(`Input[${i}]:`, JSON.stringify(info));
    }

    // Fill based on common patterns - try by type
    const emailField = page.locator('input[type="email"], input[name="Email"], input[name="username"], input[name="Username"]').first();
    if (await emailField.isVisible()) {
      await emailField.fill(EMAIL);
      console.log('Filled email field');
    } else {
      // Try first text input
      await page.locator('input[type="text"], input[type="email"]').first().fill(EMAIL);
      console.log('Filled first text/email input');
    }

    // Fill password
    await page.locator('input[type="password"]').fill(PASSWORD);
    console.log('Filled password');

    await page.screenshot({ path: '/tmp/lodgify-02-filled.png', fullPage: true });

    // Submit - look for login button
    const submitBtn = page.locator('button[type="submit"], input[type="submit"]').first();
    await submitBtn.click();
    console.log('Clicked login/submit button');

    // Wait for navigation after login
    await sleep(6000);
    console.log('After login URL:', page.url());
    await page.screenshot({ path: '/tmp/lodgify-03-dashboard.png', fullPage: true });
    
    // Check if we're still on login (wrong credentials or extra step)
    if (page.url().includes('login') || page.url().includes('Login')) {
      console.log('Still on login page - checking for errors or 2FA...');
      const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 300));
      console.log('Body text:', bodyText);
    } else {
      console.log('Login successful!');
    }

    // Step 2: Navigate to add new property
    console.log('Navigating to new property creation...');
    
    // Try direct URL first
    await page.goto('https://app.lodgify.com/#/properties/new', { waitUntil: 'networkidle', timeout: 20000 });
    await sleep(2000);
    console.log('After goto new property URL:', page.url());
    await page.screenshot({ path: '/tmp/lodgify-04-new-property.png' });

    // Check if we landed on a form or need to find a button
    const pageContent = await page.content();
    if (pageContent.includes('Add property') || pageContent.includes('New property') || pageContent.includes('property name') || pageContent.includes('Property name')) {
      console.log('Found new property form!');
    } else {
      console.log('Looking for add property button...');
      // Try clicking an "Add property" or "+" button
      const addBtn = page.locator('text=Add property, text=New property, button:has-text("Add"), a:has-text("Add property")').first();
      if (await addBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await addBtn.click();
        await sleep(2000);
        await page.screenshot({ path: '/tmp/lodgify-04b-add-clicked.png' });
      }
    }

    await page.screenshot({ path: '/tmp/lodgify-05-form.png' });
    console.log('Page title:', await page.title());
    
    // Log visible inputs
    const inputs = await page.locator('input:visible').all();
    for (const input of inputs) {
      const attrs = await input.evaluate(el => ({
        type: el.type, name: el.name, placeholder: el.placeholder, id: el.id
      }));
      console.log('Input:', attrs);
    }

    const textareas = await page.locator('textarea:visible').all();
    console.log('Textareas:', textareas.length);

    const buttons = await page.locator('button:visible').all();
    for (const btn of buttons.slice(0, 10)) {
      const text = await btn.textContent();
      console.log('Button:', text?.trim());
    }

  } catch (err) {
    console.error('Error:', err.message);
    await page.screenshot({ path: '/tmp/lodgify-error.png' });
  } finally {
    await browser.close();
    console.log('Browser closed. Screenshots saved to /tmp/lodgify-*.png');
  }
}

run().catch(console.error);
