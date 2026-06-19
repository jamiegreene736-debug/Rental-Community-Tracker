// Sub-community precision for photo verification.
//
// Kauai umbrella resorts (especially Poipu Kai) collapse to one dictionary key
// ("poipu kai") even though Regency, Villas at Poipu Kai, Kahala, etc. are
// distinct complexes with different amenity photos. Buy-in search already has
// Regency-specific guards; photo community check must use the same precision.

import { normalizeCommunityName } from "./photo-community-check-logic";

function norm(haystack: string): string {
  return normalizeCommunityName(haystack);
}

/** Sibling complexes that are NOT Regency at Poipu Kai (mirrors buy-in guards). */
export function mentionsKnownNonRegencyPoipuKaiComplex(haystack: string): string | null {
  const n = norm(haystack);
  const siblings: Array<{ re: RegExp; label: string }> = [
    { re: /\bvillas?\s+at\s+poipu\s+kai\b/, label: "Villas at Poipu Kai" },
    { re: /\bpoipu\s+kai\s+villas?\b/, label: "Villas at Poipu Kai" },
    { re: /\bthe\s+villas\s+at\s+poipu\s+kai\b/, label: "The Villas at Poipu Kai" },
    { re: /\bparrish\s+collection\b/, label: "The Villas at Poipu Kai (Parrish Collection)" },
    { re: /\baston\b/, label: "Aston at Poipu Kai" },
    { re: /\bmanualoha\b/, label: "Manualoha" },
    { re: /\b(kahala|makanui)\b/, label: "Kahala at Poipu Kai" },
    { re: /\bnihi\s+kai\b/, label: "Nihi Kai" },
    { re: /\bpoipu\s+sands\b/, label: "Poipu Sands" },
    { re: /\bpili\s+mai\b/, label: "Pili Mai" },
    { re: /\bkiahuna\b/, label: "Kiahuna Plantation" },
    { re: /\bmakahuena\b/, label: "Makahuena" },
    { re: /\bwaikomo\b/, label: "Waikomo" },
  ];
  for (const { re, label } of siblings) {
    if (re.test(n)) return label;
  }
  return null;
}

export function mentionsRegencyAtPoipuKai(haystack: string): boolean {
  const n = norm(haystack);
  return /\b1831\s+poipu\b/.test(n)
    || (/\bregency\b/.test(n) && /\b(poipu\s+kai|poipu|koloa|kauai)\b/.test(n));
}

export function expectedIsRegencyAtPoipuKai(expectedCommunity: string): boolean {
  const n = norm(expectedCommunity);
  return /\bregency\b/.test(n) && /\bpoipu\s+kai\b/.test(n);
}

export function expectedIsVillasAtPoipuKai(expectedCommunity: string): boolean {
  const n = norm(expectedCommunity);
  return /\bvillas?\b/.test(n) && /\bpoipu\s+kai\b/.test(n) && !/\bregency\b/.test(n);
}

/**
 * When the expected community is a specific Poipu Kai sub-complex, detect Lens
 * text that names a different sibling complex (dict-key matching alone misses this).
 */
export function communityPhotoSiblingConflict(
  haystack: string,
  expectedCommunity: string,
): { reason: string; identifiedCommunity: string } | null {
  const hay = haystack.trim();
  const expected = expectedCommunity.trim();
  if (!hay || !expected) return null;

  if (expectedIsRegencyAtPoipuKai(expected)) {
    const sibling = mentionsKnownNonRegencyPoipuKaiComplex(hay);
    if (sibling && !mentionsRegencyAtPoipuKai(hay)) {
      return {
        identifiedCommunity: sibling,
        reason: `Reverse image search identified "${sibling}" — a different complex within Poipu Kai, not ${expected}.`,
      };
    }
    return null;
  }

  if (expectedIsVillasAtPoipuKai(expected)) {
    if (mentionsRegencyAtPoipuKai(hay) && !mentionsKnownNonRegencyPoipuKaiComplex(hay)) {
      return {
        identifiedCommunity: "Regency at Poipu Kai",
        reason: `Reverse image search identified "Regency at Poipu Kai" — not ${expected}.`,
      };
    }
    const n = norm(hay);
    const otherSiblings: Array<{ re: RegExp; label: string }> = [
      { re: /\b(kahala|manualoha|makanui|nihi\s+kai|poipu\s+sands|pili\s+mai|kiahuna|makahuena|waikomo)\b/, label: "another Poipu Kai complex" },
    ];
    for (const { re, label } of otherSiblings) {
      if (re.test(n) && !/\bvillas?\s+at\s+poipu\s+kai\b/.test(n) && !/\bpoipu\s+kai\s+villas?\b/.test(n)) {
        return {
          identifiedCommunity: label,
          reason: `Reverse image search identified ${label} — not ${expected}.`,
        };
      }
    }
  }

  return null;
}
