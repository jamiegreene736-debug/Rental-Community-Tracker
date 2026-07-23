// Guards the listing-gallery BOT-WALL MANUAL-RESOLVE assist (2026-07-14):
// when a Zillow/Redfin/Homes scrape hits a bot check during find-replacement,
// the sidecar worker surfaces the Chrome window with a yellow
// "RESOLVE THE BOT DETECTION" banner and WAITS for the operator, while the
// server pauses the awaitOpResult wallet so the op can't be cancelled (page
// torn down) mid-solve. Two halves live in two runtimes (daemon worker .mjs +
// server queue .ts) joined only by a heartbeat STAGE string — this suite
// drift-locks that contract and behaviorally tests the wall detector by
// extracting it from the worker source (the daemon is standalone ESM with its
// own node_modules; importing it would boot the worker loop).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workerSrc = readFileSync(new URL("../daemon/vrbo-sidecar/worker.mjs", import.meta.url), "utf8");
const managerSrc = readFileSync(new URL("../daemon/vrbo-sidecar/chrome-sidecar-manager.mjs", import.meta.url), "utf8");
const installerSrc = readFileSync(new URL("../scripts/install-vrbo-sidecar-launchagent.sh", import.meta.url), "utf8");
const queueSrc = readFileSync(new URL("../server/vrbo-sidecar-queue.ts", import.meta.url), "utf8");

console.log("sidecar-botwall-assist suite");

