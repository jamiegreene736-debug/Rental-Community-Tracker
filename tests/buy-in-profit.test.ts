import { evaluateComboProfit, comboProfitAcceptable, profitToleranceUsd } from "../shared/buy-in-profit";

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

console.log(`\nbuy-in-profit: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
