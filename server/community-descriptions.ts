// Curated, web-researched, fact-checked guest-facing COMMUNITY descriptions.
//
// These power the community blurb on the guest alternatives page
// (/alternatives/:token, rendered in server/routes.ts under "Community
// Preview"). The runtime AI drafter (draftAlternativeCommunityDescription) is
// deliberately forbidden from naming amenities it can't confirm (it would
// hallucinate pools/beaches/golf), so for every community we actually operate
// in, we keep an accurate, amenity-rich description here instead. Each entry was
// researched against the resort/HOA site + established managers + reputable
// travel directories, then adversarially fact-checked: only amenities and
// setting facts confirmed across credible sources are stated. Conservative-but-
// accurate beats impressive-but-wrong — a guest must never be told a community
// has an amenity it lacks.
//
// To add a community: add an entry with its canonical name + match aliases
// (include short forms and the relevant BUY_IN_MARKETS area key so the resolver
// matches both the unit-derived label and the configured area) and a 3-5
// sentence plain-text blurb. No prices, owners, booking platforms, unit/building
// numbers, or addresses — same guest-copy safety stack as the rest of the page.

export interface CuratedCommunityDescription {
  /** Canonical display name (for reference only; matching uses `aliases`). */
  name: string;
  /**
   * Normalized-on-match name variants the resolver tests against a query.
   * Include the full resort name, common short forms (e.g. "Kaha Lani" as well
   * as "Kaha Lani Resort"), and any BUY_IN_MARKETS area key that should map
   * here. Keep aliases specific enough that they only match this community.
   */
  aliases: string[];
  /** Researched, fact-checked, guest-facing blurb. Plain text. */
  description: string;
}

