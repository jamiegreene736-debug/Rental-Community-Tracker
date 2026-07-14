// Deep links into a specific unit-builder tab, used by the guest inbox's
// Listing panel ("Photos" / "Descriptions" buttons) so the operator can jump
// from a guest question ("is there a pool?") straight to the property's
// photos or listing copy without hunting through the dashboard.
//
// Pure + browser-safe (no imports). Locked by tests/builder-deep-link.test.ts,
// which also drift-locks BUILDER_TAB_KEYS against the tab strip rendered in
// client/src/components/GuestyListingBuilder/index.tsx.

// Must stay in sync with GuestyListingBuilder's tab strip. The builder's
// activeTab state is typed off this tuple, so adding a tab there without
// updating this list is a compile error; the test suite additionally
// asserts set-equality with the strip's rendered key list.
export const BUILDER_TAB_KEYS = [
  "descriptions",
  "bedding",
  "amenities",
  "pricing",
  "photos",
  "availability",
  "otaVisibility",
] as const;

export type BuilderTabKey = (typeof BUILDER_TAB_KEYS)[number];

export function isBuilderTabKey(value: unknown): value is BuilderTabKey {
  return typeof value === "string" && (BUILDER_TAB_KEYS as readonly string[]).includes(value);
}

// The builder page route is /builder/:propertyId/:step (builder.tsx ignores
// :step); "step-1" mirrors builder-preflight.tsx's step1Url so deep links
// land on the same URL shape the Continue-to-Builder button produces.
export const BUILDER_STEP_SEGMENT = "step-1";

// ?tab=photos → "photos". Accepts a raw search string with or without the
// leading "?" (window.location.search passes through unchanged). Unknown or
// missing tab values return null so the builder keeps its own default.
export function builderTabFromSearch(search: string | null | undefined): BuilderTabKey | null {
  if (!search || typeof search !== "string") return null;
  let tab: string | null = null;
  try {
    tab = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("tab");
  } catch {
    return null;
  }
  return isBuilderTabKey(tab) ? tab : null;
}

// Builder URL for a property (positive core id or negative -draftId — the
// builder route supports both) opened on a specific tab.
export function builderTabUrl(propertyId: number, tab: BuilderTabKey): string | null {
  if (!Number.isFinite(propertyId) || !Number.isInteger(propertyId) || propertyId === 0) return null;
  return `/builder/${propertyId}/${BUILDER_STEP_SEGMENT}?tab=${tab}`;
}

// Resolve a Guesty listing id to its mapped operations property id via the
// guesty_property_map rows (GET /api/guesty-property-map response shape).
// Null-safe on every input so callers can pass query data that hasn't
// resolved yet; returns null when unmapped (callers hide the buttons).
export function propertyIdForGuestyListing(
  guestyListingId: string | null | undefined,
  mapRows: Array<{ propertyId: number; guestyListingId: string }> | null | undefined,
): number | null {
  if (!guestyListingId || !Array.isArray(mapRows)) return null;
  const row = mapRows.find((m) => m?.guestyListingId === guestyListingId);
  const id = row?.propertyId;
  return typeof id === "number" && Number.isFinite(id) && id !== 0 ? id : null;
}

// One-stop helper for the inbox: listing id + map rows + tab → URL or null.
export function builderTabLinkForGuestyListing(
  guestyListingId: string | null | undefined,
  mapRows: Array<{ propertyId: number; guestyListingId: string }> | null | undefined,
  tab: BuilderTabKey,
): string | null {
  const propertyId = propertyIdForGuestyListing(guestyListingId, mapRows);
  if (propertyId == null) return null;
  return builderTabUrl(propertyId, tab);
}
