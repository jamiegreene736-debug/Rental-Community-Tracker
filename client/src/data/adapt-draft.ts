// Adapter from CommunityDraft (the AI-generated rich shape from the
// Add a New Community wizard) into the PropertyUnitBuilder shape that
// the rest of the builder/preflight code expects. Promoted drafts
// take this path because they don't (yet) live in the static
// `unit-builder-data.ts` array; this adapter lets the existing
// builder UI render against draft data without a code-side migration.
//
// `photoFiles` is an optional per-folder file list — when supplied,
// each unit's `photos` array is populated from disk so the builder's
// Photo tab shows the operator's scraped photos. When omitted, photos
// come up empty (Guesty connection / push flow handles them later).

import { SINGLE_LISTING_SAMPLE_DISCLOSURE, type PropertyUnitBuilder } from "@/data/unit-builder-data";
import { apiRequest } from "@/lib/queryClient";
import type { CommunityDraft } from "@shared/schema";
import { buildDraftPropertyPricing } from "@/data/draft-pricing";
import { buildDraftBeddingConfig } from "@/data/draft-bedding";
import { registerDraftBeddingDefaults, type PropertyBeddingConfig } from "@/data/bedding-config";
import { registerDraftPropertyPricing, type PropertyPricing } from "@/data/pricing-data";
import { resolveDraftUnitBedrooms } from "@shared/draft-unit-bedrooms";
import { resolveCanonicalCommunityPhotoFolder } from "@shared/community-photo-folders";
import { stripAreaSectionsFromDescription } from "@shared/description-copy";

// Sample license placeholders for promoted drafts live in
// shared/license-samples.ts (moved 2026-07-10) so the placeholder
// DETECTOR in shared/license-compliance.ts and the sample GENERATOR
// share one source of truth. Re-exported here so existing client
// imports (`@/data/adapt-draft`) keep working unchanged.
import { sampleLicensesForLocation } from "@shared/license-samples";
import { isPlaceholderLicenseValue } from "@shared/license-compliance";
export { sampleLicensesForLocation };
export type { LicenseSamples, LicenseSampleContext } from "@shared/license-samples";

// True when the saved value looks like an older XXXX-style placeholder
// or a "(sample — …)" / "(verify …)" annotated string from a previous
// revision of this file. Real license numbers don't contain runs of
// X's or those parenthetical hints, so this is a safe heuristic to
// distinguish stale samples from operator-typed values.
//
// Drafts saved before the fully-formed sample values landed have the
// older annotated placeholder stored as `draft.strPermit`. Treating
// those as "no real value" lets the freshly adapted draft display the
// new, fully-formed county-specific sample without the operator having
// to clear the field by hand.
function looksLikeSamplePlaceholder(value: string): boolean {
  const v = value.toLowerCase();
  if (v.includes("sample —") || v.includes("sample -")) return true;
  if (v.includes("(verify ") || v.includes("verify with local")) return true;
  if (/x{3,}/i.test(value)) return true; // "STR-XXXX", "DWE/COND-XXXXXXX", etc.
  return false;
}

