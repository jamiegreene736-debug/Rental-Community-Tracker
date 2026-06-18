/**
 * Canonical community photo folder registry.
 * Single source of truth for folder slugs, authoritative scrape URLs,
 * and operator-verified amenity image URLs used by the refresh script.
 */

export type CommunityPhotoFolderConfig = {
  folder: string;
  /** Primary display name (matches COMMUNITY_FOLDER_TO_NAME values). */
  displayName: string;
  /** Alternate community names that resolve to this folder (combo drafts, wizard titles). */
  aliases: string[];
  address: string;
  /** Authoritative listing / resort page for scrape-first photo search. */
  sourceUrl: string;
  fallbackSourceUrl?: string;
  /** Curated on-property amenity photos (pools, exteriors, grounds — not unit interiors). */
  curatedImageUrls: string[];
};

const CASTLE_KAHA_LANI = "https://www.castleresorts.com/images/KHL/gallery";
const PARRISH = "https://www.parrishkauai.com/wp-content/uploads";

export const COMMUNITY_PHOTO_FOLDER_CONFIGS: CommunityPhotoFolderConfig[] = [
  {
    folder: "community-regency-poipu-kai",
    displayName: "Regency at Poipu Kai",
    aliases: ["Poipu Kai", "Regency Poipu Kai"],
    address: "1831 Poipu Rd",
    sourceUrl: "https://www.parrishkauai.com/kauai-condos/regency-at-poipu-kai/",
    fallbackSourceUrl:
      "https://www.zillow.com/homedetails/1831-Poipu-Rd-APT-823-Koloa-HI-96756/80152954_zpid/",
    curatedImageUrls: [
      `${PARRISH}/2025/11/Regency-at-Poipu-Kai-Resort-1-Parrish-Kauai.jpg`,
      `${PARRISH}/2025/11/Regency-at-Poipu-Kai-Resort-2-Parrish-Kauai.jpg`,
      `${PARRISH}/2025/11/Regency-at-Poipu-Kai-Resort-3-Parrish-Kauai.jpg`,
      `${PARRISH}/2025/11/Regency-at-Poipu-Kai-Resort-4-Parrish-Kauai.jpg`,
      `${PARRISH}/2025/11/Regency-at-Poipu-Kai-Resort-5-Parrish-Kauai.jpg`,
      `${PARRISH}/2025/11/Regency-at-Poipu-Kai-Resort-6-Parrish-Kauai.jpg`,
    ],
  },
  {
    folder: "community-mauna-kai",
    displayName: "Mauna Kai Princeville",
    aliases: ["Mauna Kai"],
    address: "3920 Wyllie Rd",
    sourceUrl: "https://www.hawaiigaga.com/kauai/condos/mauna-kai.aspx",
    fallbackSourceUrl: "https://maunakai.org/",
    curatedImageUrls: [
      "https://img1.wsimg.com/isteam/ip/323bc062-034e-4a33-b14b-bd4bf31d505c/03751f93.f10.jpg",
      "https://media.vrbo.com/lodging/45000000/44320000/44314400/44314390/w1925h1280x4y0-d87b490c.jpg?impolicy=ccrop&w=1925&h=1280&q=medium",
      "https://media.vrbo.com/lodging/27000000/26780000/26776100/26776083/d3b9aff7.jpg?impolicy=ccrop&w=1200&h=800&q=medium",
      "https://media.vrbo.com/lodging/68000000/67280000/67274000/67273937/c512ec09.jpg?impolicy=ccrop&w=1200&h=800&q=medium",
      "https://media.vrbo.com/lodging/77000000/76180000/76178800/76178728/374948ef.jpg?impolicy=ccrop&w=1200&h=800&q=medium",
      "https://media.vrbo.com/lodging/84000000/83050000/83040700/83040607/034179a2.jpg?impolicy=ccrop&w=1200&h=800&q=medium",
    ],
  },
  {
    folder: "community-kaha-lani",
    displayName: "Kaha Lani Resort",
    aliases: ["Kaha Lani", "Castle Kaha Lani"],
    address: "4460 Nehe Rd",
    sourceUrl: "https://www.castleresorts.com/kauai/kaha-lani-resort/",
    curatedImageUrls: [
      `${CASTLE_KAHA_LANI}/Kaha-Lani-Resort-940x470-01-Pool-Aerial.jpg`,
      `${CASTLE_KAHA_LANI}/Kaha-Lani-Resort-940x470-02-Oasis.jpg`,
      `${CASTLE_KAHA_LANI}/Kaha-Lani-Resort-940x470-05-House-Exterior.jpg`,
      `${CASTLE_KAHA_LANI}/Kaha-Lani-Resort-940x470-06-Exterior-Palm-Tree.jpg`,
      `${CASTLE_KAHA_LANI}/Kaha-Lani-Resort-940x470-08-Ground.jpg`,
      `${CASTLE_KAHA_LANI}/Kaha-Lani-Resort-940x470-10-Grounds.jpg`,
    ],
  },
  {
    folder: "community-makahuena",
    displayName: "Makahuena at Poipu",
    aliases: ["Makahuena"],
    address: "1661 Pe'e Rd",
    sourceUrl: "https://www.parrishkauai.com/kauai-condos/makahuena-at-poipu/",
    fallbackSourceUrl: "https://www.hawaiigaga.com/Images/attractions/makahuena-b1.jpg",
    curatedImageUrls: [
      "https://www.hawaiigaga.com/Images/attractions/makahuena-b1.jpg",
      `${PARRISH}/2022/08/Makahuena-at-Poipu-1106-Swimming-Pool-Lounging-Deck-Coastline-Views-Parrish-Kauai.jpg`,
      `${PARRISH}/2017/05/Oceanfront-Makahuena-Resort-Features-Dreamy-Poipu-Views.jpg`,
      `${PARRISH}/2025/11/Makahuena-at-Poipu-1-Parrish-Kauai.jpg`,
      `${PARRISH}/2025/11/Makahuena-at-Poipu-3-Parrish-Kauai.jpg`,
      `${PARRISH}/2025/11/Makahuena-at-Poipu-5-Parrish-Kauai.jpg`,
    ],
  },
  {
    folder: "community-kaiulani",
    displayName: "Kaiulani of Princeville",
    aliases: ["Kaiulani", "Ka'iulani of Princeville"],
    address: "4100 Queen Emma's Dr",
    sourceUrl:
      "https://www.hawaiiliving.com/kauai/north-shore-kauai/kaiulani-of-princeville-condos-for-sale/",
    fallbackSourceUrl: "https://www.parrishkauai.com/94128/kaiulani-of-princeville-has-new-ocean-view-townhome/",
    curatedImageUrls: [
      "https://www.hawaiiliving.com/assets/properties/2025/09/06/409685/image_723808_0.jpg",
      "https://www.hawaiiliving.com/assets/properties/2025/10/09/411747/image_724356_3.jpg",
      "https://www.hawaiiliving.com/assets/properties/2025/12/03/417205/image_726116_0.jpg",
      "https://www.hawaiiliving.com/assets/properties/2026/01/05/418570/image_726760_0.jpg",
      "https://www.hawaiiliving.com/assets/properties/2026/04/17/424724/image_729748_0.jpg",
      `${PARRISH}/2018/05/Kaiulani-12-Lani-View-Parrish-Kauai.jpg`,
    ],
  },
  {
    folder: "community-pili-mai",
    displayName: "Pili Mai",
    aliases: ["Pili Mai at Poipu", "Pili Mai Resort"],
    address: "2611 Kiahuna Plantation Dr",
    sourceUrl: "https://www.kauaicalls.com/poipus-hidden-gem/",
    fallbackSourceUrl: "https://www.parrishkauai.com/kauai-condos/pili-mai/",
    curatedImageUrls: [
      "https://www.kauaicalls.com/wp-content/uploads/2024/03/pili-mai-resort.jpg",
      "https://www.kauaicalls.com/wp-content/uploads/2018/06/Pili-Mai-Kiahuna-1-04.jpg",
      `${PARRISH}/2025/11/Pili-Mai-Resort-at-Poipu-1-Parrish-Kauai.jpg`,
      `${PARRISH}/2025/11/Pili-Mai-Resort-at-Poipu-2-Parrish-Kauai.jpg`,
      `${PARRISH}/2025/11/Pili-Mai-Resort-at-Poipu-3-Parrish-Kauai.jpg`,
      `${PARRISH}/2025/11/Pili-Mai-Resort-at-Poipu-5-Parrish-Kauai.jpg`,
    ],
  },
];

