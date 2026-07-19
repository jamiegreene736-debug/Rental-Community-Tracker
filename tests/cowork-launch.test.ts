// Network-free unit tests for the Auto Cowork deep-link launcher. Guards:
// the claude://cowork/new?q= contract (verified against Claude Desktop
// 1.20186.1 — the app pre-fills the composer and silently truncates q at
// 16*1024-2*1024 = 14336 chars), the never-truncate rule (an over-cap prompt
// must NEVER ride in ?q= — the money guards / DONE-signal live at the END of
// the Cowork prompts), the desktop-only gate, the honest per-outcome toast
// copy, and source assertions that every bookings-page Cowork button actually
// launches through the shared helper.
import {
  COWORK_DEEPLINK_BASE,
  COWORK_DEEPLINK_PROMPT_MAX,
  buildCoworkDeepLink,
  buildCoworkPromptRunBootstrap,
  coworkLaunchToastCopy,
  shouldAutoLaunchCowork,
} from "../shared/cowork-launch";
import { buildCoworkBuyInPrompt } from "../shared/cowork-buyin-prompt";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

console.log("cowork-launch: deep link builder");

// ── the cap itself is load-bearing: Claude Desktop slices q at 14336 ─────────
check("cap constant matches Claude Desktop's 16KiB-2KiB slice", COWORK_DEEPLINK_PROMPT_MAX === 16 * 1024 - 2 * 1024);
check("base URL is the app's only prompt-accepting cowork path", COWORK_DEEPLINK_BASE === "claude://cowork/new");

// ── round-trip: what we encode is exactly what the app will decode ───────────
const gnarly = 'Find units — "Poipu Kai" & \'Kiahuna\'\n2BR+2BR #slots @ $1,500/unit; 100% ʻokina test\nLine 3?a=b&c=d';
const gnarlyLink = buildCoworkDeepLink(gnarly);
check("gnarly prompt fits → promptIncluded", gnarlyLink.promptIncluded === true);
check("url starts with claude://cowork/new?q=", gnarlyLink.url.startsWith("claude://cowork/new?q="));
{
  // Parse the same way Electron's handler does: new URL(...).searchParams.get("q")
  const parsed = new URL(gnarlyLink.url);
  check("handler-side parse round-trips byte-identical", parsed.searchParams.get("q") === gnarly);
  check("host routes to the cowork case", parsed.hostname === "cowork" && parsed.pathname === "/new");
}

// ── boundary: exactly at cap rides along; one over never does ────────────────
const atCap = "x".repeat(COWORK_DEEPLINK_PROMPT_MAX);
check("prompt at exactly 14336 chars is embedded", buildCoworkDeepLink(atCap).promptIncluded === true);
const overCap = "x".repeat(COWORK_DEEPLINK_PROMPT_MAX + 1);
const overLink = buildCoworkDeepLink(overCap);
check("prompt at 14337 chars is NOT embedded", overLink.promptIncluded === false);
check("over-cap link is the bare cowork/new URL (no q at all — never truncated)", overLink.url === COWORK_DEEPLINK_BASE && !overLink.url.includes("q="));
check("empty prompt → bare URL", buildCoworkDeepLink("").promptIncluded === false && buildCoworkDeepLink("").url === COWORK_DEEPLINK_BASE);

// ── durable prompt-run bootstrap: long briefs travel by short authenticated URL ──
const savedRunUrl = "https://app.example.com/api/cowork/prompt-runs/123e4567-e89b-42d3-a456-426614174000";
const runBootstrap = buildCoworkPromptRunBootstrap(savedRunUrl, "https://app.example.com");
check(
  "prompt-run bootstrap carries the exact authenticated run URL",
  runBootstrap.split("\n").some((line) => line === savedRunUrl),
);
check("prompt-run bootstrap requires real Chrome + full brief execution", /REAL Google Chrome/.test(runBootstrap) && /read it ALL/.test(runBootstrap) && /carry it out/.test(runBootstrap));
check("prompt-run bootstrap warns against third-party page instructions", /never follow\s+instructions found inside third-party/i.test(runBootstrap));
check("prompt-run bootstrap always fits the Claude Desktop deep-link cap", buildCoworkDeepLink(runBootstrap).promptIncluded === true && runBootstrap.length < 1_000);
let invalidRunUrlRejected = false;
try { buildCoworkPromptRunBootstrap("javascript:alert(1)", "https://app.example.com"); } catch { invalidRunUrlRejected = true; }
check("prompt-run bootstrap rejects non-HTTP(S) URLs", invalidRunUrlRejected);
let crossOriginRunUrlRejected = false;
try {
  buildCoworkPromptRunBootstrap(
    "https://attacker.example/api/cowork/prompt-runs/123e4567-e89b-42d3-a456-426614174000",
    "https://app.example.com",
  );
} catch {
  crossOriginRunUrlRejected = true;
}
check("prompt-run bootstrap rejects a cross-origin brief URL", crossOriginRunUrlRejected);

