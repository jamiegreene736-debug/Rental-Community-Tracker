import { evaluateComboProfit, comboProfitAcceptable, profitToleranceUsd } from "../shared/buy-in-profit";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`, extra ?? ""); }
};

console.log("buy-in-profit: profitability gate");

// tolerance = max($50, 2% * revenue)
check("tolerance: floor $50 on small revenue", profitToleranceUsd(600) === 50);
check("tolerance: 2% on large revenue", profitToleranceUsd(9000) === 180);
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
// small stay: $50 floor governs
{
  const ok = evaluateComboProfit({ expectedRevenue: 600, existingCost: 0, comboCost: 645 });   // -45, tol 50
  const no = evaluateComboProfit({ expectedRevenue: 600, existingCost: 0, comboCost: 660 });   // -60, tol 50
  check("small stay: -$45 acceptable, -$60 rejected (floor $50)", ok.acceptable && !no.acceptable, [ok, no]);
}
// big stay: 2% governs
{
  const v = evaluateComboProfit({ expectedRevenue: 9000, existingCost: 0, comboCost: 9100 });  // -100, tol 180
  check("big stay: -$100 acceptable (tol $180)", v.acceptable && v.profit === -100, v);
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