/** Extra communities referenced in unit-builder-data but not on the dashboard refresh list. */
const LEGACY_COMMUNITY_ENTRIES: Array<{
  folder: string;
  displayName: string;
  address: string;
  sourceUrl?: string;
  fallbackSourceUrl?: string;
}> = [
  { folder: "community-kekaha-estate", displayName: "Kekaha Beachfront Estate", address: "8497 Kekaha Rd" },
  { folder: "community-keauhou-estates", displayName: "Keauhou Estates", address: "78-6855 Ali'i Dr" },
  { folder: "community-lae-nani", displayName: "Lae Nani Resort", address: "410 Papaloa Rd", sourceUrl: "https://www.hawaiigaga.com/lae-nani-rentals.aspx" },
  { folder: "community-poipu-beachside", displayName: "Poipu Brenneckes Beachside", address: "2298 Ho'one Rd" },
  { folder: "community-poipu-oceanfront", displayName: "Poipu Brenneckes Oceanfront", address: "2350 Ho'one Rd" },
  { folder: "community-coconut-plantation-at-ko-olina", displayName: "Coconut Plantation at Ko Olina", address: "92-1070 Olani St", sourceUrl: "https://koolinarealty.com/coconut-plantation/" },
  { folder: "community-ko-olina-beach-villas", displayName: "Ko Olina Beach Villas", address: "92-102 Waialii Pl", sourceUrl: "https://www.olaproperties.com/ko-olina-beach-villas/" },
  { folder: "community-kiahuna", displayName: "Kiahuna Plantation", address: "2253 Poipu Rd" },
  { folder: "community-menehune-shores", displayName: "Menehune Shores", address: "760 S Kihei Rd" },
];

function normalizeCommunityKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[''`]/g, "")
    .replace(/\b(?:resort|at|the)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Maps communityPhotoFolder slug → display name (all known community-* folders). */
export const COMMUNITY_FOLDER_TO_NAME: Record<string, string> = {
  ...Object.fromEntries(COMMUNITY_PHOTO_FOLDER_CONFIGS.map((c) => [c.folder, c.displayName])),
  ...Object.fromEntries(LEGACY_COMMUNITY_ENTRIES.map((e) => [e.folder, e.displayName])),
};

/** Maps communityPhotoFolder slug → street address fragment. */
export const COMMUNITY_FOLDER_TO_ADDRESS: Record<string, string> = {
  ...Object.fromEntries(COMMUNITY_PHOTO_FOLDER_CONFIGS.map((c) => [c.folder, c.address])),
  ...Object.fromEntries(LEGACY_COMMUNITY_ENTRIES.map((e) => [e.folder, e.address])),
};

/** Authoritative scrape URLs keyed by display community name. */
export const COMMUNITY_SOURCE_URLS: Record<string, { primary: string; fallback?: string }> = {
  ...Object.fromEntries(
    COMMUNITY_PHOTO_FOLDER_CONFIGS.map((c) => [
      c.displayName,
      { primary: c.sourceUrl, ...(c.fallbackSourceUrl ? { fallback: c.fallbackSourceUrl } : {}) },
    ]),
  ),
  "Regency at Poipu Kai": {
    primary: "https://www.parrishkauai.com/kauai-condos/regency-at-poipu-kai/",
    fallback: "https://www.zillow.com/homedetails/1831-Poipu-Rd-APT-823-Koloa-HI-96756/80152954_zpid/",
  },
  "Paniolo Hale": {
    primary: "https://www.zillow.com/b/paniolo-hale-maunaloa-hi-9NxCHL/",
  },
  "Ko Olina Beach Villas": {
    primary: "https://www.olaproperties.com/ko-olina-beach-villas/",
  },
  ...Object.fromEntries(
    LEGACY_COMMUNITY_ENTRIES
      .filter((e) => e.sourceUrl)
      .map((e) => [
        e.displayName,
        { primary: e.sourceUrl!, ...(e.fallbackSourceUrl ? { fallback: e.fallbackSourceUrl } : {}) },
      ]),
  ),
};

const ALIAS_TO_FOLDER = new Map<string, string>();
for (const config of COMMUNITY_PHOTO_FOLDER_CONFIGS) {
  const keys = [config.displayName, ...config.aliases];
  for (const name of keys) {
    ALIAS_TO_FOLDER.set(normalizeCommunityKey(name), config.folder);
  }
}

/** Resolve a draft/wizard community name to a shared `community-*` folder when known. */
export function resolveCanonicalCommunityPhotoFolder(communityName: string | null | undefined): string | null {
  const key = normalizeCommunityKey(String(communityName ?? ""));
  if (!key) return null;
  return ALIAS_TO_FOLDER.get(key) ?? null;
}

export function getCommunityPhotoFolderConfig(folder: string): CommunityPhotoFolderConfig | undefined {
  return COMMUNITY_PHOTO_FOLDER_CONFIGS.find((c) => c.folder === folder);
}

/** Dashboard communities (non-Guesty static properties) targeted by the refresh script. */
export const DASHBOARD_COMMUNITY_PHOTO_FOLDERS = COMMUNITY_PHOTO_FOLDER_CONFIGS.map((c) => c.folder);