const norm = (value: unknown): string =>
  String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const CURATED_COMMUNITY_DESCRIPTIONS: CuratedCommunityDescription[] = [
  // ── Kauai · South shore (Poipu / Koloa) ──────────────────────────────────
  {
    name: "Regency at Poipu Kai",
    aliases: ["Regency at Poipu Kai", "Regency Poipu Kai", "Regency at Poipu"],
    description:
      "Regency at Poipu Kai is a low-key condo and villa enclave set within the larger Poipu Kai Resort on Kauai's sunny south shore, surrounded by well-kept tropical grounds. The community has two swimming pools and two hot tubs of its own, along with shared barbecue areas, and guests also enjoy the wider resort's grounds. It sits a short walk from Brennecke's Beach, Poipu Beach Park, and Shipwreck Beach, with shopping and dining close by. The overall feel is relaxed and residential, making it a comfortable, spacious base for families who want room to spread out without resort crowds.",
  },
  {
    name: "Poipu Kai Resort",
    aliases: ["Poipu Kai Resort", "Poipu Kai"],
    description:
      "Poipu Kai Resort is an expansive master-planned community on Kauai's south shore, made up of several distinct condo and villa neighborhoods spread across beautifully maintained, park-like grounds. It stretches between two of the island's most beloved beaches, with Poipu Beach Park to the west and Shipwreck Beach to the east, and paved walking paths link the neighborhoods to the coast and to nearby dining. Shared amenities include a swimming pool, a hot tub, a multi-court tennis facility, and barbecue areas at select locations. The setting is peaceful and walkable with a calm, residential atmosphere, while keeping the beaches, shops, and restaurants of Poipu within easy reach.",
  },
  {
    name: "Makahuena at Poipu",
    aliases: ["Makahuena at Poipu", "Makahuena"],
    description:
      "Makahuena at Poipu occupies a dramatic bluff-top setting at the southernmost point of Kauai, where the Poipu coastline meets the open Pacific and the ocean views are wide and unobstructed. The community offers a swimming pool with an ocean-facing sun deck, a hot tub, tennis courts, and shared barbecue grills. Coastal paths and sidewalks connect the property toward Shipwreck Beach, Poipu Beach, and the Grand Hyatt Kauai. With its perch above the water and quiet point-of-land location, it suits travelers who want big ocean scenery and easy access to the south shore's beaches and trails.",
  },
  {
    name: "Pili Mai at Poipu",
    aliases: ["Pili Mai at Poipu", "Pili Mai"],
    description:
      "Pili Mai at Poipu is one of Poipu's newer townhome and condo communities, set along the Kiahuna Golf Course amid plantation-style architecture and lush tropical landscaping. Its private recreation village centers on a large family swimming pool and a children's pool, with a poolside sun deck, a fitness center, a gathering pavilion, and covered dining areas with gas barbecue grills. The location is central and convenient, within walking distance of Poipu Shopping Village and a short drive from Poipu Beach Park. The result is a polished, family-friendly community that balances resort-style amenities with a quiet residential setting.",
  },
  {
    name: "Poipu Brenneckes",
    aliases: [
      "Poipu Brenneckes Oceanfront",
      "Poipu Brenneckes Beachside",
      "Poipu Brenneckes",
      "Brenneckes",
      "Poipu Oceanfront",
    ],
    description:
      "This stretch of Kauai's sunny south shore centers on Poipu Beach Park and neighboring Brennecke's Beach, two of the island's most popular and accessible coastal spots. Poipu Beach Park is known for gentle, swimmable water, good snorkeling, and Hawaiian green sea turtles that often bask along the sand, with a grassy picnic area that makes it a favorite for families. Just steps away, Brennecke's Beach draws bodyboarders and bodysurfers to its lively shorebreak. Together they offer an easygoing beachfront setting with restrooms, showers, and a short walk to the shops and restaurants of Poipu.",
  },

  // ── Kauai · North shore (Princeville) ────────────────────────────────────
  {
    name: "Mauna Kai Princeville",
    aliases: ["Mauna Kai Princeville", "Mauna Kai"],
    description:
      "Mauna Kai is a low-density townhome community tucked into the lush, tropical landscaping of Princeville on Kauai's north shore, made up of individually designed homes with a peaceful, residential feel. The grounds center on a large shared swimming pool with a covered cabana and a gas barbecue area, set among native plantings and mature greenery. It sits in a convenient central spot near the Makai Golf Course and within walking distance of the Princeville Shopping Center and its grocery store. A shaded, tree-lined trail leads down to Anini Beach, a calm, reef-protected stretch known for easy swimming and snorkeling, with Hanalei Bay just a short drive away.",
  },
  {
    name: "Kaiulani of Princeville",
    aliases: ["Kaiulani of Princeville", "Kaiulani"],
    description:
      "Kaiulani of Princeville is one of the area's newer luxury communities, a collection of well-designed two-story townhomes set across roughly seventeen lushly landscaped acres along the edge of Princeville's golf course. Its resort-style amenities are a highlight: three heated swimming pools, covered entertaining pavilions with barbecue grills, and a lava-rock spa. A scenic, lighted walking path winds through the grounds past tropical plantings and water features, giving the community a serene, secluded atmosphere. It stays close to Princeville's shops, dining, and grocery, with the north shore's celebrated beaches just minutes away.",
  },
  {
    name: "Princeville",
    aliases: ["Princeville"],
    description:
      "Princeville is a master-planned resort community set on the bluffs above Hanalei Bay on Kauai's dramatic north shore, surrounded by ocean panoramas, green mountains laced with waterfalls, and rolling golf-course greenery. The area is known for its championship golf and easy access to some of the island's most beautiful beaches, including Hideaways, Pu'u Poa, Anini, and the wide sandy crescent of Hanalei Bay nearby. At the entrance, the Princeville Shopping Center offers a grocery store, dining, and shops for daily needs. With its lush tropical setting and unhurried pace, Princeville makes a peaceful yet polished base for exploring Kauai's north shore.",
  },

  // ── Kauai · East side (Coconut Coast: Wailua / Kapaa / Lihue) ────────────
  {
    name: "Kaha Lani Resort",
    aliases: ["Kaha Lani Resort", "Kaha Lani"],
    description:
      "Kaha Lani Resort is an oceanfront condominium community set on a quiet stretch of white-sand shoreline along Kauai's laid-back East Shore, just outside Lihue and within easy reach of the Coconut Coast. The low-key, garden-style grounds open directly onto the beach, with a heated oceanfront swimming pool, a tennis court, barbecue grills, and a beachfront walking and bike path that traces the coast. Set beside the Wailua Municipal Golf Course, the resort has an unhurried, residential feel rather than a bustling hotel atmosphere. It makes a relaxed home base for exploring nearby Lydgate Beach Park, with its sheltered lava-rock swimming and snorkeling lagoons, and the Wailua River just up the road.",
  },
  {
    name: "Lae Nani Resort",
    aliases: ["Lae Nani Resort", "Lae Nani"],
    description:
      "Lae Nani Resort is a serene, low-rise oceanfront community on Kauai's Royal Coconut Coast, just south of Kapaa in Wailua, set among well-tended tropical gardens and towering coconut palms. The grounds front a sandy beach and include a sheltered swimming area formed by a natural stone breakwater, creating calm, protected water that families with children especially appreciate. Shared amenities include a large heated oceanfront pool, a lighted tennis court, and barbecue grills near the pool. The setting is both tranquil and convenient, with the shops and restaurants of Coconut Marketplace within walking distance and the Wailua River a short distance away.",
  },
  {
    name: "Kapaa Beachfront",
    aliases: ["Kapaa Beachfront", "Kapaa"],
    description:
      "This is Kauai's East Side, often called the Royal Coconut Coast for the historic groves of coconut palms that frame its golden beaches between Wailua and Kapaa. Kapaa is the island's largest town and the heart of the coast, where plantation-era buildings house local shops, galleries, farmers markets, and casual oceanfront dining, all within an easy stroll of the water. The area is centrally located for exploring the island, with the navigable Wailua River and its waterfalls nearby, the family-friendly lava-rock pools at Lydgate Beach Park, and a scenic coastal path for walking and biking. The vibe is relaxed and unpretentious, a real Hawaiian beach town that makes a convenient base for reaching both the north and south shores.",
  },

  // ── Kauai · West side ────────────────────────────────────────────────────
  {
    name: "Kekaha Beachfront Estate",
    aliases: ["Kekaha Beachfront Estate", "Kekaha Beachfront", "Kekaha"],
    description:
      "Set along Kauai's sunny west side, Kekaha sits at the start of the longest unbroken stretch of sand in the Hawaiian Islands, a roughly fifteen-mile sweep of beach running northwest toward Polihale. The setting is quieter and less developed than the island's resort coasts, with wide-open Pacific views, world-class sunsets, and the island of Niihau visible offshore on clear days. Because the shoreline faces the open ocean with no protecting reef, the surf can be powerful and is better suited to sunset walks and beachcombing than to swimming. Kekaha is also the natural gateway to the west side's marquee landscapes, with the dramatic overlooks of Waimea Canyon and the remote sands of Polihale both within reach.",
  },

  // ── Big Island · Kona ────────────────────────────────────────────────────
  {
    name: "Keauhou Estates",
    aliases: ["Keauhou Estates", "Keauhou", "Na Hale O Keauhou"],
    description:
      "Keauhou is a relaxed, history-rich enclave in southern Kailua-Kona, set along Alii Drive about six miles south of town for a quieter pace than the busier Kona core. The area is anchored by sheltered Keauhou Bay, a departure point for snorkel cruises and the famous after-dark manta ray viewing the Kona coast is known for. Just up the coast lies Kahaluu Beach Park, one of the most reliable and accessible snorkeling spots on the island, with calm, shallow water, abundant reef fish, and frequent green sea turtle sightings. Steeped in Hawaiian heritage, the district pairs easygoing seaside living with genuine cultural depth, a fitting base for travelers who want excellent water access and a slower side of Kona.",
  },

  // ── Maui · Kihei ─────────────────────────────────────────────────────────
  {
    name: "Menehune Shores",
    aliases: ["Menehune Shores"],
    description:
      "Menehune Shores is an oceanfront condominium community set on landscaped grounds along the shoreline of North Kihei, on Maui's sunny south side. The building enjoys sweeping Pacific views and shared amenities including a heated oceanfront pool, rooftop barbecue and sunning areas, and a shuffleboard court, with the calm beach just steps away. The community sits beside the historic Kalepolepo Fishpond, an ancient Hawaiian structure whose sheltered waters create a gentle, protected area popular with families. The location is a favorite for seasonal whale watching, with humpbacks often visible offshore between roughly December and April, offering a calm, well-positioned base in Kihei.",
  },

  // ── Oahu ─────────────────────────────────────────────────────────────────
  {
    name: "Ilikai",
    aliases: ["Ilikai Hotel", "Ilikai Marina", "Ilikai"],
    description:
      "The Ilikai is an iconic Waikiki landmark, a Y-shaped tower set at the western edge of Waikiki along the Ala Wai Yacht Harbor. The community sits in one of Honolulu's most convenient spots, with the boats of the marina just outside and Duke Kahanamoku Beach and Lagoon, the calm western end of Waikiki Beach, a short walk away. On the grounds, guests can enjoy two heated swimming pools and a sun deck, a fitness center, and a selection of restaurants and shops. Just beyond the building you are minutes from the open-air Ala Moana Center and the broad sands of Ala Moana Beach Park, while many suites take in sweeping views of the harbor, the Pacific, and the Honolulu skyline.",
  },
  {
    name: "Coconut Plantation at Ko Olina",
    aliases: ["Coconut Plantation at Ko Olina", "Coconut Plantation", "Ko Olina"],
    description:
      "Coconut Plantation is a gated community within the Ko Olina Resort on Oahu's sunny leeward coast, designed in the relaxed style of Hawaii's old plantation villages with breezy, island-inspired architecture set across landscaped grounds. The community offers shared swimming pools and spa hot tubs, including a family-friendly freeform pool with a sandy beach-style entry, along with poolside loungers, shade pavilions, and barbecue grills. Its great advantage is the Ko Olina setting: the resort's four protected man-made lagoons, with calm waters ideal for swimming and snorkeling, are a short stroll away, as are the Ko Olina Golf Club and the shops and restaurants of the marketplace. The overall vibe is peaceful and resort-like, a quiet retreat on the west side that keeps you close to the area's beaches and activities.",
  },

  // ── Florida ──────────────────────────────────────────────────────────────
  {
    name: "Windsor Hills Resort",
    aliases: ["Windsor Hills Resort", "Windsor Hills"],
    description:
      "Windsor Hills is a gated vacation-home resort in Kissimmee, just a few minutes' drive from the Walt Disney World theme parks, making it one of the closest resort communities to the parks. At its heart sits a large clubhouse anchored by a heated resort pool and a water park with waterslides and a splash pad for younger guests. The clubhouse also houses a fitness center, a games room, and a movie theater, while the grounds add sports courts and playgrounds for families. The community is registered-guest-only, with a gatehouse staffed around the clock, so the setting stays quiet and secure between days at the parks.",
  },
  {
    name: "Bonita National",
    aliases: ["Bonita National Golf and Country Club", "Bonita National"],
    description:
      "Bonita National is a gated golf and country club community in Bonita Springs, set between Estero and Naples amid nature preserves, lakes, and walking trails. The centerpiece is an eighteen-hole championship golf course, complemented by practice facilities and a clubhouse with dining. Beyond golf, the community offers a resort-style swimming pool with a cabana bar, a fitness center, and an extensive racquet program that includes tennis, pickleball, and bocce. With its controlled-access entry and well-tended grounds, it has the relaxed, polished feel of a Southwest Florida resort community.",
  },
  {
    name: "Santa Maria Resort",
    aliases: ["Santa Maria Resort", "Santa Maria Harbour", "Santa Maria"],
    description:
      "Santa Maria is a Gulf-front condominium community on Fort Myers Beach, set directly across from the white sand and the Gulf of Mexico along Estero Boulevard. The community is known for its oversized heated pool, among the largest on the island, along with a hot tub and plenty of poolside lounge seating. Outdoor dining areas with gas grills make for easy cookouts, and the canal-side setting includes boat slips, with a neighboring marina offering kayak, powerboat, and fishing-charter options. With a secured lobby and elevators, it pairs the convenience of a managed building with an unbeatable position near the beach.",
  },
  {
    name: "Southern Dunes",
    aliases: ["Southern Dunes Golf and Country Club", "Southern Dunes"],
    description:
      "Southern Dunes is a peaceful golf community in Haines City, in Central Florida, set along tree-lined streets bordering a lake and an eighteen-hole course known for its dramatic, rolling layout and notable elevation changes. The community is supported by a clubhouse, a driving range, a putting green, and an on-site restaurant. It also offers swimming pools, tennis courts, a fitness facility, and a children's play area, all behind a manned security gate. The location suits a Central Florida getaway, with the Orlando-area theme parks roughly a half-hour drive away.",
  },
];

