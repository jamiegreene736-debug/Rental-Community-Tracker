// Post-processor that strips the AI tells the prompts can't reliably
// suppress on their own. Applied to BOTH the manual /api/inbox/ai-draft
// output and the auto-reply scheduler's drafts before they go to
// Guesty. Pure regex — no model calls, no third-party deps, runs in a
// few microseconds on a typical reply.
//
// Operates at SENTENCE level (not raw substring) so a closer phrase
// like "or anything else, just let me know" doesn't strip "anything
// else…" mid-sentence and leave "or " behind. Earlier substring-match
// version did exactly that — Jamie's Pili Mai draft came back ending
// with the dangling fragment "If you have any specific questions
// about the layout, amenities, or".
//
// Four transforms:
//
//   1) Em-dashes (—) → commas. Airbnb's title guidelines specifically
//      recommend commas / single slashes; em-dashes are also one of
//      the strongest "this was written by an LLM" signals in casual
//      prose. Hospitality replies rarely need them.
//
//   2) Drop whole sentences whose FIRST words match a known warm-up
//      tell — "I'm thrilled to help…", "We're excited to host you…",
//      "Thanks for reaching out!" (with exclamation), "Here's what
//      you're working with:", "What a great question!", standalone
//      "Absolutely!" / "Certainly!", "Thank you so much for…",
//      "Rest assured…".
//
//   3) Drop whole sentences whose first words match a closer tell —
//      "Is there anything…", "What other questions…", "Anything else…",
//      "If you have any (other / more / specific) questions…",
//      "Let me know if…", "Looking forward to…", "Can't wait to…",
//      "Feel free to…", "Don't hesitate to…", "Hope this helps!".
//
//   4) Light body-level style cleanup for common stiff hospitality
//      wording ("approximately" → "about", "we are" → "we're") and
//      internal-ops phrases guests should not see ("flag this with
//      our team"). This is intentionally conservative: no synonym
//      roulette, just phrases we've seen make drafts sound like a bot.
//
// What this does NOT do: re-shuffle sentence structure, swap
// vocabulary for synonyms, or any of the AI-detection-evasion tricks
// open-source humanizers run. Those tend to scramble meaning. Goal
// here is a hard guarantee that specific known-bad phrases can't
// reach the guest, not "obfuscate that this was LLM-written".

const EM_DASH_WITH_SPACES = /\s+—\s+/g;
const EM_DASH_BARE = /—/g;

function softenStiffWording(text: string): string {
  return text
    .replace(/\bapproximately\b/gi, "about")
    .replace(/\bWhat a thoughtful Christmas gift for the family\./gi, "That sounds like a really sweet Christmas surprise for your family.")
    .replace(/\bsituated\b/gi, "located")
    .replace(/\bwithin the resort grounds\b/gi, "within the resort")
    .replace(/\bWe are\b/g, "We're")
    .replace(/\bwe are\b/g, "we're")
    .replace(/\bYou are\b/g, "You're")
    .replace(/\byou are\b/g, "you're")
    .replace(/\bThey are\b/g, "They're")
    .replace(/\bthey are\b/g, "they're")
    .replace(/\bThat is\b/g, "That's")
    .replace(/\bthat is\b/g, "that's")
    .replace(/\bThere is\b/g, "There's")
    .replace(/\bthere is\b/g, "there's")
    .replace(/\bIt is\b/g, "It's")
    .replace(/\bit is\b/g, "it's")
    .replace(/\bdo not\b/gi, "don't")
    .replace(/\bcannot\b/gi, "can't");
}

// FLUFF_SENTENCE_TRIGGERS — sentences whose FIRST words match these
// are pure social filler. Strip the prefix up to the first sentence
// terminator (`:`, `.`, `!`, `?`); for these the sentence usually
// IS the prefix, leaving an empty residue → drop the whole sentence.
const FLUFF_SENTENCE_TRIGGERS: ReadonlyArray<RegExp> = [
  /^I'?m (thrilled|delighted|happy|excited|pleased|so excited|so happy|really excited|really happy)\b/i,
  /^I'?d (be (happy|delighted|thrilled|glad|pleased)|love)\b/i,
  /^We'?re (thrilled|delighted|happy|excited|pleased|so excited|so happy|really excited|really happy|stoked)\b/i,
  /^What (a|an) (great|wonderful|fantastic|amazing|awesome|excellent|terrific) question/i,
  // "Thanks for reaching out!" with exclamation — the AI tell.
  // Neutral "Thanks for reaching out." (period) reads natural and
  // passes through.
  /^Thanks for (reaching out|your message|your inquiry|the message|the inquiry)\s*[!]/i,
  /^Thank you (so much|very much) for/i,
  /^(Absolutely|Certainly|Of course|Naturally)\s*[!.]/i,
  /^Rest assured/i,
  /^Please be advised/i,
  /^If (proximity|being close|being near|having the units close|having the units near|having them close|having them near|adjacency|side[-\s]?by[-\s]?side|next to each other)\b/i,
  /^I can (flag|note|request) (this|it)\b/i,
  /^We can (flag|note|request) (this|it)\b/i,
  // Excitement-as-opener.
  /^(We'?re|I'?m) (so |really |very |truly )?(excited|thrilled|delighted|happy|stoked|pumped) to (have|host|welcome|see)/i,
  /^(So )?excited to (have|host|welcome|see)/i,
];

