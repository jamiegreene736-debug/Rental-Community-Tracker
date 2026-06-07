// Deterministic island/region resolver for a property address.
//
// Anchors the Guest Inbox AI drafter's local-area knowledge to the correct
// island/region so it never gives a Maui beach recommendation for a Kauai
// property (or a generic "Hawaii" answer). Used by both the auto-reply
// scheduler (server/auto-reply.ts get_local_property_facts) and the manual
// compose box (client buildPropertyContextForDraft) so both surfaces anchor
// identically.
//
// Keyword order matters: more-specific tokens (Kailua-KONA, Princeville) are
// checked before ambiguous ones (Kailua on Oahu). Returns null when the area
// can't be determined — callers fall back to the town/state already in the
// address, which is always safe.

export function resolveIslandRegion(address: string | null | undefined): string | null {
  const a = String(address ?? "").toLowerCase();
  if (!a) return null;

  // Big Island first — "Kailua-Kona"/"Kona" must win before Oahu's "Kailua".
  if (
    /\b(kailua[-\s]?kona|kona\b|keauhou|waikoloa|kamuela|puako|hawi|honoka['ʻ]?a|hilo|volcano|na['ʻ]?alehu|captain cook|holualoa|kealakekua|pahoa)\b/.test(a) ||
    /\bali['ʻ]?i\s+dr\b/.test(a)
  ) {
    return "the Big Island of Hawaii";
  }
  // Kauai
  if (/\b(koloa|po['ʻ]?ipu|poipu|princeville|lihue|lihu['ʻ]?e|kapa['ʻ]?a|kapaa|wailua|hanalei|kekaha|kalaheo|kilauea|anahola|lawai|kilohana|hanapepe)\b/.test(a)) {
    return "Kauai";
  }
  // Maui
  if (/\b(lahaina|kihei|wailea|ka['ʻ]?anapali|kapalua|napili|paia|makena|kahului|hana|wailuku|kula|haiku)\b/.test(a)) {
    return "Maui";
  }
  // Oahu (after Big Island so "Kailua-Kona" doesn't fall here)
  if (/\b(honolulu|waikiki|kapolei|ko['ʻ]?\s*olina|kailua\b|haleiwa|turtle bay|kaneohe|ewa beach|laie|mililani|aiea)\b/.test(a)) {
    return "Oahu";
  }
  if (/\bmoloka['ʻ]?i\b/.test(a)) return "Molokai";
  if (/\blana['ʻ]?i\b/.test(a)) return "Lanai";

  // Florida regions (vacation-rental markets the app operates in).
  if (/\b(kissimmee|davenport|orlando|champions\s*gate|clermont|reunion|celebration|haines city|four corners)\b/.test(a)) {
    return "the Kissimmee/Orlando area in Florida";
  }
  if (/\b(fort myers beach|estero|bonita springs|naples|fort myers)\b/.test(a)) {
    return "the Fort Myers Beach / Southwest Florida area";
  }
  if (/\b(destin|panama city beach|miramar beach|sandestin)\b/.test(a)) {
    return "the Florida Panhandle (Emerald Coast)";
  }

  // Generic fallbacks — better than nothing for anchoring tone.
  if (/\b(hi|hawaii|hawai['ʻ]?i)\b/.test(a)) return "Hawaii";
  if (/\b(fl|florida)\b/.test(a)) return "Florida";
  return null;
}
