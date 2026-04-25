// Map each scannable photo folder to the unit-number tokens the photo-
// listing scanner should verify Lens hits against. Built from the unit
// data in `client/src/data/unit-builder-data.ts` — when adding a
// property or renumbering a unit, update both files together.
//
// Why this exists: the scanner used to extract a unit hint directly
// from the folder name (`kaha-lani-109` → "109"). That works fine for
// folders whose names track the unit identity, but the portfolio has
// folders whose names have drifted out of sync — older unit numbers
// frozen into the path, placeholders like `pili-mai-unit-a`, and
// folders shared across multiple units (one set of photos used by
// three different unit claims). When the folder hint doesn't match
// the unit a listing actually represents, the scanner produces noise
// the dashboard had to either show as a misleading red badge or hide
// behind a grey "no signal" state. This map carries the actual unit
// tokens to verify against, regardless of what the folder is named.
//
// One folder can map to multiple tokens — verification accepts a Lens
// hit if the listing mentions ANY of them. Single-letter unit IDs
// ("A", "B") and other tokens without a digit are excluded because
// they false-positive on stray characters in Google snippets.
export const FOLDER_UNIT_TOKENS: Record<string, string[]> = {
  // prop 1 — Regency at Poipu Kai (folder hints match unit numbers)
  "unit-924": ["924"],
  // shared: prop1:unit-114(114), prop9:unit-611(611), prop27:unit-A
  // ("A" dropped — too noisy)
  "unit-114": ["114", "611"],
  // shared: prop1:unit-911(911), prop27:unit-B ("B" dropped — too
  // noisy)
  "unit-911": ["911"],
  // prop 4 — folder hints match
  "unit-423": ["423"],
  "unit-621": ["621"],
  // prop 9 — folder named for an older unit 721; current claim is 723
  "unit-721": ["723"],
  // prop 19 — units 9 and 11 share one folder
  "mauna-kai-6a": ["9", "11"],
  // prop 20 — units 7B and 8 share one folder
  "mauna-kai-t3": ["7B", "8"],
  // prop 23 — Kaha Lani; folders named for older unit identifiers,
  // current claims are 339 and 221
  "kaha-lani-109": ["339"],
  "kaha-lani-123": ["221"],
  // prop 24 — Makahuena at Poipu; unit-builder uses sample placeholder
  // unit numbers (3301, 2205) per PR #91 since the original Lae Nani
  // identifiers were swapped out
  "lae-nani-335": ["3301", "2205"],
  // prop 29 — "Unit 5" and "Units 6-7" both stored against one folder
  "kaiulani-52": ["5", "6", "7"],
  // props 32 + 33 — Pili Mai unit numbers are "Building N", and the
  // folders are placeholder names without a digit. Pull the building
  // numbers as verification tokens.
  "pili-mai-unit-a": ["38", "10"],
  "pili-mai-unit-b": ["2", "26"],
};

// Pull plausible unit-number tokens from a unit-number string. Used
// to derive verification targets when the FOLDER_UNIT_TOKENS map has
// no entry for a folder — the scanner falls back to extracting from
// the folder name itself. Drops bare single letters ("A"/"B") since
// they false-positive on snippet text.
//
// "Unit 5"        → ["5"]
// "Units 6-7"     → ["6", "7"]
// "Building 38"   → ["38"]
// "7B"            → ["7B"]
// "A"             → []
export function extractUnitTokens(unitNumber: string): string[] {
  const matches = unitNumber.match(/[a-z]?\d+[a-z]?/gi) || [];
  return matches.filter((m) => /\d/.test(m));
}

// Returns the unit-number tokens to verify against for a folder.
// `null` means there's no entry — the scanner should fall back to
// extracting a hint from the folder name itself (the legacy path)
// before deciding the folder is unscannable.
export function tokensForFolder(folder: string): string[] | null {
  return FOLDER_UNIT_TOKENS[folder] ?? null;
}
