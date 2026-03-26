const { chromium } = require('playwright');
const { execSync } = require('child_process');

const EMAIL = process.env.LODGIFY_EMAIL;
const PASSWORD = process.env.LODGIFY_PASSWORD;

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
  const chromiumPath = execSync('nix-shell -p chromium --run "which chromium"', { timeout: 30000 }).toString().trim();
  
  const browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: false, // Try non-headless to see if CF allows it
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox', 
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-automation',
    ]
  });
  
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  });

  // Remove automation flags
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();

  try {
    console.log('Navigating to Lodgify...');
    await page.goto('https://app.lodgify.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(5000);
    
    console.log('URL:', page.url());
    console.log('Inputs:', await page.locator('input:not([type="hidden"])').count());
    
    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 200));
    console.log('Page text:', bodyText);
    
    await page.screenshot({ path: '/tmp/lod-stealth.png', fullPage: true });
    
  } catch(e) {
    console.error('Error:', e.message);
  } finally {
    await browser.close();
  }
}

run().catch(console.error);
