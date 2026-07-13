// Auto Cowork launch — pure, browser-safe helpers behind the bookings-page
// "Auto Cowork" buttons. Instead of only copying a generated prompt to the
// clipboard for the operator to paste, the client fires a claude:// deep link
// that opens a NEW Cowork task in the operator's Claude Desktop app with the
// prompt already typed into the composer.
//
// DEEP LINK CONTRACT (verified against Claude Desktop 1.20186.1's claude://
// URL handler + a live end-to-end test on the operator's Mac, 2026-07-13 —
// see the AGENTS.md Decision Log entry):
//
//     claude://cowork/new?q=<url-encoded prompt>
//
// - The ONLY cowork paths the app recognizes are /new and /shared-artifact;
//   anything else is dropped with an "unrecognized cowork path" warning.
// - The app PRE-FILLS the composer with q and does NOT auto-submit. The
//   operator's send press inside Claude Desktop stays the human approval —
//   LOAD-BEARING for the checkout prompt, where sending IS the approval.
// - The app SILENTLY truncates q at 16*1024 - 2*1024 = 14336 chars
//   (String.slice → UTF-16 code units, i.e. plain JS .length). A truncated
//   prompt is dangerous here: the money guards, BOT_WALL_PROTOCOL, and the
//   DONE-signal all live at the END of the Cowork prompts (the find prompt
//   already runs ~13.9k chars). So an over-cap prompt is NEVER embedded —
//   buildCoworkDeepLink() returns the bare claude://cowork/new URL instead
//   and the caller relies on the clipboard copy it already made.

/** Claude Desktop truncates the q param at this length (16 KiB − 2 KiB). */
export const COWORK_DEEPLINK_PROMPT_MAX = 14336;

export const COWORK_DEEPLINK_BASE = "claude://cowork/new";

export interface CoworkDeepLink {
  /** The claude:// URL to open. Always present — bare when the prompt is over-cap. */
  url: string;
  /** True when the prompt rode along in ?q= (fits under the app's slice cap). */
  promptIncluded: boolean;
}

/**
 * Build the claude://cowork/new deep link for a prompt. Refuses to embed a
 * prompt Claude Desktop would silently truncate — over-cap prompts get the
 * bare URL (opens an empty Cowork task; the prompt travels via clipboard).
 */
export function buildCoworkDeepLink(prompt: string): CoworkDeepLink {
  const trimmed = typeof prompt === "string" ? prompt : "";
  if (!trimmed || trimmed.length > COWORK_DEEPLINK_PROMPT_MAX) {
    return { url: COWORK_DEEPLINK_BASE, promptIncluded: false };
  }
  return {
    url: `${COWORK_DEEPLINK_BASE}?q=${encodeURIComponent(trimmed)}`,
    promptIncluded: true,
  };
}

/**
 * The deep link only makes sense where Claude Desktop can be installed —
 * a desktop OS. On iPhone/iPad/Android an unknown scheme raises a modal
 * "address is invalid" error in Safari/Chrome, so mobile keeps the
 * copy-to-clipboard flow untouched.
 */
export function shouldAutoLaunchCowork(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false;
  if (/iPhone|iPad|iPod|Android|Mobile/i.test(userAgent)) return false;
  return /Macintosh|Mac OS X|Windows NT/i.test(userAgent);
}

export interface CoworkLaunchResult {
  /** Prompt landed on the clipboard (the paste fallback + phone path). */
  copied: boolean;
  /** The claude:// deep link was fired (desktop only). */
  launched: boolean;
  /** The prompt rode inside the deep link (vs. clipboard-only handoff). */
  promptIncluded: boolean;
}

export interface CoworkLaunchToast {
  title: string;
  description: string;
  destructive: boolean;
}

/**
 * One honest toast per outcome, shared by every Cowork button. `label` is the
 * short human name of the prompt ("Buy-in search prompt", "Checkout prompt"…).
 */
export function coworkLaunchToastCopy(result: CoworkLaunchResult, label: string): CoworkLaunchToast {
  if (result.launched && result.promptIncluded) {
    return {
      title: "Opened in Cowork",
      description: `${label} is pre-filled in a new Cowork task — review it in Claude Desktop and press send to run it.${result.copied ? " (Also copied to your clipboard.)" : ""}`,
      destructive: false,
    };
  }
  if (result.launched && result.copied) {
    return {
      title: "Opened Cowork — paste to run",
      description: `${label} is too long to pre-fill via the link, but it's on your clipboard — paste it into the new Cowork task and send.`,
      destructive: false,
    };
  }
  if (result.copied) {
    return {
      title: `${label} copied`,
      description: "Paste it into Cowork to run it.",
      destructive: false,
    };
  }
  return {
    title: "Copy failed",
    description: "Select the text in the dialog and copy manually.",
    destructive: true,
  };
}