// RESTATING_PREAMBLE_TRIGGERS — sentences whose FIRST words match
// these are restating-the-booking preambles. They're often followed
// by substantive content in the SAME sentence ("You've got two
// townhomes at Pili Mai, Unit A sleeps 8 with a king master…").
// Strip the prefix up to the first natural break (`,`, `;`, `:`,
// `!`, `.`, `?`) so the answer that follows survives.
const RESTATING_PREAMBLE_TRIGGERS: ReadonlyArray<RegExp> = [
  // "Here's what you're working with:" / "Here's the breakdown" /
  // "Here's a quick rundown" — AI transition phrases.
  /^Here'?s (what|the|a) (you'?re working with|breakdown|quick (breakdown|rundown|overview)|rundown|overview|setup|deal)/i,
  // "You've got [optional adjective] [unit-noun]" — restating which
  // property they're inquiring about. The unit-noun list keeps
  // legitimate answers like "You've got king beds in both masters"
  // (no unit-noun) from being stripped.
  /^You'?ve got (a |an |two |three |four |five |\d+ |both |several )?\s*(beautiful |stunning |gorgeous |spacious |lovely |amazing |wonderful |incredible |fabulous |fantastic |charming |cozy )?(townhome|condo|unit|villa|property|home|house|place|cottage|bungalow|residence|townhouse|apartment)s?\b/i,
  /^Your (booking|reservation|stay|trip) (is|runs|starts|begins|spans)\b/i,
  /^You'?(re|ll be) (booked|staying|with us|joining us|coming) (from|on|for)\b/i,
];

// CLOSING_TRIGGERS are stronger: when matched at sentence-start, that
// sentence AND every sentence after it (in the rest of the body) is
// dropped. Closers always live at the end of the body, and they tend
// to come in pairs ("Looking forward to hosting you. See you soon!"),
// so a single match cuts the whole tail.

