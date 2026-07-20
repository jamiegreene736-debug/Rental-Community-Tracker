// The 2026-07-19 bulk find/checkout SPLIT and its dispatch memory.
//
// Operator: "it will require my human input which defeats the purpose of the
// queue." Bulk used to send the COMBINED find + prepare-checkout brief, which
// stops for the card on every unit — ~16 interruptions per batch of 8, all
// serialized. Bulk find is now unattended and ends at ATTACH; the card work
// moved to a separate batch run. These tests lock that split, the batch-only
// money guards, and the memory that stops a second click re-sending a batch
// that is still running.
import {
  COWORK_BULK_CHECKOUT_MAX,
  COWORK_BULK_FIND_MAX,
  buildCoworkBulkBuyInPrompt,
  buildCoworkBulkCheckoutPrompt,
  buildCoworkCheckoutPrompt,
  type CoworkBuyInPromptInput,
  type CoworkCheckoutPromptInput,
} from "../shared/cowork-buyin-prompt";
import {
  COWORK_DISPATCH_MAX_RECORDS,
  COWORK_DISPATCH_TTL,
  clearCoworkDispatches,
  coworkDispatchTtlMs,
  describeCoworkSuppression,
  parseCoworkDispatches,
  partitionCoworkDispatchCandidates,
  pruneCoworkDispatches,
  recordCoworkDispatches,
  serializeCoworkDispatches,
  type CoworkDispatchRecord,
} from "../shared/cowork-dispatch-memory";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

const MIN = 60_000;

// ── The batch checkout builder ──────────────────────────────────────────────
console.log("cowork-bulk-split: batch checkout builder");

const checkoutInput = (i: number): CoworkCheckoutPromptInput => ({
  reservationId: `6a1234567890abcdef0123${i}`,
  guestName: i === 0 ? "Jacelyn Tsu" : "Faith Ito",
  propertyName: "Mauna Lani Point - 4BR Condos - Sleeps 12",
  checkIn: "2026-07-21",
  checkOut: "2026-07-26",
  units: [
    { buyInId: 40 + i, unitLabel: "Unit A (2BR)", listingUrl: "https://www.vrbo.com/1234567", costPaid: "1975.00" },
    { buyInId: 50 + i, unitLabel: "Unit B (2BR)", listingUrl: "https://www.vrbo.com/7654321", costPaid: "2100.00" },
  ],
  party: { total: 12, adults: 10, children: 2, infants: 0, pets: 0 } as any,
  baseUrl: "https://admin.vacationrentalexpertz.com",
});

check("empty input → empty string", buildCoworkBulkCheckoutPrompt([]) === "");
check(
  // Same rule the find batch follows: a one-item batch must behave exactly
  // like the per-row button, so the batch frame can never quietly change a
  // single checkout's contract.
  "one reservation → byte-identical to the per-row checkout prompt",
  buildCoworkBulkCheckoutPrompt([checkoutInput(0)]) === buildCoworkCheckoutPrompt(checkoutInput(0)),
);

const batch = buildCoworkBulkCheckoutPrompt([checkoutInput(0), checkoutInput(1)]);
const count = (re: RegExp) => (batch.match(re) ?? []).length;