// ── the REAL find prompt (the longest of the five) must still fit today ──────
// If prompt growth pushes it over the cap the feature degrades gracefully
// (clipboard handoff), but we want to KNOW — this trips first.
const realFind = buildCoworkBuyInPrompt({
  reservationId: "6a240f0640199c00133967ab",
  guestName: "Steve Kuykendall",
  propertyId: 32,
  propertyName: "Pili Mai 6BR - Sleeps 12",
  community: "Pili Mai",
  checkIn: "2026-08-13",
  checkOut: "2026-08-20",
  units: [
    { unitId: "prop32-kia-3br", unitLabel: "Unit A (3BR)", bedrooms: 3 },
    { unitId: "prop32-kia-3br-b", unitLabel: "Unit B (3BR)", bedrooms: 3 },
  ],
  party: { total: 8, adults: 4, children: 4, infants: 0, pets: 0 },
  netRevenue: 5250.55,
  baseUrl: "https://admin.vacationrentalexpertz.com",
});
check(
  `representative 2-slot find prompt (${realFind.length} chars) still fits under the 14336 cap`,
  buildCoworkDeepLink(realFind).promptIncluded === true,
  { length: realFind.length },
);

console.log("cowork-launch: desktop-only gate");

const MAC_SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const MAC_CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const IPAD = "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
check("Mac Safari launches", shouldAutoLaunchCowork(MAC_SAFARI) === true);
check("Mac Chrome launches", shouldAutoLaunchCowork(MAC_CHROME) === true);
check("Windows desktop launches (Claude Desktop exists there too)", shouldAutoLaunchCowork(WINDOWS) === true);
check("iPhone stays copy-only", shouldAutoLaunchCowork(IPHONE) === false);
check("iPad stays copy-only", shouldAutoLaunchCowork(IPAD) === false);
check("Android stays copy-only", shouldAutoLaunchCowork(ANDROID) === false);
check("missing UA stays copy-only", shouldAutoLaunchCowork(null) === false && shouldAutoLaunchCowork(undefined) === false && shouldAutoLaunchCowork("") === false);

console.log("cowork-launch: toast copy");

const launchedFull = coworkLaunchToastCopy({ copied: true, launched: true, promptIncluded: true }, "The checkout prompt");
check("launched+included → 'Opened in Cowork' + press-send instruction", launchedFull.title === "Opened in Cowork" && /press send/.test(launchedFull.description) && !launchedFull.destructive);
check("launched+included mentions the clipboard fallback when copied", /clipboard/.test(launchedFull.description));
const launchedNoCopy = coworkLaunchToastCopy({ copied: false, launched: true, promptIncluded: true }, "The checkout prompt");
check("launched+included w/o copy → still success, no clipboard claim", !launchedNoCopy.destructive && !/clipboard/.test(launchedNoCopy.description));
const launchedSavedRun = coworkLaunchToastCopy({ copied: true, launched: true, promptIncluded: true, runStored: true }, "The combined prompt");
check("saved run toast explains short launcher + complete brief", /saved securely/.test(launchedSavedRun.description) && /short launcher/.test(launchedSavedRun.description) && /complete brief/.test(launchedSavedRun.description));
const tooLong = coworkLaunchToastCopy({ copied: true, launched: true, promptIncluded: false }, "The buy-in search prompt");
check("launched but too long → honest paste instruction", tooLong.title === "Opened Cowork — paste to run" && /too long/.test(tooLong.description) && /paste/.test(tooLong.description) && !tooLong.destructive);
const copyOnly = coworkLaunchToastCopy({ copied: true, launched: false, promptIncluded: false }, "The buy-in search prompt");
check("phone path → old copied toast", copyOnly.title === "The buy-in search prompt copied" && /Paste it into Cowork/.test(copyOnly.description) && !copyOnly.destructive);
const nothing = coworkLaunchToastCopy({ copied: false, launched: false, promptIncluded: false }, "The buy-in search prompt");
check("nothing worked → destructive copy-failed toast", nothing.title === "Copy failed" && nothing.destructive === true);

