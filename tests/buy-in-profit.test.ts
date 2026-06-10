import { evaluateComboProfit, comboProfitAcceptable, profitToleranceUsd, minAcceptableProfit } from "../shared/buy-in-profit";
import { baseRateForTargetMargin, computeChannelMarkups, CHANNEL_HOST_FEE, type ChannelKey } from "../shared/pricing-rates";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

console.log("buy-in-profit: profitability gate");

// HARD max-loss limit of $100 (flat — same cap for every stay size).
check("tolerance: flat $100 on small revenue", profitToleranceUsd(600) === 100);
check("tolerance: flat $100 on large revenue (NOT 2% = $180)", profitToleranceUsd(9000) === 100);
check("tolerance: 0 when revenue unknown", profitToleranceUsd(0) === 0 && profitToleranceUsd(-5) === 0);

// clearly profitable
{
  const v = evaluateComboProfit({ expectedRevenue: 5000, existingCost: 0, comboCost: 3000 });
  check("profitable: $2000 profit acceptable", v.acceptable && v.profit === 2000 && v.gateEnabled, v);
}
// roughly break-even (small loss within tolerance) — accept
{
  const v = evaluateComboProfit({ expectedRevenue: 5000, existingCost: 0, comboCost: 5040 }); // -40, tol=100
  check("break-even: -$40 on $5000 (tol $100) acceptable", v.acceptable && v.profit === -40, v);
}
// real loss beyond tolerance — reject
{
  const v = evaluateComboProfit({ expectedRevenue: 5000, existingCost: 0, comboCost: 5200 }); // -200, tol=100
  check("loss: -$200 on $5000 (tol $100) REJECTED", !v.acceptable && v.profit === -200, v);
}
// existing attached cost is subtracted (sibling slot already filled)
{
  const v = evaluateComboProfit({ expectedRevenue: 5000, existingCost: 2000, comboCost: 2900 });
  check("existingCost subtracted: 5000-2000-2900=+100 acceptable", v.acceptable && v.profit === 100, v);
}
{
  const v = evaluateComboProfit({ expectedRevenue: 5000, existingCost: 2000, comboCost: 3200 }); // -200, tol=100
  check("existingCost subtracted: -$200 REJECTED", !v.acceptable && v.profit === -200, v);
}
// HARD $100 limit, flat across stay sizes:
// small stay can lose up to $100 too (no $50 floor anymore)
{
  const ok = evaluateComboProfit({ expectedRevenue: 600, existingCost: 0, comboCost: 695 });   // -95, within $100
  const no = evaluateComboProfit({ expectedRevenue: 600, existingCost: 0, comboCost: 720 });   // -120, beyond $100
  check("small stay: -$95 acceptable, -$120 rejected (flat $100 limit)", ok.acceptable && !no.acceptable, [ok, no]);
}
// big stay capped at $100 (NOT 2% = $180): -$100 matches, -$101 does not.
{
  const at = evaluateComboProfit({ expectedRevenue: 9000, existingCost: 0, comboCost: 9100 });   // -100, exactly the limit
  const beyond = evaluateComboProfit({ expectedRevenue: 9000, existingCost: 0, comboCost: 9101 }); // -101, $1 past the limit
  check("big stay: -$100 matches, -$101 rejected (flat $100 cap, NOT 2% = $180)",
    at.acceptable && at.profit === -100 && !beyond.acceptable && beyond.profit === -101, [at, beyond]);
}
// the operator's case: a $9,919 booking that would lose >$100 is rejected
{
  const at = evaluateComboProfit({ expectedRevenue: 9919, existingCost: 0, comboCost: 10019 });   // -100 → match
  const beyond = evaluateComboProfit({ expectedRevenue: 9919, existingCost: 0, comboCost: 10119 }); // -200 → reject
  check("$9,919 stay: -$100 matches, -$200 rejected", at.acceptable && !beyond.acceptable, [at, beyond]);
}
// DEGRADE SAFE: revenue unknown -> gate off -> always acceptable
{
  const v = evaluateComboProfit({ expectedRevenue: 0, existingCost: 0, comboCost: 9999 });
  check("revenue 0: gate disabled, attach anyway", !v.gateEnabled && v.acceptable, v);
}

