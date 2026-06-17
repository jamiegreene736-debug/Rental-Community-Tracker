// Pure logic for photo community check — no DB or vision dependencies (testable).

export const UNIT_INTERIOR_MIN = 5;
export const MATCH_THRESHOLD_RATIO = 0.8;

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
  const strongNo = photoVerdicts.filter((p) => p.match === "no" && isStrongContradiction(p.reason));
  if (strongNo.length > 0) {
    return {
      sameAsCommunity: "no",
      reason: strongNo[0].reason,
      confidence: 0.95,
    };
  }
  const threshold = Math.max(minInteriorPhotos, Math.ceil(n * MATCH_THRESHOLD_RATIO));
  if (yes >= threshold) {
    return {
      sameAsCommunity: "yes",
      reason: `${yes}/${n} interior photos match the community profile.`,
      confidence: Math.min(0.99, 0.7 + (yes / n) * 0.25),
    };
  }
  const weakNo = photoVerdicts.find((p) => p.match === "no");
  return {
    sameAsCommunity: "no",
    reason: weakNo?.reason
      || `Only ${yes}/${n} interior photos match — need at least ${threshold} matching to confirm.`,
    confidence: 0.85,
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