check("batch title counts the reservations", batch.includes("# Task: Bulk checkout preparation — 2 reservations"));
check("briefs stay in order", batch.indexOf("RESERVATION 1 of 2") < batch.indexOf("RESERVATION 2 of 2"));
check("bot-check protocol hoisted EXACTLY once", count(/## Bot-check protocol/g) === 1);
check("browser rule hoisted EXACTLY once", count(/## Browser rule/g) === 1);

// The three guards that make a batch acceptable at all. Without them, pressing
// the per-row checkout button N times is the safer product.
check(
  // buy_in_checkout_claims is keyed by reservationId, so reservation 1 sitting
  // at awaiting_payment does NOT block a claim on reservation 2. Only a
  // batch-wide machine check can catch that — prose alone would not.
  "GUARD 1: batch-wide single handoff is machine-checked across the batch's own reservation ids",
  /ONE OUTSTANDING HANDOFF ACROSS THE WHOLE BATCH/.test(batch)
    && batch.includes("/api/operations/buy-in-slot-status")
    && /BEFORE the claim step for ANY unit/.test(batch)
    && /Never keep two\s+unsubmitted payment tabs open, even for different reservations/.test(batch),
);
check(
  // The last reservation may be prepared an hour after launch, and the
  // find-on-VRBO flow re-points costPaid on an existing buy-in.
  "GUARD 2: costPaid must be compared for EQUALITY, not merely present",
  /PRICE FRESHNESS/.test(batch) && /must EQUAL the approved cost/.test(batch),
);
check(
  // The locked handoff sentence names no booking. Across ~16 handoffs that is
  // how a card goes against the wrong reservation.
  "GUARD 3: every handoff is identified by reservation, guest, unit and total",
  /NAME EVERY HANDOFF/.test(batch)
    && /Immediately BEFORE the exact handoff sentence/.test(batch)
    && /inside the spoken alert and the notification/.test(batch),
);
check(
  "a stranded awaiting_payment unit STOPS the batch and is reported with its buyInId",
  /THE ONE EXCEPTION/.test(batch)
    && /the batch STOPS there/.test(batch)
    && /"buyInId" and its reservation id/.test(batch),
);

// Money rules that must never be reworded by the batch frame.
check(
  "the exact operator handoff sentence survives verbatim, once per reservation",
  count(/\*\*Finished buy-in — please add credit card and click checkout\. No purchase has been submitted\.\*\*/g) === 2,
);
check(
  "the batch never books and never enters card details",
  /NEVER enter card details/.test(batch) && /NEVER click the final Book\/Confirm\/Pay/.test(batch),
);
check(
  "cross-reservation contamination is forbidden",
  /NEVER carry a value from one\s+reservation's brief into another's API calls/.test(batch),
);
check("done signal fires once for the whole batch", count(/all 2 reservations have durable checkout outcomes recorded/g) === 1);

check(
  // The two caps bound opposite things: find is unattended, checkout needs the
  // operator present for every unit. Raising the find cap must not drag the
  // checkout cap up with it.
  "the checkout cap is independent of the find cap",
  COWORK_BULK_CHECKOUT_MAX === 8 && COWORK_BULK_FIND_MAX === 12,
  { checkout: COWORK_BULK_CHECKOUT_MAX, find: COWORK_BULK_FIND_MAX },
);

// The find batch still ends at attach — the whole point of the split.
{
  const findInput = (i: number): CoworkBuyInPromptInput => ({
    reservationId: `6a1234567890abcdef0123${i}`,
    guestName: "Jacelyn Tsu",
    propertyId: 3,
    propertyName: "Menehune Shores - 4BR Condos",
    community: "Menehune Shores",
    checkIn: "2026-07-21",
    checkOut: "2026-07-26",
    units: [{ unitId: "unit-a", unitLabel: "Unit A (2BR)", bedrooms: 2 }],
    baseUrl: "https://admin.vacationrentalexpertz.com",
  });
  const findBatch = buildCoworkBulkBuyInPrompt([findInput(0), findInput(1)]);
  check(
    "the find batch is unattended: every brief ends at ATTACH and nothing books",
    (findBatch.match(/This task ends at ATTACH/g) ?? []).length === 2
      && /Do NOT book anything for ANY reservation/.test(findBatch),
  );
  check(
    "the find batch never asks for a card",
    !/add credit card/i.test(findBatch) && !/awaiting_payment/.test(findBatch),
  );
}

// ── Dispatch memory ─────────────────────────────────────────────────────────
console.log("cowork-bulk-split: dispatch memory");

const rec = (over: Partial<CoworkDispatchRecord> = {}): CoworkDispatchRecord => ({
  reservationId: "res-1",
  kind: "bulk-find",
  dispatchedAtMs: 1_000_000,
  unitIds: ["unit-a", "unit-b"],
  ...over,
});

check("round-trips through storage", parseCoworkDispatches(serializeCoworkDispatches([rec()])).length === 1);
check("corrupt storage degrades to no memory instead of throwing", parseCoworkDispatches("{not json").length === 0);
check("garbage records are dropped", parseCoworkDispatches(JSON.stringify([{ nope: 1 }, rec()])).length === 1);

check(
  "a later reservation in the batch gets a longer window than the first",
  coworkDispatchTtlMs("bulk-find", 7) > coworkDispatchTtlMs("bulk-find", 0),
);
check(
  "the human-paced checkout batch gets a longer window than the machine-paced find batch",
  coworkDispatchTtlMs("bulk-prepare-checkout", 0) > coworkDispatchTtlMs("bulk-find", 0),
);
check(
  "the find window still covers the LAST reservation of a full-size batch",
  coworkDispatchTtlMs("bulk-find", COWORK_BULK_FIND_MAX - 1) >= 120 * MIN,
  { ttlMin: coworkDispatchTtlMs("bulk-find", COWORK_BULK_FIND_MAX - 1) / MIN },
);

const describe = (r: { id: string; open: string[] }) => ({ reservationId: r.id, unitIds: r.open });
const candidate = (id: string, open: string[]) => ({ id, open });

check(
  "a reservation with no record is ready",
  partitionCoworkDispatchCandidates([candidate("res-9", ["unit-a"])], "bulk-find", [], 1_000_000, describe).ready.length === 1,
);
check(
  "a reservation whose open slots are all covered is suppressed",
  partitionCoworkDispatchCandidates(
    [candidate("res-1", ["unit-a"])], "bulk-find", [rec()], 1_000_000 + MIN, describe,
  ).suppressed.length === 1,
);
check(
  // THE case that makes the unit-set rule primary: the operator detaches a bad
  // unit after dispatch. That slot was never handed to Cowork, so suppressing
  // it would silently skip the booking — end state, a guest with no unit.
  "a NEWLY-OPENED slot re-admits the reservation immediately, with no waiting",
  partitionCoworkDispatchCandidates(
    [candidate("res-1", ["unit-a", "unit-c"])], "bulk-find", [rec()], 1_000_000 + MIN, describe,
  ).ready.length === 1,
);
check(
  "an expired record stops suppressing",
  partitionCoworkDispatchCandidates(
    [candidate("res-1", ["unit-a"])], "bulk-find", [rec()], 1_000_000 + 999 * MIN, describe,
  ).ready.length === 1,
);
check(
  "the two kinds do not suppress each other",
  partitionCoworkDispatchCandidates(
    [candidate("res-1", [])], "bulk-prepare-checkout", [rec({ kind: "bulk-find" })], 1_000_000 + MIN, describe,
  ).ready.length === 1,
);
check(
  "an empty recorded unit set covers the whole reservation (checkout batches)",
  partitionCoworkDispatchCandidates(
    [candidate("res-1", [])], "bulk-prepare-checkout",
    [rec({ kind: "bulk-prepare-checkout", unitIds: [] })], 1_000_000 + MIN, describe,
  ).suppressed.length === 1,
);

check(
  "recording replaces a prior record for the same reservation+kind",
  recordCoworkDispatches([rec()], [{ reservationId: "res-1", unitIds: ["unit-z"] }], "bulk-find", 2_000_000)
    .filter((r) => r.reservationId === "res-1" && r.kind === "bulk-find").length === 1,
);
check(
  "clearing is the operator's one-click escape hatch",
  clearCoworkDispatches([rec()], ["res-1"], "bulk-find").length === 0,
);
check(
  // Deleting it would RE-ADMIT the reservation, and a wrong re-admit costs more
  // than a wrong suppression.
  "a future-dated record is clamped to now, never dropped",
  pruneCoworkDispatches([rec({ dispatchedAtMs: 5_000_000 })], 1_000_000).length === 1,
);
check(
  "eviction never drops a live record while an expired one survives",
  (() => {
    const now = 10_000_000;
    const live = Array.from({ length: COWORK_DISPATCH_MAX_RECORDS + 5 }, (_, i) => rec({
      reservationId: `live-${i}`, dispatchedAtMs: now - MIN, ttlMs: COWORK_DISPATCH_TTL["bulk-find"].maxMs,
    }));
    const expired = rec({ reservationId: "expired", dispatchedAtMs: now - 999 * MIN });
    const kept = pruneCoworkDispatches([expired, ...live], now);
    return kept.length === COWORK_DISPATCH_MAX_RECORDS && !kept.some((r) => r.reservationId === "expired");
  })(),
);

check(
  // "3 just sent" is true at minute 2 and a lie at minute 80, and the operator
  // reads this line long after dispatching. Floor, not round: 90 min is "1h".
  "the suppression line reports ELAPSED time, floored",
  describeCoworkSuppression(3, 1_000_000, 1_000_000 + 90 * MIN).includes("1h ago")
    && describeCoworkSuppression(3, 1_000_000, 1_000_000 + 5 * MIN).includes("5 min ago"),
);
check(
  // M5: all the app can know is that it FIRED the deep link. Firing it does
  // not start the task — the operator still has to press send in Claude
  // Desktop — so the line must not assert Cowork is working, and must name
  // the didn't-press-send case, which is otherwise an invisible dead end.
  "the suppression line says SENT (never 'running') and names the didn't-press-send escape",
  (() => {
    const line = describeCoworkSuppression(2, 1_000_000, 1_000_000 + 5 * MIN);
    return /sent to Cowork/.test(line)
      && /Didn't press send in Claude Desktop\? Use "Send anyway"/.test(line)
      && !/already with Cowork/.test(line)
      && !/running/i.test(line);
  })(),
);
check("no suppression → no line", describeCoworkSuppression(0, 1_000_000, 1_000_000) === "");

// ── Wiring ──────────────────────────────────────────────────────────────────
{
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bookingsSrc = fs.readFileSync(path.join(here, "../client/src/pages/bookings.tsx"), "utf8");
  const claimsSrc = fs.readFileSync(path.join(here, "../server/buy-in-checkout-claims.ts"), "utf8");

  check(
    // Bulk FIND went headless 2026-07-20: its ready set is now the live-run
    // filter (bulkFindReady), not dispatch memory. Checkout keeps the memory.
    "both bulk buttons bind their COUNT to the ready set, not the raw selection",
    bookingsSrc.includes("bulkFindReady.length")
      && bookingsSrc.includes("checkoutDispatchSplit.ready.length")
      && !bookingsSrc.includes("(${selectedBulkCoworkReservations.length})"),
  );
  check(
    // M1 held its ground through the headless split: the CHECKOUT hold line is
    // always visible with its own count + escape, and the FIND hold (now a
    // LIVE-run fact, not TTL memory) renders its own separate line — no
    // override button on purpose; a stuck run is cancelled from its row panel.
    "suppression renders per KIND, each with its own count (checkout keeps the escape)",
    bookingsSrc.includes("text-cowork-dispatch-suppressed-${kind}")
      && bookingsSrc.includes("button-cowork-dispatch-resend-${kind}")
      && bookingsSrc.includes('data-testid="text-bulk-find-live-runs"')
      && /\["bulk-prepare-checkout", checkoutDispatchSplit\.suppressed/.test(bookingsSrc),
  );
  check(
    // M2's hazard is now structural: bulk find no longer writes dispatch
    // memory at all (the run store is the gate), so no fallback-TTL shortcut
    // can exist — and a card sitting's window must NEVER be shortened.
    "no shortened fallback window anywhere — find has no dispatch memory, a card sitting keeps its full window",
    !bookingsSrc.includes('ttlOverrideMs: COWORK_DISPATCH_TTL["bulk-find"].baseMs')
      && !bookingsSrc.includes('ttlOverrideMs: COWORK_DISPATCH_TTL["bulk-prepare-checkout"].baseMs'),
  );
  check(
    // M3: the launchers write AFTER awaiting a relay POST of up to ~143KB; the
    // storage listener can land inside that window, so a value captured at
    // render would erase the other tab's records. (>= 2 since bulk find went
    // headless: the checkout recorder + the suppression-row clear.)
    "dispatch memory is written through an UPDATER, never a captured value",
    bookingsSrc.includes("(update: (prev: CoworkDispatchRecord[]) => CoworkDispatchRecord[]) => {")
      && (bookingsSrc.match(/persistCoworkDispatches\(\(prev\)/g) ?? []).length >= 2
      && !/persistCoworkDispatches\(recordCoworkDispatches\(\s*coworkDispatches/.test(bookingsSrc),
  );
  check(
    // M4: after a bulk launch the button is DISABLED, so the generic "click the
    // button again" recovery dead-ends on exactly the path it exists for.
    // (1 = bulk checkout; bulk find no longer launches Cowork.)
    "the bulk toast's recovery instruction points at 'Send anyway', not the disabled button",
    (bookingsSrc.match(/coworkLaunchToastCopy\(result, label, "bulk"\)/g) ?? []).length === 1,
    (bookingsSrc.match(/coworkLaunchToastCopy\(result, label, "bulk"\)/g) ?? []).length,
  );
  check(
    // M6: measuring against the post-suppression set reported held-back
    // bookings as "a checkout is already queued" — false, and it points the
    // operator at the wrong remedy.
    "held-back bookings get their own honest note, not the active-checkout reason",
    bookingsSrc.includes("selectedWithOpenSlots.length - selectedBulkCoworkReservations.length")
      && bookingsSrc.includes("const heldBack = selectedBulkCoworkReservations.length - withOpenSlots.length"),
  );
  check(
    // A reservation a live FIND run is still working must not also be handed to
    // a checkout run: that is two Cowork tasks on one booking, one attaching
    // units while the other prices them for payment.
    "a live find run also blocks the card sitting for that reservation",
    bookingsSrc.includes("CROSS-KIND") && bookingsSrc.includes("findHeld"),
  );
  check(
    "both bulk button counts respect their cap, so the label can't promise more than it sends",
    bookingsSrc.includes("Math.min(bulkFindReady.length, CLAUDE_FIND_RUN_BULK_MAX)")
      && bookingsSrc.includes("Math.min(checkoutDispatchSplit.ready.length, COWORK_BULK_CHECKOUT_MAX)"),
  );
  check(
    // localStorage is shared across tabs but read once at mount; without this a
    // second open tab keeps a stale copy and double-dispatches.
    "a second tab is kept in sync via the storage event",
    bookingsSrc.includes('window.addEventListener("storage", onStorage)')
      && bookingsSrc.includes('window.removeEventListener("storage", onStorage)'),
  );
  check(
    "the batch checkout button exists and is separate from the find button",
    bookingsSrc.includes('data-testid="button-run-bulk-cowork-checkout"')
      && bookingsSrc.includes('data-testid="button-run-bulk-cowork"'),
  );
  check(
    // Otherwise a unit stranded at awaiting_payment is a dead end: the row's
    // checkout button hides while a checkout is active, and a plain reset
    // refuses. One bulk sitting spanning many units makes this likely.
    "a stranded awaiting_payment unit has an in-app escape, opt-in and confirm-gated",
    claimsSrc.includes("allowAwaitingPayment")
      && bookingsSrc.includes('data-testid={`button-reset-stranded-checkout-')
      && bookingsSrc.includes("allowAwaitingPayment: stranded")
      && /did NOT complete the payment/.test(bookingsSrc),
  );
  check(
    "resetting a stranded unit stays opt-in server-side (never the default)",
    claimsSrc.includes("opts?.allowAwaitingPayment === true"),
  );
  {
    const promptSrc = fs.readFileSync(path.join(here, "../shared/cowork-buyin-prompt.ts"), "utf8");
    check(
      // The reset endpoint is reachable by anything carrying the operator's
      // portal session — which the agent's own Chrome does. Releasing a unit
      // that is waiting for a card is the operator's decision alone.
      "every checkout brief FORBIDS the agent from resetting a checkout claim",
      /NEVER\s+call the checkout-claim reset endpoint/.test(promptSrc),
    );
    check(
      // A reset unit is the one most likely to have actually been paid for.
      "a reset unit is re-checked against My Trips before it can be re-prepared",
      /"bookingError" mentions a checkout reset/.test(promptSrc)
        && /My Trips/.test(promptSrc),
    );
  }
}

console.log(`\ncowork-bulk-split: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