// ── 1. Extract the detector from the worker source and test it behaviorally ──
const titleReSrc = workerSrc.match(/const LISTING_BOT_WALL_TITLE_RE =\s*\n?\s*\/.*\/i;/)?.[0];
const bodyReSrc = workerSrc.match(/const LISTING_BOT_WALL_BODY_RE =\s*\n?\s*\/.*\/i;/)?.[0];
const terminalFnSrc = workerSrc.match(/function detectListingTerminalDenial\(state\) \{[\s\S]*?\n\}/)?.[0];
const detectFnSrc = workerSrc.match(/function detectListingBotWall\(state\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(titleReSrc, "LISTING_BOT_WALL_TITLE_RE exists in worker.mjs");
assert.ok(bodyReSrc, "LISTING_BOT_WALL_BODY_RE exists in worker.mjs");
assert.ok(terminalFnSrc, "detectListingTerminalDenial exists in worker.mjs");
assert.ok(detectFnSrc, "detectListingBotWall exists in worker.mjs");

type ListingWallState = {
  url?: string;
  title?: string;
  bodyExcerpt?: string;
  bodyHtmlSnippet?: string;
} | null;

const detectors = new Function(
  `${titleReSrc}\n${bodyReSrc}\n${terminalFnSrc}\n${detectFnSrc}\n` +
    "return { detectListingTerminalDenial, detectListingBotWall };",
)() as {
  detectListingTerminalDenial: (state: ListingWallState) => string | null;
  detectListingBotWall: (state: ListingWallState) => string | null;
};
const { detectListingTerminalDenial, detectListingBotWall } = detectors;

// Homes.com / Akamai hard denial — there is no check for the operator to solve.
const homesAkamaiDenial = {
  url: "https://www.homes.com/property/example/abc123/",
  title: "Access Denied",
  bodyExcerpt:
    'You don\'t have permission to access "http://www.homes.com/property/example/abc123/" on this server. ' +
    "Reference #18.6fc3117.1784343240.15f4c59a https://errors.edgesuite.net/18.6fc3117.1784343240.15f4c59a",
  bodyHtmlSnippet: '<a href="https://errors.edgesuite.net/18.6fc3117.1784343240.15f4c59a">reference</a>',
};
assert.equal(
  detectListingTerminalDenial(homesAkamaiDenial),
  "Akamai Access Denied",
  "Homes.com hard denial is terminal",
);
assert.equal(
  detectListingBotWall(homesAkamaiDenial),
  null,
  "Homes.com hard denial is not presented as a solvable manual challenge",
);
assert.equal(
  detectListingTerminalDenial({
    url: "https://errors.edgesuite.net/18.9fc3117.1784343228.336c48a0",
    title: "An error has occurred",
    bodyExcerpt: "",
    bodyHtmlSnippet: "",
  }),
  "Akamai error redirect",
  "the Akamai redirect page cannot be mistaken for a cleared challenge",
);
console.log("  ✓ terminal Akamai denials fail closed without a manual-solve wait");

// Zillow / PerimeterX "Press & Hold" — the reported incident page.
assert.ok(
  detectListingBotWall({
    title: "Access to this page has been denied",
    bodyExcerpt:
      "Press & Hold to confirm you are a human (and not a bot). Reference ID 8a1c2f. Having trouble? Contact support.",
    bodyHtmlSnippet: '<div id="px-captcha" class="challenge"></div>',
  }),
  "Zillow PerimeterX press-and-hold wall is detected",
);
console.log("  ✓ detects the Zillow PerimeterX press & hold wall");

// Cloudflare interstitial (Homes.com class).
assert.ok(
  detectListingBotWall({
    title: "Just a moment...",
    bodyExcerpt: "Checking your browser before accessing homes.com. Please enable JavaScript and cookies to continue.",
    bodyHtmlSnippet: "<div>cf-challenge</div>",
  }),
  "Cloudflare interstitial is detected",
);
console.log("  ✓ detects a Cloudflare interstitial");

// Imperva/Distil (realtor.com class) — title-led, body wording varies.
assert.ok(
  detectListingBotWall({
    title: "Pardon Our Interruption",
    bodyExcerpt: "As you were browsing something about your browser made us think you were automated.",
    bodyHtmlSnippet: "<div></div>",
  }),
  "Imperva 'Pardon Our Interruption' wall is detected",
);
console.log("  ✓ detects the Imperva pardon-our-interruption wall");

// Challenge-markup-only fallback: near-empty body but the px-captcha element rendered.
assert.ok(
  detectListingBotWall({
    title: "zillow.com",
    bodyExcerpt: "",
    bodyHtmlSnippet: '<html><body><div id="px-captcha"></div></body></html>',
  }),
  "markup-only PerimeterX shell is detected",
);
console.log("  ✓ detects a markup-only challenge shell");

// NEGATIVE: a real listing page (long body, incidental scary words) must NOT trip.
const realListingBody =
  (
    "2611 Kiahuna Plantation Dr UNIT 101, Koloa, HI 96756 | 2 beds 2 baths 1,024 sqft condo. " +
    "This beautifully appointed unit features a robotic vacuum, keyless entry security system, split AC, " +
    "and a lanai overlooking the gardens. HOA covers water, trash, and grounds. Walk to Poipu Beach. "
  ).repeat(12); // ~3.4k chars — real pages sit at the excerpt cap
assert.equal(
  detectListingBotWall({
    title: "2611 Kiahuna Plantation Dr UNIT 101, Koloa, HI 96756 | Zillow",
    bodyExcerpt: realListingBody.slice(0, 3000),
    bodyHtmlSnippet: "<div class='gallery'></div>",
  }),
  null,
  "a real listing page never trips the wall detector",
);
console.log("  ✓ real listing page does not false-positive");

// NEGATIVE: a blank/still-loading page must not trip (would stall every scrape).
assert.equal(
  detectListingBotWall({ title: "Zillow", bodyExcerpt: "", bodyHtmlSnippet: "" }),
  null,
  "a blank/loading page does not trip the detector",
);
assert.equal(detectListingBotWall(null), null, "null state does not trip the detector");
console.log("  ✓ blank/loading page does not false-positive");

// ── 2. Worker ↔ server STAGE contract drift-lock ──
const stageMatch = workerSrc.match(/const GALLERY_BOTWALL_STAGE = "([^"]+)";/);
assert.ok(stageMatch, "GALLERY_BOTWALL_STAGE exists in worker.mjs");
const galleryStage = stageMatch![1];

const stageReMatch = queueSrc.match(/const MANUAL_SOLVE_STAGE_RE = (\/.*\/i);/);
assert.ok(stageReMatch, "MANUAL_SOLVE_STAGE_RE exists in vrbo-sidecar-queue.ts");
const reBody = stageReMatch![1];
const manualSolveStageRe = new RegExp(reBody.slice(1, reBody.lastIndexOf("/")), "i");

assert.ok(
  manualSolveStageRe.test(galleryStage),
  `server MANUAL_SOLVE_STAGE_RE matches the worker's gallery stage ("${galleryStage}") — renaming either side breaks the wallet pause`,
);
assert.ok(
  manualSolveStageRe.test("VRBO waiting for manual CAPTCHA solve"),
  "server MANUAL_SOLVE_STAGE_RE also covers the long-standing VRBO manual CAPTCHA stage",
);
assert.ok(
  !manualSolveStageRe.test("harvesting page 3 of results"),
  "an ordinary progress stage never pauses the wallet",
);
assert.ok(
  workerSrc.includes(`sendHeartbeat(GALLERY_BOTWALL_STAGE, true, id)`),
  "worker wait loop heartbeats the contract-locked stage with force=true (re-stamps stageUpdatedAt every tick)",
);
console.log("  ✓ worker stage string and server wallet-pause regex are contract-locked");

// ── 3. Worker wiring source guards ──
assert.ok(
  workerSrc.includes(`resolveListingBotWallManually(id, "listing_gallery_scrape", url)`),
  "processListingGalleryScrape runs the bot-wall assist before harvesting",
);
assert.ok(
  workerSrc.includes("RESOLVE THE BOT DETECTION"),
  "the surfaced yellow banner literally says RESOLVE THE BOT DETECTION (the operator's ask)",
);
assert.ok(
  /process\.env\.SIDECAR_GALLERY_BOTWALL_ASSIST === "0"/.test(workerSrc),
  "kill switch SIDECAR_GALLERY_BOTWALL_ASSIST=0 exists",
);
assert.ok(
  /SIDECAR_GALLERY_BOTWALL_WAIT_MS/.test(workerSrc),
  "wait ceiling env SIDECAR_GALLERY_BOTWALL_WAIT_MS exists",
);
{
  const assistFn = workerSrc.match(/async function resolveListingBotWallManually\(id, label, targetUrl\) \{[\s\S]*?\n\}\n/)?.[0] ?? "";
  assert.ok(assistFn.includes("throwIfRequestCancelled(id)"), "wait loop observes server-side cancellation");
  assert.ok(assistFn.includes("usingHeadlessRuntime()"), "headless runtime skips the wait (nobody can solve)");
  assert.ok(
    assistFn.includes("setCaptchaWindowVisibility(page, false, label, id)"),
    "the window is ALWAYS restored/re-hidden afterwards (finally)",
  );
  assert.ok(
    assistFn.includes("surfaceVrboChallengeWindow(page, label, id)"),
    "the assist reuses the existing surfaced-window machinery",
  );
  assert.ok(
    assistFn.indexOf("detectListingTerminalDenial(state)") < assistFn.indexOf("detectListingBotWall(state)"),
    "terminal denials are rejected before interactive challenge handling",
  );
  assert.ok(
    assistFn.indexOf("detectListingTerminalDenial(state)") < assistFn.indexOf("SIDECAR_GALLERY_BOTWALL_ASSIST"),
    "terminal denials fail closed even when the manual-assist feature is disabled",
  );
  assert.ok(
    assistFn.includes("terminal: true"),
    "terminal denials are returned explicitly to the gallery scraper",
  );
}
// After a solved wall the scrape must re-navigate so the listing renders with
// the fresh anti-bot cookie before the harvest.
assert.ok(
  /wallAssist\.waited && wallAssist\.cleared/.test(workerSrc),
  "a solved wall re-navigates to the listing before harvesting",
);
assert.ok(
  /function throwIfListingTerminalDenial\(wallAssist\) \{[\s\S]*?terminal[\s\S]*?throw new Error/.test(workerSrc),
  "a terminal provider denial fails the scrape instead of returning a false zero-photo success",
);
{
  const galleryFn = workerSrc.match(/async function processListingGalleryScrape\(id, params\) \{[\s\S]*?\n\}\n/)?.[0] ?? "";
  assert.ok(
    galleryFn.includes("const postSolveState = await captureVrboChallengeState(page)"),
    "the post-solve navigation is classified before gallery harvesting",
  );
  assert.ok(
    galleryFn.includes("detectListingTerminalDenial(postSolveState)"),
    "an Akamai redirect after a manual solve fails closed",
  );
  assert.ok(
    galleryFn.includes("detectListingBotWall(postSolveState)") && galleryFn.includes("manualSolveCount >= 2"),
    "a repeated interactive wall gets one bounded second assist and never loops forever",
  );
  assert.ok(
    galleryFn.includes("harvesting whatever rendered"),
    "the documented interactive-wall timeout fallback remains unchanged",
  );
  assert.ok(
    galleryFn.includes('all(?:\\s+\\d+)?\\s+photos'),
    'numbered gallery controls such as "See all 14 photos" are matched',
  );
  assert.ok(
    /await page\.waitForTimeout\(1200\);\s+\/\/ Zillow[\s\S]*?const galleryWallAssist = await resolveListingBotWallManually/.test(galleryFn),
    "the post-click manual-solve check runs even when Playwright dispatches a click but times out during challenge navigation",
  );
}
// The audible alert must fire for gallery labels too (gate was vrbo-only).
assert.ok(
  /\^\(\?:vrbo\|listing_gallery_scrape\|zillow_photo_scrape\)/.test(workerSrc),
  "challenge alert sound gate covers the gallery-scrape labels",
);
console.log("  ✓ worker wiring guards hold");

// Homes.com/Akamai treats --disable-notifications as an automation signal.
// Keep every daemon launch path on Chrome's native notification permission.
assert.ok(
  !/^[ \t]*["']--disable-notifications["'],?$/m.test(managerSrc),
  "local/server Chrome manager launch args preserve native notification permission",
);
assert.ok(
  !/^[ \t]*["']--disable-notifications["'],?$/m.test(workerSrc),
  "legacy local and headless Chrome launch args preserve native notification permission",
);
assert.ok(
  managerSrc.includes("--disable-backgrounding-occluded-windows"),
  "the independently-safe backgrounding optimization remains enabled",
);
console.log("  ✓ sidecar launch fingerprint remains Homes.com-compatible");

// Restarting the daemon must retire old CDP roots before the patched workers
// start. Otherwise a weeks-old Chrome process silently retains obsolete flags.
assert.ok(
  installerSrc.includes("dedicated_sidecar_chrome_pids"),
  "the installer identifies dedicated sidecar Chrome root processes",
);
assert.ok(
  /local max_port=9229/.test(installerSrc) && /ps -axww -o pid=,command=/.test(installerSrc),
  "cleanup scans every hard-capped sidecar slot using untruncated process commands",
);
assert.ok(
  /kill -TERM "\$\{pids\[@\]\}"[\s\S]*?kill -KILL "\$\{pids\[@\]\}"/.test(installerSrc),
  "the installer gives exact sidecar roots a graceful exit before escalation",
);
const stopChromeCallIndex = installerSrc.lastIndexOf("\nstop_dedicated_sidecar_chrome\n");
assert.ok(
  stopChromeCallIndex >= 0 && stopChromeCallIndex < installerSrc.indexOf('launchctl bootstrap "gui/${UID}"'),
  "stale sidecar Chrome roots are gone before the LaunchAgent is bootstrapped",
);
assert.ok(
  installerSrc.includes("refusing to restart workers against stale launch flags"),
  "the installer fails closed when a dedicated sidecar Chrome root survives",
);
console.log("  ✓ installer restart cannot reuse stale sidecar Chrome launch flags");

// ── 4. Server wallet-pause source guards ──
assert.ok(
  /stageFresh\s*=\s*\n?\s*typeof r\.stageUpdatedAt === "number" && now - r\.stageUpdatedAt <= MANUAL_SOLVE_STAGE_FRESH_MS/.test(queueSrc),
  "wallet pause is freshness-gated on stageUpdatedAt (a wedged worker cannot pin a wallet)",
);
assert.ok(
  /SIDECAR_MANUAL_SOLVE_HOLD_MS/.test(queueSrc),
  "pause ceiling env SIDECAR_MANUAL_SOLVE_HOLD_MS exists",
);
assert.ok(
  /activeStartedAt = now; \/\/ freeze the wallet while the operator solves/.test(queueSrc),
  "the pause freezes the wallet clock rather than widening every wallet",
);
console.log("  ✓ server wallet-pause guards hold");

console.log("sidecar-botwall-assist: all assertions passed");
