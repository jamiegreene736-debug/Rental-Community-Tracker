// Pure logic for photo community check — no DB or vision dependencies (testable).

export const UNIT_INTERIOR_MIN = 5;

const INTERIOR_CATEGORIES = new Set([
  "Bedrooms", "Bathrooms", "Kitchen", "Living Areas", "Dining", "Outdoor & Lanai",
]);

const INTERIOR_KEYWORDS = [
  "bedroom", "bathroom", "bath", "kitchen", "living", "dining", "lanai", "balcony",
  "interior", "suite", "shower", "tub", "counter", "island",
];

export function normalizeCommunityName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function communityNamesMatch(a: string, b: string): boolean {
  const na = normalizeCommunityName(a);
  const nb = normalizeCommunityName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const aw = na.split(/\s+/).filter((w) => w.length > 2);
  const bw = nb.split(/\s+/).filter((w) => w.length > 2);
  if (aw.length === 0 || bw.length === 0) return false;
  const overlap = aw.filter((w) => bw.includes(w)).length;
  return overlap >= Math.min(2, Math.min(aw.length, bw.length));
}

export function isInteriorPhoto(caption?: string): boolean {
  if (!caption) return false;
  if (Array.from(INTERIOR_CATEGORIES).some((c) => caption.includes(c))) return true;
  const lower = caption.toLowerCase();
  return INTERIOR_KEYWORDS.some((k) => lower.includes(k));
}

export function pickInteriorPhotos<T extends { filename: string; caption?: string }>(
  ordered: T[],
  targetCount: number,
): { chosen: T[]; interiorCount: number } {
  const interior: T[] = [];
  const other: T[] = [];
  for (const f of ordered) {
    if (isInteriorPhoto(f.caption)) interior.push(f);
    else other.push(f);
  }
  const chosen: T[] = [];
  for (const f of interior) {
    if (chosen.length >= targetCount) break;
    chosen.push(f);
  }
  for (const f of other) {
    if (chosen.length >= targetCount) break;
    if (!chosen.includes(f)) chosen.push(f);
  }
  return { chosen, interiorCount: interior.length };
}

const STRONG_CONTRADICTION_RE =
  /different\s+(resort|community|property|building|complex)|wrong\s+community|not\s+the\s+same\s+(resort|community|place)|signage.*(different|another)|keycard|towel.*logo|incompatible\s+(climate|architecture|view)|alpine|desert|cityscape.*(ocean|beach)|high[\s-]?rise.*garden|tropical.*(mountain|snow)/i;

export function isStrongContradiction(reason: string): boolean {
  return STRONG_CONTRADICTION_RE.test(reason);
}

export function computeUnitVerdict(
  photoVerdicts: Array<{ match: "yes" | "no"; reason: string }>,
  minInteriorPhotos: number = UNIT_INTERIOR_MIN,
): { sameAsCommunity: "yes" | "no"; reason: string; confidence: number } {
  const n = photoVerdicts.length;
  if (n < minInteriorPhotos) {
    return {
      sameAsCommunity: "no",
      reason: `Only ${n} interior photo${n === 1 ? "" : "s"} checked — need ${minInteriorPhotos}+ to confirm same community.`,
      confidence: 0.9,
    };
  }
  const yes = photoVerdicts.filter((p) => p.match === "yes").length;
  const nos = photoVerdicts.filter((p) => p.match === "no");
  const strongNo = nos.filter((p) => isStrongContradiction(p.reason));
  if (strongNo.length > 0) {
    return {
      sameAsCommunity: "no",
      reason: strongNo[0].reason,
      confidence: 0.95,
    };
  }
  if (nos.length > 0) {
    return {
      sameAsCommunity: "no",
      reason: nos[0].reason || `${nos.length} interior photo(s) do not match the community profile.`,
      confidence: 0.9,
    };
  }
  return {
    sameAsCommunity: "yes",
    reason: `${yes}/${n} interior photos match the community profile (unanimous).`,
    confidence: Math.min(0.99, 0.75 + (yes / n) * 0.2),
  };
}

export type FlaggedPhoto = { id: string; caption?: string; reason: string };

export function computeCommunityCohesion(
  photoVerdicts: Array<{ id?: string; match: "yes" | "no"; reason: string }>,
): { allSameCommunity: boolean; outliers: FlaggedPhoto[] } {
  const outliers: FlaggedPhoto[] = [];
  for (const p of photoVerdicts) {
    if (p.match === "no") outliers.push({ id: p.id ?? "?", reason: p.reason });
  }
  return { allSameCommunity: outliers.length === 0, outliers };
}

// Community amenity / exterior shots often appear in unit galleries (Zillow/VRBO
// scrape). These are NOT "wrong unit" outliers — only mismatched interiors are.
const COMMUNITY_AMENITY_CATEGORIES = new Set([
  "Pool & Spa", "Beach Access", "Grounds & Landscaping", "Building Exterior",
  "Common Areas", "Dining", "Activities", "Views",
]);

const COMMUNITY_EXTERIOR_CAPTION_RE =
  /\b(pool|spa|beach|tennis|golf|resort|grounds|amenit|common area|lobby|exterior|oceanfront|hot tub|jacuzzi|bbq|grill|fitness|gym|path|garden|courtyard|entrance|walkway|shoreline|shore)\b/i;

const COMMUNITY_EXTERIOR_REASON_RE =
  /\b(community|resort|shared|common)\s+(amenity|photo|pool|exterior|grounds|area)|resort\s+pool|exterior\s+shot|outdoor\s+amenit|not\s+(a\s+)?different\s+unit|same\s+community|building\s+exterior|grounds\s+and\s+landscap/i;

export function isCommunityExteriorInUnitGallery(caption?: string, reason?: string): boolean {
  if (caption) {
    if (Array.from(COMMUNITY_AMENITY_CATEGORIES).some((c) => caption.includes(c))) return true;
    if (COMMUNITY_EXTERIOR_CAPTION_RE.test(caption)) return true;
    // Lanai/balcony shots showing resort grounds, pool, or ocean are normal in unit sets.
    if (/\b(lanai|balcony|patio|deck)\b/i.test(caption)) return true;
  }
  if (reason && COMMUNITY_EXTERIOR_REASON_RE.test(reason)) return true;
  return false;
}

export function filterUnitOutliers(outliers: FlaggedPhoto[]): FlaggedPhoto[] {
  return outliers.filter((o) => !isCommunityExteriorInUnitGallery(o.caption, o.reason));
}
