// Post-processor that strips the AI tells the prompts can't reliably
// suppress on their own. Applied to BOTH the manual /api/inbox/ai-draft
// output and the auto-reply scheduler's drafts before they go to
// Guesty. Pure regex — no model calls, no third-party deps, runs in a
// few microseconds on a typical reply.
//
// Three transforms:
//
//   1) Em-dashes (—) → commas. Airbnb's title guidelines specifically
//      recommend commas / single slashes; em-dashes are also one of the
//      strongest "this was written by an LLM" signals in casual prose.
//      Hospitality replies rarely need them.
//
//   2) Strip warm-up / over-eager-helper phrases. These violate the
//      prompt's "lead with the answer" rule but Haiku still emits them
//      ~30% of the time. Examples: "I'm thrilled to help", "I'd be
//      happy to walk you through", "What a great question!",
//      "Absolutely!", "Thank you so much for reaching out".
//
//   3) Strip sales-y / closing-question paragraphs. The prompt
//      explicitly forbids "what other questions can I answer?" but
//      Haiku still appends them. Patterns: "Is there anything else…",
//      "What other questions…", "Looking forward to hosting you",
//      "Can't wait to welcome you", "Let me know if you have any
//      other questions".
//
// What this does NOT do: re-shuffle sentence structure, swap
// vocabulary for synonyms, or any of the AI-detection-evasion tricks
// open-source humanizers run. Those tend to scramble meaning. Goal
// here is a hard guarantee that specific known-bad phrases can't
// reach the guest, not "obfuscate that this was LLM-written".

const EM_DASH_WITH_SPACES = /\s+—\s+/g;
const EM_DASH_BARE = /—/g;

// {pattern, replacement} pairs. Most warm-ups strip to empty (""); the
// standalone-enthusiasm one preserves leading whitespace via $1 so it
// doesn't merge two words together.
const WARM_UP_RULES: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  // "I'm thrilled / delighted / happy / excited / pleased to help / assist..."
  { pattern: /\bI'?m (thrilled|delighted|happy|excited|pleased|so excited|so happy)[^.!?]*?(?:help|assist|hear from you|host you)[^.!?]*?[.!?]\s*/gi, replacement: "" },
  // "I'd be happy / delighted / thrilled to..."  /  "I'd love to..."
  { pattern: /\bI'?d (be (happy|delighted|thrilled|glad)|love)[^.!?]*?[.!?]\s*/gi, replacement: "" },
  // "What a great / wonderful / fantastic question!"
  { pattern: /\bWhat (a|an) (great|wonderful|fantastic|amazing|awesome|excellent) question[!.?]\s*/gi, replacement: "" },
  // Standalone enthusiasm words used as openers/transitions:
  // "Absolutely!" "Certainly!" "Of course!" — only when standalone
  // (followed by punctuation + space). Won't strip "absolutely" mid-
  // sentence. Preserves $1 (leading whitespace or start-of-line) so
  // surrounding words don't fuse together.
  { pattern: /(^|[\s>])(Absolutely|Certainly|Of course)[!.](?=\s)/g, replacement: "$1" },
  // "Thank you so much for [reaching out / your message / your inquiry]..."
  // Catches the over-effusive opener; a plain "Thanks for reaching out"
  // still survives because it doesn't have "so much" / "for your message".
  { pattern: /\bThank you so much for[^.!?]*?[.!?]\s*/gi, replacement: "" },
  // "Rest assured ..." — pure AI-stock hedge
  { pattern: /\bRest assured[^.!?]*?[.!?]\s*/gi, replacement: "" },
  // "Please be advised ..."
  { pattern: /\bPlease be advised[^.!?]*?[.!?]\s*/gi, replacement: "" },
];

const CLOSING_PATTERNS: ReadonlyArray<RegExp> = [
  // "Is there anything (else | specific | further | more) ... ?"
  /\bIs there anything (else|specific|further|more)[^?.!]*[?.!]\s*/gi,
  // "What other questions ... ?"  /  "What else can I ... ?"
  /\bWhat (other|else)[^?.!]*?(?:question|help|answer|share|walk you through)[^?.!]*[?.!]\s*/gi,
  // "Anything else (I can ... / to ... / that ...)"
  /\bAnything (else|more)[^?.!]*[?.!]\s*/gi,
  // "Let me know if you have any (other / more) questions ..."
  /\bLet me know if you have any[^.!?]*?(?:question|concern|thought)[^.!?]*?[.!?]\s*/gi,
  // "Looking forward to (hosting / hearing / welcoming) ..."
  /\bLooking forward to[^.!?]*?[.!?]\s*/gi,
  // "Can't wait to (welcome / host / have) ..."
  /\bCan'?t wait to[^.!?]*?[.!?]\s*/gi,
  // "We'd / I'd love to host you" closer
  /\b(We'?d|I'?d) love to (host|welcome|have) you[^.!?]*?[.!?]\s*/gi,
  // "Hope this helps!" — common AI closer
  /\bHope (this|that) helps[!.]\s*/gi,
];

// Signature is the canonical 3-line block; we never touch it. Splits
// the reply into [body, signature] so the body-cleaning patterns
// don't accidentally match anything inside the sign-off.
const SIGNATURE_MARKERS = [
  /\n\s*(Mahalo|Thank You|Thanks|Best|Regards|Sincerely|Aloha)\s*,\s*\n/i,
  /\nJohn Carpenter\s*\n/i,
];

function splitSignature(text: string): { body: string; sig: string } {
  for (const marker of SIGNATURE_MARKERS) {
    const m = text.match(marker);
    if (m && m.index !== undefined) {
      return {
        body: text.slice(0, m.index).trimEnd(),
        sig: text.slice(m.index),
      };
    }
  }
  return { body: text, sig: "" };
}

export function humanizeReply(text: string): string {
  if (!text) return text;
  const { body, sig } = splitSignature(text);

  // Step 1: em-dashes. Replace " — " (spaced) with ", " — that's how
  // Claude uses them ~95% of the time as parenthetical-aside dividers.
  // For any leftover bare "—" without surrounding spaces (rare), drop
  // to a hyphen so the character disappears entirely.
  let cleaned = body.replace(EM_DASH_WITH_SPACES, ", ");
  cleaned = cleaned.replace(EM_DASH_BARE, "-");

  // Step 2: strip warm-up phrases.
  for (const { pattern, replacement } of WARM_UP_RULES) {
    cleaned = cleaned.replace(pattern, replacement);
  }

  // Step 3: strip closing questions / sales-y closers. These almost
  // always sit on their own line at the end of the body, so stripping
  // them leaves a trailing blank line that the trim below cleans up.
  for (const pattern of CLOSING_PATTERNS) {
    cleaned = cleaned.replace(pattern, "");
  }

  // Step 4: collapse the whitespace artifacts the strips leave behind.
  cleaned = cleaned
    .replace(/[ \t]+/g, " ")              // collapse runs of spaces
    .replace(/ +(\n)/g, "$1")             // strip trailing space before newline
    .replace(/\n{3,}/g, "\n\n")           // max one blank line
    .replace(/^\s+|\s+$/g, "");           // trim ends

  // Reattach the signature with one blank line between body and sig.
  return sig ? `${cleaned}\n\n${sig.trimStart()}` : cleaned;
}
