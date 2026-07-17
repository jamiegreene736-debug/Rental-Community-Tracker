import { createHash } from "node:crypto";

export type PricingAuditReceipt = {
  runId: string;
  propertyId: number;
  completedAt: string;
  engine: "searchapi-airbnb";
  rowFingerprint: string;
  bedroomRows: number;
  monthsSaved: number;
  searchAttemptMonths: number;
  liveCompMonths: number;
  extrapolatedMonths: number;
  staticFallbackMonths: number;
};

/**
 * Summarize the rows produced by one forced live pricing invocation. SearchAPI
 * attempts are counted separately from months with usable comps: a thin month
 * may legitimately use the existing static fallback after a real search, and
 * year two deliberately extrapolates year one's researched basis.
 */
export function buildPricingAuditReceipt(input: {
  propertyId: number;
  rows: any[];
  runId: string;
  completedAt?: string;
}): PricingAuditReceipt {
  const normalizedRows = [...input.rows]
    .map((row) => ({ bedrooms: Number(row?.bedrooms), monthlyRates: row?.monthlyRates ?? {} }))
    .sort((a, b) => a.bedrooms - b.bedrooms);
  let monthsSaved = 0;
  let searchAttemptMonths = 0;
  let liveCompMonths = 0;
  let extrapolatedMonths = 0;
  let staticFallbackMonths = 0;
  for (const row of normalizedRows) {
    for (const rate of Object.values(row.monthlyRates ?? {}) as any[]) {
      monthsSaved += 1;
      const notes = Array.isArray(rate?.hybrid?.notes) ? rate.hybrid.notes.join(" ") : "";
      const extrapolated = /Year-2 extrapolation/i.test(notes);
      if (!extrapolated && (rate?.evidence?.searchedAt || /SearchAPI/i.test(notes))) searchAttemptMonths += 1;
      if (Number(rate?.channelCount) > 0 || Number(rate?.sampleCount) > 0) liveCompMonths += 1;
      if (extrapolated) extrapolatedMonths += 1;
      if (/static seasonal buy-in|static buy-in table/i.test(notes)) staticFallbackMonths += 1;
    }
  }
  if (normalizedRows.length === 0 || monthsSaved === 0 || searchAttemptMonths === 0) {
    throw new Error("Strict pricing refresh returned no durable SearchAPI monthly research evidence");
  }
  const rowFingerprint = `sha256:${createHash("sha256")
    .update(JSON.stringify({ propertyId: input.propertyId, rows: normalizedRows }))
    .digest("hex")}`;
  return {
    runId: input.runId,
    propertyId: input.propertyId,
    completedAt: input.completedAt ?? new Date().toISOString(),
    engine: "searchapi-airbnb",
    rowFingerprint,
    bedroomRows: normalizedRows.length,
    monthsSaved,
    searchAttemptMonths,
    liveCompMonths,
    extrapolatedMonths,
    staticFallbackMonths,
  };
}
