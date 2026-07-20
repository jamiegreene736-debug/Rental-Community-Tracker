// Alias-inbox link retention — locks the 2026-07-20 operator ask: "I need to
// be able to click the links that are being sent" to the unit email aliases.
//
// Three layers, all guarded here:
//   1. shared/email-mime.ts stripHtml preserves <a href> URLs as "[link: url]"
//      markers instead of discarding them with the tags.
//   2. shared/email-body-format.ts splitEmailBodyIntoSegments turns URLs (both
//      markers and raw plain-text URLs) into link segments the client renders
//      as clickable <a> elements (EmailBodyWithLinks in bookings.tsx).
//   3. Surrogate-dedup STABILITY (load-bearing): id-less emails hash a body
//      prefix into their dedup key. Bodies stored before link preservation
//      hashed WITHOUT markers, so both syncs must hash stripLinkMarkers(body)
//      — otherwise every legacy id-less HTML email re-imports as a duplicate.
//   4. Downstream parsers that label-scan email bodies (arrival details,
//      paid-rate extraction, booked-title extraction) strip markers first so a
//      trailing link on a labeled line can't pollute a captured value.
//   5. Sync-time heal: rows stored before link preservation get their body
//      rewritten in place when the fresh parse of the same IMAP message (both
//      syncs re-fetch a 45-day window every tick) recovers links.
import { readFileSync } from "node:fs";
import { stripHtml, stripLinkMarkers } from "../shared/email-mime";
import { splitEmailBodyIntoSegments } from "../shared/email-body-format";
import { extractPaidAmountFromEmailText } from "../shared/paid-rate-extraction";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
}

console.log("stripHtml link preservation");

{
  const html = `<p>Please sign your rental agreement.</p><p><a href="https://sign.example.com/agreement/abc123?res=220669&amp;t=9">Sign Your Rental Agreement</a></p>`;
  const text = stripHtml(html);
  check("anchor href survives as a [link: …] marker",
    text.includes("Sign Your Rental Agreement [link: https://sign.example.com/agreement/abc123?res=220669&t=9]"));
  check("&amp; in the href is decoded (the raw URL must open correctly)",
    !text.includes("&amp;"));
}

{
  const text = stripHtml(`<a href="https://x.example.com/a">https://x.example.com/a</a>`);
  check("anchor whose text IS the URL gets no duplicate marker",
    !text.includes("[link:") && text.includes("https://x.example.com/a"));
}

{
  const text = stripHtml(`<a href="mailto:pm@example.com">Email us</a> <a href="javascript:void(0)">Click</a> <a href="#top">Top</a>`);
  check("mailto/javascript/fragment anchors keep text only — no markers",
    !text.includes("[link:") && text.includes("Email us"));
}

{
  const text = stripHtml(`<a href="https://btn.example.com/go"><img src="cid:btn" alt=""></a>`);
  check("image-only button anchor still yields its link",
    text.includes("[link: https://btn.example.com/go]"));
}

