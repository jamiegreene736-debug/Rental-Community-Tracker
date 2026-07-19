// Network-free tests for the OUT-OF-BAND Cowork attach probe.
//
// Cowork attaches buy-ins from Claude Desktop by calling this portal's own API,
// so an open bookings tab gets no job id and nothing to poll — the row keeps
// stale slots and "Prepare checkout in Cowork" never appears. These guard the
// fix: a cheap buy_ins-only probe + slot fingerprint, invalidating the
// expensive Guesty-backed queries only when the fingerprint actually moved.
import { buyInSlotSignature, buyInSlotSignatureMap } from "../shared/buy-in-slot-signature";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

const row = (over: Partial<Parameters<typeof buyInSlotSignature>[0][number]> = {}) => ({
  unitId: "unit-a",
  buyInId: 41,
  bookingStatus: "not_started",
  listingUrl: "https://www.vrbo.com/1234567",
  costPaid: 1975 as number | string | null,
  ...over,
});

console.log("cowork-refresh: slot fingerprint");

check("no rows → empty signature", buyInSlotSignature([]) === "");
check(
  "slot ORDER is irrelevant (the two bookings endpoints don't agree on it)",
  buyInSlotSignature([row(), row({ unitId: "unit-b", buyInId: 42 })])
    === buyInSlotSignature([row({ unitId: "unit-b", buyInId: 42 }), row()]),
);
check("identical rows → identical signature", buyInSlotSignature([row()]) === buyInSlotSignature([row()]));

// The four changes that must invalidate.
check("a NEW attach changes it (this is what reveals the checkout button)", buyInSlotSignature([]) !== buyInSlotSignature([row()]));
check("a DETACH changes it", buyInSlotSignature([row(), row({ unitId: "unit-b", buyInId: 42 })]) !== buyInSlotSignature([row()]));
check("bookingStatus change (e.g. → awaiting_payment) changes it", buyInSlotSignature([row()]) !== buyInSlotSignature([row({ bookingStatus: "awaiting_payment" })]));
check(
  "listingUrl change changes it (the Find-on-VRBO flow re-points an EXISTING buy-in)",
  buyInSlotSignature([row()]) !== buyInSlotSignature([row({ listingUrl: "https://www.vrbo.com/7654321" })]),
);
check(
  "costPaid change changes it (it arms the checkout prompt's 15% price guard)",
  buyInSlotSignature([row()]) !== buyInSlotSignature([row({ costPaid: 2100 })]),
);

// The false-positive that would make the probe invalidate on EVERY tick.
check(
  "numeric-string vs number costPaid is NOT a change (pg numeric arrives both ways)",
  buyInSlotSignature([row({ costPaid: "1975.00" })]) === buyInSlotSignature([row({ costPaid: 1975 })]),
);
check(
  "null vs empty-string fields are NOT a change",
  buyInSlotSignature([row({ listingUrl: null })]) === buyInSlotSignature([row({ listingUrl: "" })]),
);
check(
  "a non-numeric costPaid degrades to its raw value instead of silently becoming empty",
  buyInSlotSignature([row({ costPaid: "n/a" })]) !== buyInSlotSignature([row({ costPaid: null })]),
);

console.log("cowork-refresh: signature map");
check(
  "map fingerprints per reservation",
  (() => {
    const m = buyInSlotSignatureMap({ a: [row()], b: [] });
    return m.a === buyInSlotSignature([row()]) && m.b === "";
  })(),
);
check("map tolerates null/garbage input", Object.keys(buyInSlotSignatureMap(null)).length === 0);