function titleCaseAddress(value: string): string {
  return value.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function cleanAddressComponent(value: string): string {
  return value.replace(/\s+/g, " ").replace(/\s+,/g, ",").trim();
}

function parseListingAddressFromUrl(url: string | null | undefined): string | null {
  const raw = String(url ?? "").trim();
  if (!raw) return null;
  const clean = (value: string): string | null => {
    const decoded = decodeURIComponent(value)
      .replace(/[_-]+/g, " ")
      .replace(/\b(?:FL|HI|CA|TX|NY|GA|SC|NC|AL|MS|LA|WA|OR|CO|AZ|NV)\b/gi, " ")
      .replace(/\b\d{5}(?: \d{4})?\b/g, " ")
      .replace(/\bM\d{4,}(?: \d+)?\b/gi, " ")
      .replace(/\bzpid\b.*$/i, " ")
      .replace(/\s+/g, " ")
      .trim();
    const m = decoded.match(
      /\b(\d{2,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,5}\s+(?:Blvd|Boulevard|Rd|Road|St|Street|Ave|Avenue|Dr|Drive|Ln|Lane|Way|Cir|Circle|Ct|Court|Pkwy|Parkway|Pl|Place|Ter|Terrace|Trail)(?:\s*(?:(?:#|Unit|Apt|Apartment|Suite|Ste)\s*)?[A-Za-z]?\d{1,5}[A-Za-z]?)?)\b/i,
    );
    return m?.[1] ? titleCaseAddress(m[1].trim()) : null;
  };

  const zillowMatch = raw.match(/\/homedetails\/([^/]+)\//i);
  if (zillowMatch) return clean(zillowMatch[1]);

  const realtorMatch = raw.match(/\/realestateandhomes-detail\/([^/?#]+)/i);
  if (realtorMatch) {
    const slug = realtorMatch[1];
    const firstSegment = slug.split("_")[0];
    return clean(firstSegment) ?? clean(slug);
  }

  const redfinMatch = raw.match(/redfin\.com\/[A-Z]{2}\/[^/]+\/([^/]+)(?:\/unit-([^/]+))?\/home\//i);
  if (redfinMatch) {
    const street = redfinMatch[1];
    const unit = redfinMatch[2] ? ` Unit ${redfinMatch[2]}` : "";
    return clean(`${street}${unit}`);
  }

  return null;
}

function fullUnitAddressForDraft(draft: CommunityDraft): string | null {
  const explicit = String((draft as any).unit1Address ?? "").trim();
  const parsed = explicit || parseListingAddressFromUrl(draft.unit1Url) || parseListingAddressFromUrl(draft.sourceUrl) || "";
  if (!parsed) return null;
  const hasCity = new RegExp(`\\b${draft.city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(parsed);
  const hasState = new RegExp(`\\b(?:${draft.state.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|${draft.state.toLowerCase() === "florida" ? "FL" : draft.state.toLowerCase() === "hawaii" ? "HI" : draft.state})\\b`, "i").test(parsed);
  return cleanAddressComponent(`${parsed}${hasCity ? "" : `, ${draft.city}`}${hasState ? "" : `, ${draft.state}`}`);
}

function unitNumberFromAddress(address: string | null): string {
  const text = String(address ?? "").trim();
  if (!text) return "A";
  const marked = text.match(/\b(?:unit|apt|apartment|suite|ste|#)\s*([A-Za-z]?\d{1,5}[A-Za-z]?)\b/i);
  if (marked?.[1]) return marked[1].toUpperCase();
  const trailing = text.split(",")[0]?.match(/\b(?:Blvd|Boulevard|Rd|Road|St|Street|Ave|Avenue|Dr|Drive|Ln|Lane|Way|Cir|Circle|Ct|Court|Pkwy|Parkway|Pl|Place|Ter|Terrace|Trail)\s+([A-Za-z]?\d{2,5}[A-Za-z]?)\b/i);
  return trailing?.[1] ? trailing[1].toUpperCase() : "A";
}

function descriptionForDraft(draft: CommunityDraft): string {
  // Drafts store the generator's FLAT description (summary + space +
  // "THE NEIGHBORHOOD" + "GETTING AROUND" glued for the wizard's Step-5
  // textarea). The builder pushes neighborhood/transit as their own
  // Guesty fields, so strip those sections here — otherwise the summary
  // duplicates them on every OTA with raw ALL-CAPS headers (2026-07-10).
  const text = stripAreaSectionsFromDescription(draft.listingDescription ?? "");
  if ((draft as any).singleListing !== true) return text;
  return text
    .replace(/please note:\s*this listing combines two units within the same community\.[\s\S]*?(?:---\s*)?/i, "")
    .replace(/please note:\s*this is a sample unit\.[\s\S]*?layout may vary\.\s*(?:---\s*)?/i, "")
    .replace(/unit assignment note:\s*this listing uses representative accommodations[\s\S]*?vary by unit\.\s*(?:---\s*)?/i, "")
    .replace(/\bthis listing (?:is comprised of|combines) two [^.]+\.\s*/gi, "")
    .replace(/\btogether they offer [^.]+\.\s*/gi, "")
    .trim();
}

export function adaptDraftToPropertyUnitBuilder(
  draft: CommunityDraft,
  photoFiles: Record<string, string[]> = {},
): PropertyUnitBuilder {
  const u1Br = resolveDraftUnitBedrooms(draft, "unit1");
  const u2Br = resolveDraftUnitBedrooms(draft, "unit2");
  const blank = "";
  const licenseSamples = sampleLicensesForLocation(draft.city, draft.state);
  // A value is "real" only when it's neither an old annotated
  // placeholder NOR one of the enumerated generator/legacy samples —
  // so a stale persisted sample (e.g. old-format "STRH-20240042")
  // auto-upgrades to the current county-correct sample on adapt.
  const realDraftValue = (value: unknown): string | undefined => {
    const text = String(value ?? "").trim();
    return text && !looksLikeSamplePlaceholder(text) && !isPlaceholderLicenseValue(text) ? text : undefined;
  };
  const savedTaxMapKey = realDraftValue((draft as any).taxMapKey) ?? realDraftValue((draft as any).dbprLicense);
  const savedTatLicense = realDraftValue((draft as any).tatLicense) ?? realDraftValue((draft as any).touristTaxAccount);
  const savedGetLicense = realDraftValue((draft as any).getLicense);
  const savedStrPermit = realDraftValue(draft.strPermit);
  const savedDbprLicense = realDraftValue((draft as any).dbprLicense);
  const savedTouristTaxAccount = realDraftValue((draft as any).touristTaxAccount);
  const singleUnitAddress = (draft as any).singleListing === true ? fullUnitAddressForDraft(draft) : null;
  const singleUnitNumber = unitNumberFromAddress(singleUnitAddress);
  const filesToPhotos = (folder: string | null | undefined) => {
    if (!folder) return [];
    const files = photoFiles[folder] ?? [];
    return files.map((filename) => ({
      filename,
      label: "Photo",
      category: "interior" as const,
    }));
  };
  return {
    propertyId: -draft.id, // matches the synthetic negative id the dashboard uses
    propertyName: draft.listingTitle || draft.name,
    complexName: draft.name,
    // Street address (when the operator filled it in on Step 5) gives
    // the preflight a real per-unit address to text-search; falls
    // back to "city, state" so older drafts keep rendering.
    address: singleUnitAddress
      ? singleUnitAddress
      : draft.streetAddress
      ? `${draft.streetAddress}, ${draft.city}, ${draft.state}`
      : `${draft.city}, ${draft.state}`,
    bookingTitle: draft.bookingTitle || draft.listingTitle || draft.name,
    sampleDisclaimer: (draft as any).singleListing === true ? SINGLE_LISTING_SAMPLE_DISCLOSURE : blank,
    combinedDescription: descriptionForDraft(draft) || blank,
    propertyType: draft.propertyType ?? "Condominium",
    neighborhood: draft.neighborhood ?? blank,
    transit: draft.transit ?? blank,
    taxMapKey: savedTaxMapKey ?? licenseSamples.taxMapKey,
    tatLicense: savedTatLicense ?? licenseSamples.tatLicense,
    getLicense: savedGetLicense ?? licenseSamples.getLicense,
    // Use the operator-entered STR permit if they typed one on Step 5,
    // otherwise drop in the county-appropriate sample format. Drafts
    // saved before the Florida county-aware samples landed have the
    // old generic placeholder stored as `draft.strPermit`; treat those
    // as "no real value typed" so the new county-specific sample wins.
    strPermit: savedStrPermit ?? licenseSamples.strPermit,
    dbprLicense: savedDbprLicense,
    touristTaxAccount: savedTouristTaxAccount,
    // CODEX NOTE (2026-05-04, claude/single-listing): branch on
    // `singleListing` so standalone drafts ignore the unit2 photo
    // folder check. Reading `unit2PhotoFolder` for a single draft
    // would still work (it's null) but being explicit keeps the
    // intent visible.
    hasPhotos: (() => {
      const isSingle = (draft as any).singleListing === true;
      const unit1Has = !!(draft.unit1PhotoFolder && photoFiles[draft.unit1PhotoFolder]?.length);
      if (isSingle) return unit1Has;
      const unit2Has = !!(draft.unit2PhotoFolder && photoFiles[draft.unit2PhotoFolder]?.length);
      return unit1Has || unit2Has;
    })(),
    // Community photos for promoted drafts live at a deterministic
    // folder name `community-draft-<draftId>`. The wizard's save flow
    // best-effort fetches and writes 6 community-level photos there
    // via /api/community/:id/persist-community-photos. The builder's
    // photos tab reads files from disk via builder.tsx →
    // /api/photos/community/<folder>, so leaving `communityPhotos`
    // empty is fine — folderFiles takes precedence over the static
    // array in the rendering code (builder.tsx line ~201). Positions
    // default to "beginning", which collapses every community photo
    // into the opener block before unit A — a sensible default for
    // drafts that don't have hand-curated position metadata.
    communityPhotos: [],
    communityPhotoFolder: resolveCanonicalCommunityPhotoFolder(draft.name) ?? `community-draft-${draft.id}`,
    // CODEX NOTE (2026-05-04, claude/single-listing): standalone drafts
    // emit a one-element units[] array. Combo drafts keep the existing
    // two-element shape. Builder tabs (Bedding, Pricing, etc.) iterate
    // over units[] without assuming length === 2, so this works without
    // further changes.
    units: ((draft as any).singleListing === true)
      ? [
          {
            id: `draft${draft.id}-unit-a`,
            unitNumber: singleUnitNumber,
            bedrooms: u1Br,
            bathrooms: draft.unit1Bathrooms ?? "",
            sqft: draft.unit1Sqft ?? "",
            maxGuests: draft.unit1MaxGuests ?? u1Br * 2,
            shortDescription: draft.unit1ShortDescription ?? "",
            longDescription: draft.unit1LongDescription ?? "",
            photoFolder: draft.unit1PhotoFolder ?? "",
            photos: filesToPhotos(draft.unit1PhotoFolder),
          },
        ]
      : [
          {
            id: `draft${draft.id}-unit-a`,
            unitNumber: "A",
            bedrooms: u1Br,
            bathrooms: draft.unit1Bathrooms ?? "",
            sqft: draft.unit1Sqft ?? "",
            maxGuests: draft.unit1MaxGuests ?? u1Br * 2,
            shortDescription: draft.unit1ShortDescription ?? "",
            longDescription: draft.unit1LongDescription ?? "",
            photoFolder: draft.unit1PhotoFolder ?? "",
            photos: filesToPhotos(draft.unit1PhotoFolder),
          },
          {
            id: `draft${draft.id}-unit-b`,
            unitNumber: "B",
            bedrooms: u2Br,
            bathrooms: draft.unit2Bathrooms ?? "",
            sqft: draft.unit2Sqft ?? "",
            maxGuests: draft.unit2MaxGuests ?? u2Br * 2,
            shortDescription: draft.unit2ShortDescription ?? "",
            longDescription: draft.unit2LongDescription ?? "",
            photoFolder: draft.unit2PhotoFolder ?? "",
            photos: filesToPhotos(draft.unit2PhotoFolder),
          },
        ],
  } as PropertyUnitBuilder;
}

// Fetch + adapt a draft by its negative property id (`-draftId`).
// Returns null when no draft matches. Pulls per-unit photo file lists
// alongside the draft so the resulting PropertyUnitBuilder has its
// units' photos arrays populated.
export async function loadDraftPropertyByNegativeId(
  propertyId: number,
): Promise<PropertyUnitBuilder | null> {
  const full = await loadDraftFullDataByNegativeId(propertyId);
  return full?.property ?? null;
}

// All-in-one loader: fetches the draft, adapts it to the builder shape,
// AND generates pricing/bedding defaults so the Pricing and Bedding
// tabs have something to render. The bedding default also gets
// registered with the bedding-config cache as a side effect, since
// the Bedding tab loads its config sync via buildDefaultBeddingConfig.
export type DraftFullData = {
  draft: CommunityDraft;
  property: PropertyUnitBuilder;
  pricing: PropertyPricing;
  bedding: PropertyBeddingConfig;
};

export async function loadDraftFullDataByNegativeId(
  propertyId: number,
): Promise<DraftFullData | null> {
  if (propertyId >= 0) return null;
  const draftId = -propertyId;
  const r = await apiRequest("GET", "/api/community/drafts");
  const drafts = (await r.json()) as CommunityDraft[];
  const match = drafts.find((d) => d.id === draftId);
  if (!match) return null;
  const communityFolder = resolveCanonicalCommunityPhotoFolder(match.name) ?? `community-draft-${draftId}`;
  const folders = [match.unit1PhotoFolder, match.unit2PhotoFolder, communityFolder]
    .filter((f): f is string => !!f);
  const filesByFolder: Record<string, string[]> = {};
  await Promise.all(
    folders.map(async (folder) => {
      try {
        const fr = await apiRequest("GET", `/api/photos/community/${encodeURIComponent(folder)}`);
        const list = (await fr.json()) as Array<{ filename: string }> | null;
        filesByFolder[folder] = Array.isArray(list) ? list.map((f) => f.filename) : [];
      } catch {
        filesByFolder[folder] = [];
      }
    }),
  );

  // Backfill: drafts saved before community-photos auto-fetch landed have an
  // empty `community-draft-<id>` folder.
  // Fire-and-forget the persist endpoint so the next builder load
  // shows them. The endpoint is idempotent — it clears + re-saves the
  // folder each time, so re-running on a populated folder is safe but
  // wasteful, hence the empty-folder gate.
  if ((filesByFolder[communityFolder] ?? []).length === 0) {
    void apiRequest("POST", `/api/community/${draftId}/persist-community-photos`, {})
      .catch((e: any) => console.warn(`[adapt-draft] community-photos backfill failed for draft ${draftId}: ${e?.message}`));
  }
  const property = adaptDraftToPropertyUnitBuilder(match, filesByFolder);
  const pricing = buildDraftPropertyPricing(match, propertyId);
  const bedding = buildDraftBeddingConfig(match, propertyId);
  // Register so sync helpers (loadBeddingConfig, getPropertyPricing)
  // find the draft data when called inside the GuestyListingBuilder.
  registerDraftBeddingDefaults(propertyId, bedding);
  registerDraftPropertyPricing(propertyId, pricing);
  return { draft: match, property, pricing, bedding };
}
