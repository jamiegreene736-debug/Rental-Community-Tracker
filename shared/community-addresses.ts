export type CommunityAddressRule = {
  names: string[];
  street: string;
  city: string;
  state: string;
};

export const COMMUNITY_ADDRESS_RULES: CommunityAddressRule[] = [
  { names: ["Regency at Poipu Kai", "Poipu Kai", "Kahala at Poipu Kai", "Poipu Sands"], street: "1831 Poipu Rd", city: "Koloa", state: "HI" },
  { names: ["Pili Mai", "Pili Mai at Poipu"], street: "2611 Kiahuna Plantation Dr", city: "Koloa", state: "HI" },
  { names: ["Mauna Kai Princeville", "Mauna Kai"], street: "3920 Wyllie Rd", city: "Princeville", state: "HI" },
  { names: ["Kaha Lani Resort", "Kaha Lani"], street: "4460 Nehe Rd", city: "Lihue", state: "HI" },
  { names: ["Makahuena at Poipu", "Makahuena"], street: "1661 Pe'e Rd", city: "Koloa", state: "HI" },
  { names: ["Kaiulani of Princeville", "Ka'iulani of Princeville", "Kaiulani"], street: "4100 Queen Emma's Dr", city: "Princeville", state: "HI" },
  { names: ["Kekaha Beachfront Estate"], street: "8497 Kekaha Rd", city: "Kekaha", state: "HI" },
  { names: ["Keauhou Estates"], street: "78-6855 Ali'i Dr", city: "Kailua-Kona", state: "HI" },
  { names: ["Caribe Cove Resort", "Caribe Cove"], street: "9000 Treasure Trove Ln", city: "Kissimmee", state: "FL" },
  { names: ["Windsor Hills", "Windsor Hills Resort"], street: "2600 N Old Lake Wilson Rd", city: "Kissimmee", state: "FL" },
  { names: ["Pink Shell Beach Resort", "Pink Shell Beach Resort and Marina", "Pink Shell Resort", "Pink Shell"], street: "275 Estero Blvd", city: "Fort Myers Beach", state: "FL" },
  // Additional Poipu/Koloa addresses for new combo seeds (enables geo-bbox unit search in /api/community/search-units and refresh-pricing)
  { names: ["Poipu Kapili"], street: "2221 Kapili Rd", city: "Koloa", state: "HI" },
  { names: ["Poipu Shores"], street: "1775 Pe'e Rd", city: "Koloa", state: "HI" },
  { names: ["Manualoha at Poipu Kai"], street: "2371 Ho'ohu Road", city: "Koloa", state: "HI" },
];

export function normalizeCommunityAddressToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(hawaii|hi|florida|fl|united states|usa|us)\b/g, " ")
    .replace(/\b(road)\b/g, "rd")
    .replace(/\b(drive)\b/g, "dr")
    .replace(/\b(lane)\b/g, "ln")
    .replace(/\b(street)\b/g, "st")
    .replace(/\b(avenue)\b/g, "ave")
    .replace(/\b(boulevard)\b/g, "blvd")
    .replace(/\b(apartment|apt|unit|suite|ste|building|bldg|#)\s*[a-z0-9-]+\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stateAbbrev(value: string): string {
  const s = value.trim().toLowerCase();
  if (s === "hawaii") return "HI";
  if (s === "florida") return "FL";
  return value.trim().toUpperCase();
}

export function communityAddressRuleForName(name: string | null | undefined): CommunityAddressRule | null {
  const n = normalizeCommunityAddressToken(String(name ?? ""));
  if (!n) return null;
  return COMMUNITY_ADDRESS_RULES.find((rule) =>
    rule.names.some((candidate) => {
      const c = normalizeCommunityAddressToken(candidate);
      return n === c || n.includes(c) || c.includes(n);
    }),
  ) ?? null;
}

export function streetRootFromAddress(value: string | null | undefined): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  return raw.split(",")[0]
    .replace(/\b(?:apartment|apt|unit|suite|ste|building|bldg|#)\s*[a-z0-9-]+\b/gi, "")
    .replace(/\b(Blvd|Boulevard|Rd|Road|St|Street|Ave|Avenue|Dr|Drive|Ln|Lane|Way|Cir|Circle|Ct|Court|Pkwy|Parkway|Pl|Place|Trl|Trail)\s+[A-Za-z]?\d{1,5}[A-Za-z]?\b$/i, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function isLikelyStreetAddress(value: string | null | undefined): boolean {
  const street = streetRootFromAddress(value);
  return /\b\d{1,6}\s+[A-Za-z0-9' .-]+(?:Rd|Road|Dr|Drive|St|Street|Ave|Avenue|Ln|Lane|Blvd|Boulevard|Way|Cir|Circle|Ct|Court|Pl|Place|Trl|Trail|Pkwy|Parkway)\b/i.test(street);
}

export function inferCommunityStreetAddress(input: {
  communityName?: string | null;
  city?: string | null;
  state?: string | null;
  unitAddresses?: Array<string | null | undefined>;
}): string {
  const rule = communityAddressRuleForName(input.communityName);
  if (rule) return rule.street;

  const addresses = (input.unitAddresses ?? []).map(streetRootFromAddress).filter(Boolean);
  if (addresses.length > 0) {
    const first = normalizeCommunityAddressToken(addresses[0]);
    const allSame = addresses.every((addr) => normalizeCommunityAddressToken(addr) === first);
    if (allSame && isLikelyStreetAddress(addresses[0])) return addresses[0];
  }

  return "";
}

export function validateCommunityStreetAddress(input: {
  communityName?: string | null;
  city?: string | null;
  state?: string | null;
  streetAddress?: string | null;
}): { ok: true; streetAddress: string; warning?: string } | { ok: false; error: string; expectedStreet?: string } {
  const street = streetRootFromAddress(input.streetAddress);
  if (!isLikelyStreetAddress(street)) {
    return { ok: false, error: "A real street address is required before saving or pushing a listing." };
  }

  const rule = communityAddressRuleForName(input.communityName);
  if (!rule) return { ok: true, streetAddress: street };

  const sameStreet = normalizeCommunityAddressToken(street) === normalizeCommunityAddressToken(rule.street);
  const sameCity = !input.city || normalizeCommunityAddressToken(input.city) === normalizeCommunityAddressToken(rule.city);
  const sameState = !input.state || stateAbbrev(input.state) === rule.state;
  if (!sameStreet || !sameCity || !sameState) {
    return {
      ok: false,
      error: `${input.communityName} should use ${rule.street}, ${rule.city}, ${rule.state}.`,
      expectedStreet: rule.street,
    };
  }

  return { ok: true, streetAddress: rule.street };
}