// ── Source assertions on the wiring ────────────────────────────────────────
{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bookingsSrc = fs.readFileSync(path.join(here, "../client/src/pages/bookings.tsx"), "utf8");
  const routesSrc = fs.readFileSync(path.join(here, "../server/routes.ts"), "utf8");
  const storageSrc = fs.readFileSync(path.join(here, "../server/storage.ts"), "utf8");

  check(
    "the probe endpoint exists on both sides",
    bookingsSrc.includes("/api/operations/buy-in-slot-status")
      && routesSrc.includes('app.post("/api/operations/buy-in-slot-status"'),
  );
  check(
    "the probe is ONE buy_ins query with no Guesty call (it runs on every tab focus)",
    storageSrc.includes("getBuyInSlotStatusByReservationIds")
      && storageSrc.includes("inArray(buyIns.guestyReservationId, reservationIds)"),
  );
  check(
    // TanStack's focusManager listens to visibilitychange ONLY. The dominant
    // Cowork layout is browser + Claude Desktop side by side, where the tab
    // never hides — so a declarative refetchOnWindowFocus would fire ZERO
    // times. window.focus is the only signal that catches the app switch back.
    "BOTH wake events are registered, with symmetric removal",
    bookingsSrc.includes('window.addEventListener("focus", onWake)')
      && bookingsSrc.includes('document.addEventListener("visibilitychange", onWake)')
      && bookingsSrc.includes('window.removeEventListener("focus", onWake)')
      && bookingsSrc.includes('document.removeEventListener("visibilitychange", onWake)'),
  );
  check(
    "the declarative form was NOT used on the bookings queries (it would fire zero times)",
    !/refetchOnWindowFocus:\s*true/.test(bookingsSrc),
  );
  check(
    "the probe bails when the document isn't visible (correct polarity)",
    bookingsSrc.includes('document.visibilityState !== "visible"'),
  );
  check("the probe is throttled", bookingsSrc.includes("< 30_000") && bookingsSrc.includes("slotProbeThrottleRef"));
  check(
    // invalidateQueries defaults to cancelRefetch:true — it ABORTS an in-flight
    // fetch and restarts it. Probing faster than the bookings endpoint's p95
    // would starve the query forever: permanent spinner, full Guesty cost, no
    // updates. The throttle alone is not enough; the p95 is unmeasured.
    //
    // MUST be isFetching (prefix-matching). getQueryState is an EXACT queryHash
    // lookup and BOTH bookings keys are parameterized, so a bare-prefix
    // getQueryState returns undefined and the guard is silently dead code —
    // that shipped in the first cut of this change and was caught in review.
    "an in-flight bookings fetch is never cancelled by the probe",
    bookingsSrc.includes("queryClient.isFetching({ queryKey: key }) > 0")
      && !/getQueryState\(key\)\?\.fetchStatus/.test(bookingsSrc),
  );
  check(
    "only a throttled probe stamps the clock (an armed poll must not swallow a real focus wake)",
    bookingsSrc.includes("if (!opts?.force) slotProbeThrottleRef.current = now;"),
  );
  check(
    "the expensive queries are invalidated ONLY when the row is actually out of date",
    (() => {
      const fn = bookingsSrc.slice(bookingsSrc.indexOf("const probeBuyInSlots"), bookingsSrc.indexOf("const onWake"));
      const guardAt = fn.indexOf("if (!stale) return;");
      const refreshAt = fn.indexOf("refreshBookingsAfterBuyInChange()");
      return guardAt > -1 && refreshAt > -1 && guardAt < refreshAt;
    })(),
  );
  check(
    // Probe-to-probe comparison would MISS the common case: an attach that
    // landed before this tab's first wake event. Screen-vs-server is the
    // question actually being asked.
    "the probe compares the server against WHAT IS ON SCREEN, not against the previous probe",
    bookingsSrc.includes("renderedSlotsRef") && bookingsSrc.includes("next[id] !== (rendered[id] ?? \"\")"),
  );
  check(
    "the probe never acts twice on the same server state (no permanent re-invalidation loop)",
    bookingsSrc.includes("lastProbeActedRef") && bookingsSrc.includes("=== lastProbeActedRef.current) return"),
  );
  check(
    "every id we asked about is fingerprinted, so a Cowork DETACH is not invisible",
    bookingsSrc.includes("next[id] = returned[id] ?? \"\""),
  );
  check(
    "a Cowork launch arms the faster poll window (side-by-side layout fires no wake event)",
    bookingsSrc.includes("armCoworkRunWindow()") && bookingsSrc.includes("coworkRunArmed.until") && bookingsSrc.includes("}, 15_000)"),
  );
  const checkoutFn = bookingsSrc.slice(
    bookingsSrc.indexOf("function CoworkCheckoutPromptButton"),
    bookingsSrc.indexOf("// \"Verify community\""),
  );
  check(
    "the checkout prompt pre-flights freshness so a stale costPaid can't mis-arm the 15% guard",
    checkoutFn.includes("/api/operations/buy-in-slot-status")
      && checkoutFn.includes("onStaleData()")
      && checkoutFn.indexOf("onStaleData()") < checkoutFn.indexOf("void launch(prompt"),
  );
  check(
    // The rendered slots come from a first-match-by-unitId join that DROPS a
    // buy-in whose unitId isn't a configured slot, while the probe returns
    // every buy_ins row. Comparing the two populations wholesale means one
    // orphan makes them never converge — every click refreshes, mismatches,
    // and says "click again" forever, permanently bricking the money button.
    "the pre-flight compares ONLY the buy-ins this click will send (no unconvergeable orphan)",
    checkoutFn.includes("const sentIds = new Set(units.map((u) => u.buyInId))")
      && checkoutFn.includes("sentIds.has(s.buyIn.id)")
      && checkoutFn.includes("sentIds.has(Number(r?.buyInId))"),
  );
  check(
    "a pre-flight outage fails OPEN but says so (silent unverified prices would arm the guard invisibly)",
    checkoutFn.includes("Couldn't verify current prices"),
  );
  check(
    "a 401 in the pre-flight aborts instead of stacking a second navigation",
    /\/\\b401\\b\/\.test\(String\(\(error as Error\)\?\.message/.test(checkoutFn),
  );
}

console.log(`\ncowork-refresh: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
