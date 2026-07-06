// Network-free unit tests for shared/alternative-page-inbox.ts — the logic that
// picks which stored alternative-unit guest page to surface in the Guest Inbox
// (so the operator can copy the /alternatives/:token URL into a text) and the
// one-glance unit summary.
import {
  selectInboxAlternativePage,
  summarizeAlternativePagePayload,
} from "../shared/alternative-page-inbox";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

console.log("alternative-page-inbox: selectInboxAlternativePage");

check("empty / nullish → null",
  selectInboxAlternativePage([]) === null
  && selectInboxAlternativePage(null) === null
  && selectInboxAlternativePage(undefined) === null);

// A single page (never sent) is still returned so its URL can be copied.
check("single unsent page returned",
  selectInboxAlternativePage([{ token: "a", createdAt: "2026-07-01T00:00:00Z" }])?.token === "a");

// Prefer the most recently SENT page even when a newer UNSENT page exists —
// the sent one is the link the guest actually has.
{
  const chosen = selectInboxAlternativePage([
    { token: "newer-unsent", createdAt: "2026-07-05T00:00:00Z" },
    { token: "older-sent", createdAt: "2026-07-01T00:00:00Z", messageSentAt: "2026-07-02T00:00:00Z" },
  ]);
  check("prefers sent over newer-but-unsent", chosen?.token === "older-sent", chosen);
}

// Among multiple SENT pages, take the most recently sent.
{
  const chosen = selectInboxAlternativePage([
    { token: "sent-old", createdAt: "2026-07-01T00:00:00Z", messageSentAt: "2026-07-02T00:00:00Z" },
    { token: "sent-new", createdAt: "2026-07-03T00:00:00Z", messageSentAt: "2026-07-06T00:00:00Z" },
  ]);
  check("most recently sent wins", chosen?.token === "sent-new", chosen);
}

// When NONE are sent, fall back to the most recently created.
{
  const chosen = selectInboxAlternativePage([
    { token: "created-old", createdAt: "2026-07-01T00:00:00Z" },
    { token: "created-new", createdAt: "2026-07-06T00:00:00Z" },
  ]);
  check("no sent → most recently created wins", chosen?.token === "created-new", chosen);
}

// Ordering of the input must not matter (function is order-independent).
{
  const reversed = selectInboxAlternativePage([
    { token: "sent-old", createdAt: "2026-07-01T00:00:00Z", messageSentAt: "2026-07-02T00:00:00Z" },
    { token: "sent-new", createdAt: "2026-07-03T00:00:00Z", messageSentAt: "2026-07-06T00:00:00Z" },
  ].reverse());
  check("order-independent", reversed?.token === "sent-new", reversed);
}

// Date objects are handled as well as ISO strings.
{
  const chosen = selectInboxAlternativePage([
    { token: "d-old", createdAt: new Date("2026-07-01T00:00:00Z") },
    { token: "d-new", createdAt: new Date("2026-07-04T00:00:00Z") },
  ]);
  check("Date objects handled", chosen?.token === "d-new", chosen);
}

console.log("alternative-page-inbox: summarizeAlternativePagePayload");

{
  const s = summarizeAlternativePagePayload({
    alternatives: [
      { title: "Ilikai - 4BR Condos", url: "https://x" },
      { title: "  Waikiki Beach Tower  ", url: "https://y" },
      { title: "", url: "https://z" }, // no usable title, still a unit
    ],
  });
  check("unitCount counts every alternative (incl. untitled)", s.unitCount === 3, s);
  check("unitTitles drops empties + trims", JSON.stringify(s.unitTitles) === JSON.stringify(["Ilikai - 4BR Condos", "Waikiki Beach Tower"]), s);
}

check("missing/garbage payload → zeroed summary",
  summarizeAlternativePagePayload(null).unitCount === 0
  && summarizeAlternativePagePayload({}).unitCount === 0
  && summarizeAlternativePagePayload({ alternatives: "nope" }).unitCount === 0
  && summarizeAlternativePagePayload(undefined).unitTitles.length === 0);

// Cap the title list at 6 for the compact chip.
{
  const many = { alternatives: Array.from({ length: 9 }, (_, i) => ({ title: `Unit ${i}` })) };
  const s = summarizeAlternativePagePayload(many);
  check("unitTitles capped at 6, unitCount honest", s.unitTitles.length === 6 && s.unitCount === 9, s);
}

console.log(`\nalternative-page-inbox: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