const CLOSING_TRIGGERS: ReadonlyArray<RegExp> = [
  /^Is there anything\b/i,
  /^What (other|else)\b/i,
  /^Anything (else|more)\b/i,
  /^If you have (any|more|other|further|additional)\b/i,
  /^If there are any\b/i,
  /^Should you (have|need)\b/i,
  /^Let me know if (you|there)\b/i,
  /^Looking forward to\b/i,
  /^Can'?t wait to\b/i,
  /^(We'?d|I'?d) love to (host|welcome|have|see)\b/i,
  /^Hope (this|that) helps\b/i,
  /^Feel free to\b/i,
  /^Don'?t hesitate to\b/i,
  /^Please (feel free|don'?t hesitate|let (me|us) know)\b/i,
];

// Signature is the canonical 3-line block; we never touch it. Splits
// the reply into [body, signature] so the body-cleaning patterns
// don't accidentally match anything inside the sign-off.
const SIGNATURE_MARKERS: ReadonlyArray<RegExp> = [
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

// Rough sentence splitter. Hospitality replies are short prose with
// well-formed punctuation; we don't need a full NLP tokenizer. Splits
// on `.`/`!`/`?` followed by whitespace, preserving the punctuation
// on the preceding sentence. Newlines inside paragraphs are flattened
// to spaces; paragraph breaks (\n\n) are preserved as separators.
function splitParagraphSentences(paragraph: string): string[] {
  const flat = paragraph.replace(/\s*\n\s*/g, " ").trim();
  if (!flat) return [];
  const out: string[] = [];
  let buf = "";
  for (let i = 0; i < flat.length; i++) {
    buf += flat[i];
    const ch = flat[i];
    if (ch === "." || ch === "!" || ch === "?") {
      // Capture trailing punctuation runs (e.g. "!?" or "...")
      while (i + 1 < flat.length && /[.!?]/.test(flat[i + 1])) {
        i++;
        buf += flat[i];
      }
      // Sentence ends here when followed by whitespace + capital, OR
      // end-of-string. Otherwise it's an abbreviation / mid-sentence.
      const nextNonSpace = flat.slice(i + 1).trimStart();
      if (!nextNonSpace || /^[A-Z"']/.test(nextNonSpace)) {
        out.push(buf.trim());
        buf = "";
      }
    }
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

// Two prefix-stripping behaviors:
//
//   FLUFF — strip the prefix up to the first hard terminator
//           (`:`, `.`, `!`, `?`). For pure-fluff sentences ("Thanks
//           for reaching out!") this leaves an empty residue and the
//           caller drops the whole sentence.
//
//   RESTATING — strip the prefix up to the first natural break
//               (`,`, `;`, `:`, `!`, `.`, `?`). Used when the prefix
//               is a restating-the-booking preamble that's followed
//               by substantive content in the SAME sentence
//               ("You've got two townhomes at Pili Mai, Unit A
//               sleeps 8 with a king master…" → "Unit A sleeps 8…").
function stripPrefix(sentence: string, mode: "fluff" | "restating"): string | null {
  const triggers = mode === "fluff" ? FLUFF_SENTENCE_TRIGGERS : RESTATING_PREAMBLE_TRIGGERS;
  for (const re of triggers) {
    if (re.test(sentence)) {
      const breakClass = mode === "fluff" ? /[:!.?]/ : /[,;:!.?]/;
      const m = sentence.match(breakClass);
      if (!m || m.index === undefined) return ""; // no terminator → drop whole sentence
      const rest = sentence.slice(m.index + 1).trim();
      // If the rest starts with a lowercase letter, capitalize it so
      // the sentence reads naturally after the prefix is removed.
      if (rest && /^[a-z]/.test(rest)) {
        return rest.charAt(0).toUpperCase() + rest.slice(1);
      }
      return rest;
    }
  }
  return null; // signals "no trigger matched"
}

function isClosingSentence(s: string): boolean {
  return CLOSING_TRIGGERS.some((re) => re.test(s));
}

// First-pass greeting check. The opening "Aloha Jolene," line has no
// terminator and isn't a warm-up trigger; the splitter naturally
// keeps it intact. This is just here to be extra-safe.
function isGreetingLine(s: string): boolean {
  return /^(Aloha|Hi|Hello|Hey|Greetings)\s+\S+,\s*$/.test(s);
}

export function humanizeReply(text: string): string {
  if (!text) return text;
  const { body, sig } = splitSignature(text);

  // Step 1: em-dashes. Replace " — " (spaced) with ", " — that's how
  // Claude uses them ~95% of the time as parenthetical-aside dividers.
  // Bare "—" without surrounding spaces (rare) collapses to a hyphen.
  let cleaned = body.replace(EM_DASH_WITH_SPACES, ", ");
  cleaned = cleaned.replace(EM_DASH_BARE, "-");
  cleaned = softenStiffWording(cleaned);

  // Step 2 + 3: walk paragraphs → sentences. For each sentence:
  //   - If it starts with a CLOSING trigger, stop processing
  //     altogether (drop this and all remaining body).
  //   - If it starts with a WARM_UP trigger, strip the prefix up to
  //     the first terminator. Whatever's left (could be empty, could
  //     be a substantive answer like "Unit A is a 3BR…") is kept.
  //   - Otherwise, keep as-is.
  const paragraphs = cleaned.split(/\n\s*\n/);
  const cleanedParagraphs: string[] = [];
  let cutTail = false;
  for (const para of paragraphs) {
    if (cutTail) break;
    const trimmed = para.trim();
    if (!trimmed) continue;
    const sentences = splitParagraphSentences(trimmed);
    if (sentences.length === 0) continue;
    const out: string[] = [];
    for (const s of sentences) {
      if (isGreetingLine(s)) {
        out.push(s);
        continue;
      }
      if (isClosingSentence(s)) {
        cutTail = true;
        break;
      }
      // Try fluff first (drop whole sentence), then restating
      // (strip up to natural break in same sentence).
      const fluff = stripPrefix(s, "fluff");
      if (fluff !== null) {
        if (fluff) out.push(fluff);
        continue;
      }
      const restated = stripPrefix(s, "restating");
      if (restated !== null) {
        if (restated) out.push(restated);
        continue;
      }
      out.push(s);
    }
    if (out.length > 0) cleanedParagraphs.push(out.join(" "));
  }
  cleaned = cleanedParagraphs.join("\n\n");

  // Step 4: collapse whitespace artifacts.
  cleaned = cleaned
    .replace(/[ \t]+/g, " ")
    .replace(/ +(\n)/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+|\s+$/g, "");

  return sig ? `${cleaned}\n\n${sig.trimStart()}` : cleaned;
}
