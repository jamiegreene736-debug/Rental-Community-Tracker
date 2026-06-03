import { COMMUNITY_ADDRESS_RULES, communityAddressRuleForName } from "./community-addresses";
import { BUY_IN_MARKETS } from "./buy-in-market";

/** Airbnb/Google Maps titles that are single units, not whole resorts/communities. */
export function looksLikeIndividualListingTitle(title: string): boolean {
  const t = String(title ?? "").trim();
  if (!t || t.length < 10) return true;
  if (/^\d\s*\/\s*\d\b/.test(t)) return true;
  if (/^\d+\s*[-\s]*(?:br|bd|bed|bedroom)s?\b/i.test(t)) return true;
  if (/\b(?:one|two|three|1|2|3)[-\s]*bedroom\s+(?:apartment|condo|unit)\b/i.test(t) && /\b(?:view|unit|#|apt)\b/i.test(t)) {
    return true;
  }
  if (/\b(?:end unit|corner unit|garden view|ocean view|oceanview|pool\s*\/\s*gym|beach\s*front\s*resort)\b/i.test(t) && t.length > 42) {
    return true;
  }
  if ((t.match(/,/g) ?? []).length >= 2 && /\b(?:\bac\b|wifi|pool|gym|courts|bch|beach|sleeps)\b/i.test(t)) return true;
  if (/\bby\s+outrigger\b/i.test(t) && /\b(?:apartment|studio|room)\b/i.test(t)) return true;
  return false;
}

export function looksLikeHotelNotVacationRentalResort(hay: string): boolean {
  const n = String(hay ?? "").toLowerCase();
  if (!/\b(hotel|motel|hostel|inn|marriott|hilton|hyatt|sheraton|westin|four seasons|ritz)\b/.test(n)) {
    return false;
  }
  return !/\b(condo|condominium|vacation rental|villa resort|townhome|townhouse|resort condominium|apartment resort)\b/.test(n);
}

const RESORT_NAME_CANDIDATES: string[] = [
  ...Object.keys(BUY_IN_MARKETS),
  ...COMMUNITY_ADDRESS_RULES.flatMap((rule) => rule.names),
].sort((a, b) => b.length - a.length);

export function matchKnownResortName(text: string): string | null {
  const hay = String(text ?? "");
  if (!hay.trim()) return null;
  const rule = communityAddressRuleForName(hay);
  if (rule) return rule.names[0];
  const lower = hay.toLowerCase();
  for (const name of RESORT_NAME_CANDIDATES) {
    const token = name.toLowerCase();
    if (token.length < 4) continue;
    if (lower.includes(token)) return name;
  }
  return null;
}

/** Best-effort resort label from an OTA listing title (not the listing headline itself). */
export function extractResortNameFromListingTitle(title: string): string | null {
  const known = matchKnownResortName(title);
  if (known) return known;
  const cleaned = String(title ?? "")
    .replace(/^\d\s*\/\s*\d\s*/i, "")
    .replace(/\b\d+\s*br\b/gi, " ")
    .trim();
  const segment = cleaned.split(/\s*[-–·|]\s*/).map((s) => s.trim()).find((s) => s.length >= 8) ?? cleaned;
  const m = segment.match(
    /\b(kiahuna(?:\s+plantation)?|pili\s*mai|whalers?\s*cove|poipu\s+kai|regency(?:\s+at\s+poipu\s+kai)?|makahuena|kahala|nihi\s*kai|kapili|poipu\s+shores|kaha\s+lani|mauna\s+kai|honua\s+kai|kaanapali\s+alii)\b/i,
  );
  if (!m) return null;
  const raw = m[1].replace(/\s+/g, " ").trim();
  if (/^kiahuna\b/i.test(raw)) return "Kiahuna Plantation";
  if (/^pili\s*mai\b/i.test(raw)) return "Pili Mai";
  if (/^whalers?\s*cove\b/i.test(raw)) return "Whalers Cove";
  if (/^regency\b/i.test(raw)) return "Regency at Poipu Kai";
  if (/^poipu\s+kai\b/i.test(raw)) return "Poipu Kai";
  if (/^makahuena\b/i.test(raw)) return "Makahuena at Poipu";
  if (/^kaha\s+lani\b/i.test(raw)) return "Kaha Lani Resort";
  if (/^mauna\s+kai\b/i.test(raw)) return "Mauna Kai Princeville";
  return raw.split(" ").map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

export function inferResortCommunityLabel(
  samples: Array<{ title?: string | null }>,
  fallback: string,
): string {
  const fb = String(fallback ?? "").trim();
  if (fb && !looksLikeIndividualListingTitle(fb)) {
    const known = matchKnownResortName(fb);
    return known ?? fb;
  }
  const votes = new Map<string, number>();
  for (const sample of samples) {
    const title = String(sample?.title ?? "");
    const candidate = matchKnownResortName(title) ?? extractResortNameFromListingTitle(title);
    if (!candidate || looksLikeIndividualListingTitle(candidate)) continue;
    votes.set(candidate, (votes.get(candidate) ?? 0) + 1);
  }
  const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
  if (best) return best[0];
  if (fb) {
    const fromFallback = extractResortNameFromListingTitle(fb);
    if (fromFallback && !looksLikeIndividualListingTitle(fromFallback)) return fromFallback;
  }
  return fb;
}

export function mergeDiscoveredScoutRowsByResort<T extends { community: string; samples?: Array<{ title?: string }> }>(
  rows: T[],
): T[] {
  const byKey = new Map<string, T>();
  for (const row of rows) {
    const label = inferResortCommunityLabel(row.samples ?? [], row.community);
    const key = label.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!key || looksLikeIndividualListingTitle(label)) continue;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...row, community: label });
      continue;
    }
    const existingCount = Number((existing as { count?: number }).count ?? 0);
    const rowCount = Number((row as { count?: number }).count ?? 0);
    if (rowCount > existingCount) byKey.set(key, { ...row, community: label });
  }
  return Array.from(byKey.values());
}
