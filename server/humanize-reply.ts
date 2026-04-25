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
// Three transforms:
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
// What this does NOT do: re-shuffle sentence structure, swap
// vocabulary for synonyms, or any of the AI-detection-evasion tricks
// open-source humanizers run. Those tend to scramble meaning. Goal
// here is a hard guarantee that specific known-bad phrases can't
// reach the guest, not "obfuscate that this was LLM-written".

const EM_DASH_WITH_SPACES = /\s+—\s+/g;
const EM_DASH_BARE = /—/g;

// WARM_UP_TRIGGERS match the START of a sentence (case-insensitive).
// When matched, the prefix up to the first sentence terminator
// (`:`, `.`, `!`, `?`) is stripped from the sentence — not the whole
// sentence. So "Here's what you're working with: Unit A is a 3BR…"
// keeps "Unit A is a 3BR…" but loses the AI-transition prefix.
// Sentences that are PURE fluff (e.g. "Thanks for reaching out!")
// have nothing left after stripping the prefix and get dropped.
const WARM_UP_TRIGGERS: ReadonlyArray<RegExp> = [
  /^I'?m (thrilled|delighted|happy|excited|pleased|so excited|so happy|really excited|really happy)\b/i,
  /^I'?d (be (happy|delighted|thrilled|glad|pleased)|love)\b/i,
  /^We'?re (thrilled|delighted|happy|excited|pleased|so excited|so happy|really excited|really happy|stoked)\b/i,
  /^What (a|an) (great|wonderful|fantastic|amazing|awesome|excellent|terrific) question/i,
  // "Thanks for reaching out!" with the exclamation — the AI tell.
  // A neutral "Thanks for reaching out." (period) reads natural and
  // is allowed through.
  /^Thanks for (reaching out|your message|your inquiry|the message|the inquiry)\s*[!]/i,
  /^Thank you (so much|very much) for/i,
  // "Here's what you're working with:" / "Here's the breakdown" /
  // "Here's a quick rundown" — AI transition phrases.
  /^Here'?s (what|the|a) (you'?re working with|breakdown|quick (breakdown|rundown|overview)|rundown|overview|setup|deal)/i,
  /^(Absolutely|Certainly|Of course|Naturally)\s*[!.]/i,
  /^Rest assured/i,
  /^Please be advised/i,
  // Excitement-as-opener: "We're so excited to host you", "Excited
  // to have you", etc.
  /^(We'?re|I'?m) (so |really |very |truly )?(excited|thrilled|delighted|happy|stoked|pumped) to (have|host|welcome|see)/i,
  /^(So )?excited to (have|host|welcome|see)/i,
  // Date / booking restating openers — guest sent the inquiry, they
  // know their dates. Specific to fluff phrasings ("You've got two
  // beautiful townhomes reserved from…") so legitimate answers like
  // "You've got king beds in both masters" don't get hit.
  /^You'?ve got (a |an |two |three |four |five |\d+ |both |several )?\s*(beautiful|stunning|gorgeous|spacious|lovely|amazing|wonderful|incredible|fabulous|fantastic|charming|cozy)\b/i,
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

// If the sentence starts with a warm-up trigger, strip the prefix up
// to (and including) the first sentence terminator (`:`, `.`, `!`, `?`).
// The residue (which may be empty) is what's kept.
function stripWarmUpPrefix(sentence: string): string {
  for (const re of WARM_UP_TRIGGERS) {
    if (re.test(sentence)) {
      const m = sentence.match(/[:!.?]/);
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
  return sentence;
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
      const after = stripWarmUpPrefix(s);
      if (after) out.push(after);
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