{
  const text = stripHtml(`<a href="https://dup.example.com/x"><img src="a.png"></a> <a href="https://dup.example.com/x">View details</a>`);
  check("same href across image + text anchors is marked exactly once",
    (text.match(/\[link:/g) ?? []).length === 1);
}

{
  const html = `<!--[if mso]><a href="https://real.example.com/sign">Sign</a><![endif]--><a href="https://real.example.com/sign">Sign</a>`;
  const text = stripHtml(html);
  check("MSO conditional-comment duplicate does not eat the visible anchor's link",
    text.includes("[link: https://real.example.com/sign]"));
}

console.log("surrogate-dedup stability (legacy id-less emails must not re-import)");

{
  const legacyBody = stripHtml(`<p>Aloha, your booking is confirmed.</p><p>Details below.</p>`);
  const anchored = stripHtml(`<p>Aloha, your booking is confirmed.</p><p><a href="https://t.example.com/r/1">Details</a> below.</p>`);
  const normalize = (s: string) => stripLinkMarkers(s).replace(/\s+/g, " ").slice(0, 200);
  check("stripLinkMarkers(new body) normalizes to what the pre-link body hashed",
    normalize(anchored).includes("Details below.") && !normalize(anchored).includes("[link:"));
  check("plain bodies pass through stripLinkMarkers untouched",
    stripLinkMarkers(legacyBody) === legacyBody);
}

console.log("splitEmailBodyIntoSegments");

{
  const segs = splitEmailBodyIntoSegments("Sign here [link: https://sign.example.com/a?b=1] today.");
  const link = segs.find((s) => s.kind === "link");
  check("marker URL becomes a link segment with href",
    link?.href === "https://sign.example.com/a?b=1");
  check("surrounding text is preserved in order",
    segs[0]?.value.includes("Sign here") === true && segs[segs.length - 1]?.value.includes("today.") === true);
}

{
  const segs = splitEmailBodyIntoSegments("See https://plain.example.com/page. Thanks!");
  const link = segs.find((s) => s.kind === "link");
  check("raw plain-text URL is linkified with trailing punctuation trimmed",
    link?.href === "https://plain.example.com/page");
}

{
  const segs = splitEmailBodyIntoSegments("No links in this body at all.");
  check("link-free body is one text segment",
    segs.length === 1 && segs[0].kind === "text");
}

console.log("downstream parsers ignore markers");

{
  const hit = extractPaidAmountFromEmailText(
    "Booking confirmed",
    "Total: $1,405.00 [link: https://receipt.example.com/9988776655]",
  );
  check("paid-rate extraction still finds the total and quotes WITHOUT the URL",
    hit?.amount === 1405 && !(hit?.quote ?? "").includes("[link:"));
  check("receipt-URL digit runs never become the money figure",
    hit?.amount !== 9988776655);
}

console.log("wiring source guards");

const emailMime = readFileSync(new URL("../shared/email-mime.ts", import.meta.url), "utf8");
const guestSync = readFileSync(new URL("../server/guest-inbox-sync.ts", import.meta.url), "utf8");
const buyInSync = readFileSync(new URL("../server/buy-in-email-sync.ts", import.meta.url), "utf8");
const buyInEmail = readFileSync(new URL("../server/buy-in-email.ts", import.meta.url), "utf8");
const compose = readFileSync(new URL("../shared/arrival-request-compose.ts", import.meta.url), "utf8");
const bookings = readFileSync(new URL("../client/src/pages/bookings.tsx", import.meta.url), "utf8");

check("comments/style/head are removed BEFORE the anchor pass (MSO dedupe trap)",
  emailMime.indexOf("withoutDeadRegions") < emailMime.indexOf("preserveAnchorHrefs(withoutDeadRegions)"));
check("guest-inbox surrogate hashes the marker-stripped body",
  /stripLinkMarkers\(parsed\.body \?\? ""\)\.replace\(\/\\s\+\/g, " "\)\.slice\(0, 200\)/.test(guestSync));
check("buy-in-email surrogate hashes the marker-stripped body",
  /stripLinkMarkers\(parsed\.body \?\? ""\)\.replace\(\/\\s\+\/g, " "\)\.slice\(0, 200\)/.test(buyInSync));
check("guest-inbox sync heals stored link-less bodies in place",
  guestSync.includes("updateGuestInboxMessageBody(alreadyStored.id, parsed.body)") &&
  guestSync.includes(`parsed.body.includes("[link: ") && !storedBody.includes("[link: ")`));
check("buy-in-email sync heals stored link-less bodies in place",
  buyInSync.includes(".set({ body: parsed.body })") &&
  buyInSync.includes(`parsed.body.includes("[link: ") && !stored.body.includes("[link: ")`));
check("arrival-details parse strips markers before label capture",
  buyInEmail.includes("return stripLinkMarkers(String(input ?? \"\"))"));
check("booked-title extraction strips markers",
  compose.includes("stripLinkMarkers(String(text ?? \"\"))"));
check("alias reading pane renders EmailBodyWithLinks (both PM and booking-thread rows)",
  bookings.includes("<EmailBodyWithLinks body={formatEmailBodyForDisplay(email.body)} />") &&
  bookings.includes(`<EmailBodyWithLinks body={String(m.body || "").slice(0, 6000)} />`));
check("sidebar snippet strips markers so a long URL can't eat the preview",
  bookings.includes("stripLinkMarkers(formatEmailBodyForDisplay(String(body ?? \"\")))"));
check("link segments render as target=_blank noreferrer anchors",
  /EmailBodyWithLinks[\s\S]{0,600}target="_blank"[\s\S]{0,200}rel="noreferrer"/.test(bookings));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