// Pre-normalize aliases once so resolution is a cheap scan.
const NORMALIZED_INDEX: Array<{ description: string; aliases: string[] }> =
  CURATED_COMMUNITY_DESCRIPTIONS.map((entry) => ({
    description: entry.description.replace(/\s+/g, " ").trim(),
    aliases: entry.aliases.map(norm).filter((a) => a.length >= 4),
  }));

const matchCuratedDescription = (value: unknown): string | null => {
  const cand = norm(value);
  if (cand.length < 4) return null;
  let best: { description: string; score: number } | null = null;
  for (const entry of NORMALIZED_INDEX) {
    for (const alias of entry.aliases) {
      let score = 0;
      if (cand === alias) score = 1000 + alias.length;
      else if (cand.includes(alias)) score = 700 + alias.length; // query carries the alias (e.g. "Kaha Lani Resort 3BR")
      else if (alias.includes(cand) && cand.length >= 6) score = 300 + cand.length; // alias carries the shorter query
      if (score > (best?.score ?? 0)) best = { description: entry.description, score };
    }
  }
  return best?.description ?? null;
};

/**
 * Resolve a curated, fact-checked community description for the guest page.
 * Tries the specific community label first (unit-derived resort name), then the
 * broader area. Returns null when we have no researched entry for either — the
 * caller then falls back to the conservative AI/deterministic blurb.
 */
export function resolveCuratedCommunityDescription(
  community: unknown,
  area?: unknown,
): string | null {
  return matchCuratedDescription(community) ?? matchCuratedDescription(area);
}
