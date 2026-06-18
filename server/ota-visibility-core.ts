import type { PropertyUnitBuilder } from "../client/src/data/unit-builder-data";

export const OTA_VISIBILITY_SCORE_THRESHOLD = 70;
export const OTA_VISIBILITY_SRP_PAGE_SIZE = 50;

export type OtaVisibilityCandidate = {
  url: string;
  title: string;
  bedrooms?: number | null;
  totalPrice?: number | null;
  nightlyPrice?: number | null;
  position: number;
  page: number;
  score: number;
  reason: string;
};

export type OtaVisibilitySidecarSnapshot = {
  candidateCount: number;
  workerOnline: boolean;
  reason: string;
};

function normalizeVisibilityText(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function visibilityTokens(value: unknown): string[] {
  const stop = new Set([
    "and", "the", "for", "with", "near", "at", "in", "on", "of", "by", "to",
    "unit", "units", "condo", "condos", "sleeps", "sleep", "guest", "guests",
    "bedroom", "bedrooms", "br", "bath", "baths",
  ]);
  return normalizeVisibilityText(value)
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !stop.has(token));
}

export function canonicalVisibilityUrl(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) return "";
  try {
    const parsed = new URL(raw.trim());
    return `${parsed.hostname.toLowerCase().replace(/^www\./, "")}${decodeURIComponent(parsed.pathname).replace(/\/+$/, "").toLowerCase()}`;
  } catch {
    return raw.trim().replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
  }
}

export function otaVisibilityPageForPosition(position: number, pageSize = OTA_VISIBILITY_SRP_PAGE_SIZE): number {
  if (!Number.isFinite(position) || position < 1) return 1;
  return Math.max(1, Math.ceil(position / pageSize));
}

export function scoreOtaVisibilityCandidate(input: {
  candidate: { url?: string; title?: string; snippet?: string };
  position: number;
  property: PropertyUnitBuilder;
  listingTitle: string | null;
  publicUrl: string | null;
}): OtaVisibilityCandidate {
  const candidateUrl = String(input.candidate.url ?? "");
  const candidateTitle = String(input.candidate.title ?? "Untitled result");
  const haystack = normalizeVisibilityText(`${candidateTitle} ${input.candidate.snippet ?? ""} ${candidateUrl}`);
  const publicKey = canonicalVisibilityUrl(input.publicUrl);
  const candidateKey = canonicalVisibilityUrl(candidateUrl);
  let score = 0;
  const reasons: string[] = [];

  if (publicKey && candidateKey && (candidateKey === publicKey || candidateKey.includes(publicKey) || publicKey.includes(candidateKey))) {
    score += 120;
    reasons.push("public URL match");
  }

  const titleSources = [
    input.property.bookingTitle,
    input.property.propertyName,
    input.listingTitle,
  ].filter(Boolean);
  for (const source of titleSources) {
    const tokens = visibilityTokens(source).slice(0, 8);
    if (tokens.length === 0) continue;
    const matched = tokens.filter((token) => haystack.includes(token)).length;
    const ratio = matched / tokens.length;
    if (ratio >= 0.8) {
      score += Math.round(60 * ratio);
      reasons.push(`${matched}/${tokens.length} title tokens`);
      break;
    }
    if (ratio >= 0.5) {
      score += Math.round(30 * ratio);
      reasons.push(`${matched}/${tokens.length} partial title tokens`);
    }
  }

  const communityTokens = visibilityTokens(input.property.complexName).slice(0, 5);
  const communityMatched = communityTokens.filter((token) => haystack.includes(token)).length;
  if (communityTokens.length && communityMatched === communityTokens.length) {
    score += 25;
    reasons.push("community match");
  }

  const totalBedrooms = input.property.units.reduce((sum, unit) => sum + unit.bedrooms, 0);
  if (totalBedrooms > 0 && new RegExp(`(?:^|[^0-9])${totalBedrooms}\\s*(?:br|bed)`, "i").test(haystack)) {
    score += 15;
    reasons.push(`${totalBedrooms}BR match`);
  }

  return {
    url: candidateUrl,
    title: candidateTitle,
    bedrooms: typeof (input.candidate as { bedrooms?: number }).bedrooms === "number"
      ? (input.candidate as { bedrooms: number }).bedrooms
      : null,
    totalPrice: typeof (input.candidate as { totalPrice?: number }).totalPrice === "number"
      ? (input.candidate as { totalPrice: number }).totalPrice
      : null,
    nightlyPrice: typeof (input.candidate as { nightlyPrice?: number }).nightlyPrice === "number"
      ? (input.candidate as { nightlyPrice: number }).nightlyPrice
      : null,
    position: input.position,
    page: otaVisibilityPageForPosition(input.position),
    score,
    reason: reasons.join(", ") || "weak match",
  };
}

export function otaVisibilitySidecarFailureMessage(sidecar: OtaVisibilitySidecarSnapshot | null): string | null {
  if (!sidecar) return "Sidecar search did not return a result.";
  const reason = String(sidecar.reason ?? "").trim();
  if (!sidecar.workerOnline) {
    return reason || "Local Chrome sidecar is offline. Start the sidecar worker on your Mac, then retry.";
  }
  if ((sidecar.candidateCount ?? 0) > 0) return null;
  if (/^worker returned \d+ result/i.test(reason)) return null;
  if (/served from successful sidecar result cache/i.test(reason)) return null;
  if (reason) return reason;
  return "Sidecar search completed with no result data.";
}

export function pickOtaVisibilityMatch(candidates: OtaVisibilityCandidate[]): {
  found: boolean;
  match: OtaVisibilityCandidate | null;
  bestCandidate: OtaVisibilityCandidate | null;
} {
  if (!candidates.length) {
    return { found: false, match: null, bestCandidate: null };
  }

  const byScore = candidates.slice().sort((a, b) => b.score - a.score || a.position - b.position);
  const bestCandidate = byScore[0] ?? null;
  const urlMatches = candidates
    .filter((candidate) => candidate.reason.includes("public URL match"))
    .sort((a, b) => a.position - b.position);
  if (urlMatches.length) {
    return { found: true, match: urlMatches[0], bestCandidate: urlMatches[0] };
  }

  if (bestCandidate && bestCandidate.score >= OTA_VISIBILITY_SCORE_THRESHOLD) {
    return { found: true, match: bestCandidate, bestCandidate };
  }

  return { found: false, match: null, bestCandidate };
}