// comboProfitAcceptable (expansion's pre-netted form)
{
  const ok = comboProfitAcceptable({ revenueAvailable: 3000, comboCost: 2900, minProfit: -100, gateEnabled: true });
  const no = comboProfitAcceptable({ revenueAvailable: 3000, comboCost: 3150, minProfit: -100, gateEnabled: true });
  const off = comboProfitAcceptable({ revenueAvailable: 0, comboCost: 9999, minProfit: -100, gateEnabled: false });
  check("comboProfitAcceptable: +100 ok, -150 rejected, gate-off ok",
    ok.acceptable && !no.acceptable && off.acceptable, [ok, no, off]);
}

// ── OPT-IN positive margin floor (default off → unchanged) ──────────────────
// Default (marginFloorPct 0/undefined) is byte-identical to the $100 loss cap.
check("floor off: minAcceptableProfit == -tolerance", minAcceptableProfit(5000) === -100);
check("floor off: minAcceptableProfit(0.2 rev) unchanged when floor 0", minAcceptableProfit(5000, 100, 0, 0) === -100);
// Floor on: a combo must CLEAR marginFloorPct × revenue in profit.
check("floor 20%: minAcceptableProfit(5000) == 1000", minAcceptableProfit(5000, 100, 0, 0.2) === 1000);
{
  const ok = evaluateComboProfit({ expectedRevenue: 5000, existingCost: 0, comboCost: 4000, marginFloorPct: 0.2 }); // +1000
  const no = evaluateComboProfit({ expectedRevenue: 5000, existingCost: 0, comboCost: 4001, marginFloorPct: 0.2 }); // +999
  check("floor 20%: +$1000 ok, +$999 rejected", ok.acceptable && ok.minProfit === 1000 && !no.acceptable, [ok, no]);
}
{
  // Floor TIGHTENS vs the loss cap: a -$40 stay that the default cap ACCEPTS is
  // rejected under a 20% floor.
  const def = evaluateComboProfit({ expectedRevenue: 5000, existingCost: 0, comboCost: 5040 });               // -40, accepted (cap)
  const flr = evaluateComboProfit({ expectedRevenue: 5000, existingCost: 0, comboCost: 5040, marginFloorPct: 0.2 }); // -40 < 1000, rejected
  check("floor 20% tightens: -$40 accepted by cap, rejected by floor", def.acceptable && !flr.acceptable, [def, flr]);
}
{
  // DEGRADE SAFE: unknown revenue disables the gate even with a floor set.
  const v = evaluateComboProfit({ expectedRevenue: 0, existingCost: 0, comboCost: 9999, marginFloorPct: 0.2 });
  check("floor + revenue 0: gate disabled, attach anyway", !v.gateEnabled && v.acceptable, v);
}

// ── Sell price actually nets the target margin AFTER channel fees ───────────
// The base rate grosses up the direct fee; with Guesty's per-channel markups
// on top, EVERY channel nets >= (1+margin)*cost. This is the property that the
// old fee-blind (1+margin)*cost base FAILED (it netted ~1.4% on Airbnb, a loss
// on Booking.com).
{
  const margin = 0.2;
  const markups = computeChannelMarkups();
  let allNet = true;
  let detail = "";
  for (const cost of [300, 827, 1654, 5000]) {
    const base = baseRateForTargetMargin(cost, margin); // direct/base calendar rate
    const targetNet = (1 + margin) * cost;
    for (const ch of ["direct", "airbnb", "vrbo", "booking"] as ChannelKey[]) {
      const guestPrice = ch === "direct" ? base : base * (1 + markups[ch]);
      const net = guestPrice * (1 - CHANNEL_HOST_FEE[ch]);
      if (net < targetNet - 0.5) { allNet = false; detail += ` ${ch}@${cost}: net=${net.toFixed(0)}<${targetNet.toFixed(0)}`; }
    }
  }
  check("base+Guesty-markups net >= 20% on cost on EVERY channel", allNet, detail);
}
{
  // The OLD fee-blind base would have FAILED Booking.com (sanity: prove the new
  // base differs from the naive form by the direct-fee gross-up).
  const naive = Math.ceil(1.2 * 1000);                 // 1200 (old)
  const corrected = baseRateForTargetMargin(1000, 0.2); // ceil(1200/0.97) = 1238
  check("base rate grosses up the direct fee (1200 -> 1238)", naive === 1200 && corrected === 1238, { naive, corrected });
}

console.log(`\nbuy-in-profit: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