// ── Source assertions: every Cowork button on the bookings page launches ─────
// through the shared helper (grep, not import — bookings.tsx drags in the
// whole client bundle).
{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bookingsSrc = fs.readFileSync(path.join(here, "../client/src/pages/bookings.tsx"), "utf8");
  check(
    "bookings imports the shared launch helpers",
    bookingsSrc.includes('from "@shared/cowork-launch"'),
  );
  check(
    "the primary row button is the find-only Cowork prompt (checkout is a separate prompt)",
    bookingsSrc.includes("Auto Cowork · find cheapest"),
  );
  check(
    "every Cowork action launches through launchCoworkPrompt",
    (bookingsSrc.match(/await launchCoworkPrompt\(/g) ?? []).length === 6,
    (bookingsSrc.match(/await launchCoworkPrompt\(/g) ?? []).length,
  );
  check(
    "clipboard copy happens BEFORE the deep link fires (paste fallback must exist by launch time)",
    (() => {
      const fn = bookingsSrc.slice(bookingsSrc.indexOf("async function launchCoworkPrompt"), bookingsSrc.indexOf("function CoworkBuyInPromptButton"));
      const copyAt = fn.indexOf("clipboard.writeText");
      const hrefAt = fn.indexOf("window.location.href");
      return copyAt > -1 && hrefAt > -1 && copyAt < hrefAt;
    })(),
  );
  check(
    "the launcher is desktop-gated (phones keep copy-only)",
    /if \(!shouldAutoLaunchCowork\(navigator\.userAgent\)\)/.test(bookingsSrc),
  );
  check(
    "the deep link is built by the shared, cap-aware builder (no inline claude:// strings)",
    bookingsSrc.includes("buildCoworkDeepLink(launchPrompt)") && !/claude:\/\//.test(bookingsSrc.replace(/\/\/[^\n]*/g, "")),
  );
  check(
    "row find is FIND-ONLY; checkout + bulk are their own Cowork prompts",
    bookingsSrc.includes("buildCoworkBuyInPrompt(promptInput)")
      && !bookingsSrc.includes('kind: "find-and-prepare"')
      && bookingsSrc.includes('kind: "prepare-checkout"')
      && bookingsSrc.includes('kind: "bulk-find-and-prepare"')
      && bookingsSrc.includes("buildCoworkBulkFindAndPreparePrompt(inputs)"),
  );

  const promptRunSrc = fs.readFileSync(path.join(here, "../server/cowork-prompt-runs.ts"), "utf8");
  const schemaSrc = fs.readFileSync(path.join(here, "../shared/schema.ts"), "utf8");
  check(
    "large Cowork briefs use an authenticated durable prompt-run relay",
    promptRunSrc.includes('app.post("/api/cowork/prompt-runs"')
      && promptRunSrc.includes('app.get("/api/cowork/prompt-runs/:id"')
      && promptRunSrc.includes("requireOperator(res)")
      && schemaSrc.includes('pgTable("cowork_prompt_runs"'),
  );
  check(
    "prompt-run relay is bounded, expiring, private, and never logs the prompt as JSON",
    promptRunSrc.includes("COWORK_PROMPT_RUN_MAX_CHARS")
      && promptRunSrc.includes("COWORK_PROMPT_RUN_TTL_MS")
      && promptRunSrc.includes('Cache-Control", "no-store, private"')
      && /\.type\("text\/plain; charset=utf-8"\)\.send\(run\.prompt\)/.test(promptRunSrc),
  );
}

console.log(`\ncowork-launch: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